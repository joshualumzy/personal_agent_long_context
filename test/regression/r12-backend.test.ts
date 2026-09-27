// Round 12 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r12-backend.test.ts
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

function modelWith(): JsonModel {
  return {
    async json<T>(request: JsonRequest): Promise<T> {
      const data = request.input as Record<string, any>;
      switch (request.task) {
        case "criterion judgement":
          return { verdicts: data.criteria.map((c: { id: string; text: string }) => ({ criterionId: c.id, satisfied: data.profile.summary.includes(c.text) ? "yes" : "no", reasoning: "k" })) } as T;
        case "outreach draft":
          return { subject: "Hi", body: `Hello ${data.candidate?.name ?? ""}` } as T;
        case "reply reading":
          return { candidateId: data.knownCandidateId ?? data.candidates[0]?.id ?? null, interested: null, wantsToSchedule: false, summary: "Replied." } as T;
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

function serviceOn(store: StateStore, opts: { source?: CandidateSource; settings?: Partial<RecruitingSettings> } = {}) {
  return new RecruitingService({
    model: modelWith(),
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
  const dir = await mkdtemp(join(tmpdir(), "r12-gmail-"));
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
const REPLY_AT = Date.parse("2026-09-22T00:00:00Z");
const SINCE = "2026-09-21T00:00:00Z";

// ======================================================================= bugs

describe("BUG: not_in_view stops at 40, so a ruled-out person added after a big search is out of the chat's reach", () => {
  test("B1 one search round rules out 45 people; the founder then adds Zoe by link, she is ruled out too, and asks to draft to her anyway: her id is in no status list and prepare_outreach refuses her name", async () => {
    const repo = new MemoryRoleRepository();
    const no = {
      c1: { criterionId: "c1", satisfied: "no" as const, reasoning: "x" },
      c2: { criterionId: "c2", satisfied: "no" as const, reasoning: "x" },
    };
    const yes = {
      c1: { criterionId: "c1", satisfied: "yes" as const, reasoning: "x" },
      c2: { criterionId: "c2", satisfied: "yes" as const, reasoning: "x" },
    };
    const candidates: Record<string, Candidate> = {
      amy: candidate(person("amy", "typescript singapore", "Amy Lim"), { verdicts: yes }),
    };
    // A default search round (3 queries x 30 results) easily yields this many people the criteria rule out.
    for (let index = 0; index < 45; index += 1) {
      const id = `search-${index}`;
      candidates[id] = candidate(person(id, "python", `Searched ${index}`), { verdicts: no });
    }
    // Added last, by link: insertion order puts her after everyone the search found.
    candidates["cand-zoe-7"] = candidate(person("cand-zoe-7", "python london", "Zoe Tan"), { origin: "referral", verdicts: no });
    await repo.store("role1").save(seeded({
      criteria: [
        { id: "c1", text: "typescript", kind: "must", origin: "stated", active: true, createdAt: AT },
        { id: "c2", text: "singapore", kind: "must", origin: "stated", active: true, createdAt: AT },
      ],
      candidates,
    }));
    const chat = recruitingExtension(new RoleBoard(repo, (store) => serviceOn(store)));

    const status = await chat.run("recruiting_status", { role_id: "role1" });
    const idVisible = status.content.includes("cand-zoe-7");
    const byName = await chat.run("recruiting_prepare_outreach", { role_id: "role1", candidate_id: "Zoe Tan" });
    const draftedByName = !byName.content.includes("\"error\"");
    assert.ok(idVisible || draftedByName, `Zoe cannot be reached from the chat: her id is in no status list, and prepare_outreach said ${byName.content}`);
  });
});

describe("BUG: Gmail's wrapped 'On ... <address>' / 'wrote:' attribution is kept as the candidate's words", () => {
  test("B2 Gmail wraps a long attribution line before 'wrote:'; the founder's name, address and 'wrote:' end up in the reply text", async () => {
    const body = [
      "Yes please, Tuesday works.",
      "",
      "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee-Hartono <michael.leehartono@acme-robotics.com>",
      "wrote:",
      "",
      "> Hi Alice, saw you built the offline sync for the driver app.",
      "> Up for a 15 minute call?",
    ].join("\r\n");
    const gmail = await gmailOver("michael.leehartono@acme-robotics.com", [
      gmailMessage("Alice Tan <alice@corp.com>", REPLY_AT, plainPart(body)),
    ]);
    const replies = await gmail.repliesFrom("alice@corp.com", SINCE);
    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.includes("Tuesday works"));
    assert.ok(
      !replies[0]!.text.includes("acme-robotics.com") && !/wrote:/.test(replies[0]!.text),
      `the quote attribution is part of the candidate's reply: ${JSON.stringify(replies[0]!.text)}`,
    );
  });
});

describe("BUG: quote headers from Chinese-language mail clients are not cut", () => {
  test("B3a Chinese Outlook ('发件人:' / '发送时间:'): the founder's whole intro email is read as the candidate's words", async () => {
    const body = [
      "好的，周二下午三点可以。",
      "",
      "发件人: Michael Lee <michael@acme.com>",
      "发送时间: 2026年9月21日 10:00",
      "收件人: Alice Tan <alice@corp.com>",
      "主题: Backend role at Acme",
      "",
      "Hi Alice, saw you built the offline sync for the driver app. Up for a 15 minute call?",
      "",
      "Michael",
    ].join("\r\n");
    const gmail = await gmailOver("michael@acme.com", [gmailMessage("Alice Tan <alice@corp.com>", REPLY_AT, plainPart(body))]);
    const replies = await gmail.repliesFrom("alice@corp.com", SINCE);
    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.includes("周二"));
    assert.ok(!replies[0]!.text.includes("offline sync"), `the founder's own email is part of the reply: ${JSON.stringify(replies[0]!.text)}`);
  });

  test("B3b Chinese Gmail ('Michael <...> 于2026年9月21日周一 20:00写道：'): the attribution with the founder's address stays in the reply", async () => {
    const body = [
      "好的，周二可以。",
      "",
      "Michael Lee <michael@acme.com> 于2026年9月21日周一 20:00写道：",
      "",
      "> Hi Alice, saw you built the offline sync for the driver app.",
    ].join("\r\n");
    const gmail = await gmailOver("michael@acme.com", [gmailMessage("Alice Tan <alice@corp.com>", REPLY_AT, plainPart(body))]);
    const replies = await gmail.repliesFrom("alice@corp.com", SINCE);
    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.includes("周二"));
    assert.ok(!replies[0]!.text.includes("michael@acme.com"), `the quote attribution is part of the reply: ${JSON.stringify(replies[0]!.text)}`);
  });
});

describe("BUG: an email reply is taken for a pasted one when only a line near its top differs", () => {
  test("B4 the founder pasted a LinkedIn 'Sure!\\nTuesday\\nat 3pm works' after an email 'Sure!\\nWednesday\\nat 3pm works' arrived; syncing the email drops it as already on record", async () => {
    const emailAt = "2026-09-22T00:00:00.000Z";
    const store = await storeWith(seeded({
      candidates: {
        a: candidate(person("a", "typescript"), {
          stage: "replied", lastContactedAt: AT,
          messages: [
            outbound(),
            // Pasted by hand (from LinkedIn) an hour after the email below arrived.
            { direction: "inbound", channel: "pasted", at: "2026-09-22T01:00:00.000Z", realAt: "2026-09-22T01:00:00.000Z", text: "Sure!\nTuesday\nat 3pm works" },
          ],
        }),
      },
    }));
    const service = serviceOn(store);
    const outcome = await service.reply("Sure!\nWednesday\nat 3pm works", "a", "email", emailAt);
    const inbound = (await find(service, "a")).messages.filter((m) => m.direction === "inbound").map((m) => m.text);
    assert.equal(inbound.length, 2, `the email with a different day was dropped (${outcome.message}); inbound: ${JSON.stringify(inbound)}`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("a reply that mentions 'From:' without a Sent/Date header line is kept whole", async () => {
    const body = "Happy to chat.\nFrom: Singapore, open to hybrid\nStart date: 1 November\nNotice: one month";
    const gmail = await gmailOver("michael@acme.com", [gmailMessage("Alice <alice@corp.com>", REPLY_AT, plainPart(body))]);
    const replies = await gmail.repliesFrom("alice@corp.com", SINCE);
    assert.equal(replies[0]!.text, body);
  });

  test("an Outlook HTML-only reply is cut at its bold From/Sent header block", async () => {
    const html = [
      "<html><head><style>p{margin:0}</style></head><body>",
      "<div>Sounds good &amp; Tuesday works.</div>",
      "<hr><div id=\"divRplyFwdMsg\"><b>From:</b> Michael &lt;michael@acme.com&gt;<br>",
      "<b>Sent:</b> Monday, September 21, 2026 10:00 AM<br><b>To:</b> Alice<br></div>",
      "<div>Hi Alice, saw you built the offline sync.</div></body></html>",
    ].join("\n");
    const gmail = await gmailOver("michael@acme.com", [gmailMessage("Alice <alice@corp.com>", REPLY_AT, { mimeType: "text/html", body: { data: b64(html) } })]);
    const replies = await gmail.repliesFrom("alice@corp.com", SINCE);
    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.text.includes("Sounds good & Tuesday works."));
    assert.ok(!replies[0]!.text.includes("offline sync"));
  });

  test("a Gmail HTML-only reply drops its gmail_quote attribution and blockquote", async () => {
    const html = "<div dir=\"ltr\">Yes please</div><br><div class=\"gmail_quote\"><div dir=\"ltr\" class=\"gmail_attr\">On Mon, Sep 21, 2026 at 8:00 PM Michael &lt;<a href=\"mailto:michael@acme.com\">michael@acme.com</a>&gt; wrote:<br></div><blockquote>Hi Alice</blockquote></div>";
    const gmail = await gmailOver("michael@acme.com", [gmailMessage("Alice <alice@corp.com>", REPLY_AT, { mimeType: "text/html", body: { data: b64(html) } })]);
    assert.deepEqual((await gmail.repliesFrom("alice@corp.com", SINCE)).map((reply) => reply.text), ["Yes please"]);
  });

  test("the founder's own message is skipped whatever the case of the From header", async () => {
    const gmail = await gmailOver("michael@acme.com", [
      gmailMessage("\"Lee, Michael\" <Michael@Acme.COM>", REPLY_AT, plainPart("Following up")),
    ]);
    assert.deepEqual(await gmail.repliesFrom("alice@corp.com", SINCE), []);
  });

  test("with 20 people in view, the 16th onwards are listed in more_in_view with their ids", async () => {
    const repo = new MemoryRoleRepository();
    const candidates: Record<string, Candidate> = {};
    for (let index = 0; index < 20; index += 1) candidates[`in-${index}`] = candidate(person(`in-${index}`, "typescript"));
    await repo.store("role1").save(seeded({ candidates }));
    const chat = recruitingExtension(new RoleBoard(repo, (store) => serviceOn(store)));
    const status = JSON.parse((await chat.run("recruiting_status", { role_id: "role1" })).content);
    const listed = [...status.status.candidates, ...status.status.more_in_view].map((entry: { id: string }) => entry.id);
    assert.equal(new Set(listed).size, 20);
  });

  test("changing only the case of a draft criterion keeps the drafted queries", async () => {
    const service = serviceOn(await storeWith(seeded({
      role: { title: "Backend engineer", requirement: REQUIREMENT, confirmed: false, createdAt: AT },
      rounds: [{ round: 0, query: "typescript engineer singapore", queries: ["typescript engineer singapore"], at: AT, found: 0, added: 0 }],
    })));
    await service.reviseDraft([{ id: "c1", text: "TypeScript", kind: "must" }]);
    assert.deepEqual((await service.snapshot()).rounds[0]?.queries, ["typescript engineer singapore"]);
  });
});
