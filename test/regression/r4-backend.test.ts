// Round 4 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r4-backend.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { buildApp } from "../../src/http-app.js";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import type { Candidate, CandidateProfile, RecruitingState } from "../../src/recruiting/domain.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel, JsonRequest } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService, type RecruitingSettings } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
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

/** A scripted model; `over` replaces the answer for a task. */
function modelWith(over: Record<string, Handler> = {}, seen: JsonRequest[] = []): JsonModel {
  return {
    async json<T>(request: JsonRequest): Promise<T> {
      seen.push(request);
      const data = request.input as Record<string, any>;
      if (over[request.task]) return over[request.task]!(data, request) as T;
      switch (request.task) {
        case "criteria extraction":
          return { title: "Backend engineer", criteria: [{ text: "typescript", kind: "must" }, { text: "startup", kind: "must" }, { text: "rust", kind: "nice" }], queries: ["q1"] } as T;
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
        case "pool expansion":
          return { query: "typescript engineer remote", operations: [], rationale: "Accept remote?" } as T;
        default:
          throw new Error(`unscripted ${request.task}`);
      }
    },
  };
}

const POOL = [person("a", "typescript startup rust"), person("b", "typescript startup"), person("c", "java bigco")];

function sourceWith(search?: CandidateSource["search"], fetchProfiles?: CandidateSource["fetchProfiles"]): CandidateSource {
  return { name: "fake", search: search ?? (async () => POOL), ...(fetchProfiles ? { fetchProfiles } : {}) };
}

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

function serviceOn(store: StateStore, opts: { model?: JsonModel; source?: CandidateSource; gmail?: unknown; settings?: Partial<RecruitingSettings> } = {}) {
  return new RecruitingService({
    model: opts.model ?? modelWith(), source: opts.source ?? sourceWith(), store, memory: new LocalIntentMemory(),
    contactFinders: [], gmail: (opts.gmail ?? null) as never, clock: () => NOW,
    settings: { founderName: "Michael", companyName: "Acme", rescoreAfterMs: 1e9, ...opts.settings },
  });
}

const outbound = (text = "Hi\n\nHello") => ({ direction: "outbound" as const, channel: "email" as const, at: AT, realAt: AT, text });
const find = async (service: RecruitingService, id: string) => (await service.snapshot()).candidates.find((c) => c.id === id)!;

// ======================================================================= bugs

describe("BUG: rescoring after a proposal is accepted", () => {
  test("B1 accepting a proposed criterion never scores someone whose retries were used up, so they stay unplaced for good", async () => {
    let failing = true;
    const model = modelWith({
      "criterion judgement": (data) => {
        if (failing && data.profile.id === "c") throw new Error("HTTP 429");
        return { verdicts: data.criteria.map((c: { id: string; text: string }) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) };
      },
    });
    const proposal = { id: "p1", type: "criterion" as const, status: "pending" as const, createdAt: AT, text: "rust", kind: "nice" as const, rationale: "Both kept people know Rust.", supportingCandidateIds: [] };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!), c: candidate(POOL[2]!, { stage: "discovered", verdicts: {} }) },
      proposals: [proposal],
    }));
    const service = serviceOn(store, { model });
    for (let i = 0; i < 4; i += 1) await service.settle(); // four failed tries in a row: retries used up
    failing = false; // the model is back
    await service.resolveProposal("p1", true); // the criteria change, which should give c a fresh start
    await service.settle();
    const c = await find(service, "c");
    assert.equal(c.settled, true, "c should be scored once the criteria changed, as changeCriteria does");
  });
});

describe("BUG: pasted replies", () => {
  test("B2 a blank reply marks the person as replied and throws away the waiting follow-up", async () => {
    const followUp = { kind: "follow_up" as const, subject: "Re: Hi", body: "Any thoughts?", createdAt: AT, warnings: [] };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, draft: followUp, contact: { email: "a@x.com", status: "verified", provider: "founder" } }) },
    }));
    const service = serviceOn(store);
    await service.reply("   ", "a", "pasted").catch(() => undefined);
    const a = await find(service, "a");
    assert.equal(a.messages.length, 1, "an empty message should not be recorded as their reply");
    assert.equal(a.stage, "contacted");
    assert.equal(a.draft?.kind, "follow_up", "the follow-up should still be waiting");
  });

  test("B3 a pasted reply is not capped before it reaches the model (every other founder text is capped at 8000)", async () => {
    const seen: JsonRequest[] = [];
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) } }));
    const service = serviceOn(store, { model: modelWith({}, seen) });
    await service.reply("x".repeat(100_000), "a", "pasted");
    const reading = seen.find((request) => request.task === "reply reading")!;
    const sent = (reading.input as { message: string }).message;
    assert.ok(sent.length <= 8000, `the model received ${sent.length} characters`);
  });

  test("B4 a reply from someone whose intro draft is still waiting leaves the cold intro as the next thing to send", async () => {
    const intro = { kind: "intro" as const, subject: "Hi", body: "Hello, saw your work on X. Up for a call?", createdAt: AT, warnings: [] };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro, contact: { email: "a@x.com", status: "verified", provider: "founder" } }) },
    }));
    const model = modelWith({ "reply reading": (data) => ({ candidateId: data.knownCandidateId, interested: true, wantsToSchedule: true, summary: "Keen, free Tuesday." }) });
    const service = serviceOn(store, { model });
    // The founder messaged them by hand on LinkedIn; they answered; the founder pastes it.
    await service.reply("Yes keen, free Tuesday afternoon", "a", "pasted");
    const a = await find(service, "a");
    assert.equal(a.stage, "replied");
    assert.notEqual(a.draft?.kind, "intro", "the waiting draft is still the cold first message; pressing send sends it to someone who just said yes");
  });
});

