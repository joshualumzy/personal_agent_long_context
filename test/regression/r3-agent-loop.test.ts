// Round 3 hunt: the chat agent's tool loop (src/soclaas-company-agent.ts), code changed since 71dd5f6.
// "BUG" tests fail today; "NOT A BUG" tests pass. The model is always a scripted fetch.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { CompanyKnowledge } from "../../src/company-domain.js";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { parseSkill } from "../../src/skills.js";
import { SoCLaaSCompanyAgent } from "../../src/soclaas-company-agent.js";

const knowledge: CompanyKnowledge = {
  async employee() { return { employeeId: "jax", displayName: "Jax", currentAssignments: [] }; },
  async search() { return [{ sourceId: "JIRA-1", sourceType: "jira", title: "Q3 budget", excerpt: "Q3 budget is $2M" }]; },
  async related() { return []; },
  async sources() { return []; },
};

function person(id: string, summary: string): CandidateProfile {
  return { id, name: `Person ${id}`, headline: summary, location: "Singapore", profileUrl: `https://www.linkedin.com/in/${id}`, workHistory: [], educationHistory: [], summary };
}
const recruitingModel: JsonModel = {
  async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
    const data = input as Record<string, any>;
    if (task === "criteria extraction") return { title: "Engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["q"] } as T;
    if (task === "criterion judgement") return { verdicts: data.criteria.map((c: any) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) } as T;
    if (task === "reason inference") return { reason: "other" } as T;
    if (task === "search query") return { queries: [`more ${data.previous.length}`] } as T;
    throw new Error(`unscripted ${task}`);
  },
};
const source: CandidateSource = { name: "fake", search: async (query) => (query.startsWith("more") ? [] : [person("a", "typescript")]) };
async function confirmedRole() {
  const roles = new RoleBoard(new MemoryRoleRepository(), (store) =>
    new RecruitingService({ model: recruitingModel, source, store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null }),
  );
  const { id, service } = roles.create();
  await service.start("We need an engineer who knows TypeScript.");
  await service.confirm();
  await service.settle();
  return { roles, id };
}

type Turn =
  | { content?: string | null; calls?: Array<[string, object]> }
  | { status: number; headers?: Record<string, string>; body?: BodyInit }
  | { throws: true };
