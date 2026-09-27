// Round 5 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r5-backend.test.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DeterministicMemoryProvider } from "../../src/adapters/deterministic-memory.js";
import { buildApp } from "../../src/http-app.js";
import type { Candidate, CandidateProfile, Draft, RecruitingState } from "../../src/recruiting/domain.js";
import { GmailClient } from "../../src/recruiting/gmail.js";
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

function modelWith(over: Record<string, Handler> = {}): JsonModel {
  return {
    async json<T>(request: JsonRequest): Promise<T> {
      const data = request.input as Record<string, any>;
      if (over[request.task]) return over[request.task]!(data, request) as T;
      switch (request.task) {
        case "criteria extraction":
          return { title: "Backend engineer", criteria: [{ text: "typescript", kind: "must" }, { text: "startup", kind: "must" }], queries: ["q1"] } as T;
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

/** A memory store whose next save can be made to fail, like a busy disk. */
class FlakyStore extends MemoryStore {
  failNext = false;
  override async save(state: RecruitingState): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("EBUSY: resource busy or locked");
    }
    await super.save(state);
  }
}

async function flakyWith(state: RecruitingState): Promise<FlakyStore> {
  const store = new FlakyStore();
  await store.save(state);
  return store;
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
const outboundCount = async (service: RecruitingService, id: string) =>
  (await find(service, id)).messages.filter((m) => m.direction === "outbound").length;

// ======================================================================= bugs

describe("BUG: Gmail send classified as 'certainly not sent'", () => {
  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("B1 a 200 from Gmail with an unreadable body releases the claim, so the next press emails the person again", async () => {
    // The real GmailClient over a fake network: Gmail accepts the message, but the body
    // that comes back is a proxy page, so response.json() throws "Unexpected token '<' ...".
    const dir = await mkdtemp(join(tmpdir(), "r5-gmail-"));
    const tokenPath = join(dir, "token.json");
    await writeFile(tokenPath, JSON.stringify({ refresh_token: "r" }));
    let delivered = 0;
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "x", expires_in: 3600 });
      if (url.endsWith("users/me/profile")) return Response.json({ emailAddress: "me@acme.com" });
      if (url.endsWith("users/me/messages/send")) {
        delivered += 1;
        return new Response("<html>upstream hiccup</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const gmail = new GmailClient({ clientId: "id", clientSecret: "s", redirectUri: "http://x/cb", tokenPath, fetch: fetchFake });
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(store, { gmail });
    const first = await service.send("a", false).then(() => "ok", (e: Error) => e.message);
    assert.equal(delivered, 1);
    // The founder sees an error and presses send again.
    await service.send("a", false).catch(() => undefined);
    assert.equal(delivered, 1, `Gmail received the same email ${delivered} times (first press answered: ${first})`);
  });
});

describe("BUG: a claimed draft with nothing in flight", () => {
  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("B2 Gmail's answer is lost and saving 'unconfirmed' fails: the draft stays 'being sent' for good, no action gets past it", async () => {
    let flaky!: FlakyStore;
    const gmail = {
      async connected() { return true; },
      async send() { flaky.failNext = true; throw new TypeError("fetch failed"); },
      async hasMailbox() { return true; },
      async repliesFrom() { return []; },
    };
    flaky = await flakyWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(flaky, { gmail });
    await assert.rejects(service.send("a", false));
    // Nothing is in flight any more. The founder checks Sent and either marks it sent,
    // or (not there) edits the draft to send again. At least one must work.
    const marked = await service.send("a", true).then(() => "ok", (e: { code?: string }) => e.code);
    if (marked === "ok") return;
    const edited = await service.editDraft("a", { body: "Hello again" }).then(() => "ok", (e: { code?: string }) => e.code);
    const prepared = await service.prepareOutreach("a").then(() => "ok", (e: { code?: string }) => e.code);
    assert.fail(`stuck: "I sent it myself" -> ${marked}, edit -> ${edited}, redraft -> ${prepared}; draft ${JSON.stringify((await find(service, "a")).draft)}`);
  });
});

describe("BUG: recording a send twice", () => {
  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("B3 after a failed record, two presses at once both record the one email (two outbound messages, two follow-ups counted)", async () => {
    let flaky!: FlakyStore;
    let sent = 0;
    const gmail = {
      async connected() { return true; },
      async send() { sent += 1; flaky.failNext = true; return { threadId: "t1" }; },
      async hasMailbox() { return true; },
      async repliesFrom() { return []; },
    };
    flaky = await flakyWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", messages: [outbound()], lastContactedAt: AT, draft: { kind: "follow_up", subject: "Re: Hi", body: "Nudge", createdAt: AT, warnings: [] }, ...withEmail,
      }) },
    }));
    const service = serviceOn(flaky, { gmail });
    await assert.rejects(service.send("a", false)); // Gmail sent it; saving the record failed
    await Promise.allSettled([service.send("a", false), service.send("a", false)]);
    assert.equal(sent, 1);
    const a = await find(service, "a");
    assert.equal(a.messages.filter((m) => m.direction === "outbound").length, 2, `one earlier email plus this one; got ${a.messages.length} outbound`);
    assert.equal(a.followUps, 1, `followUps counted ${a.followUps} times`);
  });

  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("B4 two 'I sent it myself' presses on an unconfirmed email both record it", async () => {
    const gmail = {
      async connected() { return true; },
      async send() { throw new TypeError("fetch failed"); },
      async hasMailbox() { return true; },
      async repliesFrom() { return []; },
    };
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(store, { gmail });
    await assert.rejects(service.send("a", false), { code: "send_unconfirmed" } as never);
    await Promise.allSettled([service.send("a", true), service.send("a", true)]);
    assert.equal(await outboundCount(service, "a"), 1, "one email is on record as sent twice");
  });
});