describe("BUG: Gmail sync", () => {
  test("B5 two overlapping Gmail syncs record the same reply twice", async () => {
    const replyAt = "2026-09-22T02:00:00.000Z";
    const gmail = {
      async connected() { return true; },
      async send() { return { threadId: "t1" }; },
      async repliesIn(_thread: string, since: string) {
        return Date.parse(replyAt) > Date.parse(since) ? [{ from: "a@x.com", at: replyAt, text: "Sounds good" }] : [];
      },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, gmailThreadId: "t1", contact: { email: "a@x.com", status: "verified", provider: "founder" } }) },
    }));
    const service = serviceOn(store, { gmail });
    await Promise.all([service.syncGmail(), service.syncGmail()]);
    const a = await find(service, "a");
    assert.equal(a.messages.filter((m) => m.direction === "inbound").length, 1, "one Gmail reply, recorded once");
  });
});

describe("BUG: outreach for someone already in conversation", () => {
  test("B6 prepareOutreach on someone who replied replaces the waiting scheduling reply with a cold intro", async () => {
    const scheduling = { kind: "scheduling" as const, subject: "Re: Hi", body: "Great, how about Tue 3pm?", createdAt: AT, warnings: [] };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "replied", draft: scheduling, lastContactedAt: AT,
        messages: [outbound(), { direction: "inbound", channel: "email", at: AT, realAt: AT, text: "Keen, when?" }],
        contact: { email: "a@x.com", status: "verified", provider: "founder" },
      }) },
    }));
    const service = serviceOn(store);
    await service.prepareOutreach("a").catch(() => undefined);
    const a = await find(service, "a");
    assert.equal(a.draft?.kind, "scheduling", `the answer to their reply became a "${a.draft?.kind}" first message`);
  });

  test("B7 an address typed into a LinkedIn draft is emailed with an empty subject line", async () => {
    const sent: Array<{ subject: string }> = [];
    const gmail = {
      async connected() { return true; },
      async send(message: { subject: string }) { sent.push(message); return { threadId: "t1" }; },
      async repliesIn() { return []; },
    };
    // For a LinkedIn message the prompt asks for subject "".
    const model = modelWith({
      "outreach draft": (data, request) => ({ subject: request.system.includes("LinkedIn direct message") ? "" : "Quick question", body: `Hi ${data.candidate.name}` }),
    });
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!) } }));
    const service = serviceOn(store, { model, gmail });
    await service.prepareOutreach("a"); // no address found: drafted as a LinkedIn message
    await service.editDraft("a", { email: "a@example.com" }); // the founder types the address in
    await service.send("a", false).catch(() => undefined);
    assert.ok(sent.length === 0 || sent[0]!.subject.trim() !== "", "an email went out with no subject");
  });
});

describe("BUG: duplicate criteria outside add", () => {
  test("B8 editing a criterion into another's text makes a duplicate that counts twice", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "startup", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
      candidates: { b: candidate(person("b", "startup")) },
    }));
    const service = serviceOn(store);
    await service.changeCriteria([{ op: "edit", id: "c2", text: "TypeScript" }], "make the second one typescript");
    await service.settle();
    const texts = (await service.snapshot()).criteria.map((c) => c.text.toLowerCase());
    assert.equal(new Set(texts).size, texts.length, `criteria now read ${JSON.stringify(texts)}`);
  });

  test("B9 revising the draft with the same criterion twice keeps both, so it counts twice after confirming", async () => {
    const service = serviceOn(new MemoryStore());
    await service.start(REQUIREMENT);
    await service.reviseDraft([{ text: "TypeScript", kind: "must" }, { text: "typescript ", kind: "must" }, { text: "startup", kind: "nice" }]);
    const texts = (await service.snapshot()).criteria.map((c) => c.text.toLowerCase().trim());
    assert.equal(new Set(texts).size, texts.length, `draft criteria read ${JSON.stringify(texts)}`);
  });
});

