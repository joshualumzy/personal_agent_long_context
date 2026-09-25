import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { formatTranscript, parseTranscript } from "../src/meetings/transcript.js";
import { replayTranscript } from "../src/meetings/replay.js";
import type {
  ActionPayload,
  MeetingActions,
  MeetingEvent,
  MeetingState,
  MeetingSummary,
  ProposedAction,
  TranscriptSegment,
} from "../src/meetings/domain.js";

const SIMPLE_FIXTURE = new URL("./fixtures/orgforge-zoom-simple.txt", import.meta.url);
const MULTILINE_FIXTURE = new URL("./fixtures/orgforge-zoom-multiline.txt", import.meta.url);

describe("parseTranscript on real OrgForge zoom_transcript bodies", () => {
  test("single-line turns: one segment per **[HH:MM:SS] Speaker:** line, in order", async () => {
    const body = await readFile(SIMPLE_FIXTURE, "utf8");
    const segments = parseTranscript(body, "2026-01-01T12:12:00+00:00");

    assert.equal(segments.length, 10);
    assert.deepEqual(
      segments.map((segment) => segment.speaker),
      ["Jax", "Morgan", "Yusuf", "Tasha", "Jax", "Morgan", "Yusuf", "Tasha", "Jax", "Jax"],
    );
    assert.equal(segments[0]!.at, "2026-01-01T12:12:00.000Z");
    assert.equal(segments[4]!.at, "2026-01-01T12:25:00.000Z");
    assert.match(segments[0]!.text, /^hey everyone, goal is to lock down/);
    assert.match(segments[1]!.text, /required_tags/);
    // The last turn's text should not swallow any metadata or the divider.
    assert.doesNotMatch(segments[9]!.text, /Zoom Meeting Transcript|Attendees:|^---$/);
  });

  test("without occurredAt, segments have no `at`", async () => {
    const body = await readFile(SIMPLE_FIXTURE, "utf8");
    const segments = parseTranscript(body);
    assert.equal(segments.length, 10);
    for (const segment of segments) assert.equal(segment.at, undefined);
  });

  test("multi-line turns: a continuation line with no new speaker tag attaches to the previous speaker", async () => {
    const body = await readFile(MULTILINE_FIXTURE, "utf8");
    const segments = parseTranscript(body, "2026-01-15T13:18:17+00:00");

    // 13 turns in the fixture; two of Deepa's turns run across several
    // lines (a lead-in plus a numbered list plus a trailing sentence) with
    // no **[time] Speaker:** prefix on the continuation lines.
    assert.equal(segments.length, 13);

    const firstDeepa = segments.find((segment) => segment.speaker === "Deepa" && segment.at === "2026-01-15T13:23:17.000Z");
    assert.ok(firstDeepa);
    assert.equal(
      firstDeepa!.text,
      "Sure, let me break it down:\n" +
        "1. Confirm the primary navigation tabs (Home, Stats, Settings).\n" +
        "2. Validate the placement of the real‑time metrics widget.\n" +
        "3. Align the onboarding modal sequence with the data‑fetch API.\n" +
        "If we lock these, we can move forward.",
    );

    const secondDeepa = segments.find((segment) => segment.speaker === "Deepa" && segment.at === "2026-01-15T13:36:17.000Z");
    assert.ok(secondDeepa);
    assert.equal(
      secondDeepa!.text,
      "1. Draft the final modal script by 3 PM.\n" +
        "2. Review with UX by 4 PM.\n" +
        "3. Hand off to devs at 5 PM.\n" +
        "That should give us a clean handoff.",
    );

    // Every other turn stayed a single line (no accidental merging).
    const yusuf = segments.filter((segment) => segment.speaker === "Yusuf");
    assert.equal(yusuf.length, 2);
    for (const segment of yusuf) assert.doesNotMatch(segment.text, /\n/);
  });

  test("handles blank body and text with no turns without throwing", () => {
    assert.deepEqual(parseTranscript(""), []);
    assert.deepEqual(parseTranscript("# Zoom Meeting Transcript\n**Date:** 2026-01-01\n\n---\n"), []);
  });
});

