import assert from "node:assert/strict";
import { test } from "node:test";
import { LettaMemoryProvider } from "../src/adapters/letta-memory.js";
import {
  CONSENT_POLICY_VERSION,
  type AcceptedTranscript,
} from "../src/domain.js";
import { lettaOptionsFromEnvironment } from "../src/letta-config.js";

const enabled = process.env.RUN_REAL_LETTA === "1";
const skip = enabled
  ? false
  : "Set RUN_REAL_LETTA=1 to run the local App Server smoke test.";

function transcriptFor(
  userId: string,
  sourceId: string,
  text: string,
): AcceptedTranscript {
  return {
    userId,
    sourceId,
    recordedAt: "2026-09-19T08:00:00.000Z",
    receivedAt: new Date().toISOString(),
    transcript: text,
    attestation: "uploader_only_identifiable_speaker",
    policyVersion: CONSENT_POLICY_VERSION,
    correlationId: crypto.randomUUID(),
  };
}

test(
  "real Letta App Server connects, reuses the user agent, persists, and exposes Memory",
  { skip },
  async () => {
    const options = lettaOptionsFromEnvironment(process.env);
    const runId = crypto.randomUUID();
    const userId = `smoke-${runId}`;
    const firstSourceId = `smoke-${runId}-001`;
    const secondSourceId = `smoke-${runId}-002`;

    const transcript = (sourceId: string, text: string) =>
      transcriptFor(userId, sourceId, text);

    const firstAdapter = new LettaMemoryProvider(options);
    let first: Awaited<ReturnType<LettaMemoryProvider["ingest"]>>;
    try {
      first = await firstAdapter.ingest(
        transcript(firstSourceId, "For this smoke test, my preferred tea is jasmine."),
      );
    } finally {
      await firstAdapter.close();
    }

    const resumedAdapter = new LettaMemoryProvider(options);
    try {
      const second = await resumedAdapter.ingest(
        transcript(secondSourceId, "Keep the jasmine tea preference as current context."),
      );
      assert.equal(
        second.agentRef,
        first.agentRef,
        "a fresh adapter should discover and reuse the persisted user agent",
      );

      const inspection = await resumedAdapter.inspect(userId);
      const exposedMemory = inspection.items.map((item) => item.content).join("\n");
      assert.ok(
        exposedMemory.includes(firstSourceId),
        "Letta should expose the first persisted Transcript source",
      );
      assert.ok(
        exposedMemory.includes(secondSourceId),
        "Letta should expose the second persisted Transcript source",
      );
    } finally {
      await resumedAdapter.close();
    }
  },
);

test(
  "real Letta answers a later question from the Memory it retained",
  { skip },
  async () => {
    const options = lettaOptionsFromEnvironment(process.env);
    const runId = crypto.randomUUID();
    const userId = `smoke-ask-${runId}`;

    const ingestAdapter = new LettaMemoryProvider(options);
    try {
      await ingestAdapter.ingest(
        transcriptFor(
          userId,
          `smoke-ask-${runId}-001`,
          "For this smoke test, my dentist appointment is on Thursday at nine in the morning.",
        ),
      );
    } finally {
      await ingestAdapter.close();
    }

    const askAdapter = new LettaMemoryProvider(options);
    try {
      const answer = await askAdapter.ask({
        userId,
        question: "When is my dentist appointment?",
        correlationId: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
      });

      assert.match(
        answer.answer,
        /thursday/i,
        "a fresh adapter should answer from the persisted Memory",
      );
      assert.ok(
        answer.runRef && answer.runRef.length > 0,
        "an answered question should carry the Letta run reference",
      );

      const otherUser = await askAdapter.ask({
        userId: `${userId}-other`,
        question: "When is my dentist appointment?",
        correlationId: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
      });

      assert.deepEqual(
        otherUser.sources,
        [],
        "another user must not receive this user's Memory",
      );
      assert.doesNotMatch(otherUser.answer, /thursday/i);
    } finally {
      await askAdapter.close();
    }
  },
);

/** Submits a Transcript straight to the adapter, as the application would. */
async function ingest(
  adapter: LettaMemoryProvider,
  userId: string,
  sourceId: string,
  recordedAt: string,
  text: string,
) {
  await adapter.ingest({
    userId,
    sourceId,
    recordedAt,
    receivedAt: new Date().toISOString(),
    transcript: text,
    attestation: "uploader_only_identifiable_speaker",
    policyVersion: CONSENT_POLICY_VERSION,
    correlationId: crypto.randomUUID(),
  });
}

