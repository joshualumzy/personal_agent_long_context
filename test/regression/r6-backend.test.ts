// Round 6 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r6-backend.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { buildApp } from "../../src/http-app.js";
import type { Candidate, CandidateProfile, Draft, RecruitingState } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel, JsonRequest } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService, type RecruitingSettings } from "../../src/recruiting/service.js";
import { MemoryStore, type StateStore } from "../../src/recruiting/store.js";

const AT = "2026-09-20T02:00:00.000Z";
const NOW = new Date("2026-09-23T02:00:00.000Z");
const REQUIREMENT = "We need a backend engineer who knows TypeScript and has startup experience.";

function person(id: string, summary: string, name = `Person ${id}`): CandidateProfile {
  return {
    id, name, headline: summary, location: "Singapore",
    profileUrl: `https://www.linkedin.com/in/${id}`, workHistory: [], educationHistory: [], summary,
  };
}

type Handler = (data: Record<string, any>, request: JsonRequest) => unknown;

function modelWith(over: Record<string, Handler> = {}): JsonModel {
  return {
    async json<T>(request: JsonRequest): Promise<T> {
      const data = request.input as Record<string, any>;
      if (over[request.task]) return over[request.task]!(data, request) as T;
      switch (request.task) {
        case "criterion judgement":
          return { verdicts: data.criteria.map((c: { id: string; text: string }) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) } as T;
        case "outreach draft":
          return { subject: "Hi", body: `Hello ${data.candidate.name}` } as T;
        case "role title":
          return { title: data.currentTitle } as T;
        case "reason inference":
          return { reason: "other" } as T;
        case "search query":
          return { queries: [`more ${data.previous.length}`] } as T;
        case "reply reading":
          return { candidateId: data.knownCandidateId ?? data.candidates[0]?.id ?? null, interested: null, wantsToSchedule: false, summary: "Replied." } as T;
        default:
          throw new Error(`unscripted ${request.task}`);
      }
    },
  };
}

const POOL = [person("a", "typescript startup"), person("b", "typescript"), person("c", "java")];

function candidate(profile: CandidateProfile, extra: Partial<Candidate> = {}): Candidate {
  return {
    profile, poolRound: 1, discoveredAt: AT, stage: "scored", kept: false,
    verdicts: { c1: { criterionId: "c1", satisfied: "yes", reasoning: "x" } },
    messages: [], followUps: 0, ...extra,
  };
}

function seeded(overrides: Partial<RecruitingState> = {}): RecruitingState {
  return {
    version: 1,
    role: { title: "Backend engineer", requirement: REQUIREMENT, confirmed: true, createdAt: AT },
    criteria: [{ id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT }],
    candidates: {},
    feedback: [], proposals: [], rounds: [{ round: 1, query: "q", queries: ["q"], at: AT, found: 1, added: 1 }],
    expansionStep: 0, clockOffsetDays: 0, events: [],
    ...overrides,
  };
}

async function storeWith(state: RecruitingState): Promise<StateStore> {
  const store = new MemoryStore();
  await store.save(state);
  return store;
}

function serviceOn(store: StateStore, opts: { model?: JsonModel; gmail?: unknown; clock?: () => Date; settings?: Partial<RecruitingSettings> } = {}) {
  return new RecruitingService({
    model: opts.model ?? modelWith(), source: { name: "fake", search: async () => POOL }, store, memory: new LocalIntentMemory(),
    contactFinders: [], gmail: (opts.gmail ?? null) as never, clock: opts.clock ?? (() => NOW),
    settings: { founderName: "Michael", companyName: "Acme", rescoreAfterMs: 1e9, ...opts.settings },
  });
}

const intro = (extra: Partial<Draft> = {}): Draft => ({ kind: "intro", subject: "Hi", body: "Hello there", createdAt: AT, warnings: [], ...extra });
const withEmail = { contact: { email: "a@x.com", status: "verified" as const, provider: "founder" as const } };
const outbound = (text = "Hi\n\nHello") => ({ direction: "outbound" as const, channel: "email" as const, at: AT, realAt: AT, text });
const find = async (service: RecruitingService, id: string) => (await service.snapshot()).candidates.find((c) => c.id === id)!;
const count = async (service: RecruitingService, id: string, direction: "inbound" | "outbound") =>
  (await find(service, id)).messages.filter((m) => m.direction === direction).length;

