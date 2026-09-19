import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ingestPrompt } from "../src/adapters/letta-memory.js";
import {
  CONSENT_POLICY_VERSION,
  type AcceptedQuestion,
  type AcceptedTranscript,
  type MemoryAnswer,
  type MemoryInspection,
  type MemoryProvider,
} from "../src/domain.js";
import { buildApp } from "../src/http-app.js";

/**
 * A Memory provider whose answers are scripted from a recorded real-Letta
 * run (see docs/evidence/). The application cannot decide what Current Truth
 * is: that is the agent's work. What these tests hold still is the contract
 * around it, which the application does own: every dated Transcript reaches
 * the same user-scoped agent in order, recorded time stays distinct from
 * receipt time, and the answer surfaced to the browser is the agent's
 * Current Truth with nothing stale added back by the server.
 */
class ScriptedMemoryProvider implements MemoryProvider {
  readonly ingested: AcceptedTranscript[] = [];
  readonly asked: AcceptedQuestion[] = [];

  constructor(
    private readonly answers: MemoryAnswer[],
    private readonly inspection: MemoryInspection,
  ) {}

  async ingest(transcript: AcceptedTranscript): Promise<{ agentRef: string }> {
    this.ingested.push(structuredClone(transcript));
    return { agentRef: `scripted:${transcript.userId}` };
  }

  async ask(question: AcceptedQuestion): Promise<MemoryAnswer> {
    this.asked.push(structuredClone(question));
    const next = this.answers[this.asked.length - 1];
    if (!next) throw new Error("The scripted provider ran out of answers.");
    return next;
  }

  async inspect(): Promise<MemoryInspection> {
    return structuredClone(this.inspection);
  }
}

const chain = [
  {
    sourceId: "plan-001",
    recordedAt: "2026-09-01T09:00:00+08:00",
    transcript:
      "I booked the dentist for Thursday the 24th at 9am, and I signed up for the Tuesday evening pottery class.",
  },
  {
    sourceId: "plan-002",
    recordedAt: "2026-09-08T09:00:00+08:00",
    transcript: "I moved the dentist appointment to Friday the 25th at 2pm.",
  },
  {
    sourceId: "plan-003",
    recordedAt: "2026-09-15T09:00:00+08:00",
    transcript: "I cancelled the pottery class.",
  },
  {
    // Uploaded last, but recorded before the revision above.
    sourceId: "plan-004",
    recordedAt: "2026-09-05T09:00:00+08:00",
    transcript: "Confirming the dentist is Thursday the 24th at 9am.",
  },
];

/** Answers copied from the recorded real-Letta run of the same chain. */
const currentTruth: MemoryAnswer = {
  answer: "A dentist appointment on Friday, September 25, 2026 at 2:00 PM.",
  runRef: "local-run-91",
  sources: [
    { sourceId: "plan-002", label: "personal-context/demo-chain-1.md" },
    { sourceId: "plan-001", label: "personal-context/demo-chain-1.md" },
  ],
};

const unresolvedConflict: MemoryAnswer = {
  answer:
    "The records disagree on the time. One statement has it at 2:00 PM on Friday, September 25, 2026, while a later statement says you might switch it to a morning slot but weren't sure. Which one holds?",
  runRef: "local-run-93",
  sources: [{ sourceId: "plan-005", label: "personal-context/demo-chain-1.md" }],
};

const inspectionWithHistory: MemoryInspection = {
  userId: "demo-chain-1",
  items: [
    {
      label: "personal-context/demo-chain-1.md",
      description: "Current personal context with its history.",
      content: [
        "## Current",
        "- Dentist appointment: Friday 2026-09-25 at 14:00. (source_id: plan-002)",
        "",
        "## Superseded / cancelled (history)",
        "- [superseded] Dentist appointment: Thursday 2026-09-24 at 09:00. (source_id: plan-001)",
        "- [cancelled] Tuesday evening pottery class. (source_id: plan-001)",
      ].join("\n"),
    },
  ],
};

function testApp(answers: MemoryAnswer[]) {
  const memory = new ScriptedMemoryProvider(answers, inspectionWithHistory);
  return { memory, app: buildApp({ memory }) };
}

async function submitChain(
  app: ReturnType<typeof buildApp>,
  entries: typeof chain,
) {
  for (const entry of entries) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: {
        userId: "demo-chain-1",
        attestation: "uploader_only_identifiable_speaker",
        policyVersion: CONSENT_POLICY_VERSION,
        ...entry,
      },
    });
    assert.equal(response.statusCode, 202);
  }
}

