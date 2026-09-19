import assert from "node:assert/strict";
import { test } from "node:test";
import { LettaMemoryProvider } from "../src/adapters/letta-memory.js";
import {
  CONSENT_POLICY_VERSION,
  type AcceptedTranscript,
} from "../src/domain.js";
import { lettaOptionsFromEnvironment } from "../src/letta-config.js";

const enabled = process.env.RUN_REAL_LETTA === "1";

test(
  "real Letta App Server connects, reuses the user agent, persists, and exposes Memory",
  { skip: enabled ? false : "Set RUN_REAL_LETTA=1 to run the local App Server smoke test." },
  async () => {
    const options = lettaOptionsFromEnvironment(process.env);
    const runId = crypto.randomUUID();
    const userId = `smoke-${runId}`;
    const firstSourceId = `smoke-${runId}-001`;
    const secondSourceId = `smoke-${runId}-002`;

    const transcript = (sourceId: string, text: string): AcceptedTranscript => ({
      userId,
      sourceId,
      recordedAt: "2026-09-19T08:00:00.000Z",
      receivedAt: new Date().toISOString(),
      transcript: text,
      attestation: "uploader_only_identifiable_speaker",
      policyVersion: CONSENT_POLICY_VERSION,
      correlationId: crypto.randomUUID(),
    });

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
