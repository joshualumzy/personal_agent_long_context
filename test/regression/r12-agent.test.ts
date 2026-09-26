// Round 12 hunt: the chat agent loop after the round 11 fixes (grouped citation parser, the
// duplicate-call memory kept across steps). "BUG" tests fail today; "NOT A BUG" tests pass.
// The model is always a scripted fetch; nothing touches the network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentExtension, ChatBlock } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const JIRA: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const CONF: Evidence = { sourceId: "CONF-2", sourceType: "confluence", title: "Billing", excerpt: "Billing owned by Alice" };
const INSUFFICIENT = /insufficient evidence|证据不足/i;

function knowledge(search: CompanyKnowledge["search"]): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    search,
    async related() { return []; },
    async sources() { return []; },
  };
}

type Reply = string | { calls: Array<[string, object]>; content?: string };

async function run(
  replies: Reply[],
  question: string,
  extra: Partial<SoCLaaSCompanyAgentOptions> = {},
  search: CompanyKnowledge["search"] = async () => [JIRA, CONF],
) {
  let requests = 0;
  const agent = new SoCLaaSCompanyAgent(knowledge(search), {
    apiKey: "k",
    retryBaseMs: 1,
    fetch: (async () => {
      requests += 1;
      const reply = replies.shift();
      if (reply === undefined) throw new Error("script exhausted");
      const message =
        typeof reply === "string"
          ? { content: reply }
          : {
              content: reply.content ?? null,
              tool_calls: reply.calls.map(([name, args], index) => ({
                id: `c${requests}-${index}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              })),
            };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    }) as typeof fetch,
    ...extra,
  });
  const result = await agent
    .answer({ employeeId: "jax", question })
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[] }));
  return { result, requests };
}

const recruitingSkill = parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.");

function recruitingExtension(): AgentExtension & { ran: string[] } {
  const ran: string[] = [];
  const names = ["recruiting_start", "recruiting_status", "show_recruiting_panel"];
  let roles = 0;
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
      if (name === "recruiting_start") {
        roles += 1;
        return { content: JSON.stringify({ role_id: `r${roles}` }) };
      }
      return { content: JSON.stringify({ roles: [{ id: "r1", title: "Backend" }], status: { funnel: { found: 12, in_view: 4 } } }) };
    },
  };
}

// ------------------------------------------------------------------------------------------------
describe("BUG: a call that failed is not run again when the model retries it in its next reply", () => {
  // soclaas-company-agent.ts:917 remembers every call in `previous`, errors included, and since
  // round 11 that memory spans the whole turn (line 609). A transient failure (a dropped database
  // connection) retried as the model's next call is answered "Same call ... it ran once. Error: ...",
  // so the retry never happens. Before round 11 the retry in a new reply ran.
  test("1 a search that failed once and is retried with the same query is never re-run", async () => {
    let searches = 0;
    const search = async () => {
      searches += 1;
      if (searches === 1) throw new Error("Connection terminated unexpectedly");
      return [JIRA];
    };
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments owner" }]] },
        { calls: [["search_company_knowledge", { query: "payments owner" }]] },
        "Bob owns the payments service [source:JIRA-1].",
        "Bob owns the payments service [source:JIRA-1].",
      ],
      "Who owns payments?",
      {},
      search,
    );
    assert.equal(searches, 2, "the retry of a failed search was never run");
    assert.doesNotMatch(result.answer, INSUFFICIENT, result.answer);
  });
});

describe("BUG: a grouped tag that repeats the prefix ('[source:JIRA-1, source:CONF-2]') is misread", () => {
  // idsIn (soclaas-company-agent.ts:332) splits the group on spaces and commas only, so the second
  // id is read as "source:CONF-2": a made-up id. Without a skill the whole answer goes to repair
  // (and to "Insufficient Evidence" if the model writes it the same way again); beside a skill
  // withoutStrayTags (line 245) silently drops the real CONF-2 citation.
  const answer = "Bob owns payments and Alice owns billing [source:JIRA-1, source:CONF-2].";

  test("2 a correctly cited answer is replaced by 'Insufficient Evidence'", async () => {
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "owners" }]] }, answer, answer],
      "Who owns payments and billing?",
    );
    assert.doesNotMatch(result.answer, INSUFFICIENT, result.answer);
    assert.deepEqual(result.sources.map((source) => source.sourceId).sort(), ["CONF-2", "JIRA-1"]);
  });

  test("3 beside a skill, the real CONF-2 citation is dropped from the answer", async () => {
    const extension = recruitingExtension();
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "owners" }]] },
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        answer,
      ],
      "Who owns payments and billing, and how is the backend search going?",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.ok(
      result.sources.some((source) => source.sourceId === "CONF-2") || /CONF-2/.test(result.answer),
      `the real citation to CONF-2 was lost: ${result.answer}`,
    );
  });
});

describe("BUG: a grouped tag written as '[sources: JIRA-1, CONF-2]' is not read as a citation", () => {
  // CITATION_TAG (soclaas-company-agent.ts:330) matches only the singular "source:", so the plural
  // a model naturally uses for a group leaves the answer uncited: repair, then "Insufficient Evidence".
  test("4 a correctly cited answer is replaced by 'Insufficient Evidence'", async () => {
    const plural = "Bob owns payments and Alice owns billing [sources: JIRA-1, CONF-2].";
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "owners" }]] }, plural, plural],
      "Who owns payments and billing?",
    );
    assert.doesNotMatch(result.answer, INSUFFICIENT, result.answer);
  });
});

describe("BUG: a Chinese answer citing with a full-width colon ('[source：JIRA-1]') counts as uncited", () => {
  // CITATION_TAG (soclaas-company-agent.ts:330) requires the ASCII colon; Chinese text often turns
  // it full-width. The cited Chinese answer goes to repair and ends as 证据不足.
  test("5 a correctly cited Chinese answer is replaced by 证据不足", async () => {
    const zh = "支付服务由 Bob 负责 [source：JIRA-1]。";
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments owner" }]] }, zh, zh],
      "谁负责支付服务？",
      {},
      async () => [JIRA],
    );
    assert.doesNotMatch(result.answer, INSUFFICIENT, result.answer);
  });
});

// ------------------------------------------------------------------------------------------------
describe("NOT A BUG (verified)", () => {
  test("a grouped tag with spaces '[source: JIRA-1, CONF-2]' passes with both sources", async () => {
    const { result, requests } = await run(
      [{ calls: [["search_company_knowledge", { query: "owners" }]] }, "Bob owns payments and Alice billing [source: JIRA-1, CONF-2]."],
      "Who owns payments and billing?",
    );
    assert.equal(requests, 2, "no repair was needed");
    assert.deepEqual(result.sources.map((source) => source.sourceId).sort(), ["CONF-2", "JIRA-1"]);
  });

  test("ordinary bracketed text ('[TBD]', '[link]') beside a real citation is left alone", async () => {
    const text = "Bob owns payments [source:JIRA-1]. The migration date is [TBD]; see the runbook [link].";
    const { result, requests } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, text],
      "Who owns payments?",
    );
    assert.equal(requests, 2);
    assert.equal(result.answer, text);
  });

  test("beside a skill, '[source:JIRA-1, recruiting_status]' keeps JIRA-1 and drops the stray id", async () => {
    const extension = recruitingExtension();
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        "Bob owns payments [source:JIRA-1, recruiting_status]. The backend search has 4 people in view.",
      ],
      "Who owns payments and how is hiring going?",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.match(result.answer, /\[source:JIRA-1\]/);
    assert.doesNotMatch(result.answer, /recruiting_status/);
    assert.deepEqual(result.sources.map((source) => source.sourceId), ["JIRA-1"]);
  });

  test("recruiting_start repeated after the 'You returned nothing' nudge still opens one role", async () => {
    const extension = recruitingExtension();
    await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "Backend engineer, TypeScript" }]] },
        "",
        { calls: [["recruiting_start", { requirement: "Backend engineer, TypeScript" }]] },
        "Opened the role; review the criteria in the panel below.",
      ],
      "hire a backend engineer who knows TypeScript",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.equal(extension.ran.filter((name) => name === "recruiting_start").length, 1, extension.ran.join(", "));
  });

  test("the same call with different arguments in the next reply runs (two roles asked for, two opened)", async () => {
    const extension = recruitingExtension();
    await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_start", { requirement: "Backend engineer" }]] },
        { calls: [["recruiting_start", { requirement: "Designer" }]] },
        "Opened both roles.",
      ],
      "open a backend engineer role and a designer role",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.equal(extension.ran.filter((name) => name === "recruiting_start").length, 2);
  });
});