describe("Memory Updates and Semantic Invalidation", () => {
  test("delivers every dated Transcript to one user-scoped agent in order", async () => {
    const { app, memory } = testApp([currentTruth]);
    await submitChain(app, chain);

    assert.deepEqual(
      memory.ingested.map((entry) => entry.sourceId),
      ["plan-001", "plan-002", "plan-003", "plan-004"],
    );
    assert.equal(
      new Set(memory.ingested.map((entry) => entry.userId)).size,
      1,
      "the whole chain belongs to one user-scoped agent",
    );

    // Recorded time survives, and receipt time is recorded separately.
    assert.deepEqual(
      memory.ingested.map((entry) => entry.recordedAt),
      [
        "2026-09-01T01:00:00.000Z",
        "2026-09-08T01:00:00.000Z",
        "2026-09-15T01:00:00.000Z",
        "2026-09-05T01:00:00.000Z",
      ],
    );
    for (const entry of memory.ingested) {
      assert.notEqual(entry.receivedAt, entry.recordedAt);
      assert.ok(Date.parse(entry.receivedAt) > Date.parse(entry.recordedAt));
    }

    // The upload order is not the recorded order, and both stay available.
    const recorded = memory.ingested.map((entry) => Date.parse(entry.recordedAt));
    assert.equal(
      recorded[3]! < recorded[1]!,
      true,
      "the last upload was recorded before the revision",
    );
    await app.close();
  });

  test("answers with Current Truth and does not read stale text back to the browser", async () => {
    const { app } = testApp([currentTruth]);
    await submitChain(app, chain);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      payload: { userId: "demo-chain-1", question: "What is currently on my calendar?" },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.answer, /Friday, September 25/);

    // The superseded and cancelled facts were submitted, but nothing in the
    // response path reintroduces them.
    assert.equal(/Thursday/.test(response.body), false);
    assert.equal(/pottery/i.test(response.body), false);
    assert.equal(/9am|09:00/.test(response.body), false);
    await app.close();
  });

  test("surfaces an unresolved conflict instead of a chosen answer", async () => {
    const { app } = testApp([unresolvedConflict]);
    await submitChain(app, chain);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      payload: { userId: "demo-chain-1", question: "When is my dentist appointment?" },
    });

    const body = response.json();
    assert.match(body.answer, /disagree/);
    assert.match(body.answer, /Which one holds/);
    await app.close();
  });

  test("exposes the history that explains how the answer changed", async () => {
    const { app } = testApp([currentTruth]);
    await submitChain(app, chain);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/users/demo-chain-1/memory",
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /superseded/);
    assert.match(response.body, /cancelled/);
    assert.match(response.body, /plan-001/);
    await app.close();
  });

  test("corrects Memory through another Transcript, with no per-memory controls", async () => {
    const { app } = testApp([currentTruth]);
    const page = await app.inject({ method: "GET", url: "/" });

    // The only way to change Memory is to submit another Transcript.
    assert.equal(/\bedit memory\b|\bapprove\b|\breject memory\b/i.test(page.body), false);
    const routes = app.printRoutes();
    assert.equal(/memory\/:?\w*\/(edit|approve|delete)/.test(routes), false);
    await app.close();
  });
});

describe("Chronology in the agent prompt", () => {
  test("carries recorded time and receipt time as separate fields", () => {
    const prompt = ingestPrompt({
      userId: "demo-chain-1",
      sourceId: "plan-004",
      recordedAt: "2026-09-05T01:00:00.000Z",
      receivedAt: "2026-09-19T16:00:00.000Z",
      transcript: "Confirming the dentist is Thursday the 24th at 9am.",
      attestation: "uploader_only_identifiable_speaker",
      policyVersion: CONSENT_POLICY_VERSION,
      correlationId: "corr-chain-004",
    });

    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    assert.equal(payload.recorded_at, "2026-09-05T01:00:00.000Z");
    assert.equal(payload.received_at, "2026-09-19T16:00:00.000Z");
    assert.notEqual(payload.recorded_at, payload.received_at);
    assert.equal(payload.source_id, "plan-004");

    // The instructions tell the agent which clock decides order.
    assert.match(prompt, /ordering by recorded_at rather than by the order Transcripts arrive/);
    assert.match(prompt, /superseded/);
    assert.match(prompt, /cancels something/);
    assert.match(prompt, /unresolved conflict/);
  });
});
