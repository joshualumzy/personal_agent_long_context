// Round 11 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r11-backend.test.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import type { Candidate, CandidateProfile, RecruitingState } from "../../src/recruiting/domain.js";
import { GmailClient } from "../../src/recruiting/gmail.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel, JsonRequest } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService, type RecruitingSettings } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";
import { MemoryStore, type StateStore } from "../../src/recruiting/store.js";

const AT = "2026-09-20T02:00:00.000Z";
const NOW = new Date("2026-09-23T02:00:00.000Z");
const REQUIREMENT = "We need a backend engineer in Singapore who knows TypeScript.";

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
          // Queries written from the criteria as they stand.
          return { queries: data.criteria.map((c: { text: string }) => `${c.text} engineer singapore`) } as T;
        case "reply reading":
          return { candidateId: data.knownCandidateId ?? data.candidates[0]?.id ?? null, interested: null, wantsToSchedule: false, summary: "Replied." } as T;
        case "criteria extraction":
          return { title: "Backend Engineer", criteria: [{ text: "typescript", kind: "must" }], queries: ["typescript engineer singapore"] } as T;
        default:
          throw new Error(`unscripted ${request.task}`);
      }
    },
  };
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
  } as RecruitingState;
}

async function storeWith(state: RecruitingState): Promise<StateStore> {
  const store = new MemoryStore();
  await store.save(state);
  return store;
}

function serviceOn(store: StateStore, opts: { model?: JsonModel; source?: CandidateSource; settings?: Partial<RecruitingSettings> } = {}) {
  return new RecruitingService({
    model: opts.model ?? modelWith(),
    source: opts.source ?? { name: "fake", search: async () => [] },
    store, memory: new LocalIntentMemory(),
    contactFinders: [], gmail: null, clock: () => NOW,
    settings: { founderName: "Michael", companyName: "Acme", rescoreAfterMs: 1e9, ...opts.settings },
  });
}

const outbound = (text = "Hi\n\nHello") => ({ direction: "outbound" as const, channel: "email" as const, at: AT, realAt: AT, text });
const find = async (service: RecruitingService, id: string) => (await service.snapshot()).candidates.find((c) => c.id === id)!;

/** A Gmail client over a fake Google: the founder is `own`, the thread holds `messages`. */
async function gmailOver(own: string, messages: unknown[]): Promise<GmailClient> {
  const dir = await mkdtemp(join(tmpdir(), "r11-gmail-"));
  const tokenPath = join(dir, "token.json");
  await writeFile(tokenPath, JSON.stringify({ refresh_token: "r" }));
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "a", expires_in: 3600 });
    if (url.endsWith("users/me/profile")) return json({ emailAddress: own });
    // Replies are read by sender: a search lists the messages, then each is fetched.
    // Like the real "from:<candidate>" search, the founder's own mail is never listed.
    const fromHeader = (m: unknown) => String((m as { payload?: { headers?: { name: string; value: string }[] } }).payload?.headers?.find((h) => h.name === "From")?.value ?? "");
    const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
    if (url.includes("users/me/messages?")) {
      return json({ messages: messages.flatMap((m, i) => (addressOf(fromHeader(m)) === own.toLowerCase() ? [] : [{ id: String(i) }])) });
    }
    const one = /users\/me\/messages\/(\d+)/.exec(url);
    if (one) return json(messages[Number(one[1])]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return new GmailClient({ clientId: "c", clientSecret: "s", redirectUri: "http://x/cb", tokenPath, fetch: fakeFetch });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const gmailMessage = (from: string, atMs: number, part: unknown) => ({
  internalDate: String(atMs),
  payload: { headers: [{ name: "From", value: from }], ...(part as object) },
});
const plainPart = (text: string) => ({ mimeType: "text/plain", body: { data: b64(text) } });

// ======================================================================= bugs

describe("BUG: the chat cannot reach a person the criteria ruled out, even one the founder added by link", () => {
  test("B1 the founder imports a friend (Zoe) by link, she misses two musts, and they ask the chat to draft to her anyway: no tool shows her id and prepare_outreach refuses her name", async () => {
    const repo = new MemoryRoleRepository();
    const no = (criterionId: string) => ({ criterionId, satisfied: "no" as const, reasoning: "x" });
    const yes = (criterionId: string) => ({ criterionId, satisfied: "yes" as const, reasoning: "x" });
    await repo.store("role1").save(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "singapore", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
      candidates: {
        amy: candidate(person("amy", "typescript singapore", "Amy Lim"), { verdicts: { c1: yes("c1"), c2: yes("c2") } }),
        "cand-zoe-7": candidate(person("cand-zoe-7", "python london", "Zoe Tan"), { origin: "referral", verdicts: { c1: no("c1"), c2: no("c2") } }),
      },
    }));
    const board = new RoleBoard(repo, (store) => serviceOn(store));
    const chat = recruitingExtension(board);

    const status = await chat.run("recruiting_status", { role_id: "role1" });
    const idVisible = status.content.includes("cand-zoe-7");
    const byName = await chat.run("recruiting_prepare_outreach", { role_id: "role1", candidate_id: "Zoe Tan" });
    const draftedByName = !byName.content.includes("\"error\"");
    assert.ok(idVisible || draftedByName, `Zoe cannot be reached from the chat: her id is in no status, and prepare_outreach said ${byName.content}`);
  });
});

