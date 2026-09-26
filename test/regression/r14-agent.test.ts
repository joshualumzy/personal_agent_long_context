// Round 14 hunt: the lost-model fallback added in round 13, the closing-offer exemption, the new
// Chinese greetings, and the HTTP turn around them.
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch; nothing
// touches the network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { InMemoryConversationStore } from "../../src/adapters/postgres-conversations.js";
import type { AgentExtension, ChatBlock } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { buildApp } from "../../src/http-app.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const JIRA: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const FALLBACK = /^(Insufficient Evidence|证据不足)/i;

function knowledge(): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    async search() { return [JIRA]; },
    async related() { return []; },
    async sources() { return []; },
  };
}

type Reply = string | { calls: Array<[string, object]>; content?: string };

/** A model that answers from a script; `undefined` means the endpoint is unreachable from then on. */
function scriptedFetch(replies: Array<Reply | undefined>, counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1;
    if (replies.length === 0) throw new Error("script exhausted");
    const reply = replies.shift();
    if (reply === undefined) {
      replies.unshift(undefined);
      throw new TypeError("fetch failed");
    }
    const message =
      typeof reply === "string"
        ? { content: reply }
        : {
            content: reply.content ?? null,
            tool_calls: reply.calls.map(([name, args], index) => ({
              id: `c${counter.calls}-${index}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            })),
          };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;
}

function agentFor(replies: Array<Reply | undefined>, extra: Partial<SoCLaaSCompanyAgentOptions> = {}) {
  const counter = { calls: 0 };
  const agent = new SoCLaaSCompanyAgent(knowledge(), { apiKey: "k", retryBaseMs: 1, fetch: scriptedFetch(replies, counter), ...extra });
  return { agent, counter };
}

async function run(replies: Array<Reply | undefined>, question: string, extra: Partial<SoCLaaSCompanyAgentOptions> = {}) {
  const { agent, counter } = agentFor(replies, extra);
  const result = await agent
    .answer({ employeeId: "jax", question })
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[], blocks: undefined as ChatBlock[] | undefined }));
  return { result, calls: counter.calls };
}

function afterSearch(reply: string, question: string) {
  return run([{ calls: [["search_company_knowledge", { query: question }]] }, reply, reply, reply, reply], question);
}

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");

/** A recruiting extension whose tools answer as the real ones do; `failing` tools answer {"error": …}. */
function fakeRecruiting(failing: string[] = []): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  const names = ["recruiting_status", "recruiting_start", "recruiting_confirm", "show_recruiting_panel"];
  return {
    ran,
    skill: "recruiting",
    tools: names.map((name) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } })),
    async run(name) {
      ran.push(name);
      if (failing.includes(name)) return { content: JSON.stringify({ error: `${name} failed: the search provider is down.` }) };
      if (name === "show_recruiting_panel") {
        const block: ChatBlock = { type: "recruiting", view: "criteria", roleId: "r1" };
        return { content: "Shown.", block };
      }
      if (name === "recruiting_start") return { content: JSON.stringify({ role_id: "r1", result: { title: "Backend Engineer" } }) };
      if (name === "recruiting_confirm") return { content: JSON.stringify({ role_id: "r1", result: "Confirmed." }) };
      return { content: JSON.stringify({ roles: [{ id: "r1", title: "Backend Engineer", confirmed: false }], role_id: "r1", status: { criteria: [] } }) };
    },
  };
}

const withSkill = (extension: AgentExtension) => ({ skills: [recruitingSkill], extensions: [extension] });

/** The fallback's claim that something was carried out, in either language. */
const CLAIMS_DONE = /\bwere done\b|\bdone\b|已经完成|完成了/i;
/** The fallback's pointer to a panel, in either language. */
const POINTS_TO_PANEL = /\bpanel\b|面板/i;

// ------------------------------------------------------------------------------------------------
describe("BUG: after a model outage, the lost-model note claims steps were done when nothing changed", () => {
  // soclaas-company-agent.ts:717 falls back whenever `extensionRan` is true, and runTool sets it
  // (line 585) for any recruiting tool: the read-only recruiting_status that the skill makes the
  // model call first on every turn, and a tool whose result was {"error": …}. The note it returns
  // (lines 720-722) says "The steps above were done … The panel shows where things stand" /
  // "操作已经完成…下方面板显示…". Here the founder asked to confirm the criteria; only the status was
  // read (or the confirm failed), there is no panel, and the turn ends with a normal "done" answer
  // instead of an error, so the founder believes the criteria were confirmed and the search runs.
  test("1 'confirm the criteria': only recruiting_status ran, then the endpoint went down; the note says the steps were done, with no panel", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [{ calls: [["load_skill", { name: "recruiting" }]] }, { calls: [["recruiting_status", {}]] }, undefined],
      "Looks good, confirm the criteria.",
      withSkill(extension),
    );
    assert.deepEqual(extension.ran, ["recruiting_status"]);
    assert.equal(result.blocks, undefined, "no panel was collected");
    if (!/^THREW/.test(result.answer)) {
      assert.doesNotMatch(result.answer, CLAIMS_DONE, `nothing was changed, but the founder is told: ${result.answer}`);
      assert.doesNotMatch(result.answer, POINTS_TO_PANEL, `there is no panel, but the founder is pointed to one: ${result.answer}`);
    }
  });

  test("2 '确认这些标准': recruiting_confirm returned an error, then the endpoint went down; the note says '操作已经完成'", async () => {
    const extension = fakeRecruiting(["recruiting_confirm"]);
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        { calls: [["recruiting_confirm", { role_id: "r1" }]] },
        undefined,
      ],
      "可以，确认这些标准。",
      withSkill(extension),
    );
    assert.deepEqual(extension.ran, ["recruiting_status", "recruiting_confirm"]);
    if (!/^THREW/.test(result.answer)) {
      assert.doesNotMatch(result.answer, CLAIMS_DONE, `the confirm failed, but the founder is told: ${result.answer}`);
    }
  });
});

describe("BUG: the lost-model note throws away the answer the model already wrote beside its panel", () => {
  // The model often writes its reply in the same message as its show_recruiting_panel call; the
  // loop keeps it in `spoken` (soclaas-company-agent.ts:752-756) and joins it into the final answer
  // (line 763). The lost-model fallback (lines 714-728) returns only the canned note, so the
  // founder loses what the model had already said (here: what the criteria are and what to do).
  test("3 the reply beside the panel is dropped when the endpoint goes down on the closing step", async () => {
    const extension = fakeRecruiting();
    const said = "I opened the Backend Engineer role with two must-haves: TypeScript and Postgres. Review them in the panel below and confirm when ready.";
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        { calls: [["recruiting_start", { requirement: "backend engineer, TypeScript and Postgres" }]] },
        { calls: [["show_recruiting_panel", { view: "criteria", role_id: "r1" }]], content: said },
        undefined,
      ],
      "hire a backend engineer who knows TypeScript and Postgres",
      withSkill(extension),
    );
    assert.ok(result.blocks?.length, "the panel is kept");
    assert.match(result.answer, /TypeScript and Postgres/, `the model's own reply was lost; got: ${result.answer}`);
  });
});

describe("BUG: the lost-model note ignores an explicit request for English", () => {
  // The fallback picks its language with isChinese(question) || asksForChinese(question) (line 720),
  // skipping asksForLanguage, which every other language choice in the file respects (line 875).
  // "请用英文回答" gets the Chinese note.
  test("4 '…请用英文回答。' gets the Chinese note after a role was opened", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "后端工程师，懂 TypeScript" }]] },
        { calls: [["show_recruiting_panel", { view: "criteria", role_id: "r1" }]] },
        undefined,
      ],
      "帮我招一个懂 TypeScript 的后端工程师，请用英文回答。",
      withSkill(extension),
    );
    assert.doesNotMatch(result.answer, /^THREW/);
    assert.doesNotMatch(result.answer, /[一-鿿]/, `asked for English, got: ${result.answer}`);
  });
});

