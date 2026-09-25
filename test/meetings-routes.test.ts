import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import Fastify from "fastify";
import {
  MeetingError,
  hashPayload,
  type ActionPayload,
  type MeetingActions,
  type MeetingEvent,
  type MeetingState,
  type MeetingSummary,
  type ProposedAction,
  type TranscriptSegment,
} from "../src/meetings/domain.js";
import { registerMeetingRoutes } from "../src/meetings/routes.js";

function emptyMeeting(meetingId: string, title: string, employeeId: string, sourceId?: string): MeetingState {
  return {
    meetingId,
    title,
    employeeId,
    status: "live",
    startedAt: "2026-09-25T00:00:00.000Z",
    ...(sourceId ? { sourceId } : {}),
    segments: [],
    decisions: [],
    actions: [],
    trace: [],
  };
}

function fakeAction(meetingId: string, id: string): ProposedAction {
  const payload: ActionPayload = { question: "q", answer: "a", citedSourceIds: [] };
  return {
    id,
    meetingId,
    kind: "answer_question",
    tier: "approval",
    status: "proposed",
    title: "Answer a question",
    trigger: { segmentIndex: 0, speaker: "Alice", quote: "Can we confirm?" },
    payload,
    payloadHash: hashPayload(payload),
    version: 1,
    evidence: [],
    dedupeKey: "dedupe-1",
    createdAt: "2026-09-25T00:00:00.000Z",
  };
}

/** A minimal, deterministic in-memory MeetingActions for route-contract tests. */
class FakeMeetings implements MeetingActions {
  readonly meetings = new Map<string, MeetingState>();
  readonly listeners = new Map<string, Set<(event: MeetingEvent) => void>>();
  readonly approveCalls: Array<{ meetingId: string; actionId: string; payloadHash: string }> = [];
  private counter = 0;

  seed(meeting: MeetingState): void {
    this.meetings.set(meeting.meetingId, meeting);
  }

  async start(input: { title: string; employeeId: string; sourceId?: string }): Promise<MeetingState> {
    this.counter += 1;
    const meeting = emptyMeeting(`m${this.counter}`, input.title, input.employeeId, input.sourceId);
    this.meetings.set(meeting.meetingId, meeting);
    return meeting;
  }

  async append(
    meetingId: string,
    segments: Array<{ speaker: string; text: string; at?: string }>,
  ): Promise<TranscriptSegment[]> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new MeetingError("meeting_not_found", "No meeting with that id was found.", 404);
    const appended = segments.map((segment, offset) => ({
      index: meeting.segments.length + offset,
      speaker: segment.speaker,
      text: segment.text,
      ...(segment.at ? { at: segment.at } : {}),
    }));
    meeting.segments.push(...appended);
    return appended;
  }

  async end(meetingId: string): Promise<MeetingState> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new MeetingError("meeting_not_found", "No meeting with that id was found.", 404);
    meeting.status = "ended";
    meeting.endedAt = "2026-09-25T01:00:00.000Z";
    return meeting;
  }

  async get(meetingId: string): Promise<MeetingState | null> {
    return this.meetings.get(meetingId) ?? null;
  }

  async list(): Promise<MeetingSummary[]> {
    return [...this.meetings.values()].map((meeting) => ({
      meetingId: meeting.meetingId,
      title: meeting.title,
      status: meeting.status,
      startedAt: meeting.startedAt,
      ...(meeting.sourceId ? { sourceId: meeting.sourceId } : {}),
      actionCount: meeting.actions.length,
    }));
  }

  private findAction(meetingId: string, actionId: string): ProposedAction {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new MeetingError("meeting_not_found", "No meeting with that id was found.", 404);
    const action = meeting.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new MeetingError("action_not_found", "No action with that id was found.", 404);
    return action;
  }

  async approve(meetingId: string, actionId: string, payloadHash: string): Promise<ProposedAction> {
    this.approveCalls.push({ meetingId, actionId, payloadHash });
    const action = this.findAction(meetingId, actionId);
    if (action.payloadHash !== payloadHash) {
      throw new MeetingError("payload_changed", "The payload changed since this card was rendered.", 409);
    }
    action.status = "executed";
    action.decidedAt = "2026-09-25T01:00:00.000Z";
    action.result = { summary: "Done.", simulated: true };
    return action;
  }

  async reject(meetingId: string, actionId: string, reason?: string): Promise<ProposedAction> {
    const action = this.findAction(meetingId, actionId);
    action.status = "rejected";
    action.decidedAt = "2026-09-25T01:00:00.000Z";
    if (reason) action.error = reason;
    return action;
  }

  async edit(meetingId: string, actionId: string, payload: ActionPayload): Promise<ProposedAction> {
    const action = this.findAction(meetingId, actionId);
    action.payload = payload;
    action.payloadHash = hashPayload(payload);
    action.version += 1;
    action.status = "proposed";
    return action;
  }

  subscribe(meetingId: string, listener: (event: MeetingEvent) => void): () => void {
    if (!this.listeners.has(meetingId)) this.listeners.set(meetingId, new Set());
    const set = this.listeners.get(meetingId)!;
    set.add(listener);
    return () => set.delete(listener);
  }

  async idle(): Promise<void> {}
}

