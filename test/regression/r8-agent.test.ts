// Round 8 hunt: the chat agent, focused on the round 7 narrowing of the "states no facts"
// exemption and the explicit-language rules (asksForLanguage, the new asksForChinese).
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentExtension } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const EVIDENCE: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const EN_FALLBACK = /^Insufficient Evidence/;
const ZH_FALLBACK = /^证据不足/;
const HAN = /[一-鿿]/;

function knowledge(): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    async search() { return [EVIDENCE]; },
    async related() { return []; },
    async sources() { return []; },
  };
}

type Body = { messages: Array<{ role: string; content: unknown }>; tool_choice: string };
type Reply = string | { calls: Array<[string, object]>; content?: string };

function scripted(replies: Reply[], extra: Partial<SoCLaaSCompanyAgentOptions> = {}) {
  const bodies: Body[] = [];
  const agent = new SoCLaaSCompanyAgent(knowledge(), {
    apiKey: "k",
    retryBaseMs: 1,
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("script exhausted");
      const message =
        typeof reply === "string"
          ? { content: reply }
          : {
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

const run = async (replies: Reply[], question: string, extra: Partial<SoCLaaSCompanyAgentOptions> = {}) => {
  const { agent, bodies } = scripted(replies, extra);
  const result = await agent
    .answer({ employeeId: "jax", question })
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[] }));
  return { result, calls: bodies.length, bodies };
};

/** Step 0 must call a tool, so the model searches; then it replies `reply` (and repeats it if asked to repair). */
const afterSearch = (reply: string, question: string) =>
  run([{ calls: [["search_company_knowledge", { query: question }]] }, reply, reply, reply], question);

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");

/** A stand-in for recruiting_change_criteria. */
function criteriaExtension(): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    skill: "recruiting",
    tools: [{ type: "function", function: { name: "recruiting_change_criteria", description: "Changes criteria.", parameters: { type: "object", properties: {} } } }],
    async run(name) {
      ran.push(name);
      return { content: JSON.stringify({ criteria: [{ id: "c1", text: "Fluent in Mandarin", kind: "must" }] }) };
    },
  };
}

// ---------------------------------------------------------------- (a) uncited claims still exempt

describe("BUG: a Chinese question carries an uncited claim in its first clause", () => {
  // Chinese joins a statement and a question with one comma and no "since"/"因为": the premise
  // ban and the two-comma ban both miss it, so question() accepts the whole sentence.
  test("1 '支付服务下个月由Alice关停，要我把迁移计划找出来吗？' is delivered uncited, with no repair", async () => {
    const claim = "支付服务下个月由Alice关停，要我把迁移计划找出来吗？";
    const { result, calls } = await afterSearch(claim, "支付服务是谁负责的？");
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls, no repair)`);
  });
});

describe("BUG: the greeting's name slot (1-4 Han characters) holds a four-character claim", () => {
  test("2 '好的，王五负责。你还想了解什么？' ('OK, Wang Wu is responsible') is delivered uncited", async () => {
    const claim = "好的，王五负责。你还想了解什么？";
    const { result, calls } = await afterSearch(claim, "支付服务是谁负责的？");
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls)`);
  });
});

describe("BUG: a Chinese capability clause holds a claim in its 12 free characters", () => {
  test("3 '我可以帮你联系负责支付服务的张三。' ('I can put you in touch with Zhang San, who owns payments') is delivered uncited", async () => {
    const claim = "我可以帮你联系负责支付服务的张三。要现在联系吗？";
    const { result, calls } = await afterSearch(claim, "支付服务是谁负责的？");
    assert.notEqual(result.answer, claim, `uncited company claim delivered as is (${calls} model calls)`);
  });
});

// ---------------------------------------------------------------- (b) ordinary replies now refused

