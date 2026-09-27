// From the off-script conversation run (test/hunt/chaos): items 1, 2, 3, 4, 7, 11, 12, 13.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CompanyKnowledge } from "../../src/company-domain.js";
import { recruitingExtension, statusForModel } from "../../src/recruiting/chat-tools.js";
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
  async search() { return [{ sourceId: "JIRA-1", sourceType: "jira", title: "t", excerpt: "e" }]; },
  async related() { return []; },
  async sources() { return []; },
};

function person(id: string, summary: string): CandidateProfile {
  return { id, name: `Person ${id}`, headline: summary, location: "Singapore", profileUrl: `https://www.linkedin.com/in/${id}`, workHistory: [], educationHistory: [], summary };
}
const recruitingModel: JsonModel = {
  async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
    const data = input as Record<string, any>;
    if (task === "criteria extraction") return { title: "Engineer", criteria: [{ text: "typescript", kind: "must" }, { text: "rust", kind: "nice" }], queries: ["q"] } as T;
    if (task === "criterion judgement") return { verdicts: data.criteria.map((c: any) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) } as T;
    if (task === "reason inference") return { reason: "other" } as T;
    if (task === "search query") return { queries: [`more ${data.previous.length}`] } as T;
    throw new Error(`unscripted ${task}`);
  },
};
const source: CandidateSource = { name: "fake", search: async (query) => (query.startsWith("more") ? [] : [person("a", "typescript rust"), person("b", "typescript"), person("c", "java")]) };

function board() {
  return new RoleBoard(new MemoryRoleRepository(), (store) =>
    new RecruitingService({ model: recruitingModel, source, store, memory: new LocalIntentMemory(), contactFinders: [], gmail: null }),
  );
}
async function confirmedRole() {
  const roles = board();
  const { id, service } = roles.create();
  await service.start("We need an engineer who knows TypeScript well, Rust a bonus.");
  await service.confirm();
  await service.settle();
  return { roles, id, service };
}

type Turn = { content?: string | null; calls?: Array<[string, object]> } | { status: number };
function agentWith(turns: Turn[], roles: RoleBoard | null, seen: any[] = []) {
  return new SoCLaaSCompanyAgent(knowledge, {
    apiKey: "k",
    model: "qwen3.8:27b",
    retryBaseMs: 5,
    ...(roles ? { skills: [parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody.")], extensions: [recruitingExtension(roles)] } : {}),
    fetch: (async (_url: unknown, init?: { body?: unknown }) => {
      seen.push(JSON.parse(String(init?.body)));
      const turn = turns.shift();
      if (!turn) throw new Error("script ran out");
      if ("status" in turn) return new Response("busy", { status: turn.status });
      const message = { content: turn.content ?? null, ...(turn.calls ? { tool_calls: turn.calls.map(([name, args], i) => ({ id: `c${seen.length}${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } : {}) };
      return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    }) as typeof fetch,
  });
}

describe("off-script conversations", () => {
  test("a rate-limited step is retried instead of failing the turn", async () => {
    const agent = agentWith([{ status: 429 }, { calls: [["search_company_knowledge", { query: "x" }]] }, { content: "Done [source:JIRA-1]" }], null);
    const result = await agent.answer({ employeeId: "jax", question: "status?" });
    assert.match(result.answer, /Done/);
  });

  test("what the model says alongside a tool call reaches the user, and a doubled reply is shown once", async () => {
    const { roles, id } = await confirmedRole();
    const answer = "The strongest candidates are Person a and Person b; Person a also has Rust.";
    const agent = agentWith([
      { calls: [["load_skill", { name: "recruiting" }]] },
      { content: answer, calls: [["show_recruiting_panel", { role_id: id, view: "pool" }]] },
      { content: `Let me know if you want to reach out.\n\nLet me know if you want to reach out.` },
    ], roles);
    const result = await agent.answer({ employeeId: "jax", question: "who are the best?" });
    assert.match(result.answer, /strongest candidates are Person a/);
    assert.equal(result.answer.match(/Let me know if you want to reach out/g)?.length, 1);
  });

  test("a recruiting answer is not forced through the citation check because company search ran first", async () => {
    const { roles, id } = await confirmedRole();
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "why typescript" }]] },
      { calls: [["load_skill", { name: "recruiting" }]] },
      { calls: [["recruiting_status", { role_id: id }]] },
      { content: "You asked for TypeScript yourself when you opened the role." },
    ], roles);
    const result = await agent.answer({ employeeId: "jax", question: "why do we need typescript?" });
    assert.match(result.answer, /You asked for TypeScript yourself/);
  });

  test("the insufficient-evidence fallback speaks the user's language", async () => {
    const agent = agentWith([
      { calls: [["search_company_knowledge", { query: "预算" }]] },
      { content: "预算是一百万。" },
      { content: "预算是一百万。" },
    ], null);
    const result = await agent.answer({ employeeId: "jax", question: "我们第三季度的预算是多少？" });
    assert.match(result.answer, /[一-鿿]/);
  });

  test("a Chinese question gets a Chinese answer even when the model first answers in English", async () => {
    const { roles, id } = await confirmedRole();
    const agent = agentWith([
      { calls: [["load_skill", { name: "recruiting" }]] },
      { calls: [["recruiting_status", { role_id: id }]] },
      { content: "Two people fit well." },
      { content: "有两个人很合适。" },
    ], roles);
    const result = await agent.answer({ employeeId: "jax", question: "现在有几个合适的人？" });
    assert.match(result.answer, /两个人/);
  });

  test("undoing a pass really reopens the person", async () => {
    const { service } = await confirmedRole();
    await service.feedback("a", "pass", "too corporate");
    assert.equal((await service.snapshot()).candidates.find((c) => c.id === "a")!.stage, "closed");
    await service.feedback("a", "keep");
    const a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.notEqual(a.stage, "closed");
    assert.equal(a.kept, true);
  });

  test("status names the ring for each candidate", async () => {
    const { service } = await confirmedRole();
    const status = statusForModel(await service.snapshot());
    const byId = Object.fromEntries(status.candidates.map((c: any) => [c.id, c.ring]));
    assert.deepEqual(byId, { a: "centre", b: "middle", c: "outer" });
  });

  test("find more that finds nobody says so plainly", async () => {
    const { roles, id } = await confirmedRole();
    const outcome = await recruitingExtension(roles).run("recruiting_find_more", { role_id: id });
    assert.match(JSON.parse(outcome.content).result.message, /no new people/i);
  });
});