describe("BUG: criteria revised before confirming are ignored by the first search", () => {
  test("B2 the draft says TypeScript; the founder changes it to Go and confirms; the search still runs the TypeScript queries only", async () => {
    const searched: string[] = [];
    const source: CandidateSource = { name: "fake", search: async (query) => { searched.push(query); return []; } };
    const service = serviceOn(new MemoryStore(), { source });
    await service.start(REQUIREMENT);
    await service.reviseDraft([{ text: "golang", kind: "must" }, { text: "fintech", kind: "nice" }]);
    await service.confirm();
    const stale = new Set(["typescript engineer singapore"]);
    assert.ok(
      searched.some((query) => !stale.has(query)),
      `searched only the queries written for the old criteria: ${JSON.stringify(searched)} (criteria now: golang, fintech)`,
    );
  });
});

describe("BUG: 'I sent it myself' is refused when the draft has a private-remark warning", () => {
  // Not adopted (round 11): the original spec (test/recruiting.test.ts) blocks a manual send with a private-remark warning too.
  test.skip("B3 the founder already sent the message by hand; recording it is refused, so the record says they never wrote", async () => {
    const store = await storeWith(seeded({
      feedback: [{ candidateId: "b", decision: "pass", statedReason: "too junior for us", inferredReason: "junior", at: AT }],
      candidates: {
        a: candidate(person("a", "typescript"), {
          stage: "drafted",
          draft: {
            kind: "intro", subject: "", body: "Hi a, not too junior for us at all", createdAt: AT,
            warnings: ["The draft repeats something you said privately: \"too junior for us\". Edit it before sending."],
          },
        }),
      },
    }));
    const service = serviceOn(store);
    const outcome = await service.send("a", true).then(() => "recorded", (error: Error) => error.message);
    const a = await find(service, "a");
    assert.ok(
      a.messages.some((message) => message.direction === "outbound"),
      `the founder's own send was not recorded (${outcome}); stage ${a.stage}`,
    );
  });
});

describe("BUG: an Outlook reply carries the founder's whole original email into the candidate's message", () => {
  test("B4 'Sounds good' followed by Outlook's From/Sent/To/Subject block: the founder's intro is read as the candidate's words", async () => {
    const body = [
      "Sounds good, Tuesday 3pm works for me.",
      "",
      "Alice",
      "",
      "________________________________",
      "From: Michael Lee <michael@acme.com>",
      "Sent: Monday, September 21, 2026 10:00 AM",
      "To: Alice Tan <alice@corp.com>",
      "Subject: Backend role at Acme",
      "",
      "Hi Alice, saw you built the offline sync for the driver app. Up for a 15 minute call?",
      "",
      "Michael",
    ].join("\r\n");
    const gmail = await gmailOver("michael@acme.com", [gmailMessage("Alice Tan <alice@corp.com>", Date.parse("2026-09-22T00:00:00Z"), plainPart(body))]);
    const replies = await gmail.repliesFrom("alice@corp.com", "2026-09-21T00:00:00Z");
    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.includes("Tuesday 3pm"));
    assert.ok(!replies[0]!.text.includes("offline sync"), `the founder's own email is part of the reply: ${JSON.stringify(replies[0]!.text)}`);
  });
});

describe("BUG: a reply from an address that ends with the founder's address is taken for the founder's own", () => {
  test("B5 founder jaxtan@gmail.com, candidate ajaxtan@gmail.com: the candidate's reply is dropped", async () => {
    const gmail = await gmailOver("jaxtan@gmail.com", [
      gmailMessage("Jax Tan <jaxtan@gmail.com>", Date.parse("2026-09-21T12:00:00Z"), plainPart("Hi, saw your work")),
      gmailMessage("A. Jaxtan <ajaxtan@gmail.com>", Date.parse("2026-09-22T00:00:00Z"), plainPart("Yes, keen to talk")),
    ]);
    const replies = await gmail.repliesFrom("alice@corp.com", "2026-09-21T00:00:00Z");
    assert.deepEqual(replies.map((reply) => reply.text), ["Yes, keen to talk"], "the candidate's reply is filtered out as the founder's own");
  });
});

describe("BUG: a reply sent as HTML only is never read", () => {
  test("B6 a text/html-only message ('Yes, Tuesday works') is dropped as empty, so the reply is lost", async () => {
    const gmail = await gmailOver("michael@acme.com", [
      gmailMessage("Alice <alice@corp.com>", Date.parse("2026-09-22T00:00:00Z"), { mimeType: "text/html", body: { data: b64("<div dir=\"ltr\">Yes, Tuesday works</div>") } }),
    ]);
    const replies = await gmail.repliesFrom("alice@corp.com", "2026-09-21T00:00:00Z");
    assert.equal(replies.length, 1, "the HTML-only reply was dropped");
    assert.ok(replies[0]!.text.includes("Tuesday works"));
  });
});

