// Round 14 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r14-backend.test.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recruitingExtension } from "../../src/recruiting/chat-tools.js";
import type { CandidateProfile } from "../../src/recruiting/domain.js";
import { GmailClient } from "../../src/recruiting/gmail.js";
import { LocalIntentMemory } from "../../src/recruiting/intent-memory.js";
import type { JsonModel } from "../../src/recruiting/llm.js";
import { MemoryRoleRepository, RoleBoard } from "../../src/recruiting/roles.js";
import { RecruitingService } from "../../src/recruiting/service.js";
import type { CandidateSource } from "../../src/recruiting/sources.js";

/** A Gmail client over a fake Google: the founder is `own`, the thread holds `messages`. */
async function gmailOver(own: string, messages: unknown[]): Promise<GmailClient> {
  const dir = await mkdtemp(join(tmpdir(), "r14-gmail-"));
  const tokenPath = join(dir, "token.json");
  await writeFile(tokenPath, JSON.stringify({ refresh_token: "r" }));
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "a", expires_in: 3600 });
    if (url.endsWith("users/me/profile")) return json({ emailAddress: own });
    if (url.includes("users/me/threads/")) return json({ messages });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return new GmailClient({ clientId: "c", clientSecret: "s", redirectUri: "http://x/cb", tokenPath, fetch: fakeFetch });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const plainPart = (text: string) => ({ mimeType: "text/plain", body: { data: b64(text) } });
const REPLY_AT = Date.parse("2026-09-22T00:00:00Z");
const SINCE = "2026-09-21T00:00:00Z";
const ATTRIBUTION = "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee <michael@acme.com> wrote:";

async function replyTexts(body: string): Promise<string[]> {
  const gmail = await gmailOver("michael@acme.com", [
    { internalDate: String(REPLY_AT), payload: { headers: [{ name: "From", value: "Alice Tan <alice@corp.com>" }], ...plainPart(body) } },
  ]);
  return (await gmail.repliesIn("t1", SINCE)).map((reply) => reply.text);
}

// A chat-tool harness over a real service with a fake model and source (same shape as r13-agent).
const profile = (id: string): CandidateProfile => ({
  id,
  name: `Person ${id}`,
  headline: "Engineer",
  location: "Singapore",
  profileUrl: `https://www.linkedin.com/in/${id}`,
  workHistory: [{ title: "Engineer", company: `Company ${id}` }],
  educationHistory: [],
  summary: "typescript engineer",
});

function fakeModel(): JsonModel {
  return {
    async json<T>({ task, input }: { task: string; input: unknown }): Promise<T> {
      const data = input as Record<string, any>;
      switch (task) {
        case "criteria extraction":
          return { title: "Founding backend engineer", criteria: [{ text: "typescript", kind: "must" }], query: "typescript engineer" } as T;
        case "criterion judgement":
          return {
            verdicts: data.criteria.map((criterion: { id: string }) => ({ criterionId: criterion.id, satisfied: "yes", reasoning: "k" })),
          } as T;
        case "search query":
          return { queries: ["typescript engineer"] } as T;
        default:
          throw new Error(`Unscripted task ${task}`);
      }
    },
  };
}

