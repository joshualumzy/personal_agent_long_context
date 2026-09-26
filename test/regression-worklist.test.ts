import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../src/adapters/deterministic-memory.js";
import { InMemoryConversationStore } from "../src/adapters/postgres-conversations.js";
import { buildApp } from "../src/http-app.js";
import { createSessionToken } from "../src/auth.js";
import type { CompanyKnowledge } from "../src/company-domain.js";

describe("Phase 0 — Regression Worklist", () => {
  // 1. Unauthenticated requests
  test(
    "Unauthenticated requests to chat, synchronous agent, conversations, and memory inspection are denied",
    async () => {
      const app = buildApp({
        memory: new DeterministicMemoryProvider(),
        conversationStore: new InMemoryConversationStore(),
        requireAuth: true,
      });

      // 1. Unauthenticated chat
      const chatRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent/chat",
        payload: { message: "What is Project Titan?" },
      });
      assert.equal(chatRes.statusCode, 401, "POST /api/v1/agent/chat must return 401 without auth");

      // 2. Unauthenticated synchronous agent
      const qRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent/questions",
        payload: { question: "What is Project Titan?" },
      });
      assert.equal(qRes.statusCode, 401, "POST /api/v1/agent/questions must return 401 without auth");

      // 3. Unauthenticated conversations list
      const convRes = await app.inject({
        method: "GET",
        url: "/api/v1/conversations",
      });
      assert.equal(convRes.statusCode, 401, "GET /api/v1/conversations must return 401 without auth");

      // 4. Unauthenticated memory inspection
      const memRes = await app.inject({
        method: "GET",
        url: "/api/v1/me/memory",
      });
      assert.equal(memRes.statusCode, 401, "GET /api/v1/me/memory must return 401 without auth");

      await app.close();
    },
  );

  // 2. Cross-user spoofing prevention
  test(
    "A Priya session attempting to send userId: 'jax' is rejected or bound strictly to Priya",
    async () => {
      const app = buildApp({
        memory: new DeterministicMemoryProvider(),
        conversationStore: new InMemoryConversationStore(),
        requireAuth: true,
      });

      const priyaToken = createSessionToken("priya");
      const cookie = `sme_session=${priyaToken}`;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent/chat",
        headers: { cookie },
        payload: {
          userId: "jax",
          message: "What is my current project?",
        },
      });

      // Either reject the request (400) or strictly scope turn to Priya
      if (res.statusCode === 200) {
        const json = res.json();
        assert.notEqual(json.userId, "jax", "Must not use spoofed userId from body");
      } else {
        assert.equal(res.statusCode, 400, "Should reject cross-user spoofed userId in body");
      }

      await app.close();
    },
  );

  // 3. Login with no password
  test(
    "Login with no password or empty password is explicitly rejected",
    async () => {
      const app = buildApp({
        memory: new DeterministicMemoryProvider(),
      });

      // Missing password
      const resMissing = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { employeeId: "priya" },
      });
      assert.ok(
        resMissing.statusCode === 400 || resMissing.statusCode === 401,
        "Login with missing password must return 400 or 401",
      );

      // Empty password
      const resEmpty = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { employeeId: "priya", password: "" },
      });
      assert.ok(
        resEmpty.statusCode === 400 || resEmpty.statusCode === 401,
        "Login with empty password must return 400 or 401",
      );

      await app.close();
    },
  );

  // 4. Missing or malformed session secret
  test(
    "Missing or malformed session secret fails closed at initialization",
    async () => {
      const authModule = (await import("../src/auth.js").catch(() => null)) as unknown as {
        validateAuthConfig?: (config: Record<string, string | undefined>) => void;
      };
      const validateAuthConfig = authModule?.validateAuthConfig;

      if (validateAuthConfig) {
        assert.throws(
          () => validateAuthConfig({ SESSION_SECRET: "short" }),
          /session secret/i,
          "Should throw on secret shorter than required length",
        );
      } else {
        assert.fail("validateAuthConfig must exist");
      }
    },
  );

  // 5. Requested Sonnet when only SoCLaaS is configured
  test(
    "Requested Sonnet when only SoCLaaS is configured returns 503 model_unavailable",
    async () => {
      const { createSessionToken } = await import("../src/auth.js");
      const TEST_SECRET = "test-auth-session-secret-key-32chars-min";
      const app = buildApp({
        sessionConfig: { secret: TEST_SECRET },
        memory: new DeterministicMemoryProvider(),
        companyAgents: {}, // No Sonnet agent configured
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent/questions",
        headers: { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` },
        payload: {
          employeeId: "jax",
          question: "What is Project Titan?",
          model: "claude-3-5-sonnet",
        },
      });

      assert.equal(res.statusCode, 503, "Unavailable model must return 503");
      const json = res.json();
      assert.equal(json.error, "model_unavailable", "Must return typed model_unavailable error");

      // Also verify unknown model returns 400
      const unknownRes = await app.inject({
        method: "POST",
        url: "/api/v1/agent/questions",
        headers: { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` },
        payload: {
          question: "What is Project Titan?",
          model: "gpt-nonexistent-model",
        },
      });
      assert.equal(unknownRes.statusCode, 400, "Unknown model must return 400");
      assert.equal(unknownRes.json().error, "unknown_model");

      await app.close();
    },
  );

  // 6. Provider 500 versus genuine evidence absence
  test(
    "Provider 500 returns typed provider_unavailable error instead of Insufficient Evidence",
    async () => {
      const { createSessionToken } = await import("../src/auth.js");
      const TEST_SECRET = "test-auth-session-secret-key-32chars-min";
      const failingAgent = {
        async answer() {
          const err = new Error("Gateway 500 Internal Server Error");
          (err as unknown as { statusCode: number }).statusCode = 500;
          throw err;
        },
      };

      const app = buildApp({
        sessionConfig: { secret: TEST_SECRET },
        memory: new DeterministicMemoryProvider(),
        companyAgent: failingAgent as never,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent/questions",
        headers: { cookie: `sme_session=${createSessionToken("jax", TEST_SECRET)}` },
        payload: {
          employeeId: "jax",
          question: "What is Project Titan?",
        },
      });

      assert.equal(res.statusCode, 503, "Provider 500 must return 503");
      const json = res.json();
      assert.equal(json.error, "provider_unavailable");
      assert.doesNotMatch(json.message, /insufficient evidence/i);

      await app.close();
    },
  );

  // 7. SSE frames split between event: and data:
  test(
    "SSE frames split between event: and data: chunks are reassembled without loss",
    async () => {
      // Simulate parser logic that handles split chunks
      const chunks = [
        "event: status\nda",
        "ta: {\"status\":\"Investigating additional evidence...\"}\n\n",
        "event: answer\ndata: {\"text\":\"TitanDB rollout",
        " is Tuesday [source:PR-143].\"}\n\n",
        "event: done\ndata: {}\n\n",
      ];

      type SSEEvent = { event: string; data: unknown };
      const parsed: SSEEvent[] = [];

      let buffer = "";
      for (const chunk of chunks) {
        buffer += chunk;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const lines = frame.split("\n");
          let event = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
          }
          if (dataStr) {
            parsed.push({ event, data: JSON.parse(dataStr) });
          }
        }
      }

      assert.equal(parsed.length, 3);
      assert.equal(parsed[0].event, "status");
      assert.equal(parsed[1].event, "answer");
      assert.equal(parsed[2].event, "done");
    },
  );

  // 8. Invalid streamed output followed by a safe final result
  test(
    "Invalid/uncited intermediate output is not exposed before validation gate completes",
    async () => {
      const knowledge: CompanyKnowledge = {
        async employee() {
          return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
        },
        async search() {
          return [
            {
              sourceId: "JIRA-42",
              sourceType: "jira",
              title: "Project update",
              excerpt: "The project is active.",
              occurredAt: "2026-09-23T00:00:00.000Z",
            },
          ];
        },
        async related() {
          return [];
        },
        async sources() {
          return [];
        },
      };

      const responses = [
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "search_company_knowledge",
                      arguments: JSON.stringify({ query: "project", limit: 1 }),
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              message: { content: "The project is active and launching Friday without citations." },
            },
          ],
        },
        {
          choices: [
            {
              message: { content: "Insufficient evidence." },
            },
          ],
        },
      ];

      const { GatewayCompanyAgent } = await import("../src/soclaas-company-agent.js");
      const emittedTokens: string[] = [];

      let callCount = 0;
      const agent = new GatewayCompanyAgent(knowledge, {
        apiKey: "test-key",
        fetch: async (_url, init) => {
          callCount++;
          const body = JSON.parse(String(init?.body));
          if (callCount === 1) {
            // Tool call
            return new Response(JSON.stringify(responses[0]), { status: 200 });
          }
          if (body.stream) {
            // Streaming draft answer
            const sseBody = `data: {"choices":[{"delta":{"content":"Unvalidated hallucinated draft"}}]}\n\ndata: [DONE]\n\n`;
            return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
          }
          return new Response(JSON.stringify(responses[2]), { status: 200 });
        },
      });

      const result = await agent.answer(
        { employeeId: "jax", question: "When is the project?" },
        {
          onToken: (token) => emittedTokens.push(token),
          onResetTokens: () => (emittedTokens.length = 0),
        },
      );

      assert.equal(emittedTokens.length, 0, "No draft tokens may remain exposed when validation fails");
      assert.equal(
        result.answer,
        "Insufficient Evidence: I could not find retrieved Company Evidence that supports a reliable answer to this question.",
      );
    },
  );

  // 9. Pronoun-dependent second conversation turn
  test(
    "Pronoun-dependent second conversation turn resolves antecedent using loaded history",
    async () => {
      const store = new InMemoryConversationStore();
      const conv = await store.create("jax", "Project Titan");
      await store.appendMessage({
        conversationId: conv.conversationId,
        role: "user",
        content: "What is Project Titan?",
      });
      await store.appendMessage({
        conversationId: conv.conversationId,
        role: "assistant",
        content: "Project Titan is our new distributed storage engine led by Marcus.",
      });

      let capturedHistory: Array<{ role: string; content: string }> = [];
      const historyAwareAgent = {
        async answer(input: { question: string; history?: Array<{ role: string; content: string }>; conversationHistory?: Array<{ role: string; content: string }> }) {
          capturedHistory = input.history ?? input.conversationHistory ?? [];
          return {
            answer: "Marcus leads it [source:CONF-ENG-239].",
            sources: [{ sourceId: "CONF-ENG-239", sourceType: "confluence", title: "Titan", excerpt: "" }],
            runId: "turn-2",
            toolCalls: [],
          };
        },
      };

      const app = buildApp({
        memory: new DeterministicMemoryProvider(),
        companyAgent: historyAwareAgent as never,
        conversationStore: store,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/agent/chat",
        headers: {
          cookie: `sme_session=${createSessionToken("jax")}`,
        },
        payload: {
          conversationId: conv.conversationId,
          message: "Who leads it?",
        },
      });

      assert.equal(res.statusCode, 200);
      assert.ok(capturedHistory.length >= 2, "Must pass previous conversation turns to model");
      assert.equal(capturedHistory[0].content, "What is Project Titan?");

      await app.close();
    },
  );

  // 10. Fast-memory empty, unavailable, malformed, and successful states
  test(
    "Personal Memory provider returns discriminated results (available, empty, unavailable)",
    async () => {
      const memory = new DeterministicMemoryProvider();
      // Initially empty
      const resEmpty = await (memory as unknown as { getContext(id: string): Promise<{ status: string }> }).getContext("priya");
      assert.equal(resEmpty.status, "empty");

      await memory.ingest({
        userId: "priya",
        sourceId: "TRANS-1",
        recordedAt: "2026-09-24T00:00:00Z",
        transcript: "Working on mobile payments.",
        attestation: "uploader_only_identifiable_speaker",
        policyVersion: "consent-v1",
        correlationId: "c-1",
        receivedAt: "2026-09-24T00:01:00Z",
      });

      const resAvail = await (memory as unknown as { getContext(id: string): Promise<{ status: string }> }).getContext("priya");
      assert.equal(resAvail.status, "available");
    },
  );

  // 11. Two rapid memory updates for the same employee
  test(
    "Two rapid memory updates for the same employee are serialized and do not race",
    async () => {
      const order: number[] = [];
      const createUpdateJob = (id: number, delayMs: number) => async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(id);
      };

      const { MemoryUpdateQueue } = await import("../src/memory-queue.js");
      const queue = new MemoryUpdateQueue();

      const p1 = queue.enqueue("priya", createUpdateJob(1, 30));
      const p2 = queue.enqueue("priya", createUpdateJob(2, 5));

      await Promise.all([p1, p2]);
      assert.deepEqual(order, [1, 2], "Updates must execute in order of arrival");
    },
  );

  // 12. Migration execution twice after changing a password/profile field
  test(
    "Re-running migrations does not overwrite manually updated employee passwords or roles",
    async () => {
      const { readFile } = await import("node:fs/promises");
      const sql = await readFile("database/migrations/005_employee_auth.sql", "utf-8");

      // Ensure migration 005 does not unconditionally overwrite password_hash with EXCLUDED.password_hash
      assert.doesNotMatch(
        sql,
        /password_hash\s*=\s*EXCLUDED\.password_hash/i,
        "Migration must not unconditionally overwrite existing employee password_hash",
      );
      // Ensure migration 005 does not unconditionally overwrite role with EXCLUDED.role
      assert.doesNotMatch(
        sql,
        /role\s*=\s*EXCLUDED\.role/i,
        "Migration must not unconditionally overwrite existing employee role",
      );
    },
  );
});
