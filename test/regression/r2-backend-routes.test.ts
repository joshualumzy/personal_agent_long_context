/**
 * Round 2 bug hunt: HTTP routes, the role board, and damaged role files.
 * Every test asserts the CORRECT behaviour; each failure demonstrates one bug.
 * Run: node --import tsx --test test/hunt/r2-backend-routes.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { buildApp } from "../../src/http-app.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { JsonRoleRepository, MemoryRoleRepository, RoleBoard, type RoleRepository } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";

const REQUIREMENT = "We need a founding backend engineer in Singapore who knows TypeScript.";

function profile(id: string, traits: string): CandidateProfile {
  return {
    id,
    name: `Person ${id}`,
    headline: traits,
    location: "Singapore",
    profileUrl: `https://example.com/${id}`,
    workHistory: [{ title: "Engineer", company: `Company ${id}` }],
    educationHistory: [],
    summary: traits,
  };
}

const POOL = [profile("a", "typescript startup rust"), profile("b", "typescript startup")];

class FakeSource implements CandidateSource {
  readonly name = "fake";
  gate: Promise<void> | null = null;
  entered: (() => void) | null = null;
  async search(): Promise<CandidateProfile[]> {
    if (this.gate) {
      this.entered?.();
      await this.gate;
    }
    return POOL;
  }
}

function fakeModel(): JsonModel {
  return {
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return {
            title: "Founding backend engineer",
            criteria: [
              { text: "typescript", kind: "must" },
              { text: "startup", kind: "must" },
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
        case "search query":
          return { queries: ["typescript startup engineer"] } as T;
        case "outreach draft":
          return { subject: `Hello ${data.candidate.name}`, body: "Hi." } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        case "reply reading":
          return {
            candidateId: data.knownCandidateId ?? data.candidates[0]?.id ?? null,
            interested: null,
            wantsToSchedule: false,
            summary: "Replied.",
          } as T;
        case "pool expansion":
          return { query: "typescript engineer remote", operations: [], rationale: "Accept remote." } as T;
        default:
          return {} as T;
      }
    },
  };
}

function makeBoard(repository: RoleRepository, options: { source?: FakeSource; clock?: () => Date } = {}) {
  return new RoleBoard(
    repository,
    (store) =>
      new RecruitingService({
        model: fakeModel(),
        source: options.source ?? new FakeSource(),
        store,
        memory: new LocalIntentMemory(),
        contactFinders: [],
        gmail: null,
        clock: options.clock ?? (() => new Date("2026-09-23T02:00:00.000Z")),
        settings: { resultsPerQuery: 6 },
      }),
  );
}

function appFor(board: RoleBoard) {
  return buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
}

async function createRole(app: ReturnType<typeof appFor>): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/api/recruiting/roles", payload: { text: REQUIREMENT } });
  assert.equal(created.statusCode, 200, created.body);
  return created.json().roleId;
}

const AT = "2026-09-23T02:00:00.000Z";

/** A saved role as the service writes it, with candidate "a" intact. */
function savedRole(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    role: { title: "Backend engineer", requirement: REQUIREMENT, confirmed: true, createdAt: AT },
    criteria: [{ id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT }],
    candidates: {
      a: {
        profile: profile("a", "typescript"),
        poolRound: 1,
        discoveredAt: AT,
        stage: "scored",
        kept: false,
        verdicts: { c1: { criterionId: "c1", satisfied: "yes", reasoning: "x" } },
        messages: [],
        followUps: 0,
      },
    },
    feedback: [],
    proposals: [],
    rounds: [{ round: 1, query: "q", queries: ["q"], at: AT, found: 1, added: 1 }],
    expansionStep: 0,
    clockOffsetDays: 0,
    events: [],
    ...overrides,
  };
}

async function directoryWith(files: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "r2-roles-"));
  for (const [id, content] of Object.entries(files)) {
    await writeFile(join(directory, `${id}.json`), typeof content === "string" ? content : JSON.stringify(content));
  }
  return directory;
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ bugs

describe("r2 routes: candidate ids from the URL", () => {
  test("POST /candidates/__proto__/close is a 404 and leaves Object.prototype alone", async () => {
    const board = makeBoard(new MemoryRoleRepository());
    const app = appFor(board);
    const roleId = await createRole(app);
    await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
    const proto = Object.prototype as Record<string, unknown>;
    try {
      const closed = await app.inject({
        method: "POST",
        url: `/api/recruiting/roles/${roleId}/candidates/__proto__/close`,
        payload: { reason: "withdrawn" },
      });
      const polluted = ({} as Record<string, unknown>).closedReason;
      assert.equal(polluted, undefined, `every object in the process now has closedReason=${String(polluted)}`);
      assert.equal(closed.statusCode, 404, closed.body);
    } finally {
      delete proto.stage;
      delete proto.closedReason;
      delete proto.closedAt;
    }
  });
});

describe("r2 routes: proposals", () => {
  test("a proposal request without accept is refused, not taken as a decline", async () => {
    const pending = {
      id: "p1",
      type: "expansion",
      status: "pending",
      createdAt: AT,
      step: 0,
      stepName: "Widen location",
      rationale: "Accept remote.",
      query: "typescript engineer remote",
      operations: [],
    };
    const directory = await directoryWith({ role1: savedRole({ proposals: [pending] }) });
    const app = appFor(makeBoard(new JsonRoleRepository(directory)));
    const answered = await app.inject({ method: "POST", url: "/api/recruiting/roles/role1/proposals/p1", payload: {} });
    const state = (await app.inject({ method: "GET", url: "/api/recruiting/roles/role1/state" })).json();
    assert.equal(state.proposals.length, 1, "the proposal was declined by a request that never said no");
    assert.equal(answered.statusCode, 400);
  });
});

