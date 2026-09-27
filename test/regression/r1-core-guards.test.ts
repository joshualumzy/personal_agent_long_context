/**
 * Adversarial bug hunt, recruiting core. Hypotheses that turned out NOT to be bugs; these tests PASS
 * against the current code; each failure demonstrates one bug.
 * Run: node --import tsx --test test/hunt/core-nonbugs.test.ts
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

// ------------------------------------------------------------------ non-bugs

import { judge, parseOperations, extractBrief } from "../../src/recruiting/agent.js";
import { JsonFileStore } from "../../src/recruiting/store.js";
import { JsonRoleRepository } from "../../src/recruiting/roles.js";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("core non-bugs", () => {
  test("follow-up at 5 days, cold 7 days after the follow-up is sent", async () => {
    const { service } = await confirmed();
    await service.prepareOutreach("a");
    await service.send("a", true);
    await service.fastForward(4);
    let a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.draft, null);
    await service.fastForward(1);
    a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.draft?.kind, "follow_up");
    await service.send("a", true);
    await service.fastForward(6);
    a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.stage, "contacted");
    await service.fastForward(1);
    a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.equal(a.stage, "closed");
    assert.equal(a.closedReason, "cold");
  });

  test("a proposal cannot be resolved twice, even concurrently", async () => {
    const { service, advance } = await confirmed();
    advance(8 * 86_400_000);
    await service.tick();
    const [proposal] = (await service.snapshot()).proposals;
    const results = await Promise.allSettled([service.resolveProposal(proposal!.id, true), service.resolveProposal(proposal!.id, true)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  });

  test("judge survives garbage model output and settle converges", async () => {
    const model = fakeModel({ "criterion judgement": () => ({ verdicts: "nope" }) });
    const { service } = await confirmed({ model });
    const snap = await service.snapshot();
    assert.ok(snap.candidates.every((c) => c.settled));
    const verdicts = await judge(fakeModel({ "criterion judgement": () => null }), profile("z", "x"), [
      { id: "k", text: "t", kind: "must", origin: "stated", active: true, createdAt: "" },
    ]);
    assert.equal(verdicts[0]!.satisfied, "unclear");
  });

  test("parseOperations ignores unknown ids and non-arrays", () => {
    assert.deepEqual(parseOperations({ op: "add" }, []), []);
    assert.deepEqual(parseOperations([{ op: "remove", id: "ghost" }, null, 3], []), []);
  });

  test("extractBrief without queries falls back to writeQueries on confirm", async () => {
    const brief = await extractBrief(fakeModel({ "criteria extraction": () => ({ criteria: [{ text: "go" }] }) }), "x");
    assert.deepEqual(brief.queries, []);
    assert.equal(brief.title, "Open role");
  });

  test("criterion edited mid-judgement is re-judged, never gets a stale verdict", async () => {
    const { service } = await confirmed();
    const rust = (await service.snapshot()).criteria.find((c) => c.text === "rust")!;
    await service.changeCriteria([{ op: "edit", id: rust.id, text: "startup" }], "edit");
    await service.settle();
    const snap = await service.snapshot();
    assert.equal(snap.candidates.find((c) => c.id === "b")!.tier, 100);
  });

  test("legacy reserve is adopted once and scored, without duplicating known people", async () => {
    const store = new MemoryStore();
    const seed = setup({ store });
    await seed.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await seed.service.confirm();
    await seed.service.settle();
    const state = (await store.load()) as RecruitingState & { reserve?: CandidateProfile[] };
    state.reserve = [profile("a", "dup"), profile("z", "typescript startup rust")];
    await store.save(state);
    const { service } = setup({ store });
    await service.snapshot();
    await new Promise((r) => setTimeout(r, 0));
    await service.settle();
    const snap = await service.snapshot();
    assert.equal(snap.candidates.length, 7);
    assert.equal(snap.candidates.find((c) => c.id === "z")!.tier, 100);
  });

  test("JSON store round-trips state and role repository adopts a legacy file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hunt-"));
    const store = new JsonFileStore(join(dir, "s.json"));
    const seed = setup({ store });
    await seed.service.start("We need a founding backend engineer in Singapore who knows TypeScript.");
    await seed.service.confirm();
    await seed.service.settle();
    const before = await seed.service.snapshot();
    const again = setup({ store });
    const after = await again.service.snapshot();
    assert.deepEqual(after.candidates, before.candidates);

    const repo = new JsonRoleRepository(join(dir, "roles"));
    const id = await repo.adoptLegacy(join(dir, "s.json"));
    assert.ok(id);
    assert.deepEqual(await repo.list(), [id]);
    await writeFile(join(dir, "empty.json"), JSON.stringify(emptyState()));
    assert.equal(await repo.adoptLegacy(join(dir, "empty.json")), null);
    assert.ok((await readdir(dir)).includes("empty.json"));
  });

  test("snapshot never exposes verdicts for inactive criteria", async () => {
    const { service } = await confirmed();
    const rust = (await service.snapshot()).criteria.find((c) => c.text === "rust")!;
    await service.changeCriteria([{ op: "remove", id: rust.id }], "drop rust");
    const snap = await service.snapshot();
    assert.ok(snap.candidates.every((c) => c.verdicts.length === snap.criteria.length));
    assert.ok(snap.candidates.every((c) => c.verdicts.every((v) => v && v.criterionId !== rust.id)));
  });
});
