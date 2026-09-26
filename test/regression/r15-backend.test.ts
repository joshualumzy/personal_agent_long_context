// Round 15 backend hunt. Tests under "BUG:" fail on the current code and pass once
// fixed; tests under "NOT A BUG:" pass (suspicions that were checked and are fine).
// Run: node --import tsx --test test/hunt/r15-backend.test.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { GmailClient } from "../../src/recruiting/gmail.js";

/** A Gmail client over a fake Google: the founder is `own`, the thread holds `messages`. */
async function gmailOver(own: string, messages: unknown[]): Promise<GmailClient> {
  const dir = await mkdtemp(join(tmpdir(), "r15-gmail-"));
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
const REPLY_AT = Date.parse("2026-09-22T00:00:00Z");
const SINCE = "2026-09-21T00:00:00Z";
const OUTREACH = "Hi Alice, would you be up for a 15 minute call about our founding engineer role?";
const OUTREACH_ZH = "您好 Alice，想约您 15 分钟聊聊我们的创始工程师职位，方便吗？";

async function texts(part: unknown): Promise<string[]> {
  const gmail = await gmailOver("michael@acme.com", [
    { internalDate: String(REPLY_AT), payload: { headers: [{ name: "From", value: "Alice Tan <alice@corp.com>" }], ...(part as object) } },
  ]);
  return (await gmail.repliesIn("t1", SINCE)).map((reply) => reply.text);
}
const plain = (body: string) => texts({ mimeType: "text/plain", body: { data: b64(body) } });
const html = (body: string) => texts({ mimeType: "text/html", body: { data: b64(body) } });

// ======================================================================= bugs

describe("BUG: a reply with nothing of its own (e.g. only a CV attached) is recorded as the founder's quoted words", () => {
  // gmail.ts:107-115. The round 14 fallback: when nothing is above the quote cut, it keeps every
  // line except ">" lines and one-line "On … wrote:" / "…写道：" attributions. Outlook and QQ/Foxmail
  // quote without ">" (a "____" rule or "原始邮件" line, a From/Sent header block, then the original),
  // so an empty reply from them (say a CV sent as an attachment, no text) now returns the header
  // block and the founder's whole outreach as the candidate's reply. Before round 14 it was dropped.
  // The service then records and interprets the founder's own question as the candidate's answer.
  test("B1a an Outlook reply with only the quoted original returns the founder's outreach as the reply", async () => {
    const body = [
      "",
      "________________________________",
      "From: Michael Lee <michael@acme.com>",
      "Sent: Monday, September 21, 2026 8:00 PM",
      "To: Alice Tan <alice@corp.com>",
      "Subject: Founding engineer at Acme",
      "",
      OUTREACH,
      "",
      "Michael",
    ].join("\r\n");
    const got = await plain(body);
    assert.ok(
      got.every((text) => !text.includes("15 minute call") && !/^From:/m.test(text)),
      `the founder's quoted email was returned as Alice's reply: ${JSON.stringify(got)}`,
    );
  });

  test("B1b a QQ/Foxmail reply with only the 原始邮件 block returns the founder's outreach as the reply", async () => {
    const body = [
      "",
      "------------------ 原始邮件 ------------------",
      "发件人: \"Michael Lee\" <michael@acme.com>;",
      "发送时间: 2026年9月21日(星期一) 晚上8:00",
      "收件人: \"Alice\" <alice@corp.com>;",
      "主题: 创始工程师",
      "",
      OUTREACH_ZH,
    ].join("\r\n");
    const got = await plain(body);
    assert.ok(
      got.every((text) => !text.includes("15 分钟") && !/发件人/.test(text)),
      `the founder's quoted email was returned as Alice's reply: ${JSON.stringify(got)}`,
    );
  });
});

describe("BUG: a Gmail attribution wrapped over two lines survives the below-the-quote fallback", () => {
  // gmail.ts:112. The fallback drops only one-line attributions (/^On .+wrote:$/). Gmail wraps a
  // long one ("On Mon, … Michael Lee-Hartono <" / "michael@acme.com> wrote:"), which the cut at
  // line 92-94 recognises but the fallback filter does not. A reply that is only the quote (a CV
  // attachment) becomes a phantom reply made of the attribution; a bottom-posted answer carries it.
  test("B2a a quote-only Gmail reply under a wrapped attribution is recorded as a reply", async () => {
    const body = [
      "",
      "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee-Hartono <",
      "michael@acme.com> wrote:",
      "",
      `> ${OUTREACH}`,
    ].join("\r\n");
    const got = await plain(body);
    assert.ok(
      got.every((text) => !/wrote:|Michael Lee-Hartono/.test(text)),
      `the attribution was returned as Alice's reply: ${JSON.stringify(got)}`,
    );
  });

  test("B2b a bottom-posted answer under a wrapped attribution keeps the attribution in the reply", async () => {
    const body = [
      "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee-Hartono <",
      "michael@acme.com> wrote:",
      `> ${OUTREACH}`,
      "",
      "Sure, Thursday 3pm works.",
    ].join("\r\n");
    const got = await plain(body);
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.ok(got[0]!.includes("Thursday 3pm works"), JSON.stringify(got));
    assert.ok(!/wrote:|Michael Lee-Hartono/.test(got[0]!), `attribution kept in the reply: ${JSON.stringify(got[0])}`);
  });
});

describe("BUG: in an HTML-only reply, nested blockquotes leak quoted history", () => {
  // gmail.ts:65. The round 14 change removes "<blockquote … </blockquote>" lazily, so with nested
  // quotes it stops at the INNER closing tag. Anything the outer quote holds after the inner one
  // (an earlier bottom-posted message in the chain) is kept as if the candidate had written it now.
  test("B3 an answer below a nested quote comes back with the founder's quoted follow-up in it", async () => {
    // Bottom-posted HTML: attribution, the quote (which itself quotes Alice's earlier answer), then the new answer.
    const body =
      '<div class="gmail_attr">On Tue, Sep 22, 2026 Michael Lee &lt;michael@acme.com&gt; wrote:<br></div>' +
      '<blockquote class="gmail_quote"><div class="gmail_attr">On Mon, Sep 21, 2026 Alice Tan wrote:<br></div>' +
      "<blockquote>Not interested right now, sorry.</blockquote>" +
      "<div>Understood. If anything changes, would a short call later this year work?</div>" +
      "</blockquote>" +
      "<div>Actually yes, Thursday works.</div>";
    const got = await html(body);
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.ok(got[0]!.includes("Thursday works"), JSON.stringify(got));
    assert.ok(!got[0]!.includes("If anything changes"), `the founder's quoted words leaked into the reply: ${JSON.stringify(got[0])}`);
  });
});

// ================================================================== not bugs

describe("NOT A BUG: checked and fine", () => {
  test("a Gmail quote-only reply with a one-line attribution is dropped, not recorded", async () => {
    const got = await plain(["", "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee <michael@acme.com> wrote:", `> ${OUTREACH}`].join("\n"));
    assert.deepEqual(got, []);
  });

  test("an Outlook top-posted reply keeps only the answer", async () => {
    const body = ["Happy to chat, Thursday works.", "", "________________________________", "From: Michael Lee <michael@acme.com>", "Sent: Monday", "", OUTREACH].join("\r\n");
    assert.deepEqual(await plain(body), ["Happy to chat, Thursday works."]);
  });

  test("an HTML-only Gmail reply (single-level quote) keeps the answer and drops the quote", async () => {
    const body =
      '<div dir="ltr">Sure &amp; thanks!</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Sep 21, 2026 at 8:00 PM Michael Lee &lt;<a href="mailto:michael@acme.com">michael@acme.com</a>&gt; wrote:<br></div>' +
      `<blockquote class="gmail_quote">${OUTREACH}</blockquote></div>`;
    assert.deepEqual(await html(body), ["Sure & thanks!"]);
  });

  test("an HTML-only reply written below a single blockquote is kept without the quote", async () => {
    const body = `<div>On Mon, Sep 21, 2026 Michael Lee wrote:</div><blockquote>${OUTREACH}</blockquote><div>Yes, Thursday.</div>`;
    assert.deepEqual(await html(body), ["Yes, Thursday."]);
  });

  test("a top-posted reply starting 'On 2026-09-24 I'm free' followed by a blank line is kept", async () => {
    const got = await plain(["On 2026-09-24 I'm free all day.", "", "On Mon, Sep 21, 2026 at 8:00 PM Michael Lee <michael@acme.com> wrote:", `> ${OUTREACH}`].join("\n"));
    assert.deepEqual(got, ["On 2026-09-24 I'm free all day."]);
  });
});
