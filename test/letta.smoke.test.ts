import assert from "node:assert/strict";
import { test } from "node:test";
import { LettaMemoryProvider } from "../src/adapters/letta-memory.js";
import {
  CONSENT_POLICY_VERSION,
  type AcceptedTranscript,
} from "../src/domain.js";

const enabled = process.env.RUN_REAL_LETTA === "1";

test(
  "real Letta App Server connects, reuses the user agent, persists, and exposes Memory",
  { skip: enabled ? false : "Set RUN_REAL_LETTA=1 to run the local App Server smoke test." },
  async () => {
    const options = {
      url: process.env.LETTA_APP_SERVER_URL ?? "http://127.0.0.1:4500",
      ...(process.env.LETTA_APP_SERVER_TOKEN
        ? { authToken: process.env.LETTA_APP_SERVER_TOKEN }
        : {}),
      ...(process.env.LETTA_MODEL ? { model: process.env.LETTA_MODEL } : {}),
    };
    const userId = `smoke-${Date.now()}`;

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
        transcript("smoke-001", "For this smoke test, my preferred tea is jasmine."),
      );
    } finally {
      await firstAdapter.close();
    }

    const resumedAdapter = new LettaMemoryProvider(options);
    try {
      const second = await resumedAdapter.ingest(
        transcript("smoke-002", "Keep the jasmine tea preference as current context."),
      );
      assert.equal(
        second.agentRef,
        first.agentRef,
        "a fresh adapter should discover and reuse the persisted user agent",
      );

      const inspection = await resumedAdapter.inspect(userId);
      assert.ok(inspection.items.length > 0, "Letta should expose retained Memory");
    } finally {
      await resumedAdapter.close();
    }
  },
);
