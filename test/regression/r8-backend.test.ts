// Round 8 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r8-backend.test.ts
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

// ======================================================================= bugs

describe("BUG: someone reopened by their reply is never scored on criteria added while they were closed", () => {
  test("B1 a cold person who writes back 'yes' is back in the pool, but stays unscored ('settled: false') on the criterion added meanwhile", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        // Added by the founder after this person had gone cold.
        { id: "c2", text: "startup", kind: "nice", origin: "stated", active: true, createdAt: AT },
      ],
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "cold", closedAt: AT, followUps: 1,
        messages: [outbound(), outbound("Re: Hi\n\nJust checking in")], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { model: interestedModel });
    await service.reply("Sorry, I was travelling. Yes, interested!", "a", "pasted");
    await settleBackground(service);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settleBackground(service);
    const a = (await service.snapshot()).candidates.find((c) => c.id === "a")!;
    assert.notEqual(a.stage, "closed", "precondition: the reply reopened them");
    assert.equal(a.settled, true, `reopened but never judged on the newer criterion: verdicts ${JSON.stringify(a.verdicts)}`);
  });
});

describe("BUG: keeping a cold person is undone by the next tick", () => {
  test("B2 the founder keeps someone the system closed as cold; one day later the tick closes them as cold again", async () => {
    // Cold means the last message went out at least a week ago.
    const lastWrote = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "cold", closedAt: AT, followUps: 1,
        messages: [outbound(), outbound("Re: Hi\n\nJust checking in")], lastContactedAt: lastWrote, ...withEmail,
      }) },
    }));
    const service = serviceOn(store);
    await service.feedback("a", "keep", "still want to talk to her");
    await settleBackground(service);
    assert.notEqual((await find(service, "a")).stage, "closed", "precondition: keep reopened them");
    await service.fastForward(1);
    const a = await find(service, "a");
    assert.notEqual(a.stage, "closed", `kept on purpose, closed again as ${a.closedReason} by the very next tick`);
  });
});

describe("BUG: a scheduling answer made only of a day or time is swallowed as a duplicate", () => {
  test("B3 'Thursday' is recorded, then '10:30 am' is reported as 'already on record' and lost", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }) },
    }));
    const service = serviceOn(store);
    await service.reply("Thursday", "a", "pasted");
    const second = await service.reply("10:30 am", "a", "pasted");
    const texts = (await find(service, "a")).messages.filter((m) => m.direction === "inbound").map((m) => m.text);
    assert.ok(texts.includes("10:30 am"), `the time they picked is not on record (${second.message}); inbound: ${JSON.stringify(texts)}`);
  });
});

describe("BUG: a genuinely new message with the same words as an older one is dropped", () => {
  test("B4 'Sounds good' to the intro, then 'Sounds good' days later to the proposed time: the second is never recorded", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }) },
    }));
    const service = serviceOn(store, { model: interestedModel });
    await service.reply("Sounds good", "a", "pasted");
    // The founder answers with a time.
    await service.editDraft("a", { body: "How about Thursday 10:30?" }).catch(() => undefined);
    await service.send("a", true);
    assert.equal(await count(service, "a", "outbound"), 2, "precondition: the founder's scheduling message is on record");
    const second = await service.reply("Sounds good", "a", "pasted");
    assert.equal(await inboundCount(service, "a"), 2, `their answer to the proposed time is lost: "${second.message}"`);
  });
});

describe("BUG: a reply the founder pasted is recorded again by Gmail sync", () => {
  test("B5 pasting an email reply, sending the scheduling answer, then syncing Gmail records it twice and knocks the stage back", async () => {
    const replyAt = new Date(NOW.getTime() - 3_600_000).toISOString();
    const replyText = "Yes, I'm interested, let's talk";
    const gmail = {
      async connected() { return true; },
      async send() { return { threadId: "t1" }; },
      async hasMailbox() { return true; },
      async repliesFrom(_thread: string, since: string) {
        return [{ from: "a@x.com", at: replyAt, text: replyText }].filter((m) => Date.parse(m.at) > Date.parse(since));
      },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail, model: interestedModel });
    await service.reply(replyText, "a", "pasted"); // the founder pasted it from their phone
    await service.send("a", false); // the scheduling answer
    assert.equal((await find(service, "a")).stage, "scheduling", "precondition");
    await service.syncGmail();
    const a = await find(service, "a");
    assert.equal(
      a.messages.filter((m) => m.direction === "inbound").length,
      1,
      `the same reply is on record twice; stage went ${a.stage}, draft ${a.draft?.kind ?? "none"}`,
    );
  });
});

