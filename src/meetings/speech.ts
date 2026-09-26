import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Turns one recorded audio clip into text; empty when nobody spoke. A preview
 * trades accuracy for speed, for text shown while someone is still talking.
 */
export type Transcribe = (audio: Buffer, options?: { language?: string; preview?: boolean }) => Promise<string>;

const workerScript = fileURLToPath(new URL("../../scripts/whisper_worker.py", import.meta.url));

/**
 * Transcribes with local speech models kept warm in one Python worker.
 * The worker starts on the first clip and restarts if it dies.
 */
export function localWhisper(python = process.env.WHISPER_PYTHON || "python3"): Transcribe {
  let worker: ChildProcessWithoutNullStreams | null = null;
  const pending = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  function start(): ChildProcessWithoutNullStreams {
    const child = spawn(python, [workerScript], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let reply: { id?: string; text?: string; error?: string };
      try {
        reply = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = reply.id ? pending.get(reply.id) : undefined;
      if (!waiter) return;
      pending.delete(reply.id!);
      if (reply.error) waiter.reject(new Error(reply.error));
      else waiter.resolve(reply.text ?? "");
    });
    child.stderr.resume();
    child.on("exit", () => {
      worker = null;
      for (const waiter of pending.values()) waiter.reject(new Error("The transcription worker stopped."));
      pending.clear();
    });
    return child;
  }

  return async (audio, { language, preview } = {}) => {
    const directory = await mkdtemp(join(tmpdir(), "meeting-audio-"));
    const path = join(directory, "clip.webm");
    try {
      await writeFile(path, audio);
      worker ??= start();
      const id = randomUUID();
      const text = await new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker!.stdin.write(
          JSON.stringify({ id, path, ...(language ? { language } : {}), ...(preview ? { preview: true } : {}) }) + "\n",
        );
      });
      return text;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
