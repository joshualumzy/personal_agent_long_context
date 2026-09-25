// Found while setting up the frontend checks: under several parallel sessions SoCLaaS answered
// HTTP 429, the recruiting client retried three times with no pause, and candidates whose
// scoring failed stayed unscored until something else happened to trigger scoring.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OpenAiCompatibleModel, type JsonModel } from "../../src/recruiting/llm.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import { MemoryStore } from "../../src/recruiting/store.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";

const ok = (content: object) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });

function model(fetch: typeof globalThis.fetch, extra: object = {}) {
  return new OpenAiCompatibleModel({ baseUrl: "http://model", apiKey: "k", model: "m", fetch, retryBaseMs: 60, ...extra });
}

describe("rate limits", () => {
  test("429 is retried with a pause until it succeeds", async () => {
    const calls: number[] = [];
    const fetch = (async () => {
      calls.push(Date.now());
      return calls.length < 3 ? new Response("slow down", { status: 429 }) : ok({ fine: true });
    }) as typeof globalThis.fetch;
    const result = await model(fetch).json<{ fine: boolean }>({ task: "t", system: "s", input: {} });
    assert.equal(result.fine, true);
    assert.equal(calls.length, 3);
    // Base 60 ms, doubling: at least 60 + 120 before the third call (jitter only adds).
    assert.ok(calls[2]! - calls[0]! >= 150, `the retries came ${calls[2]! - calls[0]!} ms apart`);
  });

  test("a client error other than 429 is not retried", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response("bad", { status: 400 });
    }) as typeof globalThis.fetch;
    await assert.rejects(model(fetch).json({ task: "t", system: "s", input: {} }), /HTTP 400/);
    assert.equal(calls, 1);
  });

  test("calls in flight never exceed the limit, across every caller", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return ok({ fine: true });
    }) as typeof globalThis.fetch;
    const shared = model(fetch, { maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 7 }, () => shared.json({ task: "t", system: "s", input: {} })));
    assert.equal(peak, 2);
  });
});

describe("scoring that failed is tried again", () => {
  test("a candidate whose first judgement failed is scored later without anyone asking", async () => {
    const person: CandidateProfile = {
      id: "a", name: "Person a", headline: "typescript", location: "Singapore",
      profileUrl: "https://example.com/a", workHistory: [], educationHistory: [], summary: "typescript",
    };
    const source: CandidateSource = { name: "one", search: async () => [person] };
    let judgements = 0;
    const fake: JsonModel = {
      async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
        const data = input as { criteria: Array<{ id: string }> };
        if (task === "criteria extraction") {
          return { title: "Engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["q"] } as T;
        }
        if (task === "criterion judgement") {
          judgements += 1;
          if (judgements === 1) throw new Error("HTTP 429");
          return { verdicts: data.criteria.map((c) => ({ criterionId: c.id, satisfied: "yes", reasoning: "ok" })) } as T;
        }
        throw new Error(`unscripted ${task}`);
      },
    };
    const service = new RecruitingService({
      model: fake, source, store: new MemoryStore(), memory: new LocalIntentMemory(),
      contactFinders: [], gmail: null, settings: { rescoreAfterMs: 20 },
    });
    await service.start("We need an engineer who knows TypeScript well.");
    await service.confirm(); // starts scoring; the first judgement fails
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !(await service.snapshot()).candidates[0]?.settled) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await service.snapshot()).candidates[0]?.tier, 100);
  });
});