describe("BUG: a message reopens someone the founder closed as declined", () => {
  test("B6 the founder closes a person as declined; a later message read as interested puts them back with a draft", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "replied", lastContactedAt: AT, ...withEmail,
        messages: [outbound(), { direction: "inbound", channel: "email", at: AT, realAt: AT, text: "Let me think" }],
      }) },
    }));
    const service = serviceOn(store, { model: interestedModel });
    // The candidate said no on a call; the founder records it.
    await service.close("a", "declined");
    await service.reply("Thanks for understanding! Excited to follow what Acme builds.", "a", "pasted");
    const a = await find(service, "a");
    assert.equal(a.stage, "closed", `the founder's own decision was overturned: stage ${a.stage}, draft ${a.draft?.kind ?? "none"}`);
  });
});

describe("BUG: a change that changes nothing still strips the pending widening", () => {
  test("B7 re-stating a criterion's kind ('Nothing changed') empties 'Widen location'; accepting it then widens nothing", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "based in Singapore", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
      proposals: [{
        id: "p1", type: "expansion", status: "pending", createdAt: AT, step: 0, stepName: "Widen location",
        rationale: "Accept remote candidates too?", query: "typescript remote",
        operations: [{ op: "edit", id: "c2", text: "based in Singapore or remote" }],
        targets: { c2: "based in Singapore\u0000must" },
      }],
    }));
    const service = serviceOn(store);
    const said = await service.changeCriteria([{ op: "set_kind", id: "c2", kind: "must" }], "location is a must");
    assert.equal(said.message, "Nothing changed.", "precondition: the change was a no-op");
    await service.resolveProposal("p1", true);
    await settleBackground(service);
    const texts = (await service.snapshot()).criteria.map((c) => c.text);
    assert.ok(texts.includes("based in Singapore or remote"), `accepted the widening, nothing widened: ${JSON.stringify(texts)}`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("Gmail sync reads a reply, then after the founder's answer reads the next reply once, never the first again", async () => {
    let now = NOW.getTime();
    const inbox: { from: string; at: string; text: string }[] = [];
    const gmail = {
      async connected() { return true; },
      async send() { return { threadId: "t1" }; },
      async hasMailbox() { return true; },
      async repliesFrom(_t: string, since: string) { return inbox.filter((m) => Date.parse(m.at) > Date.parse(since)); },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }) },
    }));
    const service = serviceOn(store, { gmail, model: interestedModel, clock: () => new Date(now) });
    inbox.push({ from: "a@x.com", at: new Date(now - 1000).toISOString(), text: "Yes please" });
    assert.equal(await service.syncGmail(), 1);
    now += 3_600_000;
    await service.send("a", false);
    now += 3_600_000;
    inbox.push({ from: "a@x.com", at: new Date(now - 1000).toISOString(), text: "Thursday works" });
    assert.equal(await service.syncGmail(), 1);
    assert.equal(await service.syncGmail(), 0);
    assert.equal(await inboundCount(service, "a"), 2);
  });

  test("a hired person who writes 'yes, interested' stays hired", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "closed", closedReason: "hired", closedAt: AT, messages: [outbound()], ...withEmail }) },
    }));
    const service = serviceOn(store, { model: interestedModel });
    await service.reply("Yes, interested in the other role too!", "a", "pasted");
    const a = await find(service, "a");
    assert.equal(a.stage, "closed");
    assert.equal(a.closedReason, "hired");
    assert.equal(await inboundCount(service, "a"), 1);
  });

  test("a widening still applies when the founder changed a different criterion", async () => {
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
    await service.changeCriteria([{ op: "edit", id: "c1", text: "typescript or go" }], "go is fine");
    await service.resolveProposal("p1", true);
    await settleBackground(service);
    assert.ok((await service.snapshot()).criteria.some((c) => c.text === "based in Singapore or remote"));
  });

  test("a message with a time label line in it is still told apart from a different message", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }) },
    }));
    const service = serviceOn(store);
    await service.reply("Alex Wong\n10:32 AM\nAlex: Sounds good", "a", "linkedin");
    await service.reply("Alex Wong\nTue\nAlex: Actually, can we do Friday?", "a", "linkedin");
    assert.equal(await inboundCount(service, "a"), 2);
  });
});
