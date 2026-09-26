// Round 9 hunt: the chat agent loop, repair and translation, streaming, conversations.
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type pg from "pg";
import { PostgresConversationStore } from "../../src/adapters/postgres-conversations.js";
import type { AgentExtension, ChatBlock } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const EVIDENCE: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const EN_FALLBACK = /^Insufficient Evidence/;
const ZH_FALLBACK = /^证据不足/;
const HAN = /[一-鿿]/g;

function knowledge(): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    async search() { return [EVIDENCE]; },
    async related() { return []; },
    async sources() { return []; },
  };
}

type Body = { messages: Array<{ role: string; content: unknown }>; tool_choice: string; stream?: boolean };
type Reply =
  | string
  | { calls: Array<[string, object]>; content?: string }
  | { stream: string[] }
  | { body: string; status?: number };

const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const streamText = (text: string): Reply => ({ stream: [data({ choices: [{ delta: { content: text } }] }), "data: [DONE]\n\n"] });

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]!));
        else controller.close();
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
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("script exhausted");
      if (typeof reply === "object" && "stream" in reply) return sse(reply.stream);
      if (typeof reply === "object" && "body" in reply) return new Response(reply.body, { status: reply.status ?? 200 });
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

const run = async (
  replies: Reply[],
  question: string,
  extra: Partial<SoCLaaSCompanyAgentOptions> = {},
  callbacks?: Parameters<SoCLaaSCompanyAgent["answer"]>[1],
) => {
  const { agent, bodies } = scripted(replies, extra);
  const result = await agent
    .answer({ employeeId: "jax", question }, callbacks)
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[] }));
  return { result, calls: bodies.length, bodies };
};

/** Step 0 must call a tool, so the model searches; then it replies `reply` (and repeats it if asked to repair). */
const afterSearch = (reply: string, question: string) =>
  run([{ calls: [["search_company_knowledge", { query: question }]] }, reply, reply, reply], question);

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");

/** Stand-ins for recruiting tools: each records that it ran. */
function recruitingExtension(): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  const names = ["recruiting_start", "recruiting_status", "show_recruiting_panel"];
  return {
    ran,
    skill: "recruiting",
    tools: names.map((name) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    async run(name) {
      ran.push(name);
      if (name === "show_recruiting_panel") {
        const block: ChatBlock = { type: "recruiting", view: "pool", roleId: "r1" };
        return { content: "Shown.", block };
      }
      return { content: JSON.stringify({ role_id: "r1", status: { role: { title: "Founding Backend Engineer", confirmed: false } } }) };
    },
  };
}

const hanShare = (text: string) => (text.match(HAN)?.length ?? 0) / Math.max(text.length, 1);

// ---------------------------------------------------------------- 1. the reply to "thanks"

describe("BUG: the ordinary reply to a thank-you is replaced by 'Insufficient Evidence'", () => {
  // Step 0 must call a tool, so "thanks" costs a search; the reply then needs the exemption, and
  // "You're welcome" / "不客气" are neither greetings nor acknowledgements to statesNoFacts.
  test("1 'You're welcome! Anything else I can help with?' to 'thanks' becomes 'Insufficient Evidence'", async () => {
    const { result, calls } = await afterSearch("You're welcome! Anything else I can help with?", "thanks!");
    assert.doesNotMatch(result.answer, EN_FALLBACK, `(${calls} model calls) got: ${result.answer}`);
  });

  test("2 '不客气！还有什么需要帮忙的吗？' to '谢谢' becomes '证据不足'", async () => {
    const { result, calls } = await afterSearch("不客气！还有什么需要帮忙的吗？", "谢谢");
    assert.doesNotMatch(result.answer, ZH_FALLBACK, `(${calls} model calls) got: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 2. explicit language requests

describe("BUG: '用英文写…' (write it in English) is not a language request, so the English text is translated back", () => {
  test("3 '用英文写一段支付服务的简介，发给新同事' gets a Chinese answer", async () => {
    const english = "The payments service is owned by Bob [source:JIRA-1].";
    const { result, calls } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, english, "支付服务由Bob负责 [source:JIRA-1]。", "支付服务由Bob负责 [source:JIRA-1]。"],
      "用英文写一段支付服务的简介，发给新同事",
    );
    assert.equal(result.answer, english, `(${calls} model calls) the English text the user asked for became: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 3. the translation retry

describe("BUG: a Chinese translation that drops the citations is not asked for again", () => {
  // The loop asks twice only while the reply is empty or not Chinese. A Chinese reply that fails
  // the citation check ends the loop, and the Chinese user gets the English answer.
  test("4 the first translation loses [source:JIRA-1]; the second (correct) one is never requested", async () => {
    const { result, calls } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        "Bob owns the payments service [source:JIRA-1].",
        "支付服务由Bob负责。",
        "支付服务由Bob负责 [source:JIRA-1]。",
      ],
      "支付服务是谁负责的？",
    );
    assert.ok(hanShare(result.answer) > 0.2, `(${calls} model calls) the Chinese user got: ${result.answer}`);
    assert.match(result.answer, /\[source:JIRA-1\]/);
  });
});

// ---------------------------------------------------------------- 4. repair after a skill acted

describe("BUG: a skill's answer with a stray [source:] tag is replaced by 'Insufficient evidence' after the skill acted", () => {
  // groundedElsewhere waives the citation rule but not the unknown-id check; the repair then gets the
  // strict prompt, which invites "say 'Insufficient evidence'", and that honest reply is accepted.
  test("5 the role was opened, yet the founder is told 'Insufficient evidence'", async () => {
    const extension = recruitingExtension();
    const { result, calls } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "backend engineer" }]] },
        { calls: [["show_recruiting_panel", { view: "criteria" }]] },
        "I've opened the Founding Backend Engineer role [source:recruiting_start]. Review the draft criteria in the panel below.",
        "Insufficient evidence: none of the available sources mention the new role or its criteria.",
      ],
      "hire a founding backend engineer",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.deepEqual(extension.ran, ["recruiting_start", "show_recruiting_panel"]);
    assert.doesNotMatch(result.answer, /insufficient evidence|^THREW/i, `(${calls} model calls) got: ${result.answer}`);
  });
});

