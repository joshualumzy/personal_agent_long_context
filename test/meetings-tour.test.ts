import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hashPayload, type EmailPayload } from "../src/meetings/domain.js";
import { InMemoryMeetingStore } from "../src/meetings/store.js";
import { PRODUCT_TOUR_ID, productTour, seedProductTour } from "../src/meetings/tour.js";

// The tour is a finished sample meeting that doubles as the page's manual: a
// new user opens it and meets every part of the page with something in it.

describe("Product tour meeting", () => {
  test("shows every kind of card the page can show", () => {
    const tour = productTour(new Date("2026-10-01T02:00:00.000Z"));
    const kinds = new Set(tour.actions.map((action) => action.kind));
    for (const kind of ["answer_question", "flag_conflict", "email_draft", "ticket_draft", "escalation", "calendar_draft", "hiring_request", "blocked"]) {
      assert.ok(kinds.has(kind as never), `the tour has no ${kind} card`);
    }
    assert.ok(tour.decisions.length > 0, "the notes list a decision");
    assert.ok((tour.assignments ?? []).length > 0, "the notes list who took what on");
    assert.equal(tour.minutes?.status, "ready");
    assert.match(tour.minutes?.markdown ?? "", /tray/i, "the manual explains the tray");
    for (const decision of tour.minutes?.decisions ?? []) {
      assert.ok(tour.segments.some((segment) => segment.index === decision.segmentIndex), "each decision leads to a real line");
    }
    assert.ok((tour.minutes?.decisions ?? []).length > 0);
  });

  test("quotes each card's line exactly as it appears in the transcript", () => {
    const tour = productTour(new Date("2026-10-01T02:00:00.000Z"));
    for (const action of tour.actions) {
      const segment = tour.segments.find((candidate) => candidate.index === action.trigger.segmentIndex);
      assert.ok(segment, `${action.id} points at a line that does not exist`);
      assert.ok(segment.text.includes(action.trigger.quote), `${action.id} quotes words its line does not say`);
      assert.equal(segment.speaker, action.trigger.speaker);
    }
  });

  test("offers drafts that can really be approved, and emails no one by default", () => {
    const tour = productTour(new Date("2026-10-01T02:00:00.000Z"));
    const waiting = tour.actions.filter((action) => action.tier === "approval" && action.status === "proposed");
    assert.ok(waiting.length >= 2);
    for (const action of waiting) assert.equal(action.payloadHash, hashPayload(action.payload), `${action.id} would be refused`);
    const email = tour.actions.find((action) => action.kind === "email_draft")!;
    assert.equal((email.payload as EmailPayload).to, "");
  });

  test("seeding again leaves one tour, back at its start", async () => {
    const store = new InMemoryMeetingStore();
    await seedProductTour(store, new Date("2026-10-01T02:00:00.000Z"));
    const tried = (await store.load(PRODUCT_TOUR_ID))!;
    tried.actions.find((action) => action.kind === "email_draft")!.status = "executed";
    await store.save(tried);

    await seedProductTour(store, new Date("2026-10-02T02:00:00.000Z"));

    const tours = (await store.list()).filter((meeting) => meeting.meetingId === PRODUCT_TOUR_ID);
    assert.equal(tours.length, 1);
    const reset = (await store.load(PRODUCT_TOUR_ID))!;
    assert.equal(reset.actions.find((action) => action.kind === "email_draft")!.status, "proposed");
  });
});