describe("BUG: Gmail replies missed", () => {
  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("B5 a send recorded late is stamped with the record time, so a reply that came in between is never read", async () => {
    const T0 = Date.parse("2026-09-23T02:00:00.000Z");
    let now = T0;
    let flaky!: FlakyStore;
    const replyAt = new Date(T0 + 3_600_000).toISOString(); // they answer an hour later
    const gmail = {
      async connected() { return true; },
      async send() { flaky.failNext = true; return { threadId: "t1" }; },
      async hasMailbox() { return true; },
      async repliesFrom(_thread: string, since: string) {
        return Date.parse(replyAt) > Date.parse(since) ? [{ from: "a@x.com", at: replyAt, text: "Sounds good, happy to chat" }] : [];
      },
    };
    flaky = await flakyWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(flaky, { gmail, clock: () => new Date(now) });
    await assert.rejects(service.send("a", false)); // sent at T0, record failed
    now = T0 + 2 * 3_600_000;
    await service.send("a", false); // the next press only records it
    await service.syncGmail();
    const a = await find(service, "a");
    assert.equal(a.messages.filter((m) => m.direction === "inbound").length, 1, "their reply in the Gmail thread was never read");
  });
});

describe("BUG: criteria batch order", () => {
  test("B6 'edit A into B's words, then drop B' leaves neither: the edit merged A into B, then B was removed", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "rust", kind: "nice", origin: "stated", active: true, createdAt: AT },
        { id: "c3", text: "startup", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
    }));
    const service = serviceOn(store);
    const said = "Replace startup with rust as a must, and drop the old rust nice-to-have";
    const outcome = await service
      .changeCriteria([{ op: "edit", id: "c3", text: "rust" }, { op: "remove", id: "c2" }], said)
      .then((result) => result.message, (e: Error) => `refused: ${e.message}`);
    const texts = (await service.snapshot()).criteria.map((c) => c.text);
    if (outcome.startsWith("refused")) {
      assert.deepEqual(texts, ["typescript", "rust", "startup"], "a refused batch must change nothing");
      return;
    }
    assert.ok(texts.includes("rust"), `after "${outcome}" the criteria are ${JSON.stringify(texts)}: "rust" was asked for and is gone`);
  });
});

