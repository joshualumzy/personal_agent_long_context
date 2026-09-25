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

// ---- fakes copied from test/recruiting.test.ts (not exported there) ----
function profile(id: string, traits: string, location = "Singapore"): CandidateProfile {
  return {
    id,
    name: `Person ${id}`,
    headline: traits,
    location,
    profileUrl: `https://example.com/${id}`,
    workHistory: [{ title: "Engineer", company: `Company ${id}` }],
    educationHistory: [],
    summary: traits,
  };
}

/** Six people for the first round, three more that only a wider search finds. */
const POOL = [
  profile("a", "typescript startup rust"),
  profile("b", "typescript startup"),
  profile("c", "typescript consulting"),
  profile("d", "typescript consulting"),
  profile("e", "java bigco"),
  profile("f", "typescript startup rust"),
];
const WIDER = [profile("g", "typescript startup rust remote", "Jakarta"), profile("h", "typescript remote", "Manila")];

class FakeSource implements CandidateSource {
  readonly name = "fake";
  readonly queries: string[] = [];
  async search(query: string): Promise<CandidateProfile[]> {
    this.queries.push(query);
    return query.includes("remote") ? [...WIDER, ...POOL] : POOL;
  }
}

/**
 * Judges by keyword: a criterion "typescript" is met when the profile summary
 * contains that word. Enough to drive every tier deterministically.
 */
function fakeModel(): JsonModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      calls.push(task);
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return {
            title: "Founding backend engineer",
            criteria: [
              { text: "typescript", kind: "must" },
              { text: "startup", kind: "must" },
              { text: "rust", kind: "nice" },
              { text: "under 30", kind: "must" },
            ],
            query: "typescript startup engineer singapore",
          } as T;
        case "criterion judgement":
          return {
            verdicts: data.criteria.map((criterion: { id: string; text: string }) => ({
              criterionId: criterion.id,
              satisfied: data.profile.summary.includes(criterion.text) ? "yes" : "no",
              reasoning: "keyword",
            })),
          } as T;
        case "reason inference":
          return { reason: data.profile.summary.includes("consulting") ? "consulting only" : "other" } as T;
        case "preference pattern": {
          const consultants = data.decisions.filter((entry: { reason: string }) => entry.reason === "consulting only");
          return (
            consultants.length >= 2
              ? {
                  found: true,
                  text: "startup",
                  kind: "must",
                  rationale: "You passed on two consultants.",
                  supportingCandidateIds: consultants.map((entry: { candidateId: string }) => entry.candidateId),
                }
              : { found: false }
          ) as T;
        }
        case "search query":
          return {
            queries: [`typescript startup engineer singapore ${data.previous.length + 1}`],
          } as T;
        case "pool expansion":
          return { query: "typescript engineer remote", operations: [], rationale: "Accept remote." } as T;
        case "outreach draft":
          return { subject: `Hello ${data.candidate.name}`, body: `Your work on ${data.whyTheyFit.join(", ")} stood out.` } as T;
        case "instruction interpretation":
          if (String(data.said).includes("Rust is required")) {
            const rust = data.criteria.find((criterion: { text: string }) => criterion.text === "rust");
            return { intent: "criteria", operations: [{ op: "set_kind", id: rust.id, kind: "must" }] } as T;
          }
          if (String(data.said).includes("women")) {
            return { intent: "criteria", operations: [{ op: "add", text: "women only", kind: "must" }] } as T;
          }
          return { intent: "unknown" } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        case "reply reading":
          return {
            candidateId: data.knownCandidateId,
            interested: !String(data.message).includes("not interested"),
            wantsToSchedule: String(data.message).includes("Tuesday"),
            summary: "Replied.",
          } as T;
        default:
          throw new Error(`Unscripted task ${task}`);
      }
    },
  };
}

// ---- harness ----

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not met in time.");
}

