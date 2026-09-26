import assert from "node:assert/strict";
import { test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { extractWorkingContextFromHumanMd } from "../src/adapters/letta-memory.js";
import { createSessionToken } from "../src/auth.js";
import { buildApp } from "../src/http-app.js";
import { InMemoryConversationStore } from "../src/adapters/postgres-conversations.js";
import type { CompanyAnswer } from "../src/company-domain.js";

const TEST_SECRET = "test-auth-session-secret-key-32chars-min";

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
    sessionConfig: { secret: TEST_SECRET },
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
    headers: { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` },
    payload: { question: "What is the migration status?" },
  });
  assert.equal(response.statusCode, 200);
  assert.match(asked[0]?.personalMemory ?? "", /coordinating the migration rollout/);
  assert.deepEqual(response.json().personalMemory.sources, [
    { sourceId: "note-jax-1", label: "context/note-jax-1" },
  ]);

  const otherUser = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    headers: { cookie: `sme_session=${createSessionToken("other", TEST_SECRET)}` },
    payload: { question: "What is the migration status?" },
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
    sessionConfig: { secret: TEST_SECRET },
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

  const jaxAuthHeader = { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` };

  // Ask with default (or omitted) model -> routes to soclaas
  const defaultRes = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    headers: jaxAuthHeader,
    payload: { question: "Hello" },
  });
  assert.equal(defaultRes.statusCode, 200);
  assert.equal(soclaasCalled, true);
  assert.equal(defaultRes.json().model, "soclaas");

  // Ask with explicit sonnet model -> routes to sonnet
  const sonnetRes = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    headers: jaxAuthHeader,
    payload: { question: "Hello", model: "sonnet" },
  });
  assert.equal(sonnetRes.statusCode, 200);
  assert.equal(sonnetCalled, true);
  assert.equal(sonnetRes.json().model, "sonnet");
  assert.match(sonnetRes.json().answer, /Answer from Sonnet/);

  await app.close();
});

test("extractWorkingContextFromHumanMd parses current working context and sources instantly", () => {
  const sampleHumanMd = `---
description: Personal context
---
## Recorded personal context
### Current
- Identity: user "jax". [jax-note-001]
- Favorite drink: matcha latte. [jax-note-001]

## Working context (SME employee)
### Current
- Role: head engineer on jax's team. [jax, workplace message, 2026-09-25]
- Coordinating TitanDB rollout. [jax, workplace message, 2026-09-25]

### History (superseded / cancelled)
(none)
`;

  const result = extractWorkingContextFromHumanMd(sampleHumanMd);
  assert.ok(result);
  assert.match(result.contextConsidered, /head engineer on jax's team/);
  assert.match(result.contextConsidered, /Coordinating TitanDB rollout/);
  assert.deepEqual(result.sources, [
    { sourceId: "jax-note-001", label: "system/human.md" },
    { sourceId: "jax", label: "system/human.md" },
  ]);
});

test("unified route uses getWorkingContextFast when provider supports it and triggers async update", async () => {
  let fastCalled = false;
  let updateCalled = false;
  const memory = {
    async getWorkingContextFast(userId: string) {
      fastCalled = true;
      return {
        contextConsidered: "Fast context for " + userId,
        memoryUpdated: false,
        sources: [{ sourceId: "fast-src-1", label: "system/human.md" }],
      };
    },
    async processWorkingContext() {
      updateCalled = true;
      return { contextConsidered: "", memoryUpdated: false, sources: [] };
    },
    async ask() {
      return { answer: "fallback", runRef: "ref", sources: [] };
    },
    async inspect() {
      return { userId: "jax", items: [] };
    },
    async ingest() {
      return { agentRef: "agent" };
    },
  };

  let receivedPersonalMemory = "";
  const companyAgent = {
    async answer(input: any) {
      receivedPersonalMemory = input.personalMemory ?? "";
      return {
        answer: "Company answer [source:S1]",
        sources: [{ sourceId: "S1", sourceType: "jira", title: "T", excerpt: "E" }],
        runId: "run-1",
        toolCalls: [],
      };
    },
  };

  const app = buildApp({
    sessionConfig: { secret: TEST_SECRET },
    memory: memory as never,
    companyAgent: companyAgent as never,
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    headers: { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` },
    payload: { question: "Who leads infra?" },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(fastCalled, true);
  assert.equal(receivedPersonalMemory, "Fast context for jax");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(updateCalled, true);
  await app.close();
});

test("unified route passes conversation history to processWorkingContext", async () => {
  let capturedInput: {
    userId: string;
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  } | undefined;

  const memory = {
    async processWorkingContext(input: {
      userId: string;
      message: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    }) {
      capturedInput = input;
      return { contextConsidered: "Working on infra", memoryUpdated: false, sources: [] };
    },
    async ask() {
      return { answer: "fallback", runRef: "ref", sources: [] };
    },
    async inspect() {
      return { userId: "jax", items: [] };
    },
    async ingest() {
      return { agentRef: "agent" };
    },
  };

  const companyAgent = {
    async answer() {
      return {
        answer: "I recommend classifying TitanDB migration as P0. [source:S1]",
        sources: [{ sourceId: "S1", sourceType: "jira" as const, title: "T", excerpt: "E" }],
        runId: "run-1",
        toolCalls: [],
      };
    },
  };

  const conversationStore = new InMemoryConversationStore();
  const app = buildApp({
    sessionConfig: { secret: TEST_SECRET },
    memory: memory as never,
    companyAgent: companyAgent as never,
    conversationStore,
  });

  // Turn 1
  const res1 = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    headers: { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` },
    payload: { question: "What priority should TitanDB have?" },
  });
  assert.equal(res1.statusCode, 200);
  const conversationId = res1.json().conversationId;
  assert.ok(conversationId);
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Turn 2: User agrees / confirms
  const res2 = await app.inject({
    method: "POST",
    url: "/api/v1/agent/questions",
    headers: { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` },
    payload: { question: "ok that sounds good", conversationId },
  });
  for (let i = 0; i < 30 && (!capturedInput?.history || capturedInput.history.length === 0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.ok(capturedInput);
  assert.equal(capturedInput.userId, "jax");
  assert.equal(capturedInput.message, "ok that sounds good");
  assert.ok(capturedInput.history && capturedInput.history.length > 0);
  assert.equal(capturedInput.history[0]?.role, "user");
  assert.equal(capturedInput.history[0]?.content, "What priority should TitanDB have?");
  assert.equal(capturedInput.history[1]?.role, "assistant");
  assert.match(capturedInput.history[1]?.content ?? "", /TitanDB/);

  await app.close();
});