// ======================================================================= bugs

describe("BUG: Gmail sync reads a reply twice after a late record", () => {
  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("B1 a reply synced while a follow-up was unconfirmed is read again once the founder marks it sent (the record is dated from the claim, before the reply)", async () => {
    const T0 = Date.parse("2026-09-23T02:00:00.000Z");
    let now = T0;
    const replyAt = new Date(T0 + 3_600_000).toISOString(); // they answer an hour after the follow-up
    const gmail = {
      async connected() { return true; },
      async send() { throw new TypeError("fetch failed"); }, // Gmail's answer is lost
      async hasMailbox() { return true; },
      async repliesFrom(_thread: string, since: string) {
        return now >= Date.parse(replyAt) && Date.parse(replyAt) > Date.parse(since)
          ? [{ from: "a@x.com", at: replyAt, text: "Thanks for the nudge, happy to chat" }]
          : [];
      },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", messages: [outbound()], lastContactedAt: AT, draft: { kind: "follow_up", subject: "Re: Hi", body: "Nudge", createdAt: AT, warnings: [] }, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail, clock: () => new Date(now) });
    await assert.rejects(service.send("a", false), { code: "send_unconfirmed" } as never);
    now = T0 + 2 * 3_600_000;
    assert.equal(await service.syncGmail(), 1); // their reply is read
    // The founder checks Sent, finds the follow-up there, and says so.
    await service.send("a", true);
    await service.syncGmail();
    assert.equal(await count(service, "a", "inbound"), 1, "the same Gmail reply is now on record twice");
  });
});

describe("BUG: LinkedIn inbox loses a conversation no role can place", () => {
  test("B2 a conversation naming a contacted person that the model cannot place is counted as 'did not mention anyone you contacted' and reported nowhere", async () => {
    const model = modelWith({
      "reply reading": () => ({ candidateId: null, interested: true, wantsToSchedule: false, summary: "Someone is keen." }),
    });
    const repository = new MemoryRoleRepository();
    await repository.store("only").save(seeded({
      candidates: { w: candidate(person("w", "typescript", "Alex Wong"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const board = new RoleBoard(repository, (store) => serviceOn(store, { model }));
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    const response = await app.inject({
      method: "POST", url: "/api/recruiting/inbox/linkedin",
      payload: { threads: [{ text: "Alex\nYes, keen to chat next week" }] },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { result: { read: number; ignored: number; results: { message: string }[]; failed?: string[] } };
    // The reader marks every posted conversation as seen unless it is listed as failed, and
    // tells the founder that "ignored" ones "did not mention anyone you contacted".
    const told = body.result.results.length > 0 || (body.result.failed?.length ?? 0) > 0;
    assert.ok(
      told,
      `a conversation that names Alex (contacted) vanished: ${JSON.stringify(body.result)}; the reader will never retry it and the founder is told it mentioned nobody`,
    );
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("two presses at once with a slow Gmail: Gmail is called once and one email is on record", async () => {
    let calls = 0;
    let letGo!: (value: { threadId: string }) => void;
    const gmail = {
      async connected() { return true; },
      send: () => { calls += 1; return new Promise<{ threadId: string }>((resolve) => { letGo = resolve; }); },
      async hasMailbox() { return true; },
      async repliesFrom() { return []; },
    };
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(store, { gmail });
    const first = service.send("a", false);
    const second = service.send("a", false).then(() => "ok", (e: { code?: string }) => e.code);
    while (!letGo) await new Promise((resolve) => setImmediate(resolve));
    const manual = await service.send("a", true).then(() => "ok", (e: { code?: string }) => e.code);
    letGo({ threadId: "t1" });
    await first;
    assert.equal(await second, "already_sending");
    assert.equal(manual, "already_sending");
    assert.equal(calls, 1);
    assert.equal(await count(service, "a", "outbound"), 1);
  });

  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("after an ambiguous Gmail failure, an unchanged save keeps the claim and a real edit releases it for exactly one more send", async () => {
    let calls = 0;
    const gmail = {
      async connected() { return true; },
      async send() { calls += 1; if (calls === 1) throw new TypeError("fetch failed"); return { threadId: "t1" }; },
      async hasMailbox() { return true; },
      async repliesFrom() { return []; },
    };
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(store, { gmail });
    await assert.rejects(service.send("a", false), { code: "send_unconfirmed" } as never);
    await service.editDraft("a", { subject: "Hi", body: "Hello there" });
    await assert.rejects(service.send("a", false), { code: "send_unconfirmed" } as never);
    assert.equal(calls, 1);
    await service.editDraft("a", { body: "Hello there, second try" });
    await service.send("a", false);
    assert.equal(calls, 2);
    assert.equal(await count(service, "a", "outbound"), 1);
  });

  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("a claim left by a restart mid-send (no flag, nothing in flight) can be marked sent by hand, dated from the claim", async () => {
    const claimedAt = "2026-09-22T10:00:00.000Z";
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro({ sending: true, claimedAt } as Partial<Draft>), ...withEmail }) },
    }));
    const service = serviceOn(store, { gmail: { async connected() { return true; }, async send() { throw new Error("must not send"); }, async hasMailbox() { return true; },
      async repliesFrom() { return []; } } });
    await assert.rejects(service.send("a", false), { code: "send_unconfirmed" } as never);
    await service.send("a", true);
    const a = await find(service, "a");
    assert.equal(a.stage, "contacted");
    assert.equal(a.messages.at(-1)?.realAt, claimedAt);
  });

  test("criteria batch: two criteria both edited into the same words leave one; a swap of texts keeps both", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "rust", kind: "nice", origin: "stated", active: true, createdAt: AT },
        { id: "c3", text: "startup", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
    }));
    const service = serviceOn(store);
    await service.changeCriteria([{ op: "edit", id: "c2", text: "startup" }, { op: "edit", id: "c3", text: "rust" }], "swap");
    assert.deepEqual((await service.snapshot()).criteria.map((c) => [c.id, c.text]), [["c1", "typescript"], ["c2", "startup"], ["c3", "rust"]]);
    await service.changeCriteria([{ op: "edit", id: "c2", text: "go" }, { op: "edit", id: "c3", text: "Go " }], "both into go");
    const texts = (await service.snapshot()).criteria.map((c) => c.text.trim().toLowerCase());
    assert.deepEqual(texts.filter((t) => t === "go").length, 1);
  });

  test("LinkedIn inbox: a conversation the newer role records is not also recorded by the older role that contacted the same name", async () => {
    const model = modelWith({
      "reply reading": (data) => {
        const match = data.candidates.find((c: { name: string }) => String(data.message).includes(c.name));
        return { candidateId: match?.id ?? null, interested: null, wantsToSchedule: false, summary: "Hi." };
      },
    });
    const repository = new MemoryRoleRepository();
    await repository.store("older").save(seeded({
      role: { title: "Backend", requirement: REQUIREMENT, confirmed: true, createdAt: "2026-09-10T00:00:00.000Z" },
      candidates: { w: candidate(person("w", "typescript", "Alex Wong"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    await repository.store("newer").save(seeded({
      role: { title: "Designer", requirement: REQUIREMENT, confirmed: true, createdAt: "2026-09-20T00:00:00.000Z" },
      candidates: { v: candidate(person("v", "typescript", "Alex Wong"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const board = new RoleBoard(repository, (store) => serviceOn(store, { model }));
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    const response = await app.inject({ method: "POST", url: "/api/recruiting/inbox/linkedin", payload: { threads: [{ text: "Alex Wong\nSure" }] } });
    assert.equal(response.statusCode, 200);
    assert.equal(await count(await board.get("newer"), "v", "inbound"), 1);
    assert.equal(await count(await board.get("older"), "w", "inbound"), 0);
  });
});
