// Round 10 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r10-backend.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { buildApp } from "../../src/http-app.js";
import type { Candidate, CandidateProfile, RecruitingState } from "../../src/recruiting/domain.js";
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
        case "criteria extraction":
          return { title: "Backend Engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["typescript engineer"] } as T;
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

function serviceOn(store: StateStore, opts: { model?: JsonModel; gmail?: unknown; settings?: Partial<RecruitingSettings> } = {}) {
  return new RecruitingService({
    model: opts.model ?? modelWith(), source: { name: "fake", search: async () => POOL }, store, memory: new LocalIntentMemory(),
    contactFinders: [], gmail: (opts.gmail ?? null) as never, clock: () => NOW,
    settings: { founderName: "Michael", companyName: "Acme", rescoreAfterMs: 1e9, ...opts.settings },
  });
}

const withEmail = { contact: { email: "a@x.com", status: "verified" as const, provider: "founder" as const } };
const outbound = (text = "Hi\n\nHello") => ({ direction: "outbound" as const, channel: "email" as const, at: AT, realAt: AT, text });
const find = async (service: RecruitingService, id: string) => (await service.snapshot()).candidates.find((c) => c.id === id)!;
const inboundCount = async (service: RecruitingService, id: string) =>
  (await find(service, id)).messages.filter((m) => m.direction === "inbound").length;
const settleBackground = async (service: RecruitingService) => {
  for (let i = 0; i < 50 && (await service.snapshot()).busy; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};
const interestedModel = modelWith({
  "reply reading": (data) => ({ candidateId: data.knownCandidateId, interested: true, wantsToSchedule: true, summary: "Keen to talk." }),
});
const gmailWith = (inbox: { from: string; at: string; text: string }[]) => ({
  async connected() { return true; },
  async send() { return { threadId: "t1" }; },
  async repliesIn(_thread: string, since: string) { return inbox.filter((m) => Date.parse(m.at) > Date.parse(since)); },
});
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

// ======================================================================= bugs

describe("BUG: a candidate's second message is swallowed when it differs only in lines that look like days or times", () => {
  test("B1 'Slots that work:\\nTue\\nThu\\nThanks!' then the corrected 'Slots that work:\\nMon\\nWed\\nThanks!': the correction is reported as already on record and lost", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }) },
    }));
    const service = serviceOn(store);
    await service.reply("Slots that work for me:\nTue\nThu\nThanks!", "a", "pasted");
    const second = await service.reply("Slots that work for me:\nMon\nWed\nThanks!", "a", "pasted");
    const texts = (await find(service, "a")).messages.filter((m) => m.direction === "inbound").map((m) => m.text);
    assert.equal(texts.length, 2, `the corrected days are lost (${second.message}); inbound: ${JSON.stringify(texts)}`);
  });
});

