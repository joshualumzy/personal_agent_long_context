// Round 9 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r9-backend.test.ts
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
const interestedModel = modelWith({
  "reply reading": (data) => ({ candidateId: data.knownCandidateId, interested: true, wantsToSchedule: true, summary: "Keen to talk." }),
});
const inboundCount = (service: RecruitingService, id: string) => count(service, id, "inbound");


const gmailWith = (inbox: { from: string; at: string; text: string }[]) => ({
  async connected() { return true; },
  async send() { return { threadId: "t1" }; },
  async repliesIn(_thread: string, since: string) { return inbox.filter((m) => Date.parse(m.at) > Date.parse(since)); },
});

// ======================================================================= bugs

describe("BUG: an emailed reply from someone the system closed as cold is never read", () => {
  test("B1 the tick closes a quiet person as cold; they answer the Gmail thread 'yes, interested'; Gmail sync skips them, so the reply is lost and they stay closed", async () => {
    const lastWrote = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", followUps: 1, gmailThreadId: "t1", lastContactedAt: lastWrote, ...withEmail,
        messages: [outbound(), { ...outbound("Re: Hi\n\nJust checking in"), at: lastWrote, realAt: lastWrote }],
      }) },
    }));
    const inbox: { from: string; at: string; text: string }[] = [];
    const service = serviceOn(store, { gmail: gmailWith(inbox), model: interestedModel });
    await service.tick();
    assert.equal((await find(service, "a")).stage, "closed", "precondition: the system closed them as cold");
    inbox.push({ from: "a@x.com", at: new Date(NOW.getTime() - 3_600_000).toISOString(), text: "Sorry, I was travelling. Yes, interested!" });
    await service.syncGmail();
    const a = await find(service, "a");
    assert.equal(await inboundCount(service, "a"), 1, "their emailed reply was never recorded");
    assert.notEqual(a.stage, "closed", `they said yes by email, yet stay closed as ${a.closedReason}`);
  });
});

describe("BUG: passing on someone the system closed does not stick", () => {
  test("B2 the founder passes on a cold person; a later 'yes' from them overturns the pass and drafts a scheduling message", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "cold", closedAt: AT, closedBy: "system", followUps: 1,
        messages: [outbound(), outbound("Re: Hi\n\nJust checking in")], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { model: interestedModel });
    // Via the chat ("pass on Person a, not a fit after all"): the founder's own decision.
    await service.feedback("a", "pass", "not a fit after all");
    await settleBackground(service);
    await service.reply("Sorry for the delay, yes I'm interested!", "a", "pasted");
    const a = await find(service, "a");
    assert.equal(a.stage, "closed", `the founder passed, yet they are back: stage ${a.stage}, draft ${a.draft?.kind ?? "none"}`);
  });
});

describe("BUG: a day or time answer copied with LinkedIn's name and time lines is swallowed", () => {
  test("B3 'Alex Wong / 2:14 PM / Thursday' then 'Alex Wong / 2:20 PM / 10:30 am': the second is reported as already on record", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }) },
    }));
    const service = serviceOn(store);
    await service.reply("Alex Wong\n2:14 PM\nThursday", "a", "pasted");
    const second = await service.reply("Alex Wong\n2:20 PM\n10:30 am", "a", "pasted");
    const texts = (await find(service, "a")).messages.filter((m) => m.direction === "inbound").map((m) => m.text);
    assert.equal(texts.length, 2, `the time they picked is lost (${second.message}); inbound: ${JSON.stringify(texts)}`);
  });
});

describe("BUG: Gmail sync reports a reply the founder already pasted as newly read, on every run", () => {
  test("B4 after a pasted reply, every later sync with nothing new still says 1 reply was read", async () => {
    const replyText = "Yes, I'm interested, let's talk";
    const inbox = [{ from: "a@x.com", at: new Date(NOW.getTime() - 3_600_000).toISOString(), text: replyText }];
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, gmailThreadId: "t1", ...withEmail }) },
    }));
    const service = serviceOn(store, { gmail: gmailWith(inbox), model: interestedModel });
    await service.reply(replyText, "a", "pasted");
    await service.syncGmail();
    const again = await service.syncGmail();
    assert.equal(await inboundCount(service, "a"), 1, "precondition: recorded once");
    assert.equal(again, 0, `nothing new arrived, yet the sync says ${again} reply was read`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("pasting an email reply that Gmail sync already recorded is one reply", async () => {
    const replyText = "Yes, I'm interested, let's talk";
    const inbox = [{ from: "a@x.com", at: new Date(NOW.getTime() - 3_600_000).toISOString(), text: replyText }];
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, gmailThreadId: "t1", ...withEmail }) },
    }));
    const service = serviceOn(store, { gmail: gmailWith(inbox), model: interestedModel });
    assert.equal(await service.syncGmail(), 1);
    await service.reply(replyText, "a", "pasted");
    assert.equal(await inboundCount(service, "a"), 1);
  });

  test("a system-cold person whose new message is read as a no stays closed, and the message is saved", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "cold", closedAt: AT, closedBy: "system", followUps: 1,
        messages: [outbound()], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const model = modelWith({ "reply reading": (d) => ({ candidateId: d.knownCandidateId, interested: false, wantsToSchedule: false, summary: "No." }) });
    const service = serviceOn(store, { model });
    await service.reply("Not looking, thanks", "a", "pasted");
    const a = await find(service, "a");
    assert.equal(a.stage, "closed");
    assert.equal(await inboundCount(service, "a"), 1);
  });

  test("editing a criterion to its own text keeps the pending widening", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "based in Singapore", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
      proposals: [{
        id: "p1", type: "expansion", status: "pending", createdAt: AT, step: 0, stepName: "Widen location",
        rationale: "Remote?", query: "q", operations: [{ op: "edit", id: "c2", text: "based in Singapore or remote" }],
        targets: { c2: "based in Singapore\u0000must" },
      }],
    }));
    const service = serviceOn(store);
    await service.changeCriteria([{ op: "edit", id: "c2", text: "based in Singapore" }], "keep Singapore");
    await service.resolveProposal("p1", true);
    await settleBackground(service);
    assert.ok((await service.snapshot()).criteria.some((c) => c.text === "based in Singapore or remote"));
  });

  test("a founder-closed 'declined' kept again comes back with a fresh follow-up count", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "declined", closedAt: AT, closedBy: "founder", followUps: 1,
        messages: [outbound()], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store);
    await service.feedback("a", "keep", "changed my mind");
    await settleBackground(service);
    const a = await find(service, "a");
    assert.equal(a.stage, "contacted");
    assert.equal(a.followUps, 0);
  });
});
