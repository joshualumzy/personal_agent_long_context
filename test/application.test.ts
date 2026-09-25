import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import type { ApplicationFailure } from "../src/application.js";
import { CONSENT_POLICY_VERSION } from "../src/domain.js";
import { buildApp } from "../src/http-app.js";

const fixedReceipt = new Date("2026-09-19T04:05:06.000Z");

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    userId: "demo-user",
    sourceId: "voice-note-001",
    recordedAt: "2026-09-18T13:45:00+08:00",
    transcript: "I prefer planning the week on Sunday evening.",
    attestation: "uploader_only_identifiable_speaker",
    policyVersion: CONSENT_POLICY_VERSION,
    ...overrides,
  };
}

function testApp(memory = new DeterministicMemoryProvider()) {
  const failures: ApplicationFailure[] = [];
  return {
    memory,
    failures,
    app: buildApp({
      memory,
      clock: () => fixedReceipt,
      correlationId: () => "corr-test-001",
      onFailure: (failure) => failures.push(failure),
    }),
  };
}

describe("Transcript submission application interface", () => {
  test("rejects missing and invalid attestations before Memory receives content", async () => {
    const { app, memory } = testApp();

    for (const attestation of [undefined, "unknown_speakers", ""]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/transcripts",
        payload: validSubmission({ attestation }),
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "invalid_attestation");
    }

    assert.equal(memory.ingested.length, 0);
    await app.close();
  });

  test("accepts each of the two Consent Attestations and preserves request metadata", async () => {
    const { app, memory } = testApp();
    const attestations = [
      "uploader_only_identifiable_speaker",
      "all_identifiable_speakers_agreed",
    ];

    for (const [index, attestation] of attestations.entries()) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/transcripts",
        payload: validSubmission({ sourceId: `voice-note-00${index + 1}`, attestation }),
      });
      assert.equal(response.statusCode, 202);
      assert.deepEqual(response.json(), {
        status: "accepted",
        correlationId: "corr-test-001",
        receivedAt: fixedReceipt.toISOString(),
      });
    }

    assert.equal(memory.ingested.length, 2);
    assert.deepEqual(
      {
        userId: memory.ingested[0]?.userId,
        sourceId: memory.ingested[0]?.sourceId,
        recordedAt: memory.ingested[0]?.recordedAt,
        receivedAt: memory.ingested[0]?.receivedAt,
        policyVersion: memory.ingested[0]?.policyVersion,
      },
      {
        userId: "demo-user",
        sourceId: "voice-note-001",
        recordedAt: "2026-09-18T05:45:00.000Z",
        receivedAt: "2026-09-19T04:05:06.000Z",
        policyVersion: CONSENT_POLICY_VERSION,
      },
    );
    await app.close();
  });

  test("retains accepted content across a later request and keeps users scoped", async () => {
    const { app } = testApp();

    await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission(),
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission({
        sourceId: "voice-note-002",
        transcript: "I now plan the week on Saturday morning.",
      }),
    });

    const ownMemory = await app.inject({
      method: "GET",
      url: "/api/v1/users/demo-user/memory",
    });
    assert.equal(ownMemory.statusCode, 200);
    assert.equal(ownMemory.json().items.length, 2);
    assert.match(ownMemory.body, /Sunday evening/);
    assert.match(ownMemory.body, /Saturday morning/);

    const otherMemory = await app.inject({
      method: "GET",
      url: "/api/v1/users/other-user/memory",
    });
    assert.deepEqual(otherMemory.json(), { userId: "other-user", items: [] });
    await app.close();
  });

  test("rejects Prohibited Data without echoing or forwarding the value", async () => {
    const { app, memory } = testApp();
    const secret = "secret-value-12345";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission({ transcript: `My api key is: ${secret}` }),
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, "prohibited_data");
    assert.equal(response.body.includes(secret), false);
    assert.equal(memory.ingested.length, 0);
    await app.close();
  });

  test("returns a safe rejection when the Memory provider fails", async () => {
    const memory = new DeterministicMemoryProvider();
    memory.ingest = async () => {
      throw new Error("provider token sk-live-never-expose");
    };
    const { app } = testApp(memory);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission(),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "memory_service_unavailable");
    assert.equal(response.body.includes("sk-live-never-expose"), false);
    await app.close();
  });
});

