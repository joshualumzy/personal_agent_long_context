/**
 * Adversarial bug hunt, recruiting core. Every test here is expected to FAIL
 * against the current code; each failure demonstrates one bug.
 * Run: node --import tsx --test test/hunt/core-bugs.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findPattern, interpret } from "../../src/recruiting/agent.js";
import type { CandidateProfile, Criterion, RecruitingState } from "../../src/recruiting/domain.js";
import { emptyState } from "../../src/recruiting/domain.js";
import type { GmailClient } from "../../src/recruiting/gmail.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { MemoryStore, type StateStore } from "../../src/recruiting/store.js";

// ------------------------------------------------------------------ fakes

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

const POOL = [
  profile("a", "typescript startup rust"),
  profile("b", "typescript startup"),
  profile("c", "typescript consulting"),
  profile("d", "typescript consulting"),
  profile("e", "java bigco"),
  profile("f", "typescript startup rust"),
];

class FakeSource implements CandidateSource {
  readonly name = "fake";
  readonly queries: string[] = [];
  failNext = 0;
  async search(query: string): Promise<CandidateProfile[]> {
    this.queries.push(query);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("search provider timed out");
    }
    return POOL;
  }
}

type Override = (input: Record<string, any>) => unknown | Promise<unknown>;

function fakeModel(overrides: Record<string, Override> = {}): JsonModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      calls.push(task);
      const data = input as Record<string, any>;
      if (overrides[task]) return (await overrides[task]!(data)) as T;
      switch (task) {
        case "criteria extraction":
          return {
            title: "Founding backend engineer",
            criteria: [
              { text: "typescript", kind: "must" },
              { text: "startup", kind: "must" },
              { text: "rust", kind: "nice" },
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
          const ids = data.decisions.map((entry: { candidateId: string }) => entry.candidateId);
          return {
            found: true,
            text: "has shipped a product",
            kind: "must",
            rationale: "You passed on consultants.",
            supportingCandidateIds: ids,
          } as T;
        }
        case "search query":
          return { queries: [`typescript startup engineer singapore ${data.previous.length + 1}`] } as T;
        case "pool expansion":
          return { query: "typescript engineer remote", operations: [], rationale: "Accept remote." } as T;
        case "outreach draft":
          return { subject: `Hello ${data.candidate.name}`, body: "Short note." } as T;
        case "instruction interpretation":
          return { intent: "unknown" } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        case "reply reading":
          return {
            candidateId: data.knownCandidateId,
            interested: String(data.message).includes("not interested") ? false : null,
            wantsToSchedule: false,
            summary: "Replied.",
          } as T;
        default:
          throw new Error(`Unscripted task ${task}`);
      }
    },
  };
}

function setup(options: { model?: JsonModel; store?: StateStore; source?: FakeSource; gmail?: GmailClient | null } = {}) {
  let now = new Date("2026-09-23T02:00:00.000Z");
  const model = options.model ?? fakeModel();
  const source = options.source ?? new FakeSource();
  const store = options.store ?? new MemoryStore();
  const service = new RecruitingService({
    model,
    source,
    store,
    memory: new LocalIntentMemory(),
    contactFinders: [],
    gmail: options.gmail ?? null,
    clock: () => now,
    settings: { resultsPerQuery: 6 },
  });
  return { service, model, source, store, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function confirmed(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  await context.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
  await context.service.confirm();
  await context.service.settle();
  return context;
}

/** Waits until background work (feedback proposals, expansion) is done. */
async function idle(service: RecruitingService) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!(await service.snapshot()).busy) return;
  }
  throw new Error("background work never finished");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ------------------------------------------------------------------ bugs

