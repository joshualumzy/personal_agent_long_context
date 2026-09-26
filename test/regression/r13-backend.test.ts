// Round 13 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r13-backend.test.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { interpret } from "../../src/recruiting/agent.js";
import { GmailClient } from "../../src/recruiting/gmail.js";
import type { JsonModel, JsonRequest } from "../../src/recruiting/llm.js";

/** A Gmail client over a fake Google: the founder is `own`, the thread holds `messages`. */
async function gmailOver(own: string, messages: unknown[]): Promise<GmailClient> {
  const dir = await mkdtemp(join(tmpdir(), "r13-gmail-"));
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
const gmailMessage = (from: string, atMs: number, part: unknown) => ({
  internalDate: String(atMs),
  payload: { headers: [{ name: "From", value: from }], ...(part as object) },
});
const plainPart = (text: string) => ({ mimeType: "text/plain", body: { data: b64(text) } });
const REPLY_AT = Date.parse("2026-09-22T00:00:00Z");
const SINCE = "2026-09-21T00:00:00Z";
const ATTRIBUTION = "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee <michael@acme.com> wrote:";

async function replyTexts(body: string): Promise<string[]> {
  const gmail = await gmailOver("michael@acme.com", [gmailMessage("Alice Tan <alice@corp.com>", REPLY_AT, plainPart(body))]);
  return (await gmail.repliesIn("t1", SINCE)).map((reply) => reply.text);
}

// ======================================================================= bugs

describe("BUG: a reply line starting with 'On' just above Gmail's attribution is taken for a wrapped attribution and cut", () => {
  test("B1a a one-line email reply 'On Thursday 3pm works for me.' (Gmail's usual blank line, then the one-line attribution) is dropped entirely", async () => {
    const body = [
      "On Thursday 3pm works for me.",
      "",
      ATTRIBUTION,
      "",
      "> Hi Alice, saw you built the offline sync for the driver app.",
      "> Up for a 15 minute call?",
    ].join("\r\n");
    const texts = await replyTexts(body);
    assert.equal(texts.length, 1, `the candidate's reply was lost; repliesIn returned ${JSON.stringify(texts)}`);
    assert.ok(texts[0]!.includes("Thursday 3pm works"), `reply text lost: ${JSON.stringify(texts[0])}`);
  });

  test("B1b a longer reply loses its last paragraph when that paragraph starts with 'On' ('On another note, ...')", async () => {
    const body = [
      "Hi Michael,",
      "",
      "Thanks, happy to chat.",
      "",
      "On another note, I can only do Wednesdays after 4pm.",
      "",
      ATTRIBUTION,
      "",
      "> Hi Alice, up for a 15 minute call?",
    ].join("\r\n");
    const texts = await replyTexts(body);
    assert.equal(texts.length, 1);
    assert.ok(texts[0]!.includes("Wednesdays after 4pm"), `the last paragraph was cut: ${JSON.stringify(texts[0])}`);
  });
});

describe("BUG: Chinese Gmail's wrapped '… 于<date>' / '<time>写道：' attribution keeps the founder's address in the reply", () => {
  test("B2 a long Chinese attribution wrapped before '写道：' leaves 'Michael Lee-Hartono <address> 于…' in the candidate's words", async () => {
    const body = [
      "好的，周二下午可以。",
      "",
      "Michael Lee-Hartono <michael.leehartono@acme-robotics.com> 于2026年9月21日周一",
      "20:00写道：",
      "",
      "> Hi Alice, saw you built the offline sync for the driver app.",
    ].join("\r\n");
    const gmail = await gmailOver("michael.leehartono@acme-robotics.com", [gmailMessage("Alice Tan <alice@corp.com>", REPLY_AT, plainPart(body))]);
    const texts = (await gmail.repliesIn("t1", SINCE)).map((reply) => reply.text);
    assert.equal(texts.length, 1);
    assert.ok(texts[0]!.includes("周二"));
    assert.ok(!texts[0]!.includes("acme-robotics.com"), `the quote attribution is part of the reply: ${JSON.stringify(texts[0])}`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("a wrapped attribution is still cut when the reply above it does not start with 'On'", async () => {
    const body = [
      "Yes please, Tuesday works.",
      "",
      "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee-Hartono <michael@acme.com>",
      "wrote:",
      "",
      "> Hi Alice",
    ].join("\r\n");
    assert.deepEqual(await replyTexts(body), ["Yes please, Tuesday works."]);
  });

  test("a reply starting with 'On' with no quote below is kept whole", async () => {
    const body = "On it. Tuesday 3pm works.\n\nAlice";
    assert.deepEqual(await replyTexts(body), [body]);
  });

  test("a Chinese reply that uses 写道 mid-line, or 发件人 without a time line, is kept whole", async () => {
    const body = "我在简历里写道：五年后端经验。\n发件人：Alice\n周二可以。";
    assert.deepEqual(await replyTexts(body), [body]);
  });

  test("interpret passes the focused id only when it names a known candidate, and 'this one' resolves to it", async () => {
    const seen: unknown[] = [];
    const model: JsonModel = {
      async json<T>(request: JsonRequest): Promise<T> {
        const input = request.input as { focusedCandidateId: string | null };
        seen.push(input.focusedCandidateId);
        return { intent: "feedback", candidateId: input.focusedCandidateId, decision: "pass", reason: "" } as T;
      },
    };
    const candidates = [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }];
    const known = await interpret(model, "Pass on this one", [], candidates, "b");
    const unknown = await interpret(model, "Pass on this one", [], candidates, "ghost");
    assert.deepEqual(seen, ["b", null]);
    assert.equal(known.intent, "feedback");
    assert.equal(unknown.intent, "unknown");
  });
});