function buildTestApp(meetings: FakeMeetings, options?: Parameters<typeof registerMeetingRoutes>[2]) {
  const app = Fastify();
  registerMeetingRoutes(app, meetings, options);
  return app;
}

describe("meeting routes: validation", () => {
  test("rejects a missing title or employeeId when starting a meeting", async () => {
    const app = buildTestApp(new FakeMeetings());
    after(() => app.close());

    const noBody = await app.inject({ method: "POST", url: "/api/v1/meetings", payload: {} });
    assert.equal(noBody.statusCode, 400);
    assert.equal(noBody.json().code, "invalid_request");

    const noEmployee = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      payload: { title: "Standup" },
    });
    assert.equal(noEmployee.statusCode, 400);
  });

  test("starts a meeting with 201 and the meeting state", async () => {
    const app = buildTestApp(new FakeMeetings());
    after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      payload: { title: "Standup", employeeId: "jax" },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as MeetingState;
    assert.equal(body.title, "Standup");
    assert.equal(body.employeeId, "jax");
    assert.equal(body.status, "live");
  });

  test("rejects segments with no entries, too many entries, or text over 2000 characters", async () => {
    const meetings = new FakeMeetings();
    const app = buildTestApp(meetings);
    after(() => app.close());
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/meetings",
      payload: { title: "Standup", employeeId: "jax" },
    });
    const { meetingId } = started.json() as MeetingState;

    const empty = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/segments`,
      payload: { segments: [] },
    });
    assert.equal(empty.statusCode, 400);

    const tooMany = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/segments`,
      payload: { segments: Array.from({ length: 51 }, () => ({ speaker: "Alice", text: "hi" })) },
    });
    assert.equal(tooMany.statusCode, 400);

    const tooLong = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/segments`,
      payload: { segments: [{ speaker: "Alice", text: "x".repeat(2001) }] },
    });
    assert.equal(tooLong.statusCode, 400);

    const missingSpeaker = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/segments`,
      payload: { segments: [{ text: "hi" }] },
    });
    assert.equal(missingSpeaker.statusCode, 400);

    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/meetings/${meetingId}/segments`,
      payload: { segments: [{ speaker: "Alice", text: "Let's ship it Friday.", at: "2026-09-25T00:01:00.000Z" }] },
    });
    assert.equal(ok.statusCode, 200);
    const appended = ok.json() as TranscriptSegment[];
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.index, 0);
    assert.equal(appended[0]?.speaker, "Alice");
  });

  test("rejects an edit without a payload and an approve without a payloadHash", async () => {
    const meetings = new FakeMeetings();
    const app = buildTestApp(meetings);
    after(() => app.close());
    const meeting = emptyMeeting("m1", "Standup", "jax");
    meeting.actions.push(fakeAction("m1", "a1"));
    meetings.seed(meeting);

    const editNoPayload = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/m1/actions/a1/edit",
      payload: {},
    });
    assert.equal(editNoPayload.statusCode, 400);

    const approveNoHash = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/m1/actions/a1/approve",
      payload: {},
    });
    assert.equal(approveNoHash.statusCode, 400);
  });
});

describe("meeting routes: MeetingError mapping", () => {
  test("maps a missing meeting to 404 with code and message", async () => {
    const app = buildTestApp(new FakeMeetings());
    after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/api/v1/meetings/does-not-exist" });
    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.code, "meeting_not_found");
    assert.equal(typeof body.message, "string");
  });

  test("maps a payload hash mismatch on approve to 409", async () => {
    const meetings = new FakeMeetings();
    const app = buildTestApp(meetings);
    after(() => app.close());
    const meeting = emptyMeeting("m1", "Standup", "jax");
    meeting.actions.push(fakeAction("m1", "a1"));
    meetings.seed(meeting);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/m1/actions/a1/approve",
      payload: { payloadHash: "stale-hash" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "payload_changed");
  });
});

describe("meeting routes: approve", () => {
  test("passes the exact payloadHash from the request through to MeetingActions.approve", async () => {
    const meetings = new FakeMeetings();
    const app = buildTestApp(meetings);
    after(() => app.close());
    const meeting = emptyMeeting("m1", "Standup", "jax");
    const action = fakeAction("m1", "a1");
    meeting.actions.push(action);
    meetings.seed(meeting);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/m1/actions/a1/approve",
      payload: { payloadHash: action.payloadHash },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(meetings.approveCalls, [
      { meetingId: "m1", actionId: "a1", payloadHash: action.payloadHash },
    ]);
    assert.equal(response.json().status, "executed");
  });
});

describe("meeting routes: replay", () => {
  test("answers 503 when replay is not configured", async () => {
    const app = buildTestApp(new FakeMeetings());
    after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/replay",
      payload: { sourceId: "zoom-1" },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "replay_not_configured");
  });

  test("answers 404 when the OrgForge source cannot be found", async () => {
    const meetings = new FakeMeetings();
    const app = buildTestApp(meetings, { loadReplay: async () => null });
    after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/replay",
      payload: { sourceId: "zoom-1" },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "replay_source_not_found");
  });

  test("starts the meeting, hands segments to replay in the background, and answers 201", async () => {
    const meetings = new FakeMeetings();
    let replayed: unknown;
    const app = buildTestApp(meetings, {
      loadReplay: async (sourceId) =>
        sourceId === "zoom-1"
          ? { title: "Weekly sync", segments: [{ speaker: "Alice", text: "Let's start." }] }
          : null,
      replay: (meetingId, segments, intervalMs) => {
        replayed = { meetingId, segments, intervalMs };
      },
    });
    after(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/meetings/replay",
      payload: { sourceId: "zoom-1", intervalMs: 250 },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as MeetingState;
    assert.equal(body.title, "Weekly sync");
    assert.equal(body.sourceId, "zoom-1");
    assert.deepEqual(replayed, {
      meetingId: body.meetingId,
      segments: [{ speaker: "Alice", text: "Let's start." }],
      intervalMs: 250,
    });
  });

  test("lists replays via listReplays(), or an empty array when it is not configured", async () => {
    const withList = buildTestApp(new FakeMeetings(), {
      listReplays: async () => [{ sourceId: "zoom-1", title: "Weekly sync" }],
    });
    after(() => withList.close());
    const withListResponse = await withList.inject({ method: "GET", url: "/api/v1/meetings/replays" });
    assert.deepEqual(withListResponse.json(), [{ sourceId: "zoom-1", title: "Weekly sync" }]);

    const withoutList = buildTestApp(new FakeMeetings());
    after(() => withoutList.close());
    const withoutListResponse = await withoutList.inject({ method: "GET", url: "/api/v1/meetings/replays" });
    assert.deepEqual(withoutListResponse.json(), []);
  });
});

describe("meeting routes: SSE", () => {
  test("sends the full current state first, as a snapshot event", async () => {
    const meetings = new FakeMeetings();
    meetings.seed(emptyMeeting("m1", "Standup", "jax"));
    const app = buildTestApp(meetings);
    after(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/meetings/m1/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let chunk = "";
    const deadline = Date.now() + 2_000;
    while (!chunk.includes("\n\n")) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the snapshot event.");
      const { value, done } = await reader.read();
      if (done) break;
      chunk += decoder.decode(value, { stream: true });
    }
    controller.abort();

    assert.match(chunk, /^event: snapshot\n/);
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine);
    const snapshot = JSON.parse(dataLine!.slice("data: ".length));
    assert.equal(snapshot.meetingId, "m1");
    assert.equal(snapshot.title, "Standup");
  });

  test("answers 404 (not an event stream) for an unknown meeting", async () => {
    const app = buildTestApp(new FakeMeetings());
    const response = await app.inject({ method: "GET", url: "/api/v1/meetings/does-not-exist/events" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "meeting_not_found");
  });
});

describe("meeting routes: integrations", () => {
  test("reports the Google connection and where to connect, returning to this page", async () => {
    const app = buildTestApp(new FakeMeetings(), { googleStatus: async () => ({ connected: true, mailbox: true, calendar: false }) });
    after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/api/v1/meetings/integrations" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      google: { connected: true, mailbox: true, calendar: false, connectUrl: "/api/recruiting/gmail/connect?return=/meetings" },
    });
  });

  test("says null when Google is not configured", async () => {
    const app = buildTestApp(new FakeMeetings());
    after(() => app.close());
    const response = await app.inject({ method: "GET", url: "/api/v1/meetings/integrations" });
    assert.deepEqual(response.json(), { google: null });
  });
});
