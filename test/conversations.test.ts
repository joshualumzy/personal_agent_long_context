import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryConversationStore } from "../src/adapters/postgres-conversations.js";

describe("Conversation store", () => {
  test("creates, lists, retrieves, and deletes conversations and messages", async () => {
    const store = new InMemoryConversationStore();

    // 1. Initial listing is empty
    const initialList = await store.list("jax");
    assert.deepEqual(initialList, []);

    // 2. Create conversation
    const conv = await store.create("jax", "TitanDB Migration");
    assert.equal(conv.userId, "jax");
    assert.equal(conv.title, "TitanDB Migration");
    assert.ok(conv.conversationId);

    // 3. Append messages
    const userMsg = await store.appendMessage({
      conversationId: conv.conversationId,
      role: "user",
      content: "When is the rollout?",
    });
    assert.equal(userMsg.role, "user");
    assert.equal(userMsg.content, "When is the rollout?");

    const assistantMsg = await store.appendMessage({
      conversationId: conv.conversationId,
      role: "assistant",
      content: "The rollout is scheduled for Tuesday.",
      metadata: { sources: [{ sourceId: "PR-143" }] },
    });
    assert.equal(assistantMsg.role, "assistant");
    assert.deepEqual(assistantMsg.metadata, { sources: [{ sourceId: "PR-143" }] });

    // 4. Retrieve conversation with messages
    const detail = await store.get(conv.conversationId, "jax");
    assert.ok(detail);
    assert.equal(detail.conversation.title, "TitanDB Migration");
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[0].content, "When is the rollout?");
    assert.equal(detail.messages[1].content, "The rollout is scheduled for Tuesday.");

    // 5. User scoping check
    const otherUserDetail = await store.get(conv.conversationId, "alice");
    assert.equal(otherUserDetail, null);

    // 6. List conversations shows message count
    const list = await store.list("jax");
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "TitanDB Migration");
    assert.equal(list[0].messageCount, 2);

    // 7. Update title
    const renamed = await store.updateTitle(conv.conversationId, "jax", "TitanDB Rollout Plan");
    assert.equal(renamed, true);
    const updated = await store.get(conv.conversationId, "jax");
    assert.equal(updated?.conversation.title, "TitanDB Rollout Plan");

    // 8. Delete conversation
    const deleted = await store.delete(conv.conversationId, "jax");
    assert.equal(deleted, true);
    const afterDelete = await store.get(conv.conversationId, "jax");
    assert.equal(afterDelete, null);
  });

  test("HTTP conversation endpoints support listing, creating, retrieving, and auto-logging chat turns", async () => {
    const { buildApp } = await import("../src/http-app.js");
    const { DeterministicMemoryProvider } = await import("../src/adapters/deterministic-memory.js");

    const store = new InMemoryConversationStore();
    const companyAgent = {
      async answer(input: { employeeId: string; question: string }) {
        return {
          answer: `Company answer to: ${input.question}`,
          sources: [{ sourceId: "PR-99", sourceType: "pr", title: "Test PR", excerpt: "Test excerpt" }],
          runId: "run-test-1",
          toolCalls: [],
        };
      },
    };

    const app = buildApp({
      memory: new DeterministicMemoryProvider(),
      companyAgent: companyAgent as never,
      conversationStore: store,
    });

    // 1. Initial conversations list is empty
    const listRes1 = await app.inject({ method: "GET", url: "/api/v1/conversations?userId=jax" });
    assert.equal(listRes1.statusCode, 200);
    assert.deepEqual(listRes1.json(), []);

    // 2. Chat without conversationId auto-creates conversation and appends both turns
    const chatRes1 = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { userId: "jax", message: "What is Project Titan?" },
    });
    assert.equal(chatRes1.statusCode, 200);
    const chatJson1 = chatRes1.json();
    assert.ok(chatJson1.conversationId);
    assert.match(chatJson1.answer, /Company answer to: What is Project Titan/);

    const convId = chatJson1.conversationId;

    // 3. Conversation now shows in list
    const listRes2 = await app.inject({ method: "GET", url: "/api/v1/conversations?userId=jax" });
    assert.equal(listRes2.statusCode, 200);
    const listData = listRes2.json();
    assert.equal(listData.length, 1);
    assert.equal(listData[0].conversationId, convId);
    assert.equal(listData[0].messageCount, 2);

    // 4. Continue existing conversation
    const chatRes2 = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      payload: { userId: "jax", conversationId: convId, message: "Who is the lead?" },
    });
    assert.equal(chatRes2.statusCode, 200);
    assert.equal(chatRes2.json().conversationId, convId);

    // 5. Fetch full conversation detail
    const detailRes = await app.inject({ method: "GET", url: `/api/v1/conversations/${convId}?userId=jax` });
    assert.equal(detailRes.statusCode, 200);
    const detailData = detailRes.json();
    assert.equal(detailData.messages.length, 4);
    assert.equal(detailData.messages[0].role, "user");
    assert.equal(detailData.messages[0].content, "What is Project Titan?");
    assert.equal(detailData.messages[1].role, "assistant");
    assert.equal(detailData.messages[2].role, "user");
    assert.equal(detailData.messages[2].content, "Who is the lead?");
    assert.equal(detailData.messages[3].role, "assistant");

    // 6. Delete conversation
    const deleteRes = await app.inject({ method: "DELETE", url: `/api/v1/conversations/${convId}?userId=jax` });
    assert.equal(deleteRes.statusCode, 200);

    const detailResAfter = await app.inject({ method: "GET", url: `/api/v1/conversations/${convId}?userId=jax` });
    assert.equal(detailResAfter.statusCode, 404);

    await app.close();
  });
});
