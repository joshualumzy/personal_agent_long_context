import assert from "node:assert/strict";
import { test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { buildApp } from "../src/http-app.js";
import type { CompanyAnswer } from "../src/company-domain.js";

test("unified route scopes Letta context to the requested user and keeps its sources separate", async () => {
  const memory = new DeterministicMemoryProvider();
  const asked: Array<{ employeeId: string; question: string; personalMemory?: string }> = [];
  const companyAgent = {
    async answer(input: { employeeId: string; question: string; personalMemory?: string }): Promise<CompanyAnswer> {
      asked.push(input);
      return {
        answer: "The migration is active. [source:JIRA-42]",
        sources: [{ sourceId: "JIRA-42", sourceType: "jira", title: "Migration", excerpt: "Active." }],
        runId: "company-run",
        toolCalls: [],
      };
    },
  };
  const app = buildApp({
    memory,
    companyAgent: companyAgent as never,
    clock: () => new Date("2026-09-24T00:00:00.000Z"),
    correlationId: () => "unified-test",
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/transcripts",
    payload: {
      userId: "jax",
      sourceId: "note-jax-1",
      recordedAt: "2026-09-23T00:00:00Z",
      transcript: "I am coordinating the migration rollout.",
      attestation: "uploader_only_identifiable_speaker",
      policyVersion: "consent-v1",
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    payload: { userId: "jax", employeeId: "jax", question: "What is the migration status?" },
  });
  assert.equal(response.statusCode, 200);
  assert.match(asked[0]?.personalMemory ?? "", /coordinating the migration rollout/);
  assert.deepEqual(response.json().personalMemory.sources, [
    { sourceId: "note-jax-1", label: "context/note-jax-1" },
  ]);

  const otherUser = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    payload: { userId: "other", employeeId: "jax", question: "What is the migration status?" },
  });
  assert.equal(otherUser.statusCode, 200);
  assert.equal(asked[1]?.personalMemory, undefined);
  await app.close();
});

test("GET /api/v1/models lists configured models and POST /api/v1/agent/questions routes to requested model", async () => {
  const memory = new DeterministicMemoryProvider();
  let soclaasCalled = false;
  let sonnetCalled = false;

  const soclaasAgent = {
    async answer(): Promise<CompanyAnswer> {
      soclaasCalled = true;
      return {
        answer: "Answer from SoCLaaS. [source:SOC-1]",
        sources: [{ sourceId: "SOC-1", sourceType: "slack", title: "Chat", excerpt: "Evidence" }],
        runId: "soclaas-run",
        toolCalls: [],
      };
    },
  };

  const sonnetAgent = {
    async answer(): Promise<CompanyAnswer> {
      sonnetCalled = true;
      return {
        answer: "Answer from Sonnet. [source:SON-1]",
        sources: [{ sourceId: "SON-1", sourceType: "jira", title: "Ticket", excerpt: "Evidence" }],
        runId: "sonnet-run",
        toolCalls: [],
      };
    },
  };

  const app = buildApp({
    memory,
    companyAgent: soclaasAgent as never,
    companyAgents: {
      soclaas: soclaasAgent as never,
      sonnet: sonnetAgent as never,
    },
  });

  const modelsRes = await app.inject({
    method: "GET",
    url: "/api/v1/models",
  });
  assert.equal(modelsRes.statusCode, 200);
  const modelsData = modelsRes.json();
  assert.equal(modelsData.default, "soclaas");
  assert.equal(modelsData.models.length, 2);
  assert.equal(modelsData.models.find((m: any) => m.id === "sonnet")?.available, true);

  // Ask with default (or omitted) model -> routes to soclaas
  const defaultRes = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    payload: { userId: "jax", employeeId: "jax", question: "Hello" },
  });
  assert.equal(defaultRes.statusCode, 200);
  assert.equal(soclaasCalled, true);
  assert.equal(defaultRes.json().model, "soclaas");

  // Ask with explicit sonnet model -> routes to sonnet
  const sonnetRes = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    payload: { userId: "jax", employeeId: "jax", question: "Hello", model: "sonnet" },
  });
  assert.equal(sonnetRes.statusCode, 200);
  assert.equal(sonnetCalled, true);
  assert.equal(sonnetRes.json().model, "sonnet");
  assert.match(sonnetRes.json().answer, /Answer from Sonnet/);

  await app.close();
});
