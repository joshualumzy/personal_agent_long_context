// Round 3 hunt: the chat handler (src/http-app.ts): the 8000-character limit and the 1500-character history cap.
// "BUG" tests fail today; "NOT A BUG" tests pass.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { InMemoryConversationStore } from "../../src/adapters/postgres-conversations.js";
import type { CompanyAnswer, CompanyQuestion } from "../../src/company-domain.js";
import { buildApp } from "../../src/http-app.js";

function scriptedAgent(answers: string[]) {
  const asked: CompanyQuestion[] = [];
  return {
    asked,
    agent: {
      async answer(input: CompanyQuestion): Promise<CompanyAnswer> {
        asked.push(input);
        return { answer: answers.shift() ?? "ok", sources: [], runId: "run", toolCalls: [] };
      },
    },
  };
}

async function twoTurns(first: string, firstAnswer: string, second: string) {
  const store = new InMemoryConversationStore();
  const { agent, asked } = scriptedAgent([firstAnswer, "done"]);
  const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: store });
  const one = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: first } });
  assert.equal(one.statusCode, 200, one.body);
  const conversationId = one.json().conversationId;
  const two = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: second, conversationId } });
  assert.equal(two.statusCode, 200, two.body);
  await app.close();
  return asked[1]!.history ?? [];
}

describe("BUG: the 1500-character history cap", () => {
  test("a long answer that ends with the agent's question loses the question, so 'yes' has nothing to answer", async () => {
    const longAnswer = `${"Here is the breakdown of the pool and the criteria. ".repeat(40)}\n\nShall I replace the role with the new description?`;
    const history = await twoTurns("look at the role", longAnswer, "yes");
    const assistant = history.find((turn) => turn.role === "assistant")!;
    assert.match(assistant.content, /Shall I replace the role/, `the agent's own question is cut from history (${assistant.content.length} chars kept of ${longAnswer.length})`);
  });

  test("a pasted job description (accepted up to 8000 chars) is silently cut to 1500 for the follow-up turn", async () => {
    const jd = `Senior Backend Engineer. ${"Responsibilities: design, build and run services. ".repeat(80)}Salary: SGD 9,000 to 11,000 per month. Location: Singapore, hybrid.`;
    assert.ok(jd.length < 8000 && jd.length > 1500);
    const history = await twoTurns(jd, "Got it. Shall I open the role with these criteria?", "yes, and keep the salary band in the outreach");
    const user = history.find((turn) => turn.role === "user")!;
    assert.match(user.content, /SGD 9,000/, `history holds ${user.content.length} of ${jd.length} chars, no truncation marker`);
  });
});

describe("BUG: the two agent routes disagree on the limit", () => {
  test("/api/v1/agent/questions still refuses a 3000-character message the chat route accepts", async () => {
    const { agent } = scriptedAgent([]);
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const text = "a ".repeat(1500);
    const chat = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: text } });
    const questions = await app.inject({ method: "POST", url: "/api/v1/agent/questions", payload: { userId: "jax", employeeId: "jax", question: text } });
    await app.close();
    assert.equal(chat.statusCode, 200);
    assert.equal(questions.statusCode, 200, `questions route: ${questions.statusCode} ${questions.body}`);
  });
});

describe("NOT A BUG: the chat limit", () => {
  test("8000 characters are accepted, 8001 refused, and trimming happens first", async () => {
    const { agent } = scriptedAgent([]);
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const ok = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: `  ${"x".repeat(8000)}  ` } });
    const tooLong = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "x".repeat(8001) } });
    await app.close();
    assert.equal(ok.statusCode, 200);
    assert.equal(tooLong.statusCode, 400);
  });

  test("8000 four-byte characters fit under the 128 KB body limit", async () => {
    const { agent } = scriptedAgent([]);
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never });
    const response = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "😀".repeat(4000) } });
    await app.close();
    assert.equal(response.statusCode, 200);
  });
});