describe("BUG: LinkedIn inbox across roles", () => {
  test("B7 a newer role whose contact shares a first name claims the conversation, cannot place it, and the real role never sees it", async () => {
    const model = modelWith({
      "reply reading": (data) => {
        const match = data.candidates.find((c: { name: string }) => String(data.message).includes(c.name));
        return { candidateId: match?.id ?? null, interested: true, wantsToSchedule: false, summary: "Keen." };
      },
    });
    const repository = new MemoryRoleRepository();
    await repository.store("older").save(seeded({
      role: { title: "Backend engineer", requirement: REQUIREMENT, confirmed: true, createdAt: "2026-09-10T00:00:00.000Z" },
      candidates: { w: candidate(person("w", "typescript", "Alex Wong"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    await repository.store("newer").save(seeded({
      role: { title: "Designer", requirement: REQUIREMENT, confirmed: true, createdAt: "2026-09-20T00:00:00.000Z" },
      candidates: { t: candidate(person("t", "typescript", "Alex Tan"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const board = new RoleBoard(repository, (store) => serviceOn(store, { model }));
    const app = buildApp({ memory: new DeterministicMemoryProvider(), recruiting: { board, gmail: null } });
    const response = await app.inject({
      method: "POST", url: "/api/recruiting/inbox/linkedin",
      payload: { threads: [{ text: "Alex Wong\nYes, keen to chat next week" }] },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { result: { results: { message: string }[]; failed?: string[] } };
    const wong = await find(await board.get("older"), "w");
    assert.equal(
      wong.messages.filter((m) => m.direction === "inbound").length, 1,
      `Alex Wong's reply was recorded nowhere and not reported as failed (so the reader never retries it): ${JSON.stringify(body.result)}`,
    );
  });
});

describe("BUG: redrafting over the founder's words", () => {
  test("B8 preparing outreach again silently replaces an intro the founder rewrote by hand", async () => {
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, withEmail) } }));
    const service = serviceOn(store);
    await service.prepareOutreach("a");
    await service.editDraft("a", { body: "Hey Person a, I loved your talk at JSConf. Coffee?" });
    // Later in the chat: "let's reach out to Person a" -> recruiting_prepare_outreach.
    await service.prepareOutreach("a").catch(() => undefined);
    assert.equal((await find(service, "a")).draft?.body, "Hey Person a, I loved your talk at JSConf. Coffee?", "the founder's own words were overwritten");
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("the other order ('drop B, then edit A into B's words') renames A as asked", async () => {
    const store = await storeWith(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "rust", kind: "nice", origin: "stated", active: true, createdAt: AT },
        { id: "c3", text: "startup", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
    }));
    const service = serviceOn(store);
    await service.changeCriteria([{ op: "remove", id: "c2" }, { op: "edit", id: "c3", text: "rust" }], "x");
    const criteria = (await service.snapshot()).criteria;
    assert.deepEqual(criteria.map((c) => [c.id, c.text, c.kind]), [["c1", "typescript", "must"], ["c3", "rust", "must"]]);
  });

  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("a Gmail HTTP 4xx releases the claim and the retry sends exactly once more", async () => {
    let calls = 0;
    const gmail = {
      async connected() { return true; },
      async send() { calls += 1; if (calls === 1) throw new Error("Gmail request failed with HTTP 400."); return { threadId: "t1" }; },
      async hasMailbox() { return true; },
      async repliesFrom() { return []; },
    };
    const store = await storeWith(seeded({ candidates: { a: candidate(POOL[0]!, { stage: "drafted", draft: intro(), ...withEmail }) } }));
    const service = serviceOn(store, { gmail });
    await assert.rejects(service.send("a", false));
    await service.send("a", false);
    assert.equal(calls, 2);
    assert.equal(await outboundCount(service, "a"), 1);
  });

  test("Gmail sync single-flight does not stick: a later sync runs again and reads a new reply", async () => {
    let replies: { from: string; at: string; text: string }[] = [];
    const gmail = {
      async connected() { return true; },
      async send() { return { threadId: "t1" }; },
      async hasMailbox() { return true; },
      async repliesFrom(_t: string, since: string) { return replies.filter((r) => Date.parse(r.at) > Date.parse(since)); },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }) },
    }));
    const service = serviceOn(store, { gmail });
    assert.equal(await service.syncGmail(), 0);
    replies = [{ from: "a@x.com", at: "2026-09-21T00:00:00.000Z", text: "Yes" }];
    assert.equal(await service.syncGmail(), 1);
    assert.equal(await service.syncGmail(), 0);
  });

  test("prepareOutreach by stage: contacted gets a follow-up, replied gets a scheduling reply", async () => {
    const store = await storeWith(seeded({
      candidates: {
        a: candidate(POOL[0]!, { stage: "contacted", messages: [outbound()], lastContactedAt: AT, ...withEmail }),
        b: candidate(POOL[1]!, { stage: "replied", messages: [outbound(), { direction: "inbound", channel: "email", at: AT, realAt: AT, text: "Keen" }], ...withEmail }),
      },
    }));
    const service = serviceOn(store);
    await service.prepareOutreach("a");
    await service.prepareOutreach("b");
    assert.equal((await find(service, "a")).draft?.kind, "follow_up");
    assert.equal((await find(service, "b")).draft?.kind, "scheduling");
  });

  // Retired at the S2 merge (docs/s3-bug-hunt.md): the server no longer sends email; the founder sends from their own Gmail and the page records it.
  test.skip("a reply while a follow-up is being sent keeps that draft; the send then records it without reopening anything", async () => {
    let letGo!: (value: { threadId: string }) => void;
    const gmail = {
      async connected() { return true; },
      send: () => new Promise<{ threadId: string }>((resolve) => { letGo = resolve; }),
      async hasMailbox() { return true; },
      async repliesFrom() { return []; },
    };
    const store = await storeWith(seeded({
      candidates: { a: candidate(POOL[0]!, {
        stage: "contacted", messages: [outbound()], lastContactedAt: AT, draft: { kind: "follow_up", subject: "Re", body: "Nudge", createdAt: AT, warnings: [] }, ...withEmail,
      }) },
    }));
    const service = serviceOn(store, { gmail });
    const sending = service.send("a", false);
    while (!letGo) await new Promise((resolve) => setImmediate(resolve));
    await service.reply("Sure, let's talk", "a", "pasted");
    letGo({ threadId: "t1" });
    await sending;
    const a = await find(service, "a");
    assert.equal(a.stage, "replied");
    assert.equal(a.messages.length, 3);
  });
});
