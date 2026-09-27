// Round 11 hunt: the chat agent loop (citation parsing, tool dedupe), and how the recruiting
// tools are exposed to the model. "BUG" tests fail today; "NOT A BUG" tests pass.
// The model is always a scripted fetch; nothing touches the network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentExtension, ChatBlock } from "../../src/agent-extension.js";
import type { CompanyKnowledge, Evidence } from "../../src/company-domain.js";
import { statusForModel } from "../../src/recruiting/chat-tools.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent, type SoCLaaSCompanyAgentOptions } from "../../src/soclaas-company-agent.js";

const JIRA: Evidence = { sourceId: "JIRA-1", sourceType: "jira", title: "Payments", excerpt: "Payments service owned by Bob" };
const CONF: Evidence = { sourceId: "CONF-2", sourceType: "confluence", title: "Billing", excerpt: "Billing owned by Alice" };
const INSUFFICIENT = /insufficient evidence|证据不足/i;

function knowledge(found: Evidence[] = [JIRA, CONF]): CompanyKnowledge {
  return {
    async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
    async search() { return found; },
    async related() { return []; },
    async sources() { return []; },
  };
}

type Body = { messages: Array<{ role: string; content: unknown }>; tool_choice: string };
type Reply = string | { calls: Array<[string, object]>; content?: string };

async function run(replies: Reply[], question: string, extra: Partial<SoCLaaSCompanyAgentOptions> = {}, found?: Evidence[]) {
  const bodies: Body[] = [];
  const agent = new SoCLaaSCompanyAgent(knowledge(found), {
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
  const result = await agent
    .answer({ employeeId: "jax", question })
    .catch((error: Error) => ({ answer: `THREW: ${error.message}`, sources: [] as Evidence[] }));
  return { result, calls: bodies.length, bodies };
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
        const block: ChatBlock = { type: "recruiting", view: "criteria", roleId: `r${roles}` };
        return { content: "Shown.", block };
      }
      if (name === "recruiting_start") {
        roles += 1;
        return { content: JSON.stringify({ role_id: `r${roles}`, status: { role: { title: "Founding Backend Engineer", confirmed: false } } }) };
      }
      return { content: JSON.stringify({ roles: [] }) };
    },
  };
}

// ------------------------------------------------------------------------------------------------
describe("BUG: a citation tag holding two ids ('[source:JIRA-1, CONF-2]') is not read as a citation", () => {
  // citedIds (soclaas-company-agent.ts:386) matches only /\[source:([^\]\s]+)\]/: one id, no space.
  // A grouped tag is invisible to validateCitations, so a fully cited answer counts as uncited,
  // and an id inside such a tag is never checked against what was retrieved.
  test("1 a correctly cited answer written with a grouped tag is replaced by 'Insufficient Evidence'", async () => {
    const grouped = "Bob owns payments and Alice owns billing [source:JIRA-1, CONF-2].";
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "owners" }]] }, grouped, grouped],
      "Who owns payments and billing?",
    );
    assert.doesNotMatch(result.answer, INSUFFICIENT, result.answer);
    assert.ok(result.sources.length > 0, "the answer's sources are lost");
  });

  test("2 a made-up id inside a grouped tag ('[source:JIRA-1, SLACK-99]') is delivered to the user", async () => {
    const made = "Bob owns payments [source:JIRA-1]. Payments shuts down next month [source:JIRA-1, SLACK-99].";
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, made, made],
      "What is happening with payments?",
      {},
      [JIRA],
    );
    assert.doesNotMatch(result.answer, /SLACK-99/, "a citation to a source that was never retrieved reached the user");
  });
});

describe("BUG: a citation written with a space ('[source: JIRA-1]') is not read as a citation", () => {
  // Same cause (soclaas-company-agent.ts:386): the id may not start with whitespace.
  test("3 a correctly cited answer is replaced by 'Insufficient Evidence'", async () => {
    const spaced = "Bob owns the payments service [source: JIRA-1].";
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, spaced, spaced],
      "Who owns payments?",
      {},
      [JIRA],
    );
    assert.doesNotMatch(result.answer, INSUFFICIENT, result.answer);
  });

  test("4 a made-up id with a space ('[source: SLACK-99]') beside a real citation is delivered", async () => {
    const made = "Bob owns payments [source:JIRA-1]. It shuts down next month [source: SLACK-99].";
    const { result } = await run(
      [{ calls: [["search_company_knowledge", { query: "payments" }]] }, made, made],
      "What is happening with payments?",
      {},
      [JIRA],
    );
    assert.doesNotMatch(result.answer, /SLACK-99/, "a citation to a source that was never retrieved reached the user");
  });
});