describe("r2 routes: damaged role files load as far as they can", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a candidate without verdicts", { b: { profile: profile("b", "x"), stage: "discovered", messages: [], followUps: 0 } }],
    ["a candidate without messages", { b: { profile: profile("b", "x"), stage: "discovered", verdicts: {}, followUps: 0 } }],
    ["a null candidate", { b: null }],
  ];
  for (const [label, extra] of cases) {
    test(`a role with ${label} is still listed and readable`, async () => {
      const base = savedRole();
      const directory = await directoryWith({
        role1: { ...base, candidates: { ...(base.candidates as object), ...extra } },
      });
      const app = appFor(makeBoard(new JsonRoleRepository(directory)));
      const state = await app.inject({ method: "GET", url: "/api/recruiting/roles/role1/state" });
      assert.equal(state.statusCode, 200, state.body);
      const roles = (await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json().roles;
      assert.equal(roles.length, 1, "the whole role vanished from the list");
    });
  }

  test("one role file whose role lacks createdAt does not take the role list down", async () => {
    const directory = await directoryWith({
      good: savedRole(),
      good2: savedRole({ role: { title: "PM", requirement: REQUIREMENT, confirmed: true, createdAt: "2026-09-24T00:00:00.000Z" } }),
      aodd: savedRole({ role: { title: "Designer", requirement: REQUIREMENT, confirmed: true } }),
    });
    const app = appFor(makeBoard(new JsonRoleRepository(directory)));
    const listed = await app.inject({ method: "GET", url: "/api/recruiting/roles" });
    assert.equal(listed.statusCode, 200, listed.body);
  });

  test("a role file that was unreadable once comes back after it is repaired", async () => {
    const directory = await directoryWith({ role1: "{ half written" });
    const app = appFor(makeBoard(new JsonRoleRepository(directory)));
    const before = (await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json().roles;
    assert.equal(before.length, 0);
    await writeFile(join(directory, "role1.json"), JSON.stringify(savedRole()));
    const after = (await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json().roles;
    assert.equal(after.length, 1, "the repaired role stays hidden until the server restarts");
  });
});

describe("r2 routes: LinkedIn inbox picks the newest role", () => {
  test("a conversation with someone two roles contacted goes to the newer role", async () => {
    let now = new Date("2026-09-23T02:00:00.000Z");
    const board = makeBoard(new MemoryRoleRepository(), { clock: () => now });
    const app = appFor(board);
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const roleId = await createRole(app);
      ids.push(roleId);
      await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
      await (await board.get(roleId)).settle();
      await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/candidates/a/outreach`, payload: {} });
      await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/candidates/a/send`, payload: { manual: true } });
      now = new Date(now.getTime() + 86_400_000);
    }
    const [older, newer] = ids;
    const listed = (await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json().roles;
    assert.equal(listed[0].id, newer, "sanity: the list shows the newer role first");
    await app.inject({
      method: "POST",
      url: "/api/recruiting/inbox/linkedin",
      payload: { threads: [{ text: "Person a: thanks, tell me more" }] },
    });
    const inbound = async (roleId: string) =>
      (await app.inject({ method: "GET", url: `/api/recruiting/roles/${roleId}/state` }))
        .json()
        .candidates.find((candidate: { id: string }) => candidate.id === "a")
        .messages.filter((message: { direction: string }) => message.direction === "inbound").length;
    assert.equal(await inbound(newer!), 1, `the reply went to the older role (${await inbound(older!)} there)`);
  });
});

describe("r2 roles: deleting a role", () => {
  test("a request that arrives while a role is being deleted cannot bring it back", async () => {
    const source = new FakeSource();
    const board = makeBoard(new MemoryRoleRepository(), { source });
    const app = appFor(board);
    const roleId = await createRole(app);
    // Hold a change in progress: confirm waits on the search provider.
    let release!: () => void;
    source.gate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (source.entered = resolve));
    const confirming = app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/confirm`, payload: {} });
    await entered;
    const removing = app.inject({ method: "DELETE", url: `/api/recruiting/roles/${roleId}` });
    await tick();
    // The founder's other tab acts on the role while the delete waits.
    const late = app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/fast-forward`, payload: { days: 1 } });
    await tick();
    source.gate = null;
    release();
    await Promise.all([confirming, removing]);
    const lateAnswer = await late;
    await tick(50);
    const ghost = await app.inject({ method: "GET", url: `/api/recruiting/roles/${roleId}/state` });
    // Any later change through the cached service writes the role back.
    await app.inject({ method: "POST", url: `/api/recruiting/roles/${roleId}/fast-forward`, payload: { days: 1 } });
    await tick(50);
    const roles = (await app.inject({ method: "GET", url: "/api/recruiting/roles" })).json().roles;
    assert.deepEqual(
      { stateAnswer: ghost.statusCode, listed: roles.length },
      { stateAnswer: 404, listed: 0 },
      `late request answered ${lateAnswer.statusCode}; the deleted role still answers and is listed again`,
    );
  });
});