function agentWith(turns: Turn[], opts: { roles?: RoleBoard; seen?: any[]; retryBaseMs?: number } = {}) {
  const seen = opts.seen ?? [];
  return new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "k",
    model: "qwen3.8:27b",
    retryBaseMs: opts.retryBaseMs ?? 1,
    ...(opts.roles ? { skills: [parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.")], extensions: [recruitingExtension(opts.roles)] } : {}),
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      seen.push(JSON.parse(String(init?.body)));
      const turn = turns.shift();
      if (!turn) throw new Error("script ran out");
      if ("throws" in turn) throw new TypeError("fetch failed");
      if ("status" in turn) return new Response(turn.body ?? "busy", { status: turn.status, headers: turn.headers ?? {} });
      const message = { content: turn.content ?? null, ...(turn.calls ? { tool_calls: turn.calls.map(([name, args], i) => ({ id: `c${seen.length}${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } : {}) };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    }) as typeof fetch,
  });
}

const EN_FALLBACK = /^Insufficient Evidence: I could not find/;
const ZH_FALLBACK = "证据不足：我没有找到能可靠支持这个回答的公司资料。";

// Records every retry pause without waiting for it.
const realSetTimeout = globalThis.setTimeout;
let pauses: number[] = [];
function recordPauses() {
  pauses = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    pauses.push(ms ?? 0);
    return realSetTimeout(fn, 0);
  }) as typeof setTimeout;
}
afterEach(() => { globalThis.setTimeout = realSetTimeout; });

// ---------------------------------------------------------------- retrying()

describe("BUG: retrying() around every model call", () => {
  test("a Retry-After far beyond any chat turn (1 hour) still makes the user wait ~90 s before failing", async () => {
    recordPauses();
    const agent = agentWith([
      { status: 429, headers: { "retry-after": "3600" } },
      { status: 429, headers: { "retry-after": "3600" } },
      { status: 429, headers: { "retry-after": "3600" } },
      { status: 429, headers: { "retry-after": "3600" } },
    ]);
    await assert.rejects(agent.answer({ employeeId: "jax", question: "status?" }));
    const total = pauses.reduce((a, b) => a + b, 0);
    assert.ok(total <= 30_000, `slept ${total} ms (pauses ${pauses.join(", ")}) for a server that asked for 3600 s, then failed anyway`);
  });

  test("a Retry-After given as an HTTP date is ignored (Number(date) is NaN), so the retry comes far too early", async () => {
    recordPauses();
    const when = new Date(Date.now() + 20_000).toUTCString();
    const agent = agentWith([
      { status: 429, headers: { "retry-after": when } },
      { content: "ok", calls: [["search_company_knowledge", { query: "x" }]] },
      { content: "Done [source:JIRA-1]" },
    ], { retryBaseMs: 1000 });
    await agent.answer({ employeeId: "jax", question: "status?" });
    assert.ok(pauses[0]! >= 15_000, `waited ${pauses[0]} ms although the server said "retry after ${when}"`);
  });

  test("the body of a discarded 429/503 response is never read or cancelled (the connection is held until GC)", async () => {
    let cancelled = 0;
    const body = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("busy")); }, cancel() { cancelled += 1; } });
    const agent = agentWith([
      { status: 503, body: body() },
      { status: 429, body: body() },
      { calls: [["search_company_knowledge", { query: "x" }]] },
      { content: "Done [source:JIRA-1]" },
    ]);
    await agent.answer({ employeeId: "jax", question: "status?" });
    assert.equal(cancelled, 2, "two failed responses were dropped with their bodies still open");
  });
});

describe("NOT A BUG: retrying()", () => {
  test("a 400 is not retried", async () => {
    const seen: any[] = [];
    const agent = agentWith([{ status: 400 }, { content: "never" }], { seen });
    await assert.rejects(agent.answer({ employeeId: "jax", question: "q" }), /400/);
    assert.equal(seen.length, 1);
  });

  test("a retried request sends the same body (the body is a string, not a consumed stream)", async () => {
    const seen: any[] = [];
    const agent = agentWith([{ status: 503 }, { calls: [["search_company_knowledge", { query: "x" }]] }, { content: "Done [source:JIRA-1]" }], { seen });
    await agent.answer({ employeeId: "jax", question: "q" });
    assert.deepEqual(seen[0], seen[1]);
  });

  test("each pause is capped at 30 s", async () => {
    recordPauses();
    const agent = agentWith([{ status: 429, headers: { "retry-after": "999" } }, { calls: [["search_company_knowledge", { query: "x" }]] }, { content: "Done [source:JIRA-1]" }]);
    await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(pauses[0], 30_000);
  });

  test("a 503 on a streaming step is retried before any token, so nothing is emitted twice", async () => {
    const tokens: string[] = [];
    const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
    let n = 0;
    const agent = new SoCLaaSCompanyAgent(knowledge, {
      apiKey: "k", retryBaseMs: 1,
      fetch: (async () => {
        n += 1;
        if (n === 1) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "a", type: "function", function: { name: "search_company_knowledge", arguments: "{\"query\":\"x\"}" } }] } }] }));
        if (n === 2) return new Response("busy", { status: 503 });
        return new Response(sse("Done [source:JIRA-1]"));
      }) as typeof fetch,
    });
    const result = await agent.answer({ employeeId: "jax", question: "q" }, { onToken: (t) => tokens.push(t) });
    assert.equal(tokens.join(""), "Done [source:JIRA-1]");
    assert.equal(result.answer, "Done [source:JIRA-1]");
  });
});

// ---------------------------------------------------------------- spoken text

describe("BUG: text spoken alongside tool calls is joined into the answer", () => {
  test("a long preamble ('I'll look this up...') is shown as part of the answer", async () => {
    const preamble = "Let me search the company knowledge base for the latest Jira tickets and Slack threads on this first.";
    const agent = agentWith([
      { content: preamble, calls: [["search_company_knowledge", { query: "budget" }]] },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "What is the Q3 budget?" });
    assert.doesNotMatch(result.answer, /Let me search/, `answer: ${JSON.stringify(result.answer)}`);
  });

  test("a stale draft the model corrected after searching is kept next to the correction (two contradictory numbers, the wrong one uncited)", async () => {
    const agent = agentWith([
      { content: "From what I recall, the Q3 budget is $1M and it was approved by finance in June.", calls: [["search_company_knowledge", { query: "budget" }]] },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "What is the Q3 budget?" });
    assert.doesNotMatch(result.answer, /\$1M/, `answer: ${JSON.stringify(result.answer)}`);
  });

  test("a claim restated with a citation in the final answer appears twice (dedup is exact-match only)", async () => {
    const agent = agentWith([
      { content: "The Atlas migration is blocked on the payments team's schema change.", calls: [["search_company_knowledge", { query: "atlas" }]] },
      { content: "The Atlas migration is blocked on the payments team's schema change [source:JIRA-1]." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "Why is Atlas blocked?" });
    assert.equal(result.answer.match(/Atlas migration is blocked/g)?.length, 1, `answer: ${JSON.stringify(result.answer)}`);
  });
});

describe("NOT A BUG: spoken text", () => {
  test("a short preamble (< 60 chars) is dropped", async () => {
    const agent = agentWith([
      { content: "Let me check.", calls: [["search_company_knowledge", { query: "b" }]] },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "budget?" });
    assert.equal(result.answer, "The Q3 budget is $2M [source:JIRA-1].");
  });

  test("an invalid citation in spoken text is still caught (whole answer is checked)", async () => {
    const agent = agentWith([
      { content: "Earlier notes say the Q3 budget is $1M according to the plan [source:FAKE-1].", calls: [["search_company_knowledge", { query: "b" }]] },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "budget?" });
    assert.doesNotMatch(result.answer, /FAKE-1/);
  });
});

// ---------------------------------------------------------------- withoutRepeats

describe("BUG: withoutRepeats deletes legitimate repeated paragraphs", () => {
  test("per-candidate notes: the second 'Strong match.' is deleted, leaving Bob with no verdict", async () => {
    const text = "**Alice**\n\nStrong match.\n\n**Bob**\n\nStrong match.\n\n**Carol**\n\nWeak match.";
    const agent = agentWith([{ content: text }]);
    const result = await agent.answer({ employeeId: "jax", question: "rate them", personalMemory: "ctx" });
    assert.equal(result.answer, text);
  });

  test("code: a repeated statement separated by blank lines is deleted, changing the program", async () => {
    const code = "```python\nx = 1\n\nprint(x)\n\nx = 2\n\nprint(x)\n```";
    const agent = agentWith([{ content: code }]);
    const result = await agent.answer({ employeeId: "jax", question: "show me", personalMemory: "ctx" });
    assert.equal(result.answer, code);
  });

  test("code: two blank lines inside a code block (PEP 8) are collapsed to one", async () => {
    const code = "```python\nimport os\n\n\ndef main():\n    pass\n```";
    const agent = agentWith([{ content: code }]);
    const result = await agent.answer({ employeeId: "jax", question: "show me", personalMemory: "ctx" });
    assert.equal(result.answer, code);
  });
});

describe("NOT A BUG: withoutRepeats", () => {
  test("repeated table rows and tight-list items (single newlines) are kept", async () => {
    const text = "| a | b |\n|---|---|\n| x | 1 |\n| x | 1 |\n\n- same\n- same";
    const agent = agentWith([{ content: text }]);
    const result = await agent.answer({ employeeId: "jax", question: "t", personalMemory: "ctx" });
    assert.equal(result.answer, text);
  });
});

// ---------------------------------------------------------------- language retry

describe("BUG: the language retry", () => {
  test("the translation is never re-checked: it can cite a source that was never retrieved", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "预算" }]] },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
      { content: "第三季度预算是两百万 [source:FAKE-9]。" },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "我们第三季度的预算是多少？" });
    assert.doesNotMatch(result.answer, /FAKE-9/, `answer: ${result.answer}; sources: ${result.sources.map((s) => s.sourceId)}`);
  });

  test("the translation can drop every citation while sources still lists them", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "预算" }]] },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
      { content: "第三季度预算是两百万，另外财务已经批准了一千万的额外预算。" },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "我们第三季度的预算是多少？" });
    assert.match(result.answer, /\[source:JIRA-1\]/, `uncited translated answer accepted: ${result.answer}`);
  });

  test("a failed (optional) translation call fails the whole turn although a valid answer exists", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "预算" }]] },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
      { throws: true }, { throws: true }, { throws: true }, { throws: true },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "我们第三季度的预算是多少？" }).catch((e: Error) => ({ answer: `THREW: ${e.message}` }));
    assert.match(result.answer, /\$2M/);
  });

  test("after a citation repair, the translation request does not contain the repaired answer (it translates the rejected one)", async () => {
    const seen: any[] = [];
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "预算" }]] },
      { content: "The Q3 budget is $1M." },
      { content: "The Q3 budget is $2M [source:JIRA-1]." },
      { content: "第三季度预算是一百万。" },
    ], { seen });
    const result = await agent.answer({ employeeId: "jax", question: "我们第三季度的预算是多少？" });
    const lastRequest = seen[seen.length - 1];
    const carriesRepair = lastRequest.messages.some((m: any) => typeof m.content === "string" && m.content.includes("The Q3 budget is $2M [source:JIRA-1]."));
    assert.ok(carriesRepair, `translation request lacks the repaired answer; final answer: ${result.answer}`);
  });

  test("an English answer with a single Chinese name counts as Chinese, so no retry happens", async () => {
    const seen: any[] = [];
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "王小明" }]] },
      { content: "王小明 is leading the Atlas migration this quarter and owns the rollout plan [source:JIRA-1]." },
      { content: "王小明正在负责本季度的 Atlas 迁移 [source:JIRA-1]。" },
    ], { seen });
    const result = await agent.answer({ employeeId: "jax", question: "王小明最近在做什么项目？" });
    assert.equal(seen.length, 3, `answer stayed in English: ${result.answer}`);
  });

  test("a Chinese question with English tech terms is not detected as Chinese: English fallback", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "rollback" }]] },
      { content: "Rollback uses helm." },
      { content: "Rollback uses helm." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "帮我把Kubernetes deployment的rollback流程整理一下" });
    assert.equal(result.answer, ZH_FALLBACK, `got: ${result.answer}`);
  });

  test("an English question about a Chinese-named colleague is treated as Chinese: extra call, answer replaced by Chinese", async () => {
    const seen: any[] = [];
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "王小明" }]] },
      { content: "He leads the Atlas migration [source:JIRA-1]." },
      { content: "他负责 Atlas 迁移 [source:JIRA-1]。" },
    ], { seen });
    const result = await agent.answer({ employeeId: "jax", question: "Who is 王小明?" });
    assert.equal(result.answer, "He leads the Atlas migration [source:JIRA-1].", `extra calls: ${seen.length - 2}`);
  });

  test("a Japanese question gets the Chinese fallback (kanji counted as Chinese)", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "budget" }]] },
      { content: "It is big." },
      { content: "It is big." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "東京オフィスの予算は？" });
    assert.notEqual(result.answer, ZH_FALLBACK, "a Japanese user was answered in Chinese");
  });
});

describe("NOT A BUG: language retry", () => {
  test("a mostly English question with one Chinese word is not Chinese: no extra call", async () => {
    const seen: any[] = [];
    const agent = agentWith([{ calls: [["search_company_knowledge", { query: "x" }]] }, { content: "Done [source:JIRA-1]" }], { seen });
    await agent.answer({ employeeId: "jax", question: "Summarize the 季度 report for the Atlas project please" });
    assert.equal(seen.length, 2);
  });

  test("a pasted English JD plus one Chinese line is treated as English (no extra call)", async () => {
    const seen: any[] = [];
    const jd = "We are hiring a senior backend engineer with TypeScript, Postgres and AWS experience. ".repeat(20);
    const agent = agentWith([{ calls: [["search_company_knowledge", { query: "x" }]] }, { content: "Done [source:JIRA-1]" }], { seen });
    await agent.answer({ employeeId: "jax", question: `帮我开这个职位：\n${jd}` });
    assert.equal(seen.length, 2);
  });

  test("a Chinese answer to a Chinese question costs no extra call", async () => {
    const seen: any[] = [];
    const agent = agentWith([{ calls: [["search_company_knowledge", { query: "x" }]] }, { content: "预算是两百万 [source:JIRA-1]" }], { seen });
    await agent.answer({ employeeId: "jax", question: "预算是多少？" });
    assert.equal(seen.length, 2);
  });
});

// ---------------------------------------------------------------- fallback, meta filter

describe("BUG: insufficient-evidence fallback and the meta filter", () => {
  test("a cited repair answer about the company's own 'citation check' feature is thrown away", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "citation check" }]] },
      { content: "The citation check rollout is blocked." },
      { content: "The citation check rollout is blocked on the schema migration [source:JIRA-1]." },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "Why is the citation check rollout blocked?" });
    assert.doesNotMatch(result.answer, EN_FALLBACK, `valid cited repair replaced by: ${result.answer}`);
  });

  test("an honest Chinese 'insufficient evidence' repair naming what is missing is rejected (only English is recognised)", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "预算" }]] },
      { content: "预算是一百万。" },
      { content: "证据不足：没有找到第三季度营销预算的审批记录。" },
    ]);
    const result = await agent.answer({ employeeId: "jax", question: "我们第三季度的营销预算是多少？" });
    assert.match(result.answer, /营销预算/, `what is missing was lost: ${result.answer}`);
  });
});

describe("NOT A BUG: meta filter", () => {
  test("a first-pass cited answer mentioning citations is kept", async () => {
    const agent = agentWith([{ calls: [["search_company_knowledge", { query: "x" }]] }, { content: "The citation check shipped [source:JIRA-1]." }]);
    const result = await agent.answer({ employeeId: "jax", question: "q" });
    assert.equal(result.answer, "The citation check shipped [source:JIRA-1].");
  });
});

// ---------------------------------------------------------------- groundedElsewhere

describe("BUG: groundedElsewhere = extensionRan || ...", () => {
  test("after a company search, one harmless recruiting_status call lets an uncited (and wrong) company claim through", async () => {
    const { roles, id } = await confirmedRole();
    const seen: any[] = [];
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "Q3 budget" }]] },
      { calls: [["load_skill", { name: "recruiting" }]] },
      { calls: [["recruiting_status", { role_id: id }]] },
      { content: "The Q3 budget is $1M, so we can afford two more hires; hiring has one strong candidate." },
      { content: "The Q3 budget is $2M [source:JIRA-1]; one strong candidate." },
    ], { roles, seen });
    const result = await agent.answer({ employeeId: "jax", question: "What's our Q3 budget, and how is hiring going?" });
    assert.doesNotMatch(result.answer, /\$1M/, `uncited company claim accepted: ${result.answer}`);
  });
});
