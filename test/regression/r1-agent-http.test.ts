import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { InMemoryConversationStore } from "../../src/adapters/postgres-conversations.js";
import type { CompanyAnswer, CompanyQuestion } from "../../src/company-domain.js";
import type { CompanyAgentCallbacks } from "../../src/soclaas-company-agent.js";
import { buildApp } from "../../src/http-app.js";

function fakeAgent(answer: Partial<CompanyAnswer> = {}) {
  const asked: CompanyQuestion[] = [];
  return {
    asked,
    agent: {
      async answer(input: CompanyQuestion, callbacks?: CompanyAgentCallbacks): Promise<CompanyAnswer> {
        asked.push(input);
        callbacks?.onToken?.("partial");
        callbacks?.onResetTokens?.();
        return {
          answer: `Reply to ${input.question}`,
          sources: [],
          runId: "run",
          toolCalls: [],
          ...answer,
        };
      },
    },
  };
}

function events(body: string) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

describe("handleAgentTurn", () => {
  test("history comes from the store, oldest first, without the current message", async () => {
    const store = new InMemoryConversationStore();
    const { agent, asked } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const first = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "one" } });
    const conversationId = first.json().conversationId;
    await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "two", conversationId } });
    assert.equal(asked[0]!.history, undefined);
    assert.deepEqual(asked[1]!.history, [
      { role: "user", content: "one" },
      { role: "assistant", content: "Reply to one" },
    ]);
    await app.close();
  });

  test("blocks are saved in metadata and sent on the SSE done event", async () => {
    const store = new InMemoryConversationStore();
    const block = { type: "recruiting" as const, view: "pool" as const, roleId: "r1" };
    const { agent } = fakeAgent({ blocks: [block] });
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: { accept: "text/event-stream" },
      payload: { message: "show pool" },
    });
    const list = events(response.body);
    const done = list.find((e) => e.event === "done")!;
    assert.deepEqual(done.data.blocks, [block]);
    assert.deepEqual(list.map((e) => e.event).filter((e) => e === "token" || e === "reset_tokens"), ["token", "reset_tokens"]);
    const saved = await store.get(done.data.conversationId, "jax");
    assert.deepEqual(saved!.messages[1]!.metadata.blocks, [block]);
    await app.close();
  });

  test("a non-string model field is a client error, not a 500", async () => {
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "hi", model: 5 } });
    assert.ok(response.statusCode < 500, `got ${response.statusCode}: ${response.body}`);
    await app.close();
  });

  // On a real listening server both of the next two cases throw ERR_HTTP_HEADERS_SENT from
  // Fastify's error reply as an uncaught exception, which exits the whole Node process.
  // Round 1 found this with `model: 5`, which no longer fails at all (a non-string model now
  // means "no model named", see the next test). The trigger is now another failure that still
  // happens before the agent runs: creating the conversation fails.
  test("a streaming turn that fails before the agent runs still ends with an SSE error event", async () => {
    const store = new InMemoryConversationStore();
    store.create = async () => {
      throw new Error("db down");
    };
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: { accept: "text/event-stream" },
      payload: { message: "hi" },
    });
    assert.ok(
      events(response.body).some((e) => e.event === "error"),
      `status ${response.statusCode}, body ${JSON.stringify(response.body)}`,
    );
    await app.close();
  });

  test("a streaming turn with a non-string model answers with the default model", async () => {
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: { accept: "text/event-stream" },
      payload: { message: "hi", model: 5 },
    });
    const done = events(response.body).find((e) => e.event === "done");
    assert.ok(done, `status ${response.statusCode}, body ${JSON.stringify(response.body)}`);
    await app.close();
  });

  test("a streaming turn whose conversation store fails ends with an SSE error event", async () => {
    const store = new InMemoryConversationStore();
    store.get = async () => {
      throw new Error("db down");
    };
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: { accept: "text/event-stream" },
      payload: { message: "hi", conversationId: "abc" },
    });
    assert.ok(
      events(response.body).some((e) => e.event === "error"),
      `status ${response.statusCode}, body ${JSON.stringify(response.body)}`,
    );
    await app.close();
  });

  test("asking for an unconfigured model does not label the default model's answer with it", async () => {
    const { agent } = fakeAgent();
    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      companyAgent: agent as never,
      companyAgents: { soclaas: agent as never },
    });
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "hi", model: "sonnet" } });
    // Either refuse (503) or answer and say which model really answered.
    if (response.statusCode === 200) assert.equal(response.json().model, "soclaas");
    else assert.equal(response.statusCode, 503);
    await app.close();
  });

  test("a model name that is an Object.prototype key falls back to the default agent", async () => {
    const { agent } = fakeAgent();
    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      companyAgent: agent as never,
      companyAgents: { soclaas: agent as never },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { message: "hi", model: "constructor" },
    });
    assert.equal(response.statusCode, 200, response.body);
    await app.close();
  });
});