describe("BUG: ordinary greetings and clarifying questions are replaced by 'Insufficient Evidence'", () => {
  test("4 a greeting that ends with an emoji ('Hello! How can I help you today? 😊') is refused", async () => {
    const { result, calls } = await afterSearch("Hello! How can I help you today? 😊", "hi");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `a greeting became (${calls} calls): ${result.answer}`);
  });

  test("5 the Chinese greeting with a closing emoji ('你好！有什么可以帮你的吗？😊') is refused", async () => {
    const { result, calls } = await afterSearch("你好！有什么可以帮你的吗？😊", "你好");
    assert.doesNotMatch(result.answer, ZH_FALLBACK, `a greeting became (${calls} calls): ${result.answer}`);
  });

  test("6 a Chinese either/or clarifying question with two commas is refused", async () => {
    const { result, calls } = await afterSearch("明白了，你是想了解支付服务的负责人，还是它的上线时间？", "支付服务怎么样了？");
    assert.doesNotMatch(result.answer, ZH_FALLBACK, `a clarifying question became (${calls} calls): ${result.answer}`);
  });

  test("7 a Chinese question to the user containing '已经' ('你已经看过那份设计文档了吗？') is refused", async () => {
    const { result, calls } = await afterSearch("你已经看过那份设计文档了吗？", "支付服务的设计是怎样的？");
    assert.doesNotMatch(result.answer, ZH_FALLBACK, `a clarifying question became (${calls} calls): ${result.answer}`);
  });

  test("8 the agent introducing itself ('Hello! I'm your Technical Chief of Staff. How can I help you today?') is refused", async () => {
    const { result, calls } = await afterSearch("Hello! I'm your Technical Chief of Staff. How can I help you today?", "hi");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `a greeting became (${calls} calls): ${result.answer}`);
  });

  test("9 'Happy to help! Which role do you mean?' is refused", async () => {
    const { result, calls } = await afterSearch("Happy to help! Which role do you mean?", "how is hiring going?");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `a clarifying question became (${calls} calls): ${result.answer}`);
  });

  test("10 a clarifying question with a lead-in colon ('Just to clarify: …?') is refused", async () => {
    const { result, calls } = await afterSearch("Just to clarify: do you mean the payments service or the payments team?", "How is payments going?");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `a clarifying question became (${calls} calls): ${result.answer}`);
  });

  // Known limit, accepted in round 8 (docs/s3-bug-hunt.md): only when the model searched first.
  test.skip("11 'what can you do?' answered as the bullet list the system prompt asks for is refused", async () => {
    const list = "Hi Jax! Here's what I can help with:\n\n- Search company knowledge (Jira, Slack, Confluence)\n- Recruiting: find, score and reach out to candidates\n\nWhat would you like to do?";
    const { result, calls } = await afterSearch(list, "what can you do?");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `a capability answer became (${calls} calls): ${result.answer}`);
  });
});

describe("BUG: English messages that mention Chinese or Mandarin get their answer translated into Chinese", () => {
  const english = "Added 'Fluent in Mandarin' as a must-have. Everyone will be rescored.";
  const chinese = "已将“普通话流利”添加为必备条件，所有人都会重新评分。";
  const change = (question: string) =>
    run(
      [{ calls: [["load_skill", { name: "recruiting" }]] }, { calls: [["recruiting_change_criteria", {}]] }, english, chinese],
      question,
      { skills: [recruitingSkill], extensions: [criteriaExtension()] },
    );

  test("12 'Add a must-have: fluent in Mandarin.' (a criterion, not a language request) is answered in Chinese", async () => {
    const { result, calls } = await change("Add a must-have: fluent in Mandarin.");
    assert.doesNotMatch(result.answer, HAN, `English user got Chinese (${calls} calls): ${result.answer}`);
  });

  test("13 'Did Wei reply in Chinese or English?' (about the candidate) is answered in Chinese", async () => {
    const { result, calls } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_change_criteria", {}]] },
        "Wei replied in English.",
        "Wei用英文回复的。",
      ],
      "Did Wei reply in Chinese or English?",
      { skills: [recruitingSkill], extensions: [criteriaExtension()] },
    );
    assert.doesNotMatch(result.answer, HAN, `English user got Chinese (${calls} calls): ${result.answer}`);
  });
});

// ---------------------------------------------------------------- NOT A BUG

describe("NOT A BUG (verified)", () => {
  test("plain greetings and short clarifying questions stay exempt", async () => {
    for (const [reply, question] of [
      ["Hello! How can I assist you today?", "hi"],
      ["Hi Jax! 👋 What would you like to work on today?", "hi"],
      ["Sure! Which role are we talking about?", "how is hiring going?"],
      ["你好，Jax！😊 今天想做点什么？", "你好"],
      ["您好！请问有什么可以帮您？", "你好"],
    ]) {
      const { result } = await afterSearch(reply!, question!);
      assert.equal(result.answer, reply, reply);
    }
  });

  test("'Can you answer in Chinese?' in an English message gets Chinese", async () => {
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, "Bob owns the payments service [source:JIRA-1].", "支付服务由Bob负责 [source:JIRA-1]。"],
      "Who owns the payments service? Can you answer in Chinese?",
    );
    assert.match(result.answer, HAN);
  });

  test("'Find engineers who speak Mandarin' is not read as a language request", async () => {
    const { result, calls } = await run(
      [{ calls: [["load_skill", { name: "recruiting" }]] }, { calls: [["recruiting_change_criteria", {}]] }, "Added it as a must-have."],
      "Find engineers who speak Mandarin",
      { skills: [recruitingSkill], extensions: [criteriaExtension()] },
    );
    assert.equal(result.answer, "Added it as a must-have.");
    assert.equal(calls, 3);
  });

  test("an uncited Chinese claim with a figure behind '好的，' still goes to repair and falls back", async () => {
    const { result } = await afterSearch("好的，支付服务3月关停。还需要别的吗？", "支付服务是谁负责的？");
    assert.match(result.answer, ZH_FALLBACK);
  });
});
