import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { outlookCalendarLink, outlookComposeLink } from "../src/meetings/handoff.js";

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
});