// ---------------------------------------------------------------- 5. streaming

describe("BUG: streamed parallel calls that share index 0 are merged", () => {
  // Only calls without an index are split by id; a gateway that numbers every call 0 gets one call
  // with the second call's name and both argument strings glued together (invalid JSON).
  test("6 recruiting_status + show_recruiting_panel, both index 0 with their own ids: neither runs", async () => {
    const extension = recruitingExtension();
    const call = (id: string, name: string, args: string) =>
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] } }] });
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { stream: [call("a", "recruiting_status", "{}"), call("b", "show_recruiting_panel", "{\"view\":\"pool\"}"), "data: [DONE]\n\n"] },
        streamText("The pool is in the panel below."),
        streamText("The pool is in the panel below."),
      ],
      "show me the pool",
      { skills: [recruitingSkill], extensions: [extension] },
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.deepEqual(extension.ran, ["recruiting_status", "show_recruiting_panel"], `ran: ${JSON.stringify(extension.ran)}; answer: ${result.answer}`);
  });
});

describe("BUG: a stream that stops without [DONE] or a finish_reason is taken as a finished answer", () => {
  // A close-delimited body that loses its connection ends cleanly; nothing marks the answer as cut.
  // Accepted in round 9 (docs/s3-bug-hunt.md): locked tests rely on streams that close without [DONE].
  test.skip("7 half a sentence is delivered as the answer", async () => {
    const fragment = "Bob owns [source:JIRA-1] the paym";
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { stream: [data({ choices: [{ delta: { content: fragment }, finish_reason: null }] })] },
        { stream: [data({ choices: [{ delta: { content: "Bob owns the payments service [source:JIRA-1]." }, finish_reason: "stop" }] }), "data: [DONE]\n\n"] },
      ],
      "Who owns payments?",
      {},
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.notEqual(result.answer, fragment, "the cut-off fragment was delivered as the answer");
  });
});

// ---------------------------------------------------------------- 6. conversations

describe("BUG: a NUL character in a message cannot be stored in Postgres", () => {
  // Postgres TEXT rejects 0x00 and JSONB rejects \u0000; appendMessage passes both through, so the
  // chat route's user-message save throws and the whole turn fails before the agent runs.
  test("8 appendMessage with a pasted NUL is rejected by the database", async () => {
    const pool = {
      async query(_text: string, params: unknown[] = []) {
        for (const param of params) {
          if (typeof param === "string" && (param.includes("\u0000") || param.includes("\\u0000"))) {
            throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
          }
        }
        return {
          rows: [{ message_id: "m", conversation_id: params[0], role: params[1], content: params[2], metadata: {}, created_at: new Date() }],
          rowCount: 1,
        };
      },
    } as unknown as pg.Pool;
    const store = new PostgresConversationStore(pool);
    await assert.doesNotReject(
      store.appendMessage({ conversationId: "00000000-0000-0000-0000-000000000000", role: "user", content: "copied from a PDF:\u0000 who owns payments?" }),
    );
  });
});

// ---------------------------------------------------------------- NOT A BUG

describe("NOT A BUG (verified)", () => {
  test("'Happy to help! Anything else I can do for you?' is exempt", async () => {
    const { result } = await afterSearch("Happy to help! Anything else I can do for you?", "thanks");
    assert.equal(result.answer, "Happy to help! Anything else I can do for you?");
  });

  test("a stray tag in a skill answer that the repair simply drops keeps the skill's answer", async () => {
    const extension = recruitingExtension();
    const clean = "I've opened the Founding Backend Engineer role. Review the draft criteria in the panel below.";
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "backend engineer" }]] },
        "I've opened the Founding Backend Engineer role [source:recruiting_start]. Review the draft criteria in the panel below.",
        clean,
      ],
      "hire a founding backend engineer",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.equal(result.answer, clean);
  });

  test("streamed parallel calls with their own indices both run", async () => {
    const extension = recruitingExtension();
    const call = (index: number, id: string, name: string, args: string) =>
      data({ choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] } }] });
    await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { stream: [call(0, "a", "recruiting_status", "{}"), call(1, "b", "show_recruiting_panel", "{\"view\":\"pool\"}"), "data: [DONE]\n\n"] },
        streamText("The pool is in the panel below."),
      ],
      "show me the pool",
      { skills: [recruitingSkill], extensions: [extension] },
      { onToken: () => {}, onResetTokens: () => {} },
    );
    assert.deepEqual(extension.ran, ["recruiting_status", "show_recruiting_panel"]);
  });

  test("'是用英文写的吗？' (is it written in English?) still gets the Chinese retry", async () => {
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "docs" }]] }, "Yes, the payments docs are in English [source:JIRA-1].", "是的，支付文档是英文的 [source:JIRA-1]。"],
      "支付服务的文档是用英文写的吗？",
    );
    assert.match(result.answer, /支付文档/);
  });

  test("a translation that fails both times (English twice) keeps the checked English answer after exactly two asks", async () => {
    const english = "Bob owns the payments service [source:JIRA-1].";
    const { result, calls } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, english, english, english],
      "支付服务是谁负责的？",
    );
    assert.equal(result.answer, english);
    assert.equal(calls, 4);
  });
});
