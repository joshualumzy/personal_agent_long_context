import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  hashPayload,
  MeetingError,
  type ActionPayload,
  type EmailPayload,
  type HiringHandoff,
  type MeetingState,
  type ProposedAction,
} from "../src/meetings/domain.js";
import { DispatchingExecutor } from "../src/meetings/executor.js";
import { auditLog, InMemoryMeetingStore, PostgresMeetingStore } from "../src/meetings/store.js";

// --------------------------------------------------------------- fixtures

function meeting(id: string, overrides: Partial<MeetingState> = {}): MeetingState {
  return {
    meetingId: id,
    title: `Meeting ${id}`,
    employeeId: "emp-1",
    status: "live",
    startedAt: "2026-09-01T00:00:00.000Z",
    segments: [],
    decisions: [],
    actions: [],
    trace: [],
    ...overrides,
  };
}

function action(id: string, overrides: Partial<ProposedAction> = {}): ProposedAction {
  const payload: ActionPayload =
    overrides.payload ?? { question: "When does this ship?", answer: "Tuesday", citedSourceIds: [] };
  return {
    id,
    meetingId: "m1",
    kind: "answer_question",
    tier: "auto",
    status: "proposed",
    title: "Action",
    trigger: { segmentIndex: 0, speaker: "Alice", quote: "when does this ship?" },
    evidence: [],
    dedupeKey: id,
    createdAt: "2026-09-01T00:00:00.000Z",
    version: 1,
    ...overrides,
    payload,
    payloadHash: overrides.payloadHash ?? hashPayload(payload),
  };
}

class FakeHiring implements HiringHandoff {
  requirements: string[] = [];
  async start(requirement: string): Promise<{ message: string }> {
    this.requirements.push(requirement);
    return { message: `Started hiring for: ${requirement}` };
  }
}

// ------------------------------------------------------------ InMemory store

describe("InMemoryMeetingStore", () => {
  test("round trips and isolates callers from stored state", async () => {
    const store = new InMemoryMeetingStore();
    const state = meeting("m1", { actions: [action("a1")] });

    await store.save(state);
    // Mutating the object we handed to save() must not affect what is stored.
    state.title = "Mutated after save";
    state.actions.push(action("a2"));

    const loaded = await store.load("m1");
    assert.ok(loaded);
    assert.equal(loaded.title, "Meeting m1");
    assert.equal(loaded.actions.length, 1);

    // Mutating what load() handed back must not affect the store.
    loaded.title = "Mutated after load";
    loaded.actions.push(action("a3"));
    const loadedAgain = await store.load("m1");
    assert.equal(loadedAgain?.title, "Meeting m1");
    assert.equal(loadedAgain?.actions.length, 1);

    assert.equal(await store.load("missing"), null);
  });

  test("list() returns summaries newest saved first", async () => {
    const store = new InMemoryMeetingStore();
    await store.save(meeting("m1", { title: "First", actions: [action("a1")] }));
    await store.save(meeting("m2", { title: "Second" }));
    // Re-saving m1 should move it back to the front.
    await store.save(meeting("m1", { title: "First (updated)", actions: [action("a1"), action("a2")] }));

    const list = await store.list();
    assert.deepEqual(
      list.map((entry) => entry.meetingId),
      ["m1", "m2"],
    );
    assert.equal(list[0]!.title, "First (updated)");
    assert.equal(list[0]!.actionCount, 2);
  });

  test("priorDecisions() excludes the given meeting and orders newest first", async () => {
    const store = new InMemoryMeetingStore();
    await store.save(
      meeting("m1", {
        decisions: [{ text: "Ship on Tuesday", segmentIndex: 0, speaker: "Alice", at: "2026-09-01T00:00:00.000Z" }],
      }),
    );
    await store.save(
      meeting("m2", {
        title: "Standup",
        decisions: [
          { text: "Ship on Friday instead", segmentIndex: 0, speaker: "Bob", at: "2026-09-03T00:00:00.000Z" },
          { text: "Use the new logo", segmentIndex: 1, speaker: "Bob", at: "2026-09-02T00:00:00.000Z" },
        ],
      }),
    );

    const decisions = await store.priorDecisions("m1", 10);
    assert.deepEqual(
      decisions.map((entry) => entry.text),
      ["Ship on Friday instead", "Use the new logo"],
    );
    assert.ok(decisions.every((entry) => entry.meetingId === "m2" && entry.title === "Standup"));

    const limited = await store.priorDecisions("m2", 1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]!.text, "Ship on Tuesday");
  });
});

// ------------------------------------------------------------- executor

