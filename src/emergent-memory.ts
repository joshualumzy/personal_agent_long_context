import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Keeps the emergent graph following the questions people actually ask.
 *
 * Extraction reads prose with a language model and takes minutes, so it cannot
 * happen while a request is open. Instead a question is answered from Postgres
 * immediately and queued here; the extraction runs afterwards and the graph
 * export it produces is what the next visit to /graph reads.
 *
 * The work is three Python steps, run in order:
 *
 *   query_slice     choose the dozen or so artifacts the question is about
 *   remember        extract entities and relationships from just those
 *   graph           write the export the web view serves
 *
 * Shelling out is the right shape here and the wrong shape inside a request. No
 * one is waiting, a failure is a logged warning rather than a broken answer, and
 * the alternative — reading cognee's embedded stores from this process — is not
 * possible: its graph store has no client for this runtime.
 *
 * One run at a time. The extraction is heavy, and cognee's stores are local files
 * that two concurrent writers would corrupt.
 */

export interface EmergentMemoryOptions {
  /** Python interpreter, usually the project virtualenv. */
  python: string;
  /** Repository root: the scripts resolve their own paths from there. */
  projectRoot: string;
  /** Where cognee records the questions it has already extracted. */
  questionsFile: string;
  log?: { info(object: unknown, message: string): void; warn(object: unknown, message: string): void };
  /** Cap on waiting questions, so a burst cannot grow without bound. */
  maxQueued?: number;
  /** Swappable for tests. Resolves to the process's exit code. */
  run?: (command: string, args: string[], cwd: string) => Promise<{ code: number; stderr: string }>;
}

export interface EmergentMemoryStatus {
  running: string | null;
  queued: number;
  extracted: number;
  lastFinishedAt: string | null;
  lastError: string | null;
}

function runProcess(command: string, args: string[], cwd: string) {
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    // Keep only the tail: these scripts log progress lines, and only the end of
    // the output says why something failed.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export class EmergentMemory {
  private readonly queue: string[] = [];
  private readonly seen = new Set<string>();
  private running: string | null = null;
  private lastFinishedAt: string | null = null;
  private lastError: string | null = null;
  private readonly run: NonNullable<EmergentMemoryOptions["run"]>;

  constructor(private readonly options: EmergentMemoryOptions) {
    this.run = options.run ?? runProcess;
    // Questions extracted in earlier runs are already in the graph. Reading the
    // record cognee keeps means a restart does not redo all of them.
    for (const question of this.previouslyExtracted()) this.seen.add(question);
  }

  private previouslyExtracted(): string[] {
    try {
      if (!existsSync(this.options.questionsFile)) return [];
      const parsed: unknown = JSON.parse(readFileSync(this.options.questionsFile, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  status(): EmergentMemoryStatus {
    return {
      running: this.running,
      queued: this.queue.length,
      extracted: this.seen.size,
      lastFinishedAt: this.lastFinishedAt,
      lastError: this.lastError,
    };
  }

  /**
   * Queue a question for extraction. Returns whether it was taken on.
   *
   * A question already extracted, queued, or in flight is skipped: the graph
   * would not change and the model call costs money.
   */
  enqueue(question: string): boolean {
    const trimmed = question.trim();
    if (trimmed.length < 8) return false;
    if (this.seen.has(trimmed) || this.running === trimmed || this.queue.includes(trimmed)) {
      return false;
    }
    if (this.queue.length >= (this.options.maxQueued ?? 8)) return false;

    this.queue.push(trimmed);
    // Deliberately not awaited: the caller is answering a request.
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const question = this.queue.shift();
    if (!question) return;

    this.running = question;
    try {
      await this.extract(question);
      this.seen.add(question);
      this.lastError = null;
      this.options.log?.info({ question }, "Emergent memory updated");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.log?.warn(
        { question, reason: this.lastError },
        "Emergent memory extraction failed",
      );
    } finally {
      this.lastFinishedAt = new Date().toISOString();
      this.running = null;
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async extract(question: string): Promise<void> {
    const { python, projectRoot } = this.options;
    const slicePath = join(tmpdir(), `orgforge-slice-${Date.now()}.json`);

    const steps: Array<[string, string[]]> = [
      ["orgforge_kb/query_slice.py", [question, "-o", slicePath]],
      ["orgforge_kb/cognee_memory.py", ["remember", slicePath]],
      // Rewrites the export the web view reads.
      ["orgforge_kb/cognee_memory.py", ["graph"]],
    ];

    for (const [script, args] of steps) {
      const result = await this.run(python, [script, ...args], projectRoot);
      if (result.code !== 0) {
        const detail = result.stderr.trim().split("\n").pop() ?? `exit ${result.code}`;
        throw new Error(`${script} failed: ${detail}`);
      }
    }
  }
}
