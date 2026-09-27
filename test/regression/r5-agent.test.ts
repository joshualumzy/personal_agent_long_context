// Round 5 hunt: the chat agent loop and HTTP layer, focused on what the round 4 fixes changed.
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

const lastAssistant = (body: Body) =>
  String([...body.messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string")?.content ?? "");

// ---------------------------------------------------------------- 1. the "states no facts" exemption

describe("BUG: the 'states no facts' exemption lets uncited company claims through", () => {
  // Company evidence was retrieved and the answer cites none: before round 4 this always went to repair.
  const run = async (claim: string, question = "Who owns payments?") => {
    const { agent, bodies } = scripted([{ calls: [["search_company_knowledge", { query: "payments" }]] }, claim, claim]);
    const result = await agent.answer({ employeeId: "jax", question });
    return { result, calls: bodies.length };
  };

  test("1 a claim opened with 'Sure,' and closed with a question is delivered uncited, with no repair", async () => {
    const claim = "Sure, Alice owns the payments service and it is being shut down next month. Want me to pull the migration plan?";
    const { result, calls } = await run(claim);
    assert.notEqual(result.answer, claim, `uncited claim delivered as is (${calls} model calls, no repair)`);
  });

  test("2 'I can confirm ...' counts as a sentence 'about the agent', so the claim passes uncited", async () => {
    const claim = "I can confirm Alice owns the payments service and it is being shut down next month. Anything else?";
    const { result } = await run(claim);
    assert.notEqual(result.answer, claim, "uncited claim delivered as is");
  });

  test("3 claim lines without a full stop merge into the closing question and count as one question", async () => {
    const claim = "- Alice owns the payments service\n- It is being shut down next month\n\nWant me to pull the migration plan?";
    const { result } = await run(claim);
    assert.notEqual(result.answer, claim, "uncited bullet claims delivered as is");
  });

  test("4 Chinese: '我可以告诉你，…' exempts a claim the same way", async () => {
    const claim = "我可以告诉你，支付服务归Alice负责，下个月就要下线。还需要别的吗？";
    const { result } = await run(claim, "支付服务是谁负责的？");
    assert.notEqual(result.answer, claim, "uncited claim delivered as is");
  });
});

describe("BUG: the greeting exemption misses the common Chinese greeting", () => {
  test("5 '你好！…你想先做什么？' (a Chinese greeting) is replaced by '证据不足'", async () => {
    const hello = "你好！我可以帮你查公司资料，也可以帮你招人。你想先做什么？";
    const { agent } = scripted([{ calls: [["search_company_knowledge", { query: "你好" }]] }, hello, hello]);
    const result = await agent.answer({ employeeId: "jax", question: "你好" });
    assert.doesNotMatch(result.answer, ZH_FALLBACK, `a Chinese greeting became: ${result.answer}`);
  });

  test("6 an exempt English greeting to a Chinese 'hi' cannot be translated: the translation meets the strict check", async () => {
    const { agent, bodies } = scripted([
      { calls: [["search_company_knowledge", { query: "你好" }]] },
      "Hi Jax! What would you like to do today?",
      "你好，Jax！今天想做什么？",
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "你好" });
    assert.equal(bodies.length, 3, "the language retry ran");
    assert.match(result.answer, /[一-鿿]/, `Chinese user still got: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 2. explicit language request regex

describe("BUG: the explicit-language regex misfires on ordinary Chinese questions", () => {
  const run = async (question: string) => {
    const { agent, bodies } = scripted([
      { calls: [["search_company_knowledge", { query: "q" }]] },
      "Bob owns the payments service [source:JIRA-1].",
      "支付服务由Bob负责 [source:JIRA-1]。",
    ]);
    const result = await agent.answer({ employeeId: "jax", question });
    return { result, calls: bodies.length };
  };

  test("7 '以英语为母语' (native English speakers) is read as 'answer in English': the Chinese user gets English", async () => {
    const { result, calls } = await run("我们公司有哪些以英语为母语的工程师？");
    assert.match(result.answer, /[一-鿿]/, `answer: ${result.answer} (${calls} calls)`);
  });

  test("8 '英语说得流利' (speaks English fluently) disables the language retry the same way", async () => {
    const { result, calls } = await run("团队里谁英语说得比较流利？");
    assert.match(result.answer, /[一-鿿]/, `answer: ${result.answer} (${calls} calls)`);
  });
});

// ---------------------------------------------------------------- 3. the repair and translation calls

// A search, then the recruiting skill with a panel, then an answer that cites none of the evidence: soft repair.
const softPrefix = (): Reply[] => [
  { calls: [["search_company_knowledge", { query: "payments" }]] },
  { calls: [["load_skill", { name: "recruiting" }]] },
  { calls: [["show_recruiting_panel", {}]] },
  "Three people sit in the centre ring; the panel below lets you draft outreach to each.",
];
const withPanel = () => ({ skills: [recruitingSkill], extensions: [panelExtension()] });

describe("BUG: the soft repair, which 'never fails the turn', fails it", () => {
  test("9 a 200 proxy page as the soft repair's reply throws, losing the skill's answer (the main loop retries these)", async () => {
    const { agent } = scripted([...softPrefix(), { body: "<html>upstream reset</html>", status: 200 }, "unused"], withPanel());
    const result = await agent
      .answer({ employeeId: "jax", question: "How is the search going?" })
      .catch((error: Error) => ({ answer: `THREW: ${error.message}` }));
    assert.doesNotMatch(result.answer, /^THREW/, result.answer);
  });

  test("10 a repair reply with list-shaped content (read everywhere else since round 4) throws '.trim is not a function'", async () => {
    const { agent } = scripted(
      [...softPrefix(), { raw: { content: [{ type: "text", text: "Three people sit in the centre ring; Bob owns payments [source:JIRA-1]." }] } }],
      withPanel(),
    );
    const result = await agent
      .answer({ employeeId: "jax", question: "How is the search going?" })
      .catch((error: Error) => ({ answer: `THREW: ${error.message}` }));
    assert.doesNotMatch(result.answer, /^THREW/, result.answer);
  });
});

describe("BUG: a translation with list-shaped content is thrown away", () => {
  test("11 the Chinese translation arrives as text parts and the Chinese user keeps the English answer", async () => {
    const { agent } = scripted([
      { calls: [["search_company_knowledge", { query: "支付" }]] },
      "Bob owns the payments service [source:JIRA-1].",
      { raw: { content: [{ type: "text", text: "支付服务由Bob负责 [source:JIRA-1]。" }] } },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "支付服务是谁负责的？" });
    assert.match(result.answer, /[一-鿿]/, `answer: ${result.answer}`);
  });
});

describe("BUG: the citation repair revises only the last message, dropping what was said beside the panel", () => {
  test("12 the skill's answer (spoken beside the panel) is lost when the repair revises the final line", async () => {
    const spoken = "Three people sit in the centre ring and Ann Tan is the strongest; her draft is ready in the panel below.";
    const { agent } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["show_recruiting_panel", {}]], content: spoken },
        "Bob from payments can join her interview.",
        // A model doing what it is asked: revise "your previous answer", adding the citation.
        (body) => `${lastAssistant(body)} [source:JIRA-1]`,
      ],
      withPanel(),
    );
    const result = await agent.answer({ employeeId: "jax", question: "Who is the best candidate, and who can interview?" });
    assert.match(result.answer, /Ann Tan is the strongest/, `the skill's answer is gone: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 4. duplicate calls in one step

describe("BUG: the same-call dedupe answers a later read with stale state", () => {
  test("13 status, change, status in one reply: the second status reports the criterion as it was before the change", async () => {
    const extension = stateExtension();
    const { agent, bodies } = scripted(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        {
          calls: [
            ["recruiting_status", { role_id: "r1" }],
            ["recruiting_change_criteria", { role_id: "r1", kind: "nice" }],
            ["recruiting_status", { role_id: "r1" }],
          ],
        },
        "TypeScript is now a nice-to-have.",
      ],
      { skills: [recruitingSkill], extensions: [extension] },
    );
    await agent.answer({ employeeId: "jax", question: "make TypeScript a nice-to-have and show me the criteria" });
    assert.equal(extension.kind, "nice");
    const toolReplies = bodies[2]!.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    const afterChange = toolReplies[toolReplies.length - 1]!;
    assert.doesNotMatch(afterChange, /"kind":"must"/, `the read after the change was answered with: ${afterChange}`);
  });
});

// ---------------------------------------------------------------- 5. streaming

describe("BUG: streamed steps get none of the protection non-streamed steps have", () => {
  test("14 a 200 proxy page on the last (streamed) step is not asked for again: 'I could not finish that one'", async () => {
    const { agent } = scripted(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { body: "<html>upstream reset</html>", status: 200 },
        streamText("Bob owns the payments service [source:JIRA-1]."),
      ],
      { maxSteps: 2 },
    );
    const result = await agent.answer({ employeeId: "jax", question: "Who owns payments?" }, { onToken: () => {} });
    assert.match(result.answer, /Bob owns/, `answer: ${result.answer}`);
  });

  test("15 a stream cut mid-answer fails the whole turn after the skill's tools already acted", async () => {
    const extension = panelExtension();
    const { agent } = scripted(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { stream: [data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "p", function: { name: "show_recruiting_panel", arguments: "{}" } }] } }] }), "data: [DONE]\n\n"] },
        { stream: [data({ choices: [{ delta: { content: "Three people sit in " } }] })], failAfter: true },
        streamText("Three people sit in the centre ring; see the panel below."),
      ],
      { skills: [recruitingSkill], extensions: [extension] },
    );
    const result = await agent
      .answer({ employeeId: "jax", question: "show me the pool" }, { onToken: () => {}, onResetTokens: () => {} })
      .catch((error: Error) => ({ answer: `THREW: ${error.message}` }));
    assert.equal(extension.ran.length, 1);
    assert.doesNotMatch(result.answer, /^THREW/, result.answer);
  });
});

