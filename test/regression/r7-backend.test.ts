// Round 7 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r7-backend.test.ts
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
          return { subject: "Hi", body: `Hello ${data.candidate?.name ?? ""}` } as T;
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
const settleBackground = async (service: RecruitingService) => {
  for (let i = 0; i < 50 && (await service.snapshot()).busy; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

// ======================================================================= bugs

describe("BUG: Gmail sync never reads a reply that arrived before a later send", () => {
  test("B1 a candidate's email reply that was not synced yet is lost for good once the founder sends a follow-up in the same thread", async () => {
    // Nothing syncs Gmail on its own, so a reply can sit unread for days. Meanwhile the tick
    // drafts a follow-up (the reply is not on record yet) and the founder sends it.
    const replyAt = new Date(NOW.getTime() - 3_600_000).toISOString(); // an hour before the follow-up
    const inbox = [{ from: "a@x.com", at: replyAt, text: "Yes, I'm interested, let's talk" }];
    const gmail = {
      async connected() { return true; },
      async send() { return { threadId: "t1" }; },
      async repliesIn(_thread: string, since: string) { return inbox.filter((m) => Date.parse(m.at) > Date.parse(since)); },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", messages: [outbound()], lastContactedAt: AT, gmailThreadId: "t1",
        draft: { kind: "follow_up", subject: "Re: Hi", body: "Just checking in", createdAt: AT, warnings: [] }, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail });
    await service.send("a", false);
    await service.syncGmail();
    assert.equal(
      await count(service, "a", "inbound"),
      1,
      "the reply in the thread is never read: the sync cut-off is the follow-up's send time, which is after the reply",
    );
  });
});

describe("BUG: an old widening proposal overwrites a criterion the founder changed since", () => {
  test("B2 accepting 'Widen location' rewrites a criterion the founder has since turned into something else, losing it", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "based in Singapore", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
      proposals: [{
        id: "p1", type: "expansion", status: "pending", createdAt: AT, step: 0, stepName: "Widen location",
        rationale: "Accept remote candidates too?", query: "typescript remote",
        operations: [{ op: "edit", id: "c2", text: "based in Singapore or remote" }],
      }],
    }));
    const service = serviceOn(store);
    // The founder reuses that criterion for something they now care about more.
    await service.changeCriteria([{ op: "edit", id: "c2", text: "has shipped a payments product" }], "location does not matter, payments does");
    await settleBackground(service);
    // Later the founder accepts the widening that is still on screen.
    await service.resolveProposal("p1", true);
    await settleBackground(service);
    const texts = (await service.snapshot()).criteria.map((c) => c.text);
    assert.ok(
      texts.includes("has shipped a payments product"),
      `the founder's newer criterion is gone, replaced by the proposal's stale edit: ${JSON.stringify(texts)}`,
    );
  });
});

describe("BUG: a candidate closed as cold by the system can never be answered", () => {
  test("B3 someone auto-closed as cold writes back 'yes, interested'; keeping them and asking for a draft both leave them closed with nothing to send", async () => {
    const model = modelWith({
      "reply reading": (data) => ({ candidateId: data.knownCandidateId, interested: true, wantsToSchedule: true, summary: "Keen to talk." }),
    });
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "cold", closedAt: AT, followUps: 1, gmailThreadId: "t1",
        messages: [outbound(), outbound("Re: Hi\n\nJust checking in")], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { model });
    await service.reply("Sorry for the slow reply, I was travelling. Yes, I'm interested, when can we talk?", "a", "pasted");
    // The founder tries every way to answer them.
    const kept = await service.feedback("a", "keep", "still want to talk to her").then(() => "ok", (e: { code?: string }) => e.code);
    const prepared = await service.prepareOutreach("a").then(() => "ok", (e: { code?: string }) => e.code);
    const a = await find(service, "a");
    assert.ok(
      a.draft !== null,
      `no way to answer someone who said yes: stage ${a.stage} (${a.closedReason}), keep -> ${kept}, prepare outreach -> ${prepared}`,
    );
  });
});