describe("BUG: 'Mark as hired' pressed by mistake can never be undone", () => {
  test("B2 the founder marks a replied person hired by mistake and asks to keep them; they stay closed as hired, and no draft can be made", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "replied", lastContactedAt: AT, ...withEmail,
        messages: [outbound(), { direction: "inbound", channel: "email", at: AT, realAt: AT, text: "Happy to chat" }],
      }) },
    }));
    const service = serviceOn(store);
    // The drawer's "Mark as hired" sits next to "Add reply", one click, no confirm.
    await service.close("a", "hired");
    // Closed people have no Keep/Pass buttons; the only way back is the chat ("keep Person a").
    await service.feedback("a", "keep", "marked hired by mistake");
    const reopen = (service as unknown as { reopen?: (id: string) => Promise<void> }).reopen;
    if ((await find(service, "a")).stage === "closed" && typeof reopen === "function") await reopen.call(service, "a");
    await settleBackground(service);
    const a = await find(service, "a");
    const drafted = await service.prepareOutreach("a").then(() => true, () => false);
    assert.ok(a.stage !== "closed" || drafted, `stuck: stage ${a.stage} (${a.closedReason}); outreach refused`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("Gmail sync over a hired person's thread: the message is kept, they stay hired, no draft, counted once", async () => {
    const inbox = [{ from: "a@x.com", at: hoursAgo(2), text: "Yes, very interested, when can we talk?" }];
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "hired", closedAt: AT, closedBy: "founder", gmailThreadId: "t1",
        messages: [outbound()], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail: gmailWith(inbox), model: interestedModel });
    assert.equal(await service.syncGmail(), 1);
    assert.equal(await service.syncGmail(), 0);
    const a = await find(service, "a");
    assert.equal(a.stage, "closed");
    assert.equal(a.closedReason, "hired");
    assert.equal(a.draft, null);
    assert.equal(await inboundCount(service, "a"), 1);
  });

  test("Gmail sync over a founder-passed person: an interested email is saved and they stay passed", async () => {
    const inbox = [{ from: "a@x.com", at: hoursAgo(2), text: "Sorry for the delay, yes!" }];
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "passed", closedAt: AT, closedBy: "founder", gmailThreadId: "t1",
        messages: [outbound()], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail: gmailWith(inbox), model: interestedModel });
    await service.syncGmail();
    const a = await find(service, "a");
    assert.equal(a.stage, "closed");
    assert.equal(a.draft, null);
    assert.equal(await inboundCount(service, "a"), 1);
  });

  test("the founder passes on a system-cold person; a later Gmail 'yes' keeps them closed, and 'keep' still brings them back", async () => {
    const inbox: { from: string; at: string; text: string }[] = [];
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "closed", closedReason: "cold", closedAt: AT, closedBy: "system", followUps: 1, gmailThreadId: "t1",
        messages: [outbound()], lastContactedAt: AT, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail: gmailWith(inbox), model: interestedModel });
    await service.feedback("a", "pass");
    await settleBackground(service);
    inbox.push({ from: "a@x.com", at: hoursAgo(1), text: "Yes, interested!" });
    await service.syncGmail();
    assert.equal((await find(service, "a")).stage, "closed");
    await service.feedback("a", "keep");
    await settleBackground(service);
    assert.notEqual((await find(service, "a")).stage, "closed");
  });

  test("passing on a hired person leaves the hire as it is", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "closed", closedReason: "hired", closedAt: AT, closedBy: "founder", messages: [outbound()] }) },
    }));
    const service = serviceOn(store);
    await service.feedback("a", "pass");
    await settleBackground(service);
    assert.equal((await find(service, "a")).closedReason, "hired");
  });

  test("a LinkedIn relay 'Alex Wong / 10:32 AM / Sounds good' then 'Alex Wong / Tue / Sounds good' is one message", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const service = serviceOn(store);
    await service.reply("Alex Wong\n10:32 AM\nSounds good", "a", "linkedin");
    const again = await service.reply("Alex Wong\nTue\nSounds good", "a", "linkedin");
    assert.equal(again.duplicate, true);
    assert.equal(await inboundCount(service, "a"), 1);
  });

  test("'not a role' through the HTTP create route: a 4xx, no role listed, and a real role can be opened next", async () => {
    let refuse = true;
    const model = modelWith({
      "criteria extraction": () => (refuse
        ? { notARole: true }
        : { title: "Backend Engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["typescript engineer"] }),
    });
    const board = new RoleBoard(new MemoryRoleRepository(), (store) => serviceOn(store, { model }));
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    const refused = await app.inject({ method: "POST", url: "/api/recruiting/roles", payload: { text: "'; DROP TABLE roles; -- hello there" } });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().code, "not_a_role");
    assert.deepEqual(await board.list(), []);
    refuse = false;
    const opened = await app.inject({ method: "POST", url: "/api/recruiting/roles", payload: { text: REQUIREMENT } });
    assert.equal(opened.statusCode, 200);
    assert.equal((await board.list()).length, 1);
  });
});