describe("BUG: the same recruiting_start repeated in the next step opens a second role", () => {
  // The dedupe (soclaas-company-agent.ts:~885) resets `previous` every step, so an identical call
  // that is the very next call, but in the model's next reply, runs again.
  test("5 the model repeats recruiting_start after its result: two roles are opened", async () => {
    const extension = recruitingExtension();
    const start = ["recruiting_start", { requirement: "Founding backend engineer, Singapore, TypeScript" }] as [string, object];
    await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [start] },
        { calls: [start] },
        { calls: [["show_recruiting_panel", { view: "criteria" }]] },
        "I opened the role; review the criteria in the panel below.",
      ],
      "I want to hire a founding backend engineer in Singapore who knows TypeScript",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.equal(extension.ran.filter((name) => name === "recruiting_start").length, 1, extension.ran.join(", "));
  });
});

// ------------------------------------------------------------------------------------------------
type FakeCandidate = Record<string, unknown>;
function snapshotWith(inView: number) {
  const candidates: FakeCandidate[] = Array.from({ length: inView }, (_, index) => ({
    id: `cand${index + 1}`,
    profile: { name: `Person ${index + 1}`, headline: "Engineer" },
    tier: index < 5 ? 100 : index < 12 ? 75 : 50,
    stage: "scored",
    settled: true,
    kept: false,
    messages: [],
  }));
  return {
    role: { title: "Founding Backend Engineer", confirmed: true },
    criteria: [{ id: "k1", text: "TypeScript", kind: "must" }],
    candidates,
    integrations: { source: "sample", gmail: false },
    rounds: [{ query: "typescript engineer" }],
    busy: false,
    proposals: [],
    lastError: null,
  };
}

describe("BUG: the model sees only the first 15 people in view, so it cannot act on the rest", () => {
  // statusForModel (src/recruiting/chat-tools.ts:231) slices the in-view list to 15. The panel shows
  // everyone; recruiting_prepare_outreach and the candidate panel need an id the model never gets.
  test("6 with 20 people in view, 'draft a message to Person 20' has no id to use", () => {
    const status = JSON.stringify(statusForModel(snapshotWith(20) as never));
    assert.match(status, /cand20/, "the 20th person in view is not in anything the model can read");
  });
});

// ------------------------------------------------------------------------------------------------
describe("NOT A BUG (verified)", () => {
  test("adjacent single tags '[source:JIRA-1][source:CONF-2]' pass, with both sources", async () => {
    const { result, calls } = await run(
      [{ calls: [["search_company_knowledge", { query: "owners" }]] }, "Bob owns payments and Alice billing [source:JIRA-1][source:CONF-2]."],
      "Who owns payments and billing?",
    );
    assert.equal(calls, 2);
    assert.deepEqual(result.sources.map((source) => source.sourceId).sort(), ["CONF-2", "JIRA-1"]);
  });

  test("a made-up single tag is caught and repaired", async () => {
    const { result } = await run(
      [
        { calls: [["search_company_knowledge", { query: "payments" }]] },
        "Bob owns payments [source:SLACK-99].",
        "Bob owns payments [source:JIRA-1].",
      ],
      "Who owns payments?",
      {},
      [JIRA],
    );
    assert.equal(result.answer, "Bob owns payments [source:JIRA-1].");
  });

  test("the same read repeated across steps with a change in between runs both times", async () => {
    const extension = recruitingExtension();
    await run(
      [
        { calls: [["load_skill", { name: "recruiting" }]] },
        { calls: [["recruiting_status", {}]] },
        { calls: [["recruiting_start", { requirement: "Backend engineer" }]] },
        { calls: [["recruiting_status", {}]] },
        "Opened.",
      ],
      "hire a backend engineer",
      { skills: [recruitingSkill], extensions: [extension] },
    );
    assert.equal(extension.ran.filter((name) => name === "recruiting_status").length, 2);
  });

  test("with 15 or fewer people in view every id reaches the model", () => {
    const status = JSON.stringify(statusForModel(snapshotWith(15) as never));
    for (let index = 1; index <= 15; index += 1) assert.match(status, new RegExp(`cand${index}\\b`));
  });
});
