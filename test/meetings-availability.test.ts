import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CompanyKnowledge } from "../src/company-domain.js";
import { checkAvailability, googleAvailability, sgtLabel } from "../src/meetings/availability.js";
import type { AvailabilityChecker, BusySlot, CandidateAction, MeetingState } from "../src/meetings/domain.js";
import { ActionDrafter } from "../src/meetings/drafter.js";
import type { JsonModel } from "../src/recruiting/llm.js";

/** Friday 2026-09-25, 10:00 in Singapore. */
const NOW = new Date("2026-09-25T02:00:00Z");

function checker(calendars: Record<string, Array<[string, string]> | null>, connected = true) {
  const asked: string[][] = [];
  const fake: AvailabilityChecker & { asked: string[][] } = {
    asked,
    connected: async () => connected,
    async busy(people) {
      asked.push(people);
      const result = new Map<string, BusySlot[] | null>();
      for (const person of people) {
        const slots = calendars[person];
        result.set(person, slots === null || slots === undefined ? null : slots.map(([start, end]) => ({ start: new Date(start), end: new Date(end) })));
      }
      return result;
    },
  };
  return fake;
}

describe("calendar availability", () => {
  test("a proposed time is checked for each visible calendar, unknown ones are said to be unknown", async () => {
    const lines = await checkAvailability(
      checker({
        me: [["2026-09-30T02:00:00Z", "2026-09-30T03:00:00Z"]],
        "priya@acme.test": [],
        "lena@datadog.test": null,
      }),
      { title: "Review", attendees: ["priya@acme.test", "lena@datadog.test", "Wei"], proposedStart: "2026-09-30T10:00:00+08:00", durationMinutes: 30 },
      NOW,
    );
    assert.deepEqual(lines, [
      "You: busy at Wed 30 Sept, 10:00.",
      "priya@acme.test: free at Wed 30 Sept, 10:00.",
      "lena@datadog.test: calendar not visible, so not checked.",
    ]);
  });

  test("with no time set, free working-hour weekday slots are suggested around existing events", async () => {
    const lines = await checkAvailability(
      checker({
        // Busy the rest of Friday and all of Monday morning.
        me: [["2026-09-25T02:00:00Z", "2026-09-25T10:00:00Z"], ["2026-09-28T01:00:00Z", "2026-09-28T05:00:00Z"]],
      }),
      { title: "Sync", attendees: [], durationMinutes: 30 },
      NOW,
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^No time was set\. Free for You: Mon 28 Sept, 13:00; /);
    assert.doesNotMatch(lines[0]!, /Sat|Sun|Fri/);
  });

  test("Singapore time labels", () => {
    assert.equal(sgtLabel(new Date("2026-10-01T07:00:00Z")), "Thu 1 Oct, 15:00");
  });

  test("the Google adapter asks for the primary calendar for the employee", async () => {
    let ids: string[] = [];
    const adapter = googleAvailability({
      canReadCalendar: async () => true,
      busy: async (calendars) => {
        ids = calendars;
        return new Map([["primary", [{ start: "2026-09-30T02:00:00Z", end: "2026-09-30T03:00:00Z" }]], ["x@y.test", null]]);
      },
    });
    const result = await adapter.busy(["me", "x@y.test"], NOW, NOW);
    assert.deepEqual(ids, ["primary", "x@y.test"]);
    assert.equal(result.get("me")!.length, 1);
    assert.equal(result.get("x@y.test"), null);
  });

  const knowledge: CompanyKnowledge = {
    employee: async (employeeId) => ({ employeeId, displayName: "E", currentAssignments: [] }),
    search: async () => [],
    related: async () => [],
    sources: async () => [],
  };
  const model: JsonModel = {
    json: async <T>() => ({ title: "Review", attendees: [], proposedStart: "2026-09-30T10:00:00+08:00", durationMinutes: 30, notes: "", missing: [] }) as T,
  };
  const meeting = { meetingId: "m1", title: "t", employeeId: "jax", status: "live", startedAt: NOW.toISOString(), segments: [{ index: 0, speaker: "Jax", text: "Let's review Wednesday at 10am." }], decisions: [], actions: [], trace: [] } as unknown as MeetingState;
  const candidate: CandidateAction = { kind: "calendar_draft", trigger: { segmentIndex: 0, speaker: "Jax", quote: "Let's review Wednesday at 10am." }, summary: "Review Wednesday 10am", dedupeKey: "calendar_draft:review", details: {} };

  test("an invite carries the availability check as notes when the calendar is connected", async () => {
    const drafter = new ActionDrafter({ model, knowledge, availability: checker({ me: [] }), now: () => NOW });
    const result = await drafter.draft(candidate, meeting);
    assert.deepEqual(result.notes, ["You: free at Wed 30 Sept, 10:00."]);
    assert.ok(result.lookups?.some((line) => line.startsWith("Checked calendar free/busy")));
  });

  test("a calendar that is not connected is never read", async () => {
    const fake = checker({ me: [] }, false);
    const result = await new ActionDrafter({ model, knowledge, availability: fake, now: () => NOW }).draft(candidate, meeting);
    assert.equal(result.notes, undefined);
    assert.equal(fake.asked.length, 0);
  });
});