async function confirmedRole() {
  const fetched: string[][] = [];
  const source: CandidateSource = {
    name: "fake",
    async search() {
      return [profile("a")];
    },
    async fetchProfiles(urls: string[]) {
      fetched.push(urls);
      return urls.map((url) => profile(url.replace(/.*\/in\//, "").replace(/\/$/, "")));
    },
  };
  const board = new RoleBoard(
    new MemoryRoleRepository(),
    (store) =>
      new RecruitingService({
        model: fakeModel(),
        source,
        store,
        memory: new LocalIntentMemory(),
        contactFinders: [],
        gmail: null,
        clock: () => new Date("2026-09-23T02:00:00.000Z"),
        settings: { resultsPerQuery: 6 },
      }),
  );
  const { id, service } = board.create();
  await service.start("We need a backend engineer who knows TypeScript.");
  await service.confirm();
  return { tools: recruitingExtension(board), roleId: id, fetched };
}

// ======================================================================= bugs

describe("BUG: a top-posted reply opening with 'On …' and any four-digit number is still taken for a wrapped attribution", () => {
  // gmail.ts:90-92. The round 13 guard lets an "On" line count as a wrapped attribution when it
  // holds a year, tested as any standalone 4-digit number (\b\d{4}\b), and "wrote:" appears within
  // the next two lines. Gmail puts a blank line and then the one-line attribution right under the
  // reply, so a reply like "On Thursday, 1400 works" (24-hour time) or one with a Singapore phone
  // number ("9123 4567") is cut at its first line: the text is empty and the reply is dropped.
  test("B1a 'On Thursday, 1400 works for me.' above Gmail's attribution is dropped entirely", async () => {
    const body = ["On Thursday, 1400 works for me.", "", ATTRIBUTION, "", "> Hi Alice, up for a 15 minute call?"].join("\r\n");
    const texts = await replyTexts(body);
    assert.equal(texts.length, 1, `the candidate's reply was lost; repliesIn returned ${JSON.stringify(texts)}`);
    assert.ok(texts[0]!.includes("1400 works"), `reply text lost: ${JSON.stringify(texts[0])}`);
  });

  test("B1b a last paragraph 'On Friday I'm out, call me on 9123 4567.' is cut from the reply", async () => {
    const body = [
      "Hi Michael, keen to chat.",
      "",
      "On Friday I'm out, call me on 9123 4567 instead.",
      "",
      ATTRIBUTION,
      "",
      "> Hi Alice, up for a 15 minute call?",
    ].join("\r\n");
    const texts = await replyTexts(body);
    assert.equal(texts.length, 1);
    assert.ok(texts[0]!.includes("9123 4567"), `the last paragraph was cut: ${JSON.stringify(texts[0])}`);
  });
});

describe("BUG: a reply written below or between the quoted lines (bottom-posting, inline answers) is dropped", () => {
  // gmail.ts:84-103. withoutQuote cuts at the FIRST quote marker and keeps only what is above it.
  // When the candidate answers under the quote (common among engineers, and Gmail's own
  // "reply inline"), everything above the first marker is empty, the text is "", and repliesIn
  // filters the message out (gmail.ts:200). The reply is never recorded: no "replied" stage, and
  // the tick later drafts a "just checking in" follow-up and then closes them as cold.
  test("B2a a bottom-posted 'Sure, Thursday 3pm works.' under the attribution and quote is lost", async () => {
    const body = [ATTRIBUTION, "> Hi Alice, up for a 15 minute call?", "", "Sure, Thursday 3pm works."].join("\r\n");
    const texts = await replyTexts(body);
    assert.equal(texts.length, 1, `the candidate's reply was lost; repliesIn returned ${JSON.stringify(texts)}`);
    assert.ok(texts[0]!.includes("Thursday 3pm works"), JSON.stringify(texts[0]));
  });

  test("B2b answers interleaved with the founder's quoted questions are lost", async () => {
    const body = [
      ATTRIBUTION,
      "> Up for a 15 minute call?",
      "Yes, happy to.",
      "",
      "> Thursday or Friday?",
      "Thursday 3pm.",
    ].join("\r\n");
    const texts = await replyTexts(body);
    assert.equal(texts.length, 1, `the candidate's reply was lost; repliesIn returned ${JSON.stringify(texts)}`);
    assert.ok(texts[0]!.includes("happy to") && texts[0]!.includes("Thursday 3pm"), JSON.stringify(texts[0]));
    assert.ok(!texts[0]!.includes("Up for a 15 minute call"), "the founder's quoted words were kept as the reply");
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("a top-posted 'On Thursday 3pm works' (no address, no 4-digit number) survives", async () => {
    const texts = await replyTexts(["On Thursday 3pm works for me.", "", ATTRIBUTION, "", "> Hi Alice"].join("\r\n"));
    assert.deepEqual(texts, ["On Thursday 3pm works for me."]);
  });

  test("Gmail's attribution wrapped inside the address is still cut whole", async () => {
    const body = ["Yes please", "", "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee-Hartono <", "michael@acme.com> wrote:", "", "> Hi Alice"].join("\r\n");
    assert.deepEqual(await replyTexts(body), ["Yes please"]);
  });

  test("a reply line 'From: my side, Thursday works.' is not taken for an Outlook header", async () => {
    const texts = await replyTexts(["From: my side, Thursday works.", "Any time after 3pm is fine."].join("\n"));
    assert.equal(texts.length, 1);
    assert.ok(texts[0]!.includes("Thursday works"));
  });

  test("the chat tool takes one string holding two links split by a full-width comma, without https", async () => {
    const { tools, roleId, fetched } = await confirmedRole();
    const out = await tools.run("recruiting_import_profiles", { role_id: roleId, urls: "linkedin.com/in/alice-tan，www.linkedin.com/in/bob-lim" });
    assert.doesNotMatch(out.content, /Not a LinkedIn profile link/, out.content);
    assert.deepEqual(fetched, [["https://linkedin.com/in/alice-tan", "https://www.linkedin.com/in/bob-lim"]]);
  });

  test("the chat tool turns an http country-subdomain share link with tracking into a clean https link", async () => {
    const { tools, roleId, fetched } = await confirmedRole();
    await tools.run("recruiting_import_profiles", { role_id: roleId, urls: ["  http://sg.linkedin.com/in/alice-tan/?utm_source=share  "] });
    assert.deepEqual(fetched, [["https://sg.linkedin.com/in/alice-tan/"]]);
  });

  test("the chat tool still refuses a company page instead of importing it", async () => {
    const { tools, roleId, fetched } = await confirmedRole();
    const out = await tools.run("recruiting_import_profiles", { role_id: roleId, urls: ["linkedin.com/company/acme"] });
    assert.match(out.content, /Not a LinkedIn profile link/);
    assert.equal(fetched.length, 0);
  });
});