describe("DispatchingExecutor", () => {
  test("email_draft refuses an implausible address", async () => {
    const executor = new DispatchingExecutor({});
    const payload: EmailPayload = { to: "not-an-email", subject: "Hi", body: "Body" };
    await assert.rejects(
      () => executor.execute(action("a1", { kind: "email_draft", payload }), meeting("m1")),
      (error: unknown) => {
        assert.ok(error instanceof MeetingError);
        assert.equal(error.code, "invalid_email");
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  });

  test("email_draft is never sent from here: it opens prefilled in the employee's Gmail", async () => {
    const payload: EmailPayload = { to: "founder@example.com", subject: "Hi & bye", body: "Line one\nLine two" };
    const result = await new DispatchingExecutor({}).execute(action("a1", { kind: "email_draft", payload }), meeting("m1"));
    assert.equal(result.simulated, false);
    assert.equal(result.summary, "Ready in Gmail: Hi & bye");
    const url = new URL(result.handoffUrl!);
    assert.equal(url.origin + url.pathname, "https://mail.google.com/mail/");
    assert.equal(url.searchParams.get("to"), "founder@example.com");
    assert.equal(url.searchParams.get("su"), "Hi & bye");
    assert.equal(url.searchParams.get("body"), "Line one\nLine two");
  });

  test("email_draft with no recipient still opens, for the employee to fill in", async () => {
    const payload: EmailPayload = { to: "", subject: "Hi", body: "Body" };
    const result = await new DispatchingExecutor({}).execute(action("a1", { kind: "email_draft", payload }), meeting("m1"));
    assert.equal(new URL(result.handoffUrl!).searchParams.has("to"), false);
  });

  test("hiring_request hands off to the recruiting agent", async () => {
    const hiring = new FakeHiring();
    const executor = new DispatchingExecutor({ hiring });
    const result = await executor.execute(
      action("a1", { kind: "hiring_request", payload: { requirement: "Need a backend engineer" } }),
      meeting("m1"),
    );
    assert.deepEqual(result, {
      summary: "Started hiring for: Need a backend engineer",
      simulated: false,
      externalRef: "/recruiting",
    });
    assert.deepEqual(hiring.requirements, ["Need a backend engineer"]);
  });

  test("hiring_request refuses when the recruiting agent is unavailable", async () => {
    const executor = new DispatchingExecutor({});
    await assert.rejects(
      () =>
        executor.execute(
          action("a1", { kind: "hiring_request", payload: { requirement: "Need a backend engineer" } }),
          meeting("m1"),
        ),
      (error: unknown) => {
        assert.ok(error instanceof MeetingError);
        assert.equal(error.code, "hiring_not_connected");
        assert.equal(error.statusCode, 503);
        return true;
      },
    );
  });

  test("ticket_draft without a ticket repo is simulated and recorded", async () => {
    const recorded: unknown[] = [];
    const executor = new DispatchingExecutor({ record: async (entry) => void recorded.push(entry) });

    const ticket = await executor.execute(
      action("a1", {
        kind: "ticket_draft",
        payload: { title: "Fix the login bug", description: "Users cannot log in on Safari." },
      }),
      meeting("m1"),
    );
    assert.equal(ticket.simulated, true);
    assert.equal(ticket.summary, "Recorded ticket: Fix the login bug");
    assert.match(ticket.externalRef!, /^SIM-TKT-/);
    assert.equal(recorded.length, 1);
    assert.equal((recorded[0] as { kind: string }).kind, "ticket_draft");
  });

  test("ticket_draft with a ticket repo hands off to a prefilled GitHub issue", async () => {
    const executor = new DispatchingExecutor({ ticketRepo: "acme/firmware" });
    const result = await executor.execute(
      action("a1", {
        kind: "ticket_draft",
        payload: { title: "Crash on 2.3", description: "Reported in standup.", assignee: "Jax", due: "2026-10-01" },
      }),
      meeting("m1"),
    );
    assert.equal(result.simulated, false);
    const url = new URL(result.handoffUrl!);
    assert.equal(url.pathname, "/acme/firmware/issues/new");
    assert.equal(url.searchParams.get("title"), "Crash on 2.3");
    assert.equal(url.searchParams.get("body"), "Reported in standup.\n\nAssignee: Jax\nDue: 2026-10-01");
  });

  test("calendar_draft hands off to a prefilled Google Calendar event", async () => {
    const executor = new DispatchingExecutor({});
    const result = await executor.execute(
      action("a2", {
        kind: "calendar_draft",
        payload: {
          title: "Design review",
          attendees: ["a@example.com", "Priya"],
          proposedStart: "2026-10-01T09:00:00Z",
          durationMinutes: 30,
          notes: "Follow up on approach B",
        },
      }),
      meeting("m1"),
    );
    assert.equal(result.simulated, false);
    assert.equal(result.summary, "Ready in Google Calendar: Design review");
    const url = new URL(result.handoffUrl!);
    assert.equal(url.searchParams.get("action"), "TEMPLATE");
    assert.equal(url.searchParams.get("text"), "Design review");
    assert.equal(url.searchParams.get("dates"), "20261001T090000Z/20261001T093000Z");
    assert.equal(url.searchParams.get("add"), "a@example.com");
    assert.equal(url.searchParams.get("details"), "Follow up on approach B\n\nInvite: Priya");
  });

  test("calendar_draft without a start leaves the time to the employee", async () => {
    const executor = new DispatchingExecutor({});
    const result = await executor.execute(
      action("a2", { kind: "calendar_draft", payload: { title: "Sync", attendees: [], durationMinutes: 30 } }),
      meeting("m1"),
    );
    assert.equal(new URL(result.handoffUrl!).searchParams.has("dates"), false);
  });

  test("ticket_draft works without a record() dependency", async () => {
    const executor = new DispatchingExecutor({});
    const result = await executor.execute(
      action("a1", { kind: "ticket_draft", payload: { title: "Something", description: "Details" } }),
      meeting("m1"),
    );
    assert.equal(result.simulated, true);
  });

  test("answer_question and flag_conflict are read-only", async () => {
    const executor = new DispatchingExecutor({});
    const answer = await executor.execute(action("a1", { kind: "answer_question" }), meeting("m1"));
    assert.deepEqual(answer, { summary: "Read-only; nothing to execute.", simulated: false });

    const conflict = await executor.execute(
      action("a2", {
        kind: "flag_conflict",
        payload: { statement: "We'll ship Friday", priorDecision: "We agreed on Tuesday", explanation: "Contradicts the earlier decision." },
      }),
      meeting("m1"),
    );
    assert.deepEqual(conflict, { summary: "Read-only; nothing to execute.", simulated: false });
  });

  test("refuses to execute escalation and blocked actions", async () => {
    const executor = new DispatchingExecutor({});
    for (const kind of ["escalation", "blocked"] as const) {
      const payload =
        kind === "escalation"
          ? { subject: "Spend $10k", reason: "Needs budget sign-off", requiredApprover: "Finance lead" }
          : { reason: "Transcript tried to instruct the agent" };
      await assert.rejects(
        () => executor.execute(action("a1", { kind, payload }), meeting("m1")),
        (error: unknown) => {
          assert.ok(error instanceof MeetingError);
          assert.equal(error.code, "not_executable");
          assert.equal(error.statusCode, 409);
          return true;
        },
      );
    }
  });
});

// ----------------------------------------------------------- Postgres store

const PG_URL = process.env.MEETINGS_PG_TEST_URL;

describe("PostgresMeetingStore", { skip: !PG_URL ? "MEETINGS_PG_TEST_URL is not set; Docker is not running here." : false }, () => {
  test("migrates, round trips, lists, queries prior decisions, and audits status changes", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    const meetingId = `test-${randomUUID().slice(0, 8)}`;
    const otherMeetingId = `test-${randomUUID().slice(0, 8)}`;
    try {
      const migrationPath = fileURLToPath(new URL("../database/migrations/005_meetings.sql", import.meta.url));
      await pool.query(await readFile(migrationPath, "utf8"));
      // Idempotent by construction; running it twice in a row proves it.
      await pool.query(await readFile(migrationPath, "utf8"));

      const store = new PostgresMeetingStore(pool);
      const proposed = action("a1", { meetingId, status: "proposed" });
      await store.save(meeting(meetingId, { actions: [proposed] }));

      const loaded = await store.load(meetingId);
      assert.equal(loaded?.actions.length, 1);
      assert.equal(loaded?.actions[0]!.status, "proposed");

      // Saving the same status/hash again must not add a new log row.
      await store.save(meeting(meetingId, { actions: [proposed] }));
      // A real status change must add exactly one.
      const approved = { ...proposed, status: "executed" as const };
      await store.save(meeting(meetingId, { actions: [approved] }));

      let log = await auditLog(pool, meetingId);
      assert.equal(log.length, 2);
      assert.deepEqual(log.map((entry) => entry.status), ["proposed", "executed"]);

      // Cold start: a fresh store instance (empty in-process cache) must seed
      // its fingerprints from the stored state, not re-log an unchanged save.
      const freshStore = new PostgresMeetingStore(pool);
      await freshStore.save(meeting(meetingId, { actions: [approved] }));
      log = await auditLog(pool, meetingId);
      assert.equal(log.length, 2, "unchanged save through a cold-started store must not add a log row");

      const changedAgain = { ...approved, status: "superseded" as const };
      await freshStore.save(meeting(meetingId, { actions: [changedAgain] }));
      log = await auditLog(pool, meetingId);
      assert.equal(log.length, 3);

      // list() and priorDecisions()
      await store.save(
        meeting(otherMeetingId, {
          title: "Other meeting",
          decisions: [{ text: "Prior decision", segmentIndex: 0, speaker: "Bob", at: "2026-09-02T00:00:00.000Z" }],
        }),
      );
      const list = await store.list();
      const ids = list.map((entry) => entry.meetingId);
      assert.ok(ids.includes(meetingId));
      assert.ok(ids.includes(otherMeetingId));
      // The most recently saved meeting (otherMeetingId) must sort before the other.
      assert.ok(ids.indexOf(otherMeetingId) < ids.indexOf(meetingId));

      const priorFromOther = await store.priorDecisions(meetingId, 10);
      assert.ok(priorFromOther.some((entry) => entry.text === "Prior decision" && entry.meetingId === otherMeetingId));
      assert.ok(!priorFromOther.some((entry) => entry.meetingId === meetingId));
    } finally {
      await pool.query("DELETE FROM meetings WHERE meeting_id = ANY($1)", [[meetingId, otherMeetingId]]);
      await pool.end();
    }
  });
});