async function ask(adapter: LettaMemoryProvider, userId: string, question: string) {
  return adapter.ask({
    userId,
    question,
    correlationId: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
  });
}

test(
  "real Letta applies a Memory Update and a Semantic Invalidation",
  { skip },
  async () => {
    const options = lettaOptionsFromEnvironment(process.env);
    const userId = `smoke-update-${crypto.randomUUID()}`;
    const adapter = new LettaMemoryProvider(options);

    try {
      await ingest(
        adapter,
        userId,
        "plan-001",
        "2026-09-01T01:00:00.000Z",
        "I booked the dentist for Thursday the 24th at 9am, and I signed up for the Tuesday evening pottery class.",
      );
      await ingest(
        adapter,
        userId,
        "plan-002",
        "2026-09-08T01:00:00.000Z",
        "Quick update. I moved the dentist appointment to Friday the 25th at 2pm.",
      );
      await ingest(
        adapter,
        userId,
        "plan-003",
        "2026-09-15T01:00:00.000Z",
        "I cancelled the pottery class, I am not going to continue with it.",
      );

      const answer = await ask(adapter, userId, "What is currently on my calendar?");

      // Current Truth is present.
      assert.match(
        answer.answer,
        /Friday/i,
        `the revised day should be current: ${answer.answer}`,
      );
      assert.match(
        answer.answer,
        /25/,
        `the revised date should be current: ${answer.answer}`,
      );

      // A superseded or cancelled fact may be named, but only as history.
      // Naming it without that framing is presenting it as current.
      if (/Thursday/i.test(answer.answer)) {
        assert.match(
          answer.answer,
          /Thursday[\s\S]{0,120}(moved|resched|changed|no longer|superseded|previous|was)|(moved|resched|changed|no longer|superseded|previously|originally)[\s\S]{0,120}Thursday/i,
          `the superseded day was presented as current: ${answer.answer}`,
        );
      }
      if (/pottery/i.test(answer.answer)) {
        assert.match(
          answer.answer,
          /pottery[\s\S]{0,120}(cancel|no longer|dropped|not continuing|removed)|(cancel\w*|no longer|dropped)[\s\S]{0,120}pottery/i,
          `the cancelled commitment was presented as current: ${answer.answer}`,
        );
      }

      // Inspection still explains how the answer got there.
      const inspection = await adapter.inspect(userId);
      const memory = inspection.items.map((item) => item.content).join("\n");
      assert.match(memory, /supersed|cancel/i, "history should remain inspectable");
      assert.match(memory, /plan-001/, "the original source should remain inspectable");
    } finally {
      await adapter.close();
    }
  },
);

test(
  "real Letta keeps a late older Transcript from overwriting a newer decision",
  { skip },
  async () => {
    const options = lettaOptionsFromEnvironment(process.env);
    const userId = `smoke-chronology-${crypto.randomUUID()}`;
    const adapter = new LettaMemoryProvider(options);

    try {
      await ingest(
        adapter,
        userId,
        "plan-001",
        "2026-09-01T01:00:00.000Z",
        "I booked the dentist for Thursday the 24th at 9am.",
      );
      await ingest(
        adapter,
        userId,
        "plan-002",
        "2026-09-08T01:00:00.000Z",
        "Quick update. I moved the dentist appointment to Friday the 25th at 2pm.",
      );
      // Uploaded now, but recorded before the revision above.
      await ingest(
        adapter,
        userId,
        "plan-004",
        "2026-09-05T01:00:00.000Z",
        "Confirming the dentist is Thursday the 24th at 9am.",
      );

      const afterLateUpload = await ask(
        adapter,
        userId,
        "When is my dentist appointment?",
      );
      assert.match(
        afterLateUpload.answer,
        /Friday/i,
        "a late older Transcript must not silently become Current Truth",
      );

      await ingest(
        adapter,
        userId,
        "plan-005",
        "2026-09-18T01:00:00.000Z",
        "I might switch the dentist to a morning slot, I am not sure yet.",
      );

      const afterHedge = await ask(adapter, userId, "When is my dentist appointment?");
      assert.match(
        afterHedge.answer,
        /disagree|unsure|not sure|uncertain|conflict|which|clarify|confirm/i,
        "a hedged contradiction should ask rather than choose",
      );
    } finally {
      await adapter.close();
    }
  },
);
