/**
 * Round 2 bug hunt: the protected-characteristic check and model-output
 * parsing. Every test asserts the CORRECT behaviour; each failure is a bug.
 * Run: node --import tsx --test test/hunt/r2-backend-fairness.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { judge, parseOperations } from "../../src/recruiting/agent.js";
import type { CandidateProfile, Criterion } from "../../src/recruiting/domain.js";
import { protectedCharacteristic } from "../../src/recruiting/fairness.js";
import type { JsonModel } from "../../src/recruiting/llm.js";

function flagged(texts: string[]) {
  return texts
    .map((text) => ({ text, characteristic: protectedCharacteristic(text) }))
    .filter((entry) => entry.characteristic !== null);
}

function missed(texts: string[]) {
  return texts.filter((text) => protectedCharacteristic(text) === null);
}

describe("r2 fairness: legitimate, job-related criteria are not refused", () => {
  test("nationality rule: citizen developer, foreigners' work passes, Singaporean SMEs, PR applications, 中国籍客户", () => {
    assert.deepEqual(
      flagged([
        "built citizen developer platforms (low-code)",
        "processed work passes for foreigners (HR operations)",
        "sold to Singaporean SMEs",
        "Singaporean-founded startup experience",
        "immigration law: handled permanent resident applications",
        "熟悉中国籍客户",
        // controls that already pass
        "experience with Singapore market",
        "knows Singapore regulations",
        "Singaporean customers",
        "civic tech",
        "PR experience",
        "中国市场经验",
        "懂新加坡法规",
      ]),
      [],
    );
  });

  test("race rule: a job-related language or domain is not race", () => {
    assert.deepEqual(
      flagged([
        "business-level Chinese",
        "Chinese proficiency (HSK 5)",
        "licensed Traditional Chinese Medicine practitioner",
        "sold to Indian enterprises",
      ]),
      [],
    );
  });

  test("age rule: numbers after under/over are not ages", () => {
    assert.deepEqual(
      flagged([
        "kept API p99 latency under 50 ms",
        "managed teams of over 10 engineers",
        "served over 20 enterprise clients",
        "experience at a young startup",
      ]),
      [],
    );
  });

  test("sex, family and disability rules: the product domain is not the person", () => {
    assert.deepEqual(
      flagged([
        "built women's health products",
        "shipped pregnancy tracking apps",
        "accessibility work for disabled users",
      ]),
      [],
    );
  });
});

describe("r2 fairness: discriminatory criteria are refused", () => {
  test("age in common English and Chinese phrasings", () => {
    assert.deepEqual(
      missed([
        "aged 25-35",
        "age 25 to 35",
        "30 years old or younger",
        "between 25 and 35 years old",
        "max age 35",
        "born after 1995",
        "20多岁",
        "90后",
      ]),
      [],
    );
  });

  test("nationality in common English and Chinese phrasings", () => {
    assert.deepEqual(
      missed([
        "新加坡人优先",
        "本地人优先",
        "Malaysian only",
        "Singapore PR",
        "SC/PR",
        "Singapore passport holder",
        "local candidates only",
      ]),
      [],
    );
  });

  test("sex and family status in common English and Chinese phrasings", () => {
    assert.deepEqual(missed(["限男", "男士优先", "ladies preferred", "must be a mother"]), []);
  });
});

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
