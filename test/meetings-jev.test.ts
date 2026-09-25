import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CompanyKnowledge } from "../src/company-domain.js";
import type { Decision } from "../src/meetings/domain.js";
import { jevConflictChecker, type ConflictChecker } from "../src/meetings/jev.js";

const knowledge: CompanyKnowledge = {
  employee: async (employeeId) => ({ employeeId, displayName: "E", currentAssignments: [] }),
  search: async () => [],
  related: async () => [],
  sources: async () => [],
};
const decision: Decision = { text: "Decision: we go with approach A.", speaker: "Morgan", segmentIndex: 1, at: "2026-09-25T02:00:00Z" };
const priors = [{ text: "Decision: we'll go with approach B.", speaker: "Jax", segmentIndex: 8, at: "2026-09-18T02:00:00Z", meetingId: "m0", title: "NOC weekly sync" }];

function jevReplying(choice: string, probability: number, status = 200) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(JSON.stringify(status === 200 ? { answers: { contradicts: { type: "choice", choice, probabilities: { [choice]: probability } } } } : { error: { message: "unavailable" } }), { status });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

function recordingFallback(): ConflictChecker & { calls: number } {
  const fallback = Object.assign(async () => {
    fallback.calls += 1;
    return null;
  }, { calls: 0 });
  return fallback;
}

describe("Jev conflict checker", () => {
  test("a confident pick of an earlier decision becomes a conflict that says Jev checked it", async () => {
    const { fetchImpl, bodies } = jevReplying("d0", 0.97);
    const fallback = recordingFallback();
    const conflict = await jevConflictChecker("key", fallback, { fetchImpl })(decision, priors, knowledge);
    assert.equal(conflict?.priorDecision, "Decision: we'll go with approach B.");
    assert.equal(conflict?.priorMeetingId, "m0");
    assert.match(conflict!.explanation, /NOC weekly sync.*checked by Jev, 97% sure/);
    assert.equal(fallback.calls, 0);
    const sent = JSON.parse(bodies[0]!);
    assert.deepEqual(Object.keys(sent.questions.contradicts.criteria), ["none", "d0"]);
  });

  test("a confident none is no conflict", async () => {
    const fallback = recordingFallback();
    assert.equal(await jevConflictChecker("key", fallback, jevReplying("none", 0.99))(decision, priors, knowledge), null);
    assert.equal(fallback.calls, 0);
  });

  test("an unsure answer goes to the meeting model", async () => {
    const fallback = recordingFallback();
    const reasons: string[] = [];
    await jevConflictChecker("key", fallback, { ...jevReplying("d0", 0.51), onFallback: (reason) => reasons.push(reason) })(decision, priors, knowledge);
    assert.equal(fallback.calls, 1);
    assert.match(reasons[0]!, /unsure/);
  });

  test("a failed request goes to the meeting model", async () => {
    const fallback = recordingFallback();
    await jevConflictChecker("key", fallback, jevReplying("none", 0, 500))(decision, priors, knowledge);
    assert.equal(fallback.calls, 1);
  });

  test("nothing to compare with asks nobody", async () => {
    const { fetchImpl, bodies } = jevReplying("none", 1);
    const fallback = recordingFallback();
    assert.equal(await jevConflictChecker("key", fallback, { fetchImpl })(decision, [], knowledge), null);
    assert.equal(bodies.length + fallback.calls, 0);
  });
});
