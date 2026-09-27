// Round 7 hunt: the chat agent loop, focused on the round 6 fixes (statesNoFacts, asksForLanguage,
// the translation retry, streamed error events and plain completions).
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

/** Company evidence is retrieved, then the model answers `claim` (and repeats it if asked to repair). */
const uncited = async (claim: string, question = "Who owns payments?") => {
  const out = await run([{ calls: [["search_company_knowledge", { query: "payments" }]] }, claim, claim, claim], question);
  return out;
};

// ---------------------------------------------------------------- 1. statesNoFacts, widened in round 6

describe("BUG: the Chinese greeting's 'name' slot swallows a whole clause", () => {
  // Chinese has no spaces, so "[\s,，]+[\p{L}]+" after 你好/好的 matches any clause up to the full stop.
  test("1 '你好，支付服务下个月由Alice关停！还需要别的吗？' is delivered uncited, with no repair", async () => {
    const claim = "你好，支付服务下个月由Alice关停！还需要别的吗？";
    const { result, calls } = await uncited(claim, "支付服务是谁负责的？");
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls, no repair)`);
  });

  test("2 '好的，…' opens an uncited claim the same way", async () => {
    const claim = "好的，支付服务下个月由Alice关停。要我把迁移计划找出来吗？";
    const { result, calls } = await uncited(claim, "支付服务是谁负责的？");
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls)`);
  });

  test("3 the translation of an exempt English greeting may add an uncited claim behind '你好，'", async () => {
    const { result, calls } = await run(
      [
        { calls: [["search_company_knowledge", { query: "你好" }]] },
        "Hi Jax! What would you like to do today?",
        "你好，支付服务归Alice负责！今天想做什么？",
      ],
      "你好",
    );
    assert.doesNotMatch(result.answer, /Alice/, `the translation added an uncited claim (${calls} calls): ${result.answer}`);
  });
});

describe("BUG: 'what the agent can help with' is matched on its first words only", () => {
  test("4 'I can help with that: <claim>.' is a sentence 'about the agent', so the claim passes uncited", async () => {
    const claim = "I can help with that: Alice owns the payments service and it is being shut down next month. Want the migration plan?";
    const { result, calls } = await uncited(claim);
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls)`);
  });

  test("5 Chinese: '我可以帮你总结一下：<claim>。' passes uncited the same way", async () => {
    const claim = "我可以帮你总结一下：支付服务归Alice负责，下个月就要下线。还需要别的吗？";
    const { result, calls } = await uncited(claim, "支付服务是谁负责的？");
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls)`);
  });
});

describe("BUG: a claim stated as the premise of a question counts as 'a question back'", () => {
  test("6 'Since Alice owns payments and it shuts down next month, do you want the plan?' is delivered uncited", async () => {
    const claim = "Since Alice owns the payments service and it is being shut down next month, do you want me to pull the migration plan?";
    const { result, calls } = await uncited(claim);
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls)`);
  });
});

// ---------------------------------------------------------------- 2. asksForLanguage, widened in round 6

describe("BUG: ordinary Chinese questions about English are read as 'answer in English'", () => {
  const english = "Yes, the API docs are written in English [source:JIRA-1].";
  const chinese = "是的，接口文档是用英文写的 [source:JIRA-1]。";
  const ask = (question: string) => run([{ calls: [["search_company_knowledge", { query: "docs" }]] }, english, chinese], question);

  test("7 '我们的接口文档是用英文写的吗？' (are our docs written in English?) gets an English answer", async () => {
    const { result, calls } = await ask("我们的接口文档是用英文写的吗？");
    assert.match(result.answer, HAN, `Chinese user got English (${calls} calls, no retry): ${result.answer}`);
  });

  test("8 '面试时他的英语回答流利吗？' (were his English answers fluent?) gets an English answer", async () => {
    const { result, calls } = await ask("面试时他的英语回答流利吗？");
    assert.match(result.answer, HAN, `Chinese user got English (${calls} calls, no retry): ${result.answer}`);
  });

  test("9 '我们什么时候把界面改成英文？' (when do we switch the UI to English?) gets an English answer", async () => {
    const { result, calls } = await ask("我们什么时候把产品界面改成英文？");
    assert.match(result.answer, HAN, `Chinese user got English (${calls} calls, no retry): ${result.answer}`);
  });
});

describe("BUG: an explicit request for Chinese is ignored when the rest of the message is English", () => {
  test("10 'Who owns the payments service? 请用中文回答' gets an English answer and no retry", async () => {
    const { result, calls } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        "Bob owns the payments service [source:JIRA-1].",
        "支付服务由Bob负责 [source:JIRA-1]。",
      ],
      "Who owns the payments service? 请用中文回答",
    );
    assert.match(result.answer, HAN, `asked for Chinese, got (${calls} calls): ${result.answer}`);
  });
});

// ---------------------------------------------------------------- NOT A BUG

describe("NOT A BUG (verified)", () => {
  test("a plain Chinese greeting with a name ('你好，Jax！你想做什么？') is still exempt", async () => {
    const hello = "你好，Jax！你想先做什么？";
    const { result } = await uncited(hello, "你好");
    assert.equal(result.answer, hello);
  });

  test("'他英语说得怎么样？' and '英文名' are not language requests: the retry still runs", async () => {
    for (const question of ["他的英语说得怎么样？", "他的英文名叫什么？"]) {
      const { result } = await run(
        [{ calls: [["search_company_knowledge", { query: "q" }]] }, "Bob speaks fluent English [source:JIRA-1].", "Bob英语很流利 [source:JIRA-1]。"],
        question,
      );
      assert.match(result.answer, HAN, question);
    }
  });

  test("an honest 'Insufficient evidence' in hand cannot smuggle a claim into its translation", async () => {
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        "Alice runs it.",
        "Insufficient evidence: nothing retrieved says who owns the payments service.",
        "证据不足，但支付服务归Alice负责。",
      ],
      "支付服务是谁负责的？",
    );
    assert.doesNotMatch(result.answer, /Alice/);
  });

  test("an error event after tokens were streamed resets them, and a plain completion's tool calls run", async () => {
    const extension = panelExtension();
    const events: string[] = [];
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        // A gateway that ignores stream:true, answering a streamed step with tool calls.
        { raw: { content: null, tool_calls: [{ id: "p", type: "function", function: { name: "show_recruiting_panel", arguments: "{}" } }] } },
        { stream: [data({ choices: [{ delta: { content: "Three " } }] }), data({ object: "error", message: "boom" }), "data: [DONE]\n\n"] },
        streamText("Three people sit in the centre ring; see the panel below."),
      ],
      "show me the pool",
      { skills: [recruitingSkill], extensions: [extension] },
      { onToken: (t) => events.push(`t:${t}`), onResetTokens: () => events.push("reset") },
    );
    assert.equal(extension.ran.length, 1);
    assert.equal(result.answer, "Three people sit in the centre ring; see the panel below.");
    assert.deepEqual(events.slice(-3), ["t:Three ", "reset", "t:Three people sit in the centre ring; see the panel below."]);
  });

  test("a stream whose first event follows a 2 MB comment preamble is still read", async () => {
    const pad = `: ${"x".repeat(2_000_000)}\n\n`;
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, { stream: [pad, data({ choices: [{ delta: { content: "Bob owns the payments service [source:JIRA-1]." } }] }), "data: [DONE]\n\n"] }],
      "Who owns payments?",
      {},
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.equal(result.answer, "Bob owns the payments service [source:JIRA-1].");
  });
});
