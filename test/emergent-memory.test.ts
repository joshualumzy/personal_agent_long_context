import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmergentMemory } from "../src/emergent-memory.js";

/** A stand-in for the Python steps, recording what it was asked to run. */
function recorder(outcome: (script: string) => { code: number; stderr: string } = () => ({
  code: 0,
  stderr: "",
})) {
  const calls: string[][] = [];
  let release: (() => void) | null = null;
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    if (release) await new Promise<void>((resolve) => { release = resolve; });
    return outcome(args[0] ?? "");
  };
  return { calls, run, hold: () => { release = () => {}; } };
}

type RunStep = (command: string, args: string[], cwd: string) => Promise<{ code: number; stderr: string }>;

function worker(run: RunStep, questionsFile?: string) {
  return new EmergentMemory({
    python: "/nonexistent/python",
    projectRoot: "/nonexistent",
    questionsFile: questionsFile ?? join(mkdtempSync(join(tmpdir(), "em-")), "questions.json"),
    run,
  });
}

/** Waits for the queue to empty, so assertions do not race the worker. */
async function settle(memory: EmergentMemory) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = memory.status();
    if (!status.running && status.queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The worker never went idle.");
}

describe("emergent memory extraction", () => {
  test("a question runs the three steps in order, slice first", async () => {
    const { calls, run } = recorder();
    const memory = worker(run);

    assert.equal(memory.enqueue("why did the TiDB migration slip"), true);
    await settle(memory);

    assert.deepEqual(
      calls.map((args) => args[0]),
      [
        "orgforge_kb/query_slice.py",
        "orgforge_kb/cognee_memory.py",
        "orgforge_kb/cognee_memory.py",
      ],
    );
    // The slice written by the first step is what the second one reads.
    // Arguments are [script, ...] so the path is last in each call.
    const slicePath = calls[0]!.at(-1);
    assert.match(String(slicePath), /orgforge-slice-\d+\.json$/);
    assert.deepEqual(calls[1]!.slice(1), ["remember", slicePath]);
    assert.deepEqual(calls[2]!.slice(1), ["graph"]);
    assert.equal(memory.status().extracted, 1);
  });

  test("the same question is not extracted twice", async () => {
    const { calls, run } = recorder();
    const memory = worker(run);

    assert.equal(memory.enqueue("why did the TiDB migration slip"), true);
    await settle(memory);
    // Already in the graph: running it again would cost a model call and change
    // nothing.
    assert.equal(memory.enqueue("why did the TiDB migration slip"), false);
    assert.equal(memory.enqueue("  why did the TiDB migration slip  "), false);
    await settle(memory);
    assert.equal(calls.length, 3);
  });

  test("a question already extracted in an earlier run is skipped after a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "em-"));
    const questionsFile = join(directory, "questions.json");
    writeFileSync(questionsFile, JSON.stringify(["an older question about TiDB"]), "utf8");

    const { calls, run } = recorder();
    const memory = worker(run, questionsFile);
    assert.equal(memory.enqueue("an older question about TiDB"), false);
    assert.equal(calls.length, 0);
    assert.equal(memory.status().extracted, 1);
  });

  test("something too short to be a question is ignored", async () => {
    const { calls, run } = recorder();
    const memory = worker(run);
    assert.equal(memory.enqueue("hi"), false);
    assert.equal(memory.enqueue("   "), false);
    assert.equal(calls.length, 0);
  });

  test("a failed step is reported and does not stop the next question", async () => {
    const { run } = recorder((script) =>
      script.includes("cognee_memory")
        ? { code: 1, stderr: "LLM_API_KEY is not set, so there is no model to extract with." }
        : { code: 0, stderr: "" },
    );
    const memory = worker(run);

    memory.enqueue("a question that will fail during extraction");
    await settle(memory);

    const status = memory.status();
    assert.match(status.lastError ?? "", /cognee_memory\.py failed/);
    assert.match(status.lastError ?? "", /LLM_API_KEY/);
    // The failure is recorded, not thrown, and the worker is ready again.
    assert.equal(status.running, null);
    assert.equal(status.extracted, 0);

    memory.enqueue("a second question, which should still be attempted");
    assert.equal(memory.status().queued + (memory.status().running ? 1 : 0), 1);
    await settle(memory);
  });

  test("a burst is queued rather than run all at once", async () => {
    const { calls, run } = recorder();
    const memory = worker(run);

    for (let index = 0; index < 4; index += 1) {
      memory.enqueue(`question number ${index} about the migration`);
    }
    // One in flight, the rest waiting: cognee's stores are local files that two
    // writers would corrupt.
    const status = memory.status();
    assert.ok(status.running !== null, "one question should be in flight");
    assert.equal(status.queued, 3);

    await settle(memory);
    assert.equal(calls.length, 12);
    assert.equal(memory.status().extracted, 4);
  });
});