// ---------------------------------------------------------------- 6. HTTP history clipping

describe("BUG: history clipping cuts an emoji in half", () => {
  test("16 a long message with an emoji at the clip point sends a lone surrogate to the model on every later turn", async () => {
    const asked: CompanyQuestion[] = [];
    const agent = {
      async answer(input: CompanyQuestion): Promise<CompanyAnswer> {
        asked.push(input);
        return { answer: "ok", sources: [], runId: "run", toolCalls: [] };
      },
    };
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent as never, conversationStore: new InMemoryConversationStore() });
    const jd = `${"a".repeat(1999)}🚀${"b".repeat(3000)}`; // the emoji spans code units 1999 and 2000
    const one = await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: jd } });
    const conversationId = one.json().conversationId;
    await app.inject({ method: "POST", url: "/api/v1/agent/chat", payload: { message: "yes", conversationId } });
    await app.close();
    const user = asked[1]!.history!.find((turn) => turn.role === "user")!;
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(user.content), "history holds a lone surrogate");
  });
});

// ---------------------------------------------------------------- NOT A BUG

describe("NOT A BUG (verified)", () => {
  test("an uncited answer with a figure and a closing question still goes to repair and falls back", async () => {
    const claim = "Sure, the payments budget is $2M. Anything else?";
    const { agent, bodies } = scripted([{ calls: [["search_company_knowledge", { query: "budget" }]] }, claim, claim]);
    const result = await agent.answer({ employeeId: "jax", question: "What is the payments budget?" });
    assert.equal(bodies.length, 3);
    assert.match(result.answer, EN_FALLBACK);
  });

  test("'英文名' (English name) is not an explicit language request: the retry still runs", async () => {
    const { agent, bodies } = scripted([
      { calls: [["search_company_knowledge", { query: "q" }]] },
      "Bob's English name is Bob Lee [source:JIRA-1].",
      "支付服务负责人Bob的英文名是Bob Lee [source:JIRA-1]。",
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "支付负责人的英文名是什么？" });
    assert.equal(bodies.length, 3);
    assert.match(result.answer, /英文名/);
  });

  test("the dedupe keeps two calls with different arguments: both run", async () => {
    const extension = stateExtension();
    const { agent, bodies } = scripted(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", { role_id: "r1" }], ["recruiting_status", { role_id: "r2" }]] },
        "Both roles are listed.",
      ],
      { skills: [recruitingSkill], extensions: [extension] },
    );
    await agent.answer({ employeeId: "jax", question: "status of both roles" });
    const replies = bodies[2]!.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    assert.ok(replies.slice(1).every((content) => !content.startsWith("Same call")), JSON.stringify(replies));
  });

  test("a soft repair that drops every citation keeps the skill's answer", async () => {
    const { agent } = scripted([...softPrefix(), "Three people sit in the centre ring."], withPanel());
    const result = await agent.answer({ employeeId: "jax", question: "How is the search going?" });
    assert.equal(result.answer, "Three people sit in the centre ring; the panel below lets you draft outreach to each.");
  });

  test("an unreadable streamed body before the last step costs a step but the turn recovers", async () => {
    const { agent } = scripted([
      { calls: [["search_company_knowledge", { query: "payments" }]] },
      { body: "<html>upstream reset</html>", status: 200 },
      streamText("Bob owns the payments service [source:JIRA-1]."),
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "Who owns payments?" }, { onToken: () => {} });
    assert.equal(result.answer, "Bob owns the payments service [source:JIRA-1].");
  });
});