describe("core bugs: service state machine", () => {
  test("confirm that fails mid-search can be retried", async () => {
    const source = new FakeSource();
    const { service, store } = setup({ source });
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    source.failNext = 1;
    await assert.rejects(service.confirm(), /timed out/);

    // Nothing was saved, so the founder should be able to press confirm again.
    const saved = await store.load();
    assert.equal(saved.role?.confirmed, false, "store still says draft");
    // actual: RecruitingError invalid_state "There are no draft criteria to confirm."
    await service.confirm();
    await service.settle();
    assert.ok((await service.snapshot()).candidates.length > 0);
  });

  test("two concurrent sends of one draft deliver it once", async () => {
    let sent = 0;
    const gmail = {
      connected: async () => true,
      send: async () => {
        sent += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { threadId: "t1" };
      },
    } as unknown as GmailClient;
    const { service } = await confirmed({ gmail });
    await service.prepareOutreach("a");
    await service.editDraft("a", { email: "a@example.com" });

    const results = await Promise.allSettled([service.send("a", false), service.send("a", false)]);
    const snapshot = await service.snapshot();
    const a = snapshot.candidates.find((candidate) => candidate.id === "a")!;
    assert.equal(sent, 1, `email sent ${sent} times; results: ${results.map((r) => r.status).join(",")}`);
    assert.equal(a.messages.filter((m) => m.direction === "outbound").length, 1);
  });

  test("sending a leftover draft does not reopen a closed candidate", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    await service.fastForward(5); // follow-up drafted
    let snap = await service.snapshot();
    assert.equal(snap.candidates.find((c) => c.id === "a")!.draft?.kind, "follow_up");

    await service.reply("Thanks but I am not interested.", "a", "pasted");
    snap = await service.snapshot();
    const declined = snap.candidates.find((c) => c.id === "a")!;
    assert.equal(declined.stage, "closed");

    // The stale follow-up is still sendable to someone who said no.
    await assert.rejects(service.send("a", true), "sending to a closed candidate should be refused");
    snap = await service.snapshot();
    assert.equal(snap.candidates.find((c) => c.id === "a")!.stage, "closed");
  });

  test("an unclear reply clears the pending follow-up nudge", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    await service.fastForward(5);
    await service.reply("Maybe, what is the salary range?", "a", "pasted");
    const a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.stage, "replied");
    assert.notEqual(a.draft?.kind, "follow_up", "a 'no answer yet' nudge is still queued after they answered");
  });

  test("two overlapping ticks create one expansion proposal", async () => {
    const gate = deferred();
    const model = fakeModel({
      "pool expansion": async () => {
        await gate.promise;
        return { query: "typescript engineer remote", operations: [], rationale: "Accept remote." };
      },
    });
    const { service, advance } = await confirmed({ model });
    advance(8 * 86_400_000);
    const first = service.tick();
    const second = service.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.resolve();
    await Promise.all([first, second]);
    const pending = (await service.snapshot()).proposals.filter((p) => p.type === "expansion");
    assert.equal(pending.length, 1, `got ${pending.length} pending expansion proposals for the same step`);
  });

  test("feedback on a candidate erased by retention does not break preference learning", async () => {
    const { service } = await confirmed();
    await service.feedback("e", "pass");
    await idle(service);
    await service.fastForward(30);
    await service.fastForward(2); // e closed >30 days ago: erased
    assert.equal((await service.snapshot()).candidates.some((c) => c.id === "e"), false);
    service.clearError();

    await service.feedback("c", "pass", "only consulting");
    await idle(service);
    const snap = await service.snapshot();
    assert.equal(snap.lastError, null, `background crashed: ${snap.lastError}`);
  });

  test("passing the same person twice is not two decisions", async () => {
    const { service } = await confirmed();
    await service.feedback("c", "pass", "only consulting");
    await idle(service);
    await service.feedback("c", "pass", "really, only consulting");
    await idle(service);
    const proposals = (await service.snapshot()).proposals.filter((p) => p.type === "criterion");
    assert.equal(
      proposals.length,
      0,
      `a preference was proposed from one person: ${JSON.stringify(proposals.map((p) => (p as any).supportingCandidateIds))}`,
    );
  });

  test("concurrent first load does not drop a change", async () => {
    // A store whose read captures the file first and parses later, like readFile + JSON.parse.
    const base = new MemoryStore();
    const seed = setup({ store: base });
    await seed.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await seed.service.confirm();
    await seed.service.settle();

    let loads = 0;
    const slowFirstLoad: StateStore = {
      async load() {
        const copy = await base.load();
        loads += 1;
        if (loads === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        return copy;
      },
      save: (state) => base.save(state),
    };
    const { service } = setup({ store: slowFirstLoad });
    const viewing = service.snapshot(); // e.g. RoleBoard.list() on a fresh process
    await service.close("a", "withdrawn");
    await viewing;
    const a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.stage, "closed", "the close was overwritten in memory by a stale load");
  });

  test("a model feedback reply without a decision does not pass the candidate", async () => {
    const model = fakeModel({
      "instruction interpretation": () => ({ intent: "feedback", candidateId: "a", summary: "about a" }),
    });
    const { service } = await confirmed({ model });
    await service.say("What do you think of Person a?");
    const a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.notEqual(a.stage, "closed", "a missing decision was treated as pass and closed the candidate");
  });

  test("the founder cannot remove every criterion after confirming", async () => {
    const model = fakeModel({
      "instruction interpretation": (data) => ({
        intent: "criteria",
        operations: data.criteria.map((criterion: { id: string }) => ({ op: "remove", id: criterion.id })),
      }),
    });
    const { service } = await confirmed({ model });
    await service.say("forget all of that").catch(() => undefined);
    const snap = await service.snapshot();
    assert.ok(snap.criteria.length > 0, "every criterion is gone; every candidate is now 'pending' forever");
  });

  test("revised draft criteria keep unique ids", async () => {
    const { service } = setup();
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    const [first] = (await service.snapshot()).criteria;
    await service.reviseDraft([
      { id: first!.id, text: "typescript", kind: "must" },
      { id: first!.id, text: "startup", kind: "must" },
    ]);
    const ids = (await service.snapshot()).criteria.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate criterion ids: ${ids.join(",")}`);
  });
});

describe("core bugs: legacy duplicate merging", () => {
  function candidate(id: string, url: string, extra: Partial<RecruitingState["candidates"][string]> = {}) {
    return {
      profile: { ...profile(id, "typescript"), profileUrl: url },
      poolRound: 1,
      discoveredAt: "2026-09-01T00:00:00.000Z",
      stage: "scored" as const,
      kept: false,
      verdicts: {},
      messages: [],
      followUps: 0,
      ...extra,
    };
  }

  test("three copies of one person leave no dangling feedback", async () => {
    const store = new MemoryStore();
    const state = emptyState();
    state.role = { title: "x", requirement: "x", confirmed: true, createdAt: "2026-09-01T00:00:00.000Z" };
    // Iteration order x1, x2, x3. x2 loses to x1, then x1 loses to x3.
    state.candidates.x1 = candidate("x1", "https://www.linkedin.com/in/alice", { kept: true });
    state.candidates.x2 = candidate("x2", "https://linkedin.com/in/alice/");
    state.candidates.x3 = candidate("x3", "https://sg.linkedin.com/in/Alice", {
      messages: [{ direction: "outbound", channel: "linkedin", at: "2026-09-02T00:00:00.000Z", text: "hi" }],
    });
    state.feedback.push({ candidateId: "x2", decision: "keep", inferredReason: "r", at: "2026-09-01T00:00:00.000Z" });
    await store.save(state);

    const { service } = setup({ store });
    const snap = await service.snapshot();
    assert.equal(snap.candidates.length, 1);
    const survivors = new Set(snap.candidates.map((c) => c.id));
    const saved = await (async () => {
      await service.close(snap.candidates[0]!.id, "withdrawn").catch(() => undefined);
      return store.load();
    })();
    for (const entry of saved.feedback) {
      assert.ok(survivors.has(entry.candidateId), `feedback points at erased record ${entry.candidateId}`);
    }
  });

  test("merging keeps the founder's pass", async () => {
    const store = new MemoryStore();
    const state = emptyState();
    state.role = { title: "x", requirement: "x", confirmed: true, createdAt: "2026-09-01T00:00:00.000Z" };
    state.criteria = ["c1", "c2", "c3"].map((id) => ({
      id, text: id, kind: "must", origin: "stated", active: true, createdAt: "2026-09-01T00:00:00.000Z",
    })) as Criterion[];
    const verdicts = (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { criterionId: id, satisfied: "no" as const, reasoning: "" }]));
    // The founder passed on this person under one spelling of the URL...
    state.candidates.p1 = candidate("p1", "https://www.linkedin.com/in/bob", {
      stage: "closed",
      closedReason: "passed",
      closedAt: "2026-09-10T00:00:00.000Z",
      verdicts: verdicts(["c1", "c2"]),
    });
    // ...and a later search found the same person under another.
    state.candidates.p2 = candidate("p2", "https://linkedin.com/in/bob", { verdicts: verdicts(["c1", "c2", "c3"]) });
    state.feedback.push({ candidateId: "p1", decision: "pass", statedReason: "no", inferredReason: "r", at: "2026-09-10T00:00:00.000Z" });
    await store.save(state);

    const { service } = setup({ store });
    const [only] = (await service.snapshot()).candidates;
    assert.equal(only!.stage, "closed", "the person the founder passed on is back in the pool");
  });
});

describe("core bugs: role board", () => {
  function board(repository = new MemoryRoleRepository(), model: JsonModel = fakeModel()) {
    return new RoleBoard(
      repository,
      (store) =>
        new RecruitingService({
          model,
          source: new FakeSource(),
          store,
          memory: new LocalIntentMemory(),
          contactFinders: [],
          gmail: null,
          clock: () => new Date("2026-09-23T02:00:00.000Z"),
          settings: { resultsPerQuery: 6 },
        }),
    );
  }

  test("two concurrent gets of one role share one service", async () => {
    const repository = new MemoryRoleRepository();
    const first = board(repository);
    const { id, service } = first.create();
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await service.confirm();
    await service.settle();

    // A fresh process: two requests arrive together.
    const restarted = board(repository);
    const [one, two] = await Promise.all([restarted.get(id), restarted.get(id)]);
    await one.snapshot();
    await two.snapshot();
    await one.close("a", "withdrawn");
    await two.close("b", "withdrawn");
    const now = await (await restarted.get(id)).snapshot();
    const closed = now.candidates.filter((c) => c.stage === "closed").map((c) => c.id).sort();
    assert.deepEqual(closed, ["a", "b"], "one founder action was silently lost");
  });

  test("a removed role stays removed when its background scoring finishes", async () => {
    const gate = deferred();
    let hold = true;
    const model = fakeModel({
      "criterion judgement": async (data) => {
        if (hold) await gate.promise;
        return {
          verdicts: data.criteria.map((criterion: { id: string }) => ({
            criterionId: criterion.id, satisfied: "yes", reasoning: "ok",
          })),
        };
      },
    });
    const repository = new MemoryRoleRepository();
    const roles = board(repository, model);
    const { id, service } = roles.create();
    await service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await service.confirm(); // scoring now runs in the background, held at the gate
    await roles.remove(id);
    assert.deepEqual(await repository.list(), []);
    hold = false;
    gate.resolve();
    await service.settle();
    assert.deepEqual(await repository.list(), [], "the deleted role came back");
  });
});

describe("core bugs: model output parsing", () => {
  test("findPattern needs distinct supporting people", async () => {
    const model = fakeModel({
      "preference pattern": () => ({
        found: true, text: "shipped a product", kind: "must", rationale: "r", supportingCandidateIds: ["c", "c"],
      }),
    });
    const finding = await findPattern(
      model,
      "pass",
      [
        { candidateId: "c", reason: "consulting only", profile: profile("c", "consulting") },
        { candidateId: "e", reason: "other", profile: profile("e", "java") },
      ],
      [],
      2,
    );
    assert.equal(finding, null, `one person counted twice: ${JSON.stringify(finding?.supportingCandidateIds)}`);
  });

  test("interpret does not turn an unknown decision into pass", async () => {
    const model = fakeModel({
      "instruction interpretation": () => ({ intent: "feedback", candidateId: "a", decision: "maybe", reason: "" }),
    });
    const instruction = await interpret(model, "hmm, Person a?", [], [{ id: "a", name: "Person a" }]);
    assert.notDeepEqual(
      instruction.intent === "feedback" ? instruction.decision : null,
      "pass",
      "decision 'maybe' became 'pass'",
    );
  });
});
