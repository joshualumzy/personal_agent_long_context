// Round 3 backend hunt: llm.ts (retry, concurrency slot), store.ts normalization, roles.ts removal.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { statusForModel } from "../../src/recruiting/chat-tools.js";
import { RecruitingError } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import { OpenAiCompatibleModel, type JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { normalizeState, type StateStore } from "../../src/recruiting/store.js";

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("r3 llm", () => {
  test("B13 a 200 reply whose body is not JSON (a proxy error page) is not retried", async () => {
    let calls = 0;
    const model = new OpenAiCompatibleModel({
      baseUrl: "http://x", apiKey: "k", model: "m", retryBaseMs: 1,
      fetch: (async () => {
        calls += 1;
        return calls === 1 ? new Response("<html>502 Bad Gateway</html>", { status: 200 }) : ok('{"a":1}');
      }) as typeof fetch,
    });
    const result = await model.json<{ a: number }>({ task: "t", system: "s", input: {} }).catch((e: Error) => e);
    assert.deepEqual(result, { a: 1 }, `gave up after ${calls} call(s): ${(result as Error).message}`);
  });

  test("B14 the concurrency slot can be taken by a newcomer while a woken waiter is resuming, exceeding maxConcurrent", async () => {
    // For each microtask depth, start: A (holds the only slot), B (waits), then release A and
    // start C some microtasks later. If C lands between A's release and B's wake-up, both run.
    let worst = 0;
    for (let depth = 0; depth < 40 && worst < 2; depth += 1) {
      let live = 0;
      const gates: Array<() => void> = [];
      const model = new OpenAiCompatibleModel({
        baseUrl: "http://x", apiKey: "k", model: "m", maxConcurrent: 1, retryBaseMs: 1,
        fetch: (async () => {
          live += 1;
          worst = Math.max(worst, live);
          await new Promise<void>((resolve) => gates.push(resolve));
          live -= 1;
          return ok('{"ok":true}');
        }) as typeof fetch,
      });
      const request = { task: "t", system: "s", input: {} };
      const a = model.json(request);
      const b = model.json(request);
      await new Promise((resolve) => setTimeout(resolve, 5));
      let c: Promise<unknown> = Promise.resolve();
      gates.shift()!(); // A's reply arrives
      let chain: Promise<void> = Promise.resolve();
      for (let i = 0; i < depth; i += 1) chain = chain.then(() => undefined);
      await chain;
      c = model.json(request);
      await new Promise((resolve) => setTimeout(resolve, 5));
      while (gates.length) { gates.shift()!(); await new Promise((resolve) => setTimeout(resolve, 2)); }
      await Promise.all([a, b, c]);
    }
    assert.equal(worst, 1, "two model calls were in flight with maxConcurrent 1");
  });
});

// ------------------------------------------------------------ store normalization

const judgeCalls = { n: 0 };
const model: JsonModel = {
  async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
    const data = input as Record<string, any>;
    if (task === "criterion judgement") {
      judgeCalls.n += 1;
      if (judgeCalls.n > 25) throw new Error("test guard: judged the same person over and over");
      return { verdicts: data.criteria.map((c: { id: string }) => ({ criterionId: c.id, satisfied: "yes", reasoning: "k" })) } as T;
    }
    if (task === "reason inference") return { reason: "r" } as T;
    throw new Error(`unscripted ${task}`);
  },
};
const source: CandidateSource = { name: "fake", search: async () => [] };
const at = "2026-09-01T00:00:00.000Z";
const criterion = { id: "k1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: at };
const profile = (id: string) => ({
  id, name: `P ${id}`, headline: "", location: "", profileUrl: `https://www.linkedin.com/in/${id}`,
  workHistory: [], educationHistory: [], summary: "",
});

function serviceOver(raw: unknown) {
  const store: StateStore = { load: async () => normalizeState(structuredClone(raw)), save: async () => undefined };
  return new RecruitingService({
    model, source, store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null,
    settings: { rescoreAttempts: 0 },
  });
}

describe("r3 store normalization", () => {
  test("B15 a candidate saved under a key other than its profile id is re-judged in a loop and cannot be acted on", async () => {
    judgeCalls.n = 0;
    const service = serviceOver({
      role: { title: "Eng", requirement: "r", confirmed: true, createdAt: at },
      criteria: [criterion],
      candidates: { key1: { profile: profile("p1"), stage: "discovered" } },
    });
    await service.settle();
    const snapshot = await service.snapshot();
    const shown = snapshot.candidates[0]!;
    const acted = await service.feedback(shown.id, "keep").then(() => "ok", (e: Error) => e.message);
    assert.equal(judgeCalls.n, 1, `the same person was judged ${judgeCalls.n} times (settled=${shown.settled})`);
    assert.equal(acted, "ok", `acting on the id the snapshot shows (${shown.id}) failed: ${acted}`);
  });

  test("B16 one null entry in criteria/proposals/feedback/messages makes the whole role unreadable", async () => {
    const service = serviceOver({
      role: { title: "Eng", requirement: "r", confirmed: true, createdAt: at },
      criteria: [criterion, null],
      proposals: [null],
      feedback: [null],
      candidates: { p1: { profile: profile("p1"), stage: "contacted", verdicts: { k1: { criterionId: "k1", satisfied: "yes", reasoning: "" } }, messages: [null] } },
    });
    const outcome = await service.snapshot().then((s) => statusForModel(s)).then(() => "readable", (e: Error) => e.message);
    assert.equal(outcome, "readable");
  });
});

// ------------------------------------------------------------ roles

describe("r3 roles", () => {
  test("B17 a delete that failed half-way can never be retried; the file with third-party records stays", async () => {
    class Flaky extends MemoryRoleRepository {
      fail = true;
      override async remove(roleId: string) {
        if (this.fail) { this.fail = false; throw new Error("EBUSY"); }
        return super.remove(roleId);
      }
    }
    const repository = new Flaky();
    const roles = new RoleBoard(repository, (store) =>
      new RecruitingService({ model: { json: async () => ({ title: "Eng", criteria: [{ text: "typescript", kind: "must" }], queries: ["q"] }) as never }, source, store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null }));
    const { id, service } = roles.create();
    await service.start("We need an engineer who knows TypeScript well.");
    await roles.remove(id).catch(() => undefined);
    const retry = await roles.remove(id).then(() => "removed", (e: Error) => (e instanceof RecruitingError ? e.code : e.message));
    assert.equal(retry, "removed", `retrying the delete said ${retry}`);
    assert.deepEqual(await repository.list(), [], "the role's data is still stored");
  });
});
