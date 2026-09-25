// Round 2 hunt: the chat handler in src/http-app.ts. "BUG" tests fail today; "NOT A BUG" tests pass.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { InMemoryConversationStore } from "../../src/adapters/postgres-conversations.js";
import type { CompanyAnswer, CompanyQuestion } from "../../src/company-domain.js";
import type { CompanyAgentCallbacks } from "../../src/soclaas-company-agent.js";
import { buildApp } from "../../src/http-app.js";

function fakeAgent(answer: Partial<CompanyAnswer> = {}, beforeReturn?: () => Promise<void>) {
  const asked: CompanyQuestion[] = [];
  return {
    asked,
    agent: {
      async answer(input: CompanyQuestion, callbacks?: CompanyAgentCallbacks): Promise<CompanyAnswer> {
        asked.push(input);
        callbacks?.onToken?.("The answer");
        await beforeReturn?.();
        return { answer: `Reply to ${input.question}`, sources: [], runId: "run", toolCalls: [], ...answer };
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

describe("BUG: saving the assistant message fails after the answer was produced", () => {
  test("non-stream: the user gets 502 'please try again' although the agent answered (and its tools already acted)", async () => {
    const store = new InMemoryConversationStore();
    const original = store.appendMessage.bind(store);
    store.appendMessage = async (params) => {
      if (params.role === "assistant") throw new Error("db blip");
      return original(params);
    };
    const { agent, asked } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "confirm the role" } });
    assert.equal(asked.length, 1, "the agent ran and produced an answer");
    const conversations = await store.list("jax");
    const saved = await store.get(conversations[0]!.conversationId, "jax");
    assert.deepEqual(saved!.messages.map((m) => m.role), ["user"], "half-saved: the question without its answer");
    assert.equal(response.statusCode, 200, `answer lost: ${response.statusCode} ${response.body}`);
    await app.close();
  });

  test("stream: tokens of the answer are shown, then replaced by an error event", async () => {
    const store = new InMemoryConversationStore();
    const original = store.appendMessage.bind(store);
    store.appendMessage = async (params) => {
      if (params.role === "assistant") throw new Error("db blip");
      return original(params);
    };
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: { accept: "text/event-stream" },
      payload: { message: "confirm the role" },
    });
    const kinds = events(response.body).map((e) => e.event);
    assert.ok(kinds.includes("token"));
    assert.ok(kinds.includes("done"), `events: ${kinds.join(",")}`);
    await app.close();
  });
});

describe("BUG: message validation", () => {
  test("a non-string message next to a string question is a 500", async () => {
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { message: 5, question: "hi" },
    });
    assert.ok(response.statusCode < 500, `got ${response.statusCode}: ${response.body}`);
    await app.close();
  });
});

describe("BUG: prohibited data reaches the model through /api/v1/company/questions", () => {
  test("a password in the question is sent to the company agent", async () => {
    const { agent, asked } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const chat = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { message: "my password is Hunter2!secret" },
    });
    assert.equal(chat.statusCode, 400, "the chat route refuses it");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/company/questions",
      payload: { employeeId: "jax", question: "my password is Hunter2!secret" },
    });
    assert.equal(asked.length, 0, `the model saw: ${asked.map((q) => q.question).join(" | ")} (status ${response.statusCode})`);
    await app.close();
  });
});

describe("BUG: blank userId", () => {
  test("userId '  ' saves the conversation under user '' but every read defaults to 'jax'", async () => {
    const store = new InMemoryConversationStore();
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const chat = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "hi", userId: "   " } });
    const conversationId = chat.json().conversationId;
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}?userId=${encodeURIComponent("   ")}`,
    });
    assert.equal(read.statusCode, 200, "the same userId cannot read back the conversation it just wrote");
    await app.close();
  });
});

describe("BUG: unknown conversationId", () => {
  test("a conversation replacing an unknown or foreign id gets no title from the message", async () => {
    const store = new InMemoryConversationStore();
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const chat = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { message: "Plan the Q3 hiring", conversationId: "gone" },
    });
    const saved = await store.get(chat.json().conversationId, "jax");
    assert.equal(saved!.conversation.title, "Plan the Q3 hiring");
    await app.close();
  });
});

describe("NOT A BUG (verified)", () => {
  test("another user's conversation id is neither read into history nor appended to", async () => {
    const store = new InMemoryConversationStore();
    const { agent, asked } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const mine = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "secret plan", userId: "alice" } });
    const aliceId = mine.json().conversationId;
    const theirs = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { message: "what did I say?", userId: "bob", conversationId: aliceId },
    });
    assert.notEqual(theirs.json().conversationId, aliceId);
    assert.equal(asked[1]!.history, undefined);
    assert.equal((await store.get(aliceId, "alice"))!.messages.length, 2);
    await app.close();
  });

  test("prohibited data in a stream ends with an error event and saves nothing", async () => {
    const store = new InMemoryConversationStore();
    const { agent, asked } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: { accept: "text/event-stream" },
      payload: { message: "my password is Hunter2!secret" },
    });
    assert.deepEqual(events(response.body).map((e) => e.event), ["error"]);
    assert.equal(asked.length, 0);
    assert.equal((await store.list("jax")).length, 0);
    await app.close();
  });

  // The limit moved from 2000 to 8000 so a pasted job description fits (black-box use case 15).
  test("8000 characters pass, 8001 are refused, surrounding whitespace is not counted", async () => {
    const { agent } = fakeAgent();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const ok = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: `  ${"a".repeat(8000)}  ` } });
    const tooLong = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "a".repeat(8001) } });
    assert.equal(ok.statusCode, 200);
    assert.equal(tooLong.statusCode, 400);
    await app.close();
  });

  test("history keeps the last 6 turns and caps each at 1500 characters", async () => {
    const store = new InMemoryConversationStore();
    const long = "x".repeat(5000);
    const { agent, asked } = fakeAgent({ answer: long });
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    let conversationId: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const r = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: `m${i}`, conversationId } });
      conversationId = r.json().conversationId;
    }
    const last = asked.at(-1)!.history!;
    assert.equal(last.length, 6);
    assert.ok(last.every((turn) => turn.content.length <= 1500));
    await app.close();
  });

  test("a client that disconnects mid-stream does not crash the server, and the answer is still saved", async () => {
    const store = new InMemoryConversationStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let tokenSent!: () => void;
    const tokenSeen = new Promise<void>((resolve) => (tokenSent = resolve));
    const { agent } = fakeAgent({}, async () => {
      tokenSent();
      await gate;
    });
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/v1/agent/chat",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
    });
    req.on("error", () => {});
    req.on("response", (res) => res.on("data", () => {}).on("error", () => {}));
    req.end(JSON.stringify({ message: "hello" }));
    await tokenSeen;
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.off("uncaughtException", onUncaught);
    assert.deepEqual(uncaught, []);
    const [conversation] = await store.list("jax");
    assert.deepEqual((await store.get(conversation!.conversationId, "jax"))!.messages.map((m) => m.role), ["user", "assistant"]);
    await app.close();
  });
});