/** A board whose recruiting model can be made to fail like a real LLM outage. */
function boardSetup() {
  const inner = fakeModel();
  const outage = { on: false };
  const model: JsonModel = {
    async json<T>(request: Parameters<JsonModel["json"]>[0]): Promise<T> {
      if (outage.on) throw new Error(`The model could not complete ${request.task}: fetch failed`);
      return inner.json<T>(request);
    },
  };
  const source = new FakeSource();
  const memory = new LocalIntentMemory();
  const board = new RoleBoard(
    new MemoryRoleRepository(),
    (store) =>
      new RecruitingService({
        model,
        source,
        store,
        memory,
        contactFinders: [],
        gmail: null,
        clock: () => new Date("2026-09-23T02:00:00.000Z"),
        settings: { resultsPerQuery: 6 },
      }),
  );
  return { board, outage };
}

async function draftRole() {
  const setup = boardSetup();
  const { id, service } = setup.board.create();
  await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
  return { ...setup, roleId: id, service };
}

async function confirmedRole() {
  const setup = await draftRole();
  await setup.service.confirm();
  await setup.service.settle();
  return setup;
}

const REQUIREMENT = "We need a founding backend engineer in Singapore who knows TypeScript.";

describe("recruiting_status", () => {
  test("zero roles", async () => {
    const { board } = boardSetup();
    const out = JSON.parse((await recruitingExtension(board).run("recruiting_status", {})).content);
    assert.deepEqual(out, { roles: [] });
  });

  test("one role: detail comes without asking", async () => {
    const { board, roleId } = await confirmedRole();
    const out = JSON.parse((await recruitingExtension(board).run("recruiting_status", {})).content);
    assert.equal(out.role_id, roleId);
    assert.equal(out.status.role.confirmed, true);
  });

  test("several roles: no detail until one is named", async () => {
    const { board } = await confirmedRole();
    await recruitingExtension(board).run("recruiting_start", { requirement: REQUIREMENT });
    const out = JSON.parse((await recruitingExtension(board).run("recruiting_status", {})).content);
    assert.equal(out.roles.length, 2);
    assert.equal(out.status, undefined);
  });

  test("an unknown role_id is a tool error, not a throw", async () => {
    const { board } = await confirmedRole();
    const out = await recruitingExtension(board).run("recruiting_status", { role_id: "nosuchrole" });
    assert.match(out.content, /No such role/);
  });

  test("a role_id with stray whitespace is accepted like every other tool accepts it", async () => {
    const { board, roleId } = await confirmedRole();
    const tools = recruitingExtension(board);
    // Every scoped tool trims role_id; this one reads status fine.
    assert.ok((await tools.run("show_recruiting_panel", { role_id: ` ${roleId} `, view: "pool" })).block);
    const out = JSON.parse((await tools.run("recruiting_status", { role_id: ` ${roleId} ` })).content);
    assert.equal(out.error, undefined, `recruiting_status refused a role_id show_recruiting_panel accepted: ${JSON.stringify(out)}`);
  });
});

describe("recruiting_start", () => {
  test("a missing requirement is a tool error", async () => {
    const { board } = boardSetup();
    const out = await recruitingExtension(board).run("recruiting_start", {});
    assert.match(out.content, /requirement is required/);
    assert.deepEqual(await board.list(), []);
  });

  test("a recruiting model outage becomes a tool error the chat model can report, not a thrown error", async () => {
    const { board, outage } = boardSetup();
    outage.on = true;
    const out = await recruitingExtension(board)
      .run("recruiting_start", { requirement: REQUIREMENT })
      .catch((error: Error) => ({ content: `THREW: ${error.message}` }));
    assert.doesNotMatch(out.content, /^THREW/, out.content);
  });

  test("...and so the whole chat turn fails instead of the agent explaining it", async () => {
    const { board, outage } = boardSetup();
    outage.on = true;
    const replies: object[] = [
      { content: null, tool_calls: [{ id: "a", type: "function", function: { name: "load_skill", arguments: '{"name":"recruiting"}' } }] },
      {
        content: null,
        tool_calls: [
          { id: "b", type: "function", function: { name: "recruiting_start", arguments: JSON.stringify({ requirement: REQUIREMENT }) } },
        ],
      },
      { content: "The hiring model is down right now; try again in a minute." },
    ];
    const knowledge: CompanyKnowledge = {
      async employee() {
        return { employeeId: "jax", displayName: "Jax", currentAssignments: [] };
      },
      async search() {
        return [];
      },
      async related() {
        return [];
      },
      async sources() {
        return [];
      },
    };
    const agent = new SoCLaaSCompanyAgent(knowledge, {
      apiKey: "k",
      skills: [parseSkill("---\nname: recruiting\ndescription: Hiring.\n---\nBody")],
      extensions: [recruitingExtension(board)],
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }), { status: 200 }),
    });
    const result = await agent.answer({ employeeId: "jax", question: "Hire a backend engineer" });
    assert.match(result.answer, /down/);
  });
});