describe("formatTranscript", () => {
  test("is the inverse of parseTranscript's turn shape: one **[time] Speaker:** block per segment", () => {
    const rendered = formatTranscript([
      { speaker: "Jax", text: "hello team", at: "2026-01-01T12:12:00.000Z" },
      { speaker: "Morgan", text: "line one\nline two", at: "2026-01-01T12:16:00.000Z" },
    ]);
    assert.equal(
      rendered,
      "**[12:12:00] Jax:** hello team\n\n**[12:16:00] Morgan:** line one\nline two",
    );

    const reparsed = parseTranscript(rendered, "2026-01-01T00:00:00Z");
    assert.equal(reparsed.length, 2);
    assert.equal(reparsed[0]!.speaker, "Jax");
    assert.equal(reparsed[0]!.text, "hello team");
    assert.equal(reparsed[1]!.text, "line one\nline two");
  });

  test("segments without `at` render without a bracketed time", () => {
    const rendered = formatTranscript([{ speaker: "Deepa", text: "no timestamp here" }]);
    assert.equal(rendered, "**Deepa:** no timestamp here");
  });
});

// --------------------------------------------------------------- replay

class FakeMeetingActions implements MeetingActions {
  readonly appended: Array<{ meetingId: string; speaker: string; text: string; at?: string }> = [];
  readonly ended: string[] = [];
  private nextIndex = 0;

  async start(input: { title: string; employeeId: string; sourceId?: string }): Promise<MeetingState> {
    return {
      meetingId: "meeting-1",
      title: input.title,
      employeeId: input.employeeId,
      status: "live",
      startedAt: new Date().toISOString(),
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      segments: [],
      decisions: [],
      actions: [],
      trace: [],
    };
  }

  async append(
    meetingId: string,
    segments: Array<{ speaker: string; text: string; at?: string }>,
  ): Promise<TranscriptSegment[]> {
    const added: TranscriptSegment[] = [];
    for (const segment of segments) {
      this.appended.push({ meetingId, ...segment });
      added.push({ index: this.nextIndex++, speaker: segment.speaker, text: segment.text, ...(segment.at ? { at: segment.at } : {}) });
    }
    return added;
  }

  async end(meetingId: string): Promise<MeetingState> {
    this.ended.push(meetingId);
    return {
      meetingId,
      title: "t",
      employeeId: "jax",
      status: "ended",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      segments: [],
      decisions: [],
      actions: [],
      trace: [],
    };
  }

  async get(): Promise<MeetingState | null> {
    return null;
  }

  async list(): Promise<MeetingSummary[]> {
    return [];
  }

  async approve(): Promise<ProposedAction> {
    throw new Error("not used in this test");
  }

  async reject(): Promise<ProposedAction> {
    throw new Error("not used in this test");
  }

  async edit(_meetingId: string, _actionId: string, _payload: ActionPayload): Promise<ProposedAction> {
    throw new Error("not used in this test");
  }

  subscribe(_meetingId: string, _listener: (event: MeetingEvent) => void): () => void {
    return () => {};
  }

  async idle(): Promise<void> {}
}

describe("replayTranscript", () => {
  test("appends one segment at a time, in order, then ends the meeting", async () => {
    const fake = new FakeMeetingActions();
    const segments = [
      { speaker: "Jax", text: "first" },
      { speaker: "Morgan", text: "second" },
      { speaker: "Deepa", text: "third" },
    ];

    await replayTranscript(fake, "meeting-1", segments, { intervalMs: 0 });

    assert.equal(fake.appended.length, 3);
    // Each append call carried exactly one segment, not the whole batch.
    assert.deepEqual(
      fake.appended.map((entry) => entry.text),
      ["first", "second", "third"],
    );
    assert.deepEqual(fake.ended, ["meeting-1"]);
  });

  test("stops before the next append and never ends the meeting once aborted", async () => {
    const fake = new FakeMeetingActions();
    const controller = new AbortController();
    const segments = [
      { speaker: "Jax", text: "first" },
      { speaker: "Morgan", text: "second" },
      { speaker: "Deepa", text: "third" },
    ];

    // intervalMs 0 still awaits a microtask per iteration; abort right away.
    controller.abort();
    await replayTranscript(fake, "meeting-1", segments, { intervalMs: 0, signal: controller.signal });

    assert.equal(fake.appended.length, 0);
    assert.deepEqual(fake.ended, []);
  });

  test("empty segment list ends the meeting immediately", async () => {
    const fake = new FakeMeetingActions();
    await replayTranscript(fake, "meeting-1", [], { intervalMs: 0 });
    assert.equal(fake.appended.length, 0);
    assert.deepEqual(fake.ended, ["meeting-1"]);
  });
});
