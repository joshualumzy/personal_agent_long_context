import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { judge, parseOperations } from "../../src/recruiting/agent.js";
import type { CandidateProfile, Criterion } from "../../src/recruiting/domain.js";
import type { JsonModel } from "../../src/recruiting/llm.js";

// Split out of r2-backend-fairness.test.ts when the owner removed the fairness check.
describe("r2 agent: parsing model output", () => {
  const criteria: Criterion[] = [
    { id: "k1", text: "rust", kind: "nice", origin: "stated", active: true, createdAt: "2026-09-23T00:00:00.000Z" },
  ];

  test("set_kind with an unrecognised kind does not flip a nice criterion to must", () => {
    // The founder said "keep rust a nice-to-have"; the model spelled the kind its own way.
    const operations = parseOperations([{ op: "set_kind", id: "k1", kind: "nice-to-have" }], criteria);
    assert.ok(
      operations.every((operation) => operation.op !== "set_kind" || operation.kind === "nice"),
      `parsed as ${JSON.stringify(operations)}`,
    );
  });

  test("a verdict whose criterion id came back as a number is not discarded", async () => {
    const numeric: Criterion[] = [
      { id: "12345678", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: "2026-09-23T00:00:00.000Z" },
    ];
    const model: JsonModel = {
      async json<T>(): Promise<T> {
        return { verdicts: [{ criterionId: 12345678, satisfied: "yes", reasoning: "TypeScript at Grab" }] } as T;
      },
    };
    const profile: CandidateProfile = {
      id: "p",
      name: "P",
      headline: "",
      location: "",
      profileUrl: "",
      workHistory: [],
      educationHistory: [],
      summary: "",
    };
    const [verdict] = await judge(model, profile, numeric);
    assert.equal(verdict!.satisfied, "yes", "the model said yes; the parser recorded 'Not assessed'");
  });
});