describe("argument validation", () => {
  test("revise_criteria with criteria sent as a JSON string is refused, not treated as 'delete every criterion'", async () => {
    const { board, roleId, service } = await draftRole();
    const before = (await service.snapshot()).criteria.length;
    assert.ok(before > 0);
    const out = await recruitingExtension(board).run("recruiting_revise_criteria", {
      role_id: roleId,
      criteria: JSON.stringify([{ text: "typescript", kind: "must" }]),
    });
    const after = (await service.snapshot()).criteria.length;
    assert.equal(after, before, `draft criteria were wiped; tool said ${out.content.slice(0, 120)}`);
  });

  test("resolve_proposal with accept as the string \"true\" does not silently decline", async () => {
    const { board, roleId, service } = await confirmedRole();
    await service.fastForward(8);
    const [proposal] = (await service.snapshot()).proposals;
    assert.ok(proposal);
    const out = await recruitingExtension(board).run("recruiting_resolve_proposal", {
      role_id: roleId,
      proposal_id: proposal.id,
      accept: "true",
    });
    const refused = JSON.parse(out.content).error !== undefined;
    const accepted = await waitFor(async () => (await service.snapshot()).rounds.length === 2, 500).then(
      () => true,
      () => false,
    );
    assert.ok(refused || accepted, "the founder said yes, the tool recorded no");
  });

  test("show_recruiting_panel: bad view, missing role, missing candidate are tool errors", async () => {
    const { board, roleId } = await confirmedRole();
    const tools = recruitingExtension(board);
    const bad = await tools.run("show_recruiting_panel", { role_id: roleId, view: "chart" });
    assert.equal(bad.block, undefined);
    assert.match(bad.content, /Unknown panel view/);
    const noRole = await tools.run("show_recruiting_panel", { view: "pool" });
    assert.equal(noRole.block, undefined);
    const ghostRole = await tools.run("show_recruiting_panel", { role_id: "ghost", view: "pool" });
    assert.equal(ghostRole.block, undefined);
    const noCandidate = await tools.run("show_recruiting_panel", { role_id: roleId, view: "candidate" });
    assert.equal(noCandidate.block, undefined);
    const ok = await tools.run("show_recruiting_panel", { role_id: roleId, view: "pool" });
    assert.deepEqual(ok.block, { type: "recruiting", view: "pool", roleId });
  });
});

describe("statusForModel", () => {
  test("handles pending tiers, missing contact/draft, legacy rounds, and no role", () => {
    const base = {
      role: null,
      criteria: [],
      rounds: [{ round: 0, query: "q", at: "", found: 0, added: 0 }],
      busy: false,
      proposals: [],
      lastError: null,
      integrations: { source: "fake", contactFinders: [], gmail: null },
      candidates: [
        { id: "p", profile: { name: "P", headline: "h" }, tier: "pending", settled: false, stage: "discovered", kept: false, contact: null, draft: null },
        { id: "q", profile: { name: "Q", headline: "h" }, tier: 50, settled: true, stage: "scored", kept: false, contact: null, draft: null },
        { id: "r", profile: { name: "R", headline: "h" }, tier: 100, settled: true, stage: "scored", kept: true, contact: { status: "found" }, draft: {} },
      ],
    };
    const out = statusForModel(base as never);
    assert.equal(out.role, null);
    assert.deepEqual(out.searches, [["q"]]);
    assert.deepEqual(out.candidates.map((c) => c.id), ["r", "q", "p"]);
    assert.equal(out.counts.pending, 1);
    assert.equal(out.candidates[2]!.email, "none");
  });
});