// ------------------------------------------------------------------------------------------------
describe("NOT A BUG (verified)", () => {
  test("a role opened then the endpoint lost: panel kept, turn ends normally", async () => {
    const extension = fakeRecruiting();
    const { result } = await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "backend engineer" }]] },
        { calls: [["show_recruiting_panel", { view: "criteria", role_id: "r1" }]] },
        undefined,
      ],
      "hire a backend engineer",
      withSkill(extension),
    );
    assert.doesNotMatch(result.answer, /^THREW/);
    assert.equal(result.blocks?.length, 1);
  });

  test("the fallback over HTTP streaming ends with one 'done' (no 'error'), and the saved answer keeps the panel", async () => {
    const extension = fakeRecruiting();
    const { agent } = agentFor(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "backend engineer" }]] },
        { calls: [["show_recruiting_panel", { view: "criteria", role_id: "r1" }]] },
        undefined,
      ],
      withSkill(extension),
    );
    const store = new InMemoryConversationStore();
    const app = buildApp({ memory: new DeterministicMemoryProvider(), companyAgent: agent, conversationStore: store });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chat",
      headers: { accept: "text/event-stream" },
      payload: { message: "hire a backend engineer" },
    });
    await app.close();
    const events = [...response.body.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
    assert.equal(events.filter((event) => event === "done").length, 1, response.body);
    assert.ok(!events.includes("error"), response.body);
    assert.equal(events[events.length - 1], "done");
    const [conversation] = await store.list("jax");
    const detail = await store.get(conversation!.conversationId, "jax");
    const saved = detail!.messages.find((message) => message.role === "assistant");
    assert.ok(Array.isArray(saved?.metadata.blocks) && (saved.metadata.blocks as unknown[]).length === 1);
  });

  test("an uncited claim before the closing offer is still checked", async () => {
    const { result } = await afterSearch("Bob owns the payments service. Let me know if you need anything else.", "who owns payments?");
    assert.match(result.answer, FALLBACK);
  });

  test("a claim joined by a comma to the closing offer is still checked", async () => {
    const { result } = await afterSearch("支付服务下个月关停，有需要随时找我。", "支付服务怎么样？");
    assert.match(result.answer, FALLBACK);
  });

  test("'早上好，Jax！有需要随时找我。' to '早上好' is exempt", async () => {
    const { result } = await afterSearch("早上好，Jax！有需要随时找我。", "早上好");
    assert.equal(result.answer, "早上好，Jax！有需要随时找我。");
  });

  test("a claim after a Chinese time-of-day greeting is still checked", async () => {
    const { result } = await afterSearch("下午好！支付服务由 Bob 负责。有需要随时找我。", "下午好，支付谁负责？");
    assert.match(result.answer, FALLBACK);
  });
});
