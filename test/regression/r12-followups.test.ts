// Round 12 (r26): "Pass on this one" from the panel names the candidate whose details are open.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import { MemoryStore } from "../../src/recruiting/store.js";

test("say passes the open candidate to the interpreter, which resolves 'this one'", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const model: JsonModel = {
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      const data = input as Record<string, any>;
      if (task === "criteria extraction") return { title: "Engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["q"] } as T;
      if (task === "criterion judgement") return { verdicts: data.criteria.map((c: any) => ({ criterionId: c.id, satisfied: "yes", reasoning: "k" })) } as T;
      if (task === "instruction interpretation") {
        seen.push(data);
        return { intent: "feedback", summary: "pass", candidateId: data.focusedCandidateId, decision: "pass", reason: "too corporate" } as T;
      }
      if (task === "reason inference") return { reason: "corporate" } as T;
      return {} as T;
    },
  };
  const person = (id: string) => ({ id, name: `P ${id}`, headline: "typescript", location: "SG", profileUrl: `https://www.linkedin.com/in/${id}`, workHistory: [], educationHistory: [], summary: "typescript" });
  const service = new RecruitingService({
    model, source: { name: "fake", search: async () => [person("a"), person("b")] }, store: new MemoryStore(),
    memory: new LocalIntentMemory(), contactFinders: [], gmail: null,
  });
  await service.start("We need an engineer who knows TypeScript.");
  await service.confirm();
  await service.settle();
  await service.say("Pass on this one, too corporate", "b");
  assert.equal(seen[0]!.focusedCandidateId, "b");
  const b = (await service.snapshot()).candidates.find((c) => c.id === "b")!;
  assert.equal(b.stage, "closed");
  // An id that is not in the pool is not passed on.
  await service.say("Pass on this one", "nobody");
  assert.equal(seen[1]!.focusedCandidateId, null);
});