describe("BUG: chat tool arguments", () => {
  test("B10 recruiting_change_criteria refuses a remove because the model filled kind with null", async () => {
    const board = new RoleBoard(new MemoryRoleRepository(), (store) => serviceOn(store));
    const extension = recruitingExtension(board);
    const started = JSON.parse((await extension.run("recruiting_start", { requirement: REQUIREMENT })).content);
    const roleId = started.role_id as string;
    await extension.run("recruiting_confirm", { role_id: roleId });
    const nice = started.status.criteria.find((c: { kind: string }) => c.kind === "nice");
    const result = JSON.parse((await extension.run("recruiting_change_criteria", {
      role_id: roleId,
      changes: [{ op: "remove", id: nice.id, text: null, kind: null }],
    })).content);
    assert.equal(result.error, undefined, `refused: ${result.error}`);
  });
});

describe("BUG: LinkedIn inbox privacy", () => {
  test("B11 a contacted person with a short first name makes unrelated private conversations 'relevant'", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(person("a", "typescript", "An Nguyen"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const service = serviceOn(store);
    const relevant = await service.relevantConversations(["Mum: Can we plan dinner on Friday? I can cook."]);
    assert.deepEqual(relevant, [], "a family conversation that never names An Nguyen would be sent to the model");
  });

  test("B12 one conversation the model cannot read fails the whole post after others were recorded, so the reader's retry records them twice", async () => {
    let bobFails = true;
    const model = modelWith({
      "reply reading": (data) => {
        if (String(data.message).includes("Bob") && bobFails) { bobFails = false; throw new Error("The model could not complete reply reading: HTTP 503"); }
        const match = data.candidates.find((c: { name: string }) => String(data.message).includes(c.name));
        return { candidateId: match?.id ?? null, interested: null, wantsToSchedule: false, summary: "Replied." };
      },
    });
    const repository = new MemoryRoleRepository();
    await repository.store("role1").save(seeded({
      candidates: {
        a: candidate(person("a", "typescript", "Alice Tan"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }),
        b: candidate(person("b", "typescript", "Bob Lee"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }),
      },
    }));
    const board = new RoleBoard(repository, (store) => serviceOn(store, { model }));
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    const threads = [{ text: "Alice Tan\nSounds great, happy to chat" }, { text: "Bob Lee\nMaybe next month" }];
    // scripts/linkedin-inbox.ts saves what it has seen only after a 2xx, so a failure means the same batch again.
    let response = await app.inject({ method: "POST", url: "/api/recruiting/inbox/linkedin", payload: { threads } });
    if (response.statusCode >= 300) response = await app.inject({ method: "POST", url: "/api/recruiting/inbox/linkedin", payload: { threads } });
    const service = await board.get("role1");
    const alice = await find(service, "a");
    assert.equal(alice.messages.filter((m) => m.direction === "inbound").length, 1, "Alice's one message is on record twice");
  });
});

describe("BUG: search rounds", () => {
  test("B13 one failing query out of several fails confirm and throws away what the other queries found", async () => {
    const model = modelWith({
      "criteria extraction": () => ({ title: "Backend engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["q1", "q2", "q3"] }),
    });
    const source = sourceWith(async (query) => {
      if (query === "q2") throw new Error("Exa search failed: The operation was aborted due to timeout");
      return POOL;
    });
    const service = serviceOn(new MemoryStore(), { model, source });
    await service.start(REQUIREMENT);
    const outcome = await service.confirm().then(() => "confirmed", (error: Error) => error.message);
    const snapshot = await service.snapshot();
    assert.equal(outcome, "confirmed", "two of three queries answered, yet the role could not be confirmed");
    assert.ok(snapshot.candidates.length > 0);
  });
});

describe("BUG: adding people by link", () => {
  test("B14 a LinkedIn share link (with ?utm_source=share) is refused as 'not a LinkedIn profile link'", async () => {
    const source = sourceWith(undefined, async (urls) => urls.map((url, i) => ({ ...person(`r${i}`, "typescript"), profileUrl: url })));
    const store = await storeWith(seeded());
    const service = serviceOn(store, { source });
    const outcome = await service
      .importProfiles(["https://www.linkedin.com/in/jane-doe-1a2b3c?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app"])
      .then((result) => result.message, (error: Error) => `refused: ${error.message}`);
    assert.doesNotMatch(outcome, /refused/);
  });
});

describe("BUG: decisions on closed people", () => {
  test("B15 passing on someone already hired rewrites the hire as a pass", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "closed", closedReason: "hired", closedAt: AT, messages: [outbound()] }) },
    }));
    const service = serviceOn(store);
    await service.feedback("a", "pass", "not for this role").catch(() => undefined);
    const a = await find(service, "a");
    assert.equal(a.closedReason, "hired", `the hire now reads "${a.closedReason}"`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("two concurrent confirms: one search round, the second is refused", async () => {
    let searches = 0;
    const service = serviceOn(new MemoryStore(), { source: sourceWith(async () => { searches += 1; return POOL; }) });
    await service.start(REQUIREMENT);
    const outcomes = await Promise.allSettled([service.confirm(), service.confirm()]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(searches, 1);
    assert.equal((await service.snapshot()).candidates.length, 3);
  });

  test("a reply naming a candidate id that does not exist records nothing and does not throw", async () => {
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()] }) } }));
    const service = serviceOn(store);
    const result = await service.reply("hello", "nobody", "pasted");
    assert.equal(result.intent, "reply");
    assert.equal((await find(service, "a")).messages.length, 1);
  });

  test("a 1 MB requirement is capped at 8000 characters before reaching the model", async () => {
    const seen: JsonRequest[] = [];
    const service = serviceOn(new MemoryStore(), { model: modelWith({}, seen) });
    await service.start(`${"需要 TypeScript 工程师 🚀 ".repeat(50_000)}`);
    const input = seen.find((r) => r.task === "criteria extraction")!.input as { requirement: string };
    assert.ok(input.requirement.length <= 8000);
  });

  test("unicode and emoji criteria added through the chat tool are kept exactly and scored", async () => {
    const board = new RoleBoard(new MemoryRoleRepository(), (store) => serviceOn(store));
    const extension = recruitingExtension(board);
    const started = JSON.parse((await extension.run("recruiting_start", { requirement: REQUIREMENT })).content);
    await extension.run("recruiting_confirm", { role_id: started.role_id });
    const result = JSON.parse((await extension.run("recruiting_change_criteria", {
      role_id: started.role_id, changes: [{ op: "add", text: "熟悉 Rust 🦀", kind: "nice" }],
    })).content);
    assert.equal(result.error, undefined);
    assert.ok(result.status.criteria.some((c: { text: string }) => c.text === "熟悉 Rust 🦀"));
  });

  test("deleting a role while find-more is searching: find-more fails cleanly and the role stays deleted", async () => {
    let release!: () => void;
    let entered!: () => void;
    const inSearch = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const source = sourceWith(async (query) => {
      if (query.startsWith("more") && !held) { held = true; entered(); await gate; }
      return POOL;
    });
    const repository = new MemoryRoleRepository();
    const board = new RoleBoard(repository, (store) => serviceOn(store, { source }));
    const { id, service } = board.create();
    await service.start(REQUIREMENT);
    await service.confirm();
    await service.settle();
    const more = service.findMore().then(() => "ok", (error: Error) => error.message);
    await inSearch;
    const removing = board.remove(id);
    release();
    await removing;
    await more;
    assert.deepEqual(await repository.list(), []);
    await assert.rejects(board.get(id));
  });

  test("control for B1: changing criteria in the chat does give a used-up person fresh retries", async () => {
    let failing = true;
    const model = modelWith({
      "criterion judgement": (data) => {
        if (failing && data.profile.id === "c") throw new Error("HTTP 429");
        return { verdicts: data.criteria.map((c: { id: string; text: string }) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) };
      },
    });
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!), c: candidate(POOL[2]!, { stage: "discovered", verdicts: {} }) },
    }));
    const service = serviceOn(store, { model });
    for (let i = 0; i < 4; i += 1) await service.settle();
    failing = false;
    await service.settle();
    assert.equal((await find(service, "c")).settled, false, "retries are used up, as designed");
    await service.changeCriteria([{ op: "add", text: "rust", kind: "nice" }], "rust is a plus");
    await service.settle();
    assert.equal((await find(service, "c")).settled, true);
  });

  test("a follow-up is not drafted over a draft that is being sent", async () => {
    let letGo!: (value: { threadId: string }) => void;
    const gmail = {
      async connected() { return true; },
      send: () => new Promise<{ threadId: string }>((resolve) => { letGo = resolve; }),
      async repliesIn() { return []; },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", followUps: 0, lastContactedAt: AT, messages: [outbound()],
        draft: { kind: "follow_up", subject: "Re", body: "Nudge", createdAt: AT, warnings: [] },
        contact: { email: "a@x.com", status: "verified", provider: "founder" },
      }) },
    }));
    const service = serviceOn(store, { gmail });
    const sending = service.send("a", false);
    while (!letGo) await new Promise((resolve) => setImmediate(resolve));
    await service.fastForward(6);
    letGo({ threadId: "t1" });
    await sending;
    const a = await find(service, "a");
    assert.equal(a.followUps, 1);
    assert.equal(a.draft, null);
  });
});
