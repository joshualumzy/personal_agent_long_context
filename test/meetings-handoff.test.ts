import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { docClipboardText, githubIssueLink, gmailComposeLink, googleCalendarLink, outlookCalendarLink, outlookComposeLink, whatsappLink } from "../src/meetings/handoff.js";

describe("handoff links", () => {
  test("spaces are %20, never +, since Outlook shows + literally", () => {
    const link = outlookComposeLink({ to: "a@example.com", subject: "Hi there", body: "One two" });
    assert.ok(!link.includes("+"));
    assert.match(link, /subject=Hi%20there/);
  });

  test("Outlook calendar carries start, end and email attendees", () => {
    const url = new URL(
      outlookCalendarLink({
        title: "Sync",
        attendees: ["a@example.com", "Priya"],
        proposedStart: "2026-10-01T09:00:00Z",
        durationMinutes: 45,
      }),
    );
    assert.equal(url.pathname, "/calendar/deeplink/compose");
    assert.equal(url.searchParams.get("startdt"), "2026-10-01T09:00:00.000Z");
    assert.equal(url.searchParams.get("enddt"), "2026-10-01T09:45:00.000Z");
    assert.equal(url.searchParams.get("to"), "a@example.com");
    assert.equal(url.searchParams.get("body"), "Invite: Priya");
  });

  test("what leaves for another tool carries no [source:ID] markers: they are for the reviewer, not the recipient", () => {
    const body = "The root cause was a race [source:CONF-ENG-311]. Same service as before [source:ENG-148][source:ENG-210].\nBest, Jax";
    const clean = "The root cause was a race. Same service as before.\nBest, Jax";
    assert.equal(new URL(gmailComposeLink({ to: "owen@notc.example", subject: "ENG-210 [source:ENG-210]", body })).searchParams.get("body"), clean);
    assert.equal(new URL(gmailComposeLink({ to: "owen@notc.example", subject: "ENG-210 [source:ENG-210]", body })).searchParams.get("su"), "ENG-210");
    assert.equal(new URL(outlookComposeLink({ to: "owen@notc.example", subject: "Fix", body })).searchParams.get("body"), clean);
    assert.equal(new URL(githubIssueLink("acme/app", { title: "Alerting [source:ENG-210]", description: body, assignee: "", due: "" })).searchParams.get("body"), clean);
    assert.doesNotMatch(new URL(googleCalendarLink({ title: "Checkpoint", attendees: [], durationMinutes: 30, notes: body })).searchParams.get("details")!, /\[source:/);
    assert.doesNotMatch(decodeURIComponent(whatsappLink({ address: "", text: body } as never)), /\[source:/);
    assert.doesNotMatch(docClipboardText({ title: "Notes", body } as never), /\[source:/);
  });
});
