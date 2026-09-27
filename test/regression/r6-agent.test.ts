// Round 6 hunt: the chat agent loop and HTTP layer, focused on what the round 5 fixes changed.
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { InMemoryConversationStore } from "../../src/adapters/postgres-conversations.js";
import type { AgentExtension } from "../../src/agent-extension.js";
import type { CompanyAnswer, CompanyKnowledge, CompanyQuestion, Evidence } from "../../src/company-domain.js";
import { buildApp } from "../../src/http-app.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const EVIDENCE: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const EN_FALLBACK = /^Insufficient Evidence/;
const ZH_FALLBACK = /^证据不足/;

function knowledge(): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    async search() { return [EVIDENCE]; },
    async related() { return []; },
    async sources() { return []; },
  };
}

type Body = { messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>; tool_choice: string; stream?: boolean };
type Reply =
  | string
  | { raw: Record<string, unknown> }
  | { calls: Array<[string, object]>; content?: string }
  | { stream: string[]; failAfter?: boolean }
  | { body: string; status?: number }
  | ((body: Body) => string);

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const streamText = (text: string): Reply => ({ stream: [data({ choices: [{ delta: { content: text } }] }), "data: [DONE]\n\n"] });

function sse(chunks: string[], failAfter = false): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent < chunks.length) {
          controller.enqueue(encoder.encode(chunks[sent]!));
          sent += 1;
        } else if (failAfter) {
          controller.error(new TypeError("terminated: other side closed"));
        } else {
          controller.close();
        }
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function scripted(replies: Reply[], extra: Partial<SoCLaaSCompanyAgentOptions> = {}) {
  const bodies: Body[] = [];
  const agent = new SoCLaaSCompanyAgent(knowledge(), {
    apiKey: "k",
    retryBaseMs: 1,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("script exhausted");
      if (typeof reply === "function") return new Response(JSON.stringify({ choices: [{ message: { content: reply(body) } }] }), { status: 200 });
      if (typeof reply === "object" && "stream" in reply) return sse(reply.stream, reply.failAfter);
      if (typeof reply === "object" && "body" in reply) return new Response(reply.body, { status: reply.status ?? 200 });
      let message: Record<string, unknown>;
      if (typeof reply === "string") message = { content: reply };
      else if ("raw" in reply) message = reply.raw;
      else
        message = {
          content: reply.content ?? null,
          tool_calls: reply.calls.map(([name, args], index) => ({
            id: `c${bodies.length}-${index}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    }) as typeof fetch,
    ...extra,
  });
  return { agent, bodies };
}

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");

function panelExtension(): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    skill: "recruiting",
    tools: [{ type: "function", function: { name: "show_recruiting_panel", description: "Shows a panel.", parameters: { type: "object", properties: {} } } }],
    async run(name) {
      ran.push(name);
      return { content: "Shown.", block: { type: "recruiting", view: "pool", roleId: "r1" } };
    },
  };
}

/** A stand-in for recruiting_status / recruiting_change_criteria over one mutable criterion. */
function stateExtension(): AgentExtension & { kind: string } {
  const state = {
    kind: "must",
    skill: "recruiting",
    tools: ["recruiting_status", "recruiting_change_criteria"].map((name) => ({
      type: "function" as const,
      function: { name, description: name, parameters: { type: "object", properties: {} } },
    })),
    async run(name: string, args: Record<string, unknown>) {
      if (name === "recruiting_change_criteria") state.kind = String(args.kind);
      return { content: JSON.stringify({ criteria: [{ id: "c1", text: "TypeScript", kind: state.kind }] }) };
    },
  };
  return state;
}

const HAN = /[一-鿿]/;
const lastAssistant = (body: Body) =>
  String([...body.messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string")?.content ?? "");
const run = async (replies: Reply[], question: string, extra: Partial<SoCLaaSCompanyAgentOptions> = {}, callbacks?: Parameters<SoCLaaSCompanyAgent["answer"]>[1]) => {
  const { agent, bodies } = scripted(replies, extra);
  const result = await agent
    .answer({ employeeId: "jax", question }, callbacks)
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[] }));
  return { result, calls: bodies.length, bodies };
};

// ---------------------------------------------------------------- 1. statesNoFacts, narrowed in round 5

describe("BUG: the narrowed greeting rule rejects ordinary greetings and acknowledgements before a question", () => {
  // Company evidence was retrieved (step 0 must search), the reply cites none, and the repair repeats it.
  const greet = (reply: string, question: string) =>
    run([{ calls: [["search_company_knowledge", { query: question }]] }, reply, reply], question);

  test("1 (regression from round 5) 'Hi there, Jax! What would you like to work on today?' is replaced by 'Insufficient Evidence'", async () => {
    const { result, calls } = await greet("Hi there, Jax! What would you like to work on today?", "hi");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `a greeting became (${calls} calls): ${result.answer}`);
  });

  test("2 the clarifying question the prompt asks for, opened with 'Got it.', is replaced by 'Insufficient Evidence'", async () => {
    const { result, calls } = await greet("Got it. Do you mean the payments service or the payments team?", "How is payments going?");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `a clarifying question became (${calls} calls): ${result.answer}`);
  });

  test("3 Chinese: '明白了。你是指支付服务还是支付团队？' is replaced by '证据不足'", async () => {
    const { result, calls } = await greet("明白了。你是指支付服务还是支付团队？", "支付那边怎么样了？");
    assert.doesNotMatch(result.answer, ZH_FALLBACK, `a clarifying question became (${calls} calls): ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 2. asksForLanguage, narrowed in round 5

describe("BUG: explicit requests for English are no longer recognised, and the answer is translated back into Chinese", () => {
  const english = "Bob owns the payments service [source:JIRA-1].";
  const ask = (question: string) =>
    run([{ calls: [["search_company_knowledge", { query: "payments" }]] }, english, "支付服务由Bob负责 [source:JIRA-1]。"], question);

  test("4 '用英文说一下…' (say it in English; matched before round 5) gets a Chinese answer", async () => {
    const { result, calls } = await ask("用英文说一下支付服务是谁负责的");
    assert.doesNotMatch(result.answer, HAN, `asked for English, got (${calls} calls): ${result.answer}`);
  });

  test("5 '…是谁负责的？In English please.' (matched before round 5) gets a Chinese answer", async () => {
    const { result, calls } = await ask("支付服务是谁负责的？In English please.");
    assert.doesNotMatch(result.answer, HAN, `asked for English, got (${calls} calls): ${result.answer}`);
  });

  test("6 '翻译成英文' (translate into English): the English translation is translated back into Chinese", async () => {
    const { result, calls } = await ask("把支付服务负责人的说明翻译成英文");
    assert.doesNotMatch(result.answer, HAN, `asked for an English translation, got (${calls} calls): ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 3. translation after an accepted "insufficient evidence"

describe("BUG: an accepted 'Insufficient evidence' repair can never be translated for a Chinese user", () => {
  test("7 the repair's honest English 'Insufficient evidence: …' passes, but its Chinese translation meets a stricter check and is dropped", async () => {
    const { result, calls } = await run(
      [
        { calls: [["search_company_knowledge", { query: "营销预算" }]] },
        "The Q3 marketing budget is one million.",
        "Insufficient evidence: no record of the Q3 marketing budget approval was found.",
        "证据不足：没有找到第三季度营销预算的审批记录。",
      ],
      "我们第三季度的营销预算是多少？",
    );
    assert.equal(calls, 4, "the translation was asked for");
    assert.match(result.answer, HAN, `the Chinese user got English: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 4. streamed steps

describe("BUG: streamed steps: an error inside the stream and a non-streamed reply", () => {
  test("8 vLLM's in-stream error event (data: {error}, then [DONE]) is taken as a normal end: a half sentence is the answer", async () => {
    const extension = panelExtension();
    const fragment = "Three people sit in ";
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { stream: [data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "p", function: { name: "show_recruiting_panel", arguments: "{}" } }] } }] }), "data: [DONE]\n\n"] },
        {
          stream: [
            data({ choices: [{ delta: { content: fragment } }] }),
            data({ error: { object: "error", message: "CUDA out of memory", type: "InternalServerError", code: 500 } }),
            "data: [DONE]\n\n",
          ],
        },
        streamText("Three people sit in the centre ring; see the panel below."),
      ],
      "show me the pool",
      { skills: [recruitingSkill], extensions: [extension] },
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.equal(extension.ran.length, 1);
    assert.notEqual(result.answer.trim(), fragment.trim(), "the cut-off fragment was delivered as the answer");
  });

  test("9 a gateway that ignores stream:true and answers with a normal JSON completion: the answer in the body is thrown away", async () => {
    const answer = "Bob owns the payments service [source:JIRA-1].";
    const { result, calls } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, answer, answer, answer, answer, answer, answer, answer, answer],
      "Who owns payments?",
      {},
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.equal(result.answer, answer, `(${calls} calls) got: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- NOT A BUG

describe("NOT A BUG (verified)", () => {
  test("a stream cut mid-answer resets the streamed tokens before the retry's tokens arrive", async () => {
    const events: string[] = [];
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { stream: [data({ choices: [{ delta: { content: "Bob owns " } }] })], failAfter: true },
        streamText("Bob owns the payments service [source:JIRA-1]."),
      ],
      "Who owns payments?",
      {},
      { onToken: (t) => events.push(`t:${t}`), onResetTokens: () => events.push("reset") },
    );
    assert.equal(result.answer, "Bob owns the payments service [source:JIRA-1].");
    assert.deepEqual(events, ["t:Bob owns ", "reset", "t:Bob owns the payments service [source:JIRA-1]."]);
  });

  test("a cut stream is retried inside the same step: it costs no step (maxSteps 2 still answers)", async () => {
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { stream: [data({ choices: [{ delta: { content: "Bob" } }] })], failAfter: true },
        { stream: [data({ choices: [{ delta: { content: "Bob" } }] })], failAfter: true },
        streamText("Bob owns the payments service [source:JIRA-1]."),
      ],
      "Who owns payments?",
      { maxSteps: 2 },
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.equal(result.answer, "Bob owns the payments service [source:JIRA-1].");
  });

  test("the same state-changing call twice in a row still runs once", async () => {
    const extension = stateExtension();
    let changes = 0;
    const run0 = extension.run.bind(extension);
    extension.run = async (name, args) => {
      if (name === "recruiting_change_criteria") changes += 1;
      return run0(name, args);
    };
    await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_change_criteria", { kind: "nice" }], ["recruiting_change_criteria", { kind: "nice" }]] },
        "Done.",
      ],
      "make it nice",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.equal(changes, 1);
  });

  test("the repair sees the joined answer (spoken text plus final line) as the model's last word", async () => {
    const spoken = "Three people sit in the centre ring and Ann Tan is the strongest; her draft is ready below.";
    const { bodies } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["show_recruiting_panel", {}]], content: spoken },
        "Bob from payments can join.",
        (body) => `${lastAssistant(body)} [source:JIRA-1]`,
      ],
      "Who is best?",
      { skills: [recruitingSkill], extensions: [panelExtension()] },
    );
    const repair = bodies[bodies.length - 1]!;
    assert.match(lastAssistant(repair), /Ann Tan[\s\S]*Bob from payments/);
  });

  test("'请用英文回答' is still respected, and '英语说得流利' still is not a language request", async () => {
    const english = "Bob owns the payments service [source:JIRA-1].";
    const a = await run([{ calls: [["search_company_knowledge", { query: "q" }]] }, english, "支付服务由Bob负责 [source:JIRA-1]。"], "请用英文回答：支付服务是谁负责的？");
    assert.equal(a.result.answer, english);
    const b = await run([{ calls: [["search_company_knowledge", { query: "q" }]] }, english, "支付服务由Bob负责 [source:JIRA-1]。"], "团队里谁英语说得比较流利？");
    assert.match(b.result.answer, HAN);
  });

  test("a 4000-emoji message (8000 code units) is kept whole in history, with no marker", async () => {
    const asked: CompanyQuestion[] = [];
    const agent = { async answer(input: CompanyQuestion): Promise<CompanyAnswer> { asked.push(input); return { answer: "ok", sources: [], runId: "r", toolCalls: [] }; } };
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: new InMemoryConversationStore() });
    const message = "🚀".repeat(4000);
    const one = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message } });
    await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "yes", conversationId: one.json().conversationId } });
    await app.close();
    assert.equal(asked[1]!.history!.find((turn) => turn.role === "user")!.content, message);
  });
});