describe("BUG: a pasted reply whose first or second line is a day loses a correction of that day", () => {
  test("B7 'Sure!\\nTuesday\\nat 3pm works' then 'Sure!\\nWednesday\\nat 3pm works': the correction is reported as already on record", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(person("a", "typescript"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const service = serviceOn(store);
    await service.reply("Sure!\nTuesday\nat 3pm works", "a", "pasted");
    const second = await service.reply("Sure!\nWednesday\nat 3pm works", "a", "pasted");
    const inbound = (await find(service, "a")).messages.filter((m) => m.direction === "inbound").map((m) => m.text);
    assert.equal(inbound.length, 2, `the corrected day is lost (${second.message}); inbound: ${JSON.stringify(inbound)}`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("keep undoes a founder's 'withdrawn' but a pass never overturns a founder's hire", async () => {
    const store = await storeWith(seeded({
      candidates: {
        a: candidate(person("a", "typescript"), { stage: "closed", closedReason: "withdrawn", closedAt: AT, closedBy: "founder", messages: [outbound()] }),
        b: candidate(person("b", "typescript"), { stage: "closed", closedReason: "hired", closedAt: AT, closedBy: "founder" }),
      },
    }));
    const service = serviceOn(store);
    await service.feedback("a", "keep");
    await service.feedback("b", "pass");
    assert.equal((await find(service, "a")).stage, "contacted");
    assert.equal((await find(service, "b")).closedReason, "hired");
  });

  test("confirming unrevised draft criteria searches the drafted queries without another model call", async () => {
    const searched: string[] = [];
    const source: CandidateSource = { name: "fake", search: async (query) => { searched.push(query); return []; } };
    const service = serviceOn(new MemoryStore(), { source });
    await service.start(REQUIREMENT);
    await service.confirm();
    assert.deepEqual(searched, ["typescript engineer singapore"]);
  });

  test("Gmail's own 'On ... wrote:' quote and '>' lines are cut, and the founder's messages are skipped", async () => {
    const gmail = await gmailOver("michael@acme.com", [
      gmailMessage("Michael <michael@acme.com>", Date.parse("2026-09-21T12:00:00Z"), plainPart("Hi Alice")),
      gmailMessage("Alice <alice@corp.com>", Date.parse("2026-09-22T00:00:00Z"), plainPart("Yes please\n\nOn Mon, Sep 21, 2026 at 8:00 PM Michael <michael@acme.com> wrote:\n> Hi Alice")),
    ]);
    const replies = await gmail.repliesFrom("alice@corp.com", "2026-09-21T00:00:00Z");
    assert.deepEqual(replies.map((reply) => reply.text), ["Yes please"]);
  });

  test("a multipart/alternative reply is read from its text/plain part", async () => {
    const gmail = await gmailOver("michael@acme.com", [
      gmailMessage("Alice <alice@corp.com>", Date.parse("2026-09-22T00:00:00Z"), {
        mimeType: "multipart/alternative",
        parts: [plainPart("Tuesday works"), { mimeType: "text/html", body: { data: b64("<p>Tuesday works</p>") } }],
      }),
    ]);
    assert.deepEqual((await gmail.repliesFrom("alice@corp.com", "2026-09-21T00:00:00Z")).map((reply) => reply.text), ["Tuesday works"]);
  });

  test("the chat status lists a ruled-in candidate among the first 15 with their id", async () => {
    const repo = new MemoryRoleRepository();
    await repo.store("role1").save(seeded({ candidates: { "cand-amy-1": candidate(person("cand-amy-1", "typescript", "Amy Lim")) } }));
    const chat = recruitingExtension(new RoleBoard(repo, (store) => serviceOn(store)));
    const status = await chat.run("recruiting_status", { role_id: "role1" });
    assert.ok(status.content.includes("cand-amy-1"));
  });

  test("a LinkedIn preview relayed again with a changed time label is still one message", async () => {
    const store = await storeWith(seeded({
      candidates: { a: candidate(person("a", "typescript"), { stage: "contacted", messages: [outbound()], lastContactedAt: AT }) },
    }));
    const service = serviceOn(store);
    await service.reply("Alex Wong\n10:32 AM\nSounds good, see you", "a", "linkedin");
    const again = await service.reply("Alex Wong\nYesterday\nSounds good, see you", "a", "linkedin");
    assert.equal(again.duplicate, true);
  });

  test("sending by Gmail is still refused while a private-remark warning stands", async () => {
    const store = await storeWith(seeded({
      candidates: {
        a: candidate(person("a", "typescript"), {
          stage: "drafted", contact: { email: "a@x.com", status: "verified", provider: "founder" },
          draft: { kind: "intro", subject: "Hi", body: "b", createdAt: AT, warnings: ["The draft repeats something you said privately."] },
        }),
      },
    }));
    const service = serviceOn(store);
    await assert.rejects(service.send("a", false), /privately/);
  });
});