describe("BUG: the same LinkedIn message is recorded again when the reader posts it again", () => {
  test("B4 a LinkedIn preview whose time label changed ('10:32 AM' -> 'Tue') is a new fingerprint to the reader, and the server records the same reply twice", async () => {
    const model = modelWith({
      "reply reading": (data) => {
        const match = data.candidates.find((c: { name: string }) => String(data.message).includes(c.name));
        return { candidateId: match?.id ?? null, interested: null, wantsToSchedule: false, summary: "Replied." };
      },
    });
    const repository = new MemoryRoleRepository();
    await repository.store("only").save(seeded({
      candidates: { w: candidate(person("w", "typescript", "Alex Wong"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const board = new RoleBoard(repository, (store) => serviceOn(store, { model }));
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    // The reader fingerprints the whole preview, and LinkedIn's preview carries a time label
    // that changes as the day passes, so the next run posts the same message again.
    for (const label of ["10:32 AM", "Tue"]) {
      const response = await app.inject({
        method: "POST", url: "/api/recruiting/inbox/linkedin",
        payload: { threads: [{ text: `Alex Wong\n${label}\nAlex: Sounds good, happy to chat next week` }] },
      });
      assert.equal(response.statusCode, 200);
    }
    assert.equal(await count(await board.get("only"), "w", "inbound"), 1, "one LinkedIn message is on record twice");
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("editing the draft while Gmail is still sending it is refused, and the send is recorded once", async () => {
    let letGo!: (value: { threadId: string }) => void;
    let calls = 0;
    const gmail = {
      async connected() { return true; },
      send: () => { calls += 1; return new Promise<{ threadId: string }>((resolve) => { letGo = resolve; }); },
      async repliesIn() { return []; },
    };
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(store, { gmail });
    const sending = service.send("a", false);
    while (!letGo) await new Promise((resolve) => setImmediate(resolve));
    const edited = await service.editDraft("a", { body: "changed my mind" }).then(() => "ok", (e: { code?: string }) => e.code);
    letGo({ threadId: "t1" });
    await sending;
    assert.equal(edited, "already_sending");
    assert.equal(calls, 1);
    assert.equal(await count(service, "a", "outbound"), 1);
    assert.equal((await find(service, "a")).draft, null);
  });

  test("closing someone whose send is unconfirmed drops the draft; a later press sends nothing and does not reopen them", async () => {
    let calls = 0;
    const gmail = {
      async connected() { return true; },
      async send() { calls += 1; throw new TypeError("fetch failed"); },
      async repliesIn() { return []; },
    };
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(store, { gmail });
    await assert.rejects(service.send("a", false), { code: "send_unconfirmed" } as never);
    await service.close("a", "withdrawn");
    await assert.rejects(service.send("a", false));
    await assert.rejects(service.send("a", true));
    const a = await find(service, "a");
    assert.equal(calls, 1);
    assert.equal(a.stage, "closed");
    assert.equal(a.draft, null);
  });

  test("an email-only edit does not mark the intro as rewritten: preparing outreach can still redraft it", async () => {
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro() }) } }));
    const service = serviceOn(store);
    await service.editDraft("a", { email: "alex@acme.io" });
    await service.prepareOutreach("a");
    assert.equal((await find(service, "a")).draft?.body, "Hello Person a");
  });

  test("criteria batch: 'add X' followed by 'edit A into X' leaves exactly one X and keeps the untouched criterion", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "rust", kind: "nice", origin: "stated", active: true, createdAt: AT },
      ],
    }));
    const service = serviceOn(store);
    await service.changeCriteria([{ op: "add", text: "Go", kind: "must" }, { op: "edit", id: "c2", text: "go" }], "go");
    const texts = (await service.snapshot()).criteria.map((c) => c.text.trim().toLowerCase());
    assert.deepEqual(texts.filter((t) => t === "go").length, 1);
    assert.ok(texts.includes("typescript"));
  });

  test("Gmail sync after a late 'I sent it myself' still reads a reply that came in after the claim", async () => {
    const T0 = NOW.getTime();
    let now = T0;
    const replyAt = new Date(T0 + 3_600_000).toISOString();
    const gmail = {
      async connected() { return true; },
      async send() { throw new TypeError("fetch failed"); },
      async repliesIn(_t: string, since: string) {
        return now >= Date.parse(replyAt) && Date.parse(replyAt) > Date.parse(since) ? [{ from: "a@x.com", at: replyAt, text: "Sure" }] : [];
      },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", messages: [outbound()], lastContactedAt: AT, gmailThreadId: "t1",
        draft: { kind: "follow_up", subject: "Re: Hi", body: "Nudge", createdAt: AT, warnings: [] }, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail, clock: () => new Date(now) });
    await assert.rejects(service.send("a", false), { code: "send_unconfirmed" } as never);
    now = T0 + 2 * 3_600_000;
    await service.send("a", true); // marked sent after the reply came in, before any sync
    assert.equal(await service.syncGmail(), 1);
    assert.equal(await count(service, "a", "inbound"), 1);
  });
});