describe("Failure reporting", () => {
  test("records the failure reason for the server log without returning it", async () => {
    for (const operation of ["submit", "ask"] as const) {
      const memory = new DeterministicMemoryProvider();
      const failing = async () => {
        throw new Error("letta app server token sk-live-never-expose");
      };
      if (operation === "submit") memory.ingest = failing;
      else memory.ask = failing;

      const { app, failures } = testApp(memory);
      const response = await app.inject({
        method: "POST",
        url: operation === "submit" ? "/api/v1/transcripts" : "/api/v1/questions",
        payload:
          operation === "submit"
            ? validSubmission()
            : { userId: "demo-user", question: "When do I plan my week?" },
      });

      assert.equal(response.statusCode, 503);
      assert.equal(response.body.includes("sk-live-never-expose"), false);
      assert.deepEqual(failures, [
        {
          operation,
          correlationId: "corr-test-001",
          userId: "demo-user",
          reason: "letta app server token sk-live-never-expose",
        },
      ]);
      await app.close();
    }
  });

  test("keeps Transcript and question text out of the failure record", async () => {
    const memory = new DeterministicMemoryProvider();
    memory.ingest = async () => {
      throw new Error("provider unavailable");
    };
    const { app, failures } = testApp(memory);

    await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission({ transcript: "A private detail about Sunday." }),
    });

    assert.equal(failures.length, 1);
    assert.equal(
      JSON.stringify(failures[0]).includes("A private detail about Sunday."),
      false,
    );
    await app.close();
  });
});

describe("Browser surface", () => {
  test("serves the workplace assistant interface at root", async () => {
    const { app } = testApp();
    const response = await app.inject({ method: "GET", url: "/" });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /SME Assistant/);
    assert.match(response.body, /id="chat-form"/);
    assert.match(response.body, /id="message-input"/);
    await app.close();
  });

  test("offers an agent chat interface that reaches the unified adapter", async () => {
    const { app } = testApp();

    const [html, script] = await Promise.all([
      app.inject({ method: "GET", url: "/" }),
      app.inject({ method: "GET", url: "/app.js" }),
    ]);

    assert.match(html.body, /id="chat-form"/);
    assert.match(html.body, /id="message-input"/);
    assert.match(script.body, /fetch\("\/api\/v1\/agent\/chat"/);
    assert.equal(/\b(?:https?|wss?):\/\//.test(script.body), false);
    assert.equal(script.body.includes("4500"), false);
    await app.close();
  });

  test("does not deliver server credentials in browser assets", async () => {
    const previousToken = process.env.LETTA_APP_SERVER_TOKEN;
    process.env.LETTA_APP_SERVER_TOKEN = "server-only-token-for-test";
    const { app } = testApp();

    const [html, script] = await Promise.all([
      app.inject({ method: "GET", url: "/" }),
      app.inject({ method: "GET", url: "/app.js" }),
    ]);
    assert.equal(`${html.body}${script.body}`.includes("server-only-token-for-test"), false);

    if (previousToken === undefined) delete process.env.LETTA_APP_SERVER_TOKEN;
    else process.env.LETTA_APP_SERVER_TOKEN = previousToken;
    await app.close();
  });
});

describe("Question application interface", () => {
  test("answers from the asking user's retained Memory and cites its sources", async () => {
    const { app } = testApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      payload: { userId: "demo-user", question: "When do I plan my week?" },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, "answered");
    assert.equal(body.correlationId, "corr-test-001");
    assert.equal(body.receivedAt, fixedReceipt.toISOString());
    assert.match(body.answer, /Sunday evening/);
    assert.equal(typeof body.runRef, "string");
    assert.ok(body.runRef.length > 0);
    assert.deepEqual(
      body.sources.map((source: { sourceId?: string }) => source.sourceId),
      ["voice-note-001"],
    );
    await app.close();
  });

  test("keeps one user's Memory out of another user's answer", async () => {
    const { app } = testApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/transcripts",
      payload: validSubmission(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      payload: { userId: "other-user", question: "When do I plan my week?" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes("Sunday evening"), false);
    assert.deepEqual(response.json().sources, []);
    await app.close();
  });

  test("answers without sources when no Memory is retained yet", async () => {
    const { app } = testApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      payload: { userId: "demo-user", question: "When do I plan my week?" },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, "answered");
    assert.deepEqual(body.sources, []);
    assert.match(body.answer, /No Memory is retained/);
    await app.close();
  });

  test("rejects a question that carries no text", async () => {
    const { app } = testApp();

    for (const payload of [
      { userId: "demo-user" },
      { userId: "demo-user", question: "   " },
      { userId: "demo user", question: "When do I plan my week?" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/questions",
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "invalid_request");
    }
    await app.close();
  });

  test("returns a safe rejection when the Memory provider cannot answer", async () => {
    const memory = new DeterministicMemoryProvider();
    memory.ask = async () => {
      throw new Error("letta app server token sk-live-never-expose");
    };
    const { app } = testApp(memory);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/questions",
      payload: { userId: "demo-user", question: "When do I plan my week?" },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "memory_service_unavailable");
    assert.equal(response.body.includes("sk-live-never-expose"), false);
    assert.equal(response.json().correlationId, "corr-test-001");
    await app.close();
  });
});
