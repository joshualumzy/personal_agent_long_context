import type pg from "pg";
import { parseTranscript } from "./transcript.js";
import type { MeetingActions } from "./domain.js";

export interface ReplaySegment {
  speaker: string;
  text: string;
  at?: string;
}

export interface ReplayOptions {
  /** Delay between segments, in ms. 0 appends back to back (used by tests). */
  intervalMs: number;
  /** When aborted, the loop stops before its next append and the meeting is
   * left running (not ended) — the caller decides what to do with it. */
  signal?: AbortSignal;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Replays a demo or OrgForge transcript into a live meeting, one segment at
 * a time, waiting `intervalMs` between appends so the UI can show the
 * agent proposing actions as the "meeting" unfolds. Ends the meeting once
 * every segment has been sent, unless `signal` was aborted first.
 */
export async function replayTranscript(
  meetings: MeetingActions,
  meetingId: string,
  segments: ReadonlyArray<ReplaySegment>,
  { intervalMs, signal }: ReplayOptions,
): Promise<void> {
  for (const segment of segments) {
    if (signal?.aborted) return;
    await meetings.append(meetingId, [segment]);
    if (signal?.aborted) return;
    await delay(intervalMs, signal);
  }
  if (signal?.aborted) return;
  await meetings.end(meetingId);
}

export interface ReplaySource {
  /** zoom_transcript rows, newest first, limit 50. */
  list(): Promise<Array<{ sourceId: string; title: string }>>;
  load(sourceId: string): Promise<{ title: string; segments: ReplaySegment[] } | null>;
}

interface ListRow {
  source_id: string;
  title: string | null;
}

interface LoadRow {
  title: string | null;
  body: string;
  occurred_at: Date | null;
}

/** Reads OrgForge zoom_transcript rows out of `source_documents` (see
 * scripts/orgforge/ingest.py) to replay a real meeting instead of a scripted
 * demo scenario. */
export function postgresReplaySource(pool: pg.Pool): ReplaySource {
  return {
    async list() {
      const result = await pool.query<ListRow>(
        `SELECT source_id, title
           FROM source_documents
          WHERE source_type = 'zoom_transcript'
          ORDER BY occurred_at DESC NULLS LAST, source_id DESC
          LIMIT 50`,
      );
      return result.rows.map((row) => ({ sourceId: row.source_id, title: row.title ?? row.source_id }));
    },

    async load(sourceId) {
      const result = await pool.query<LoadRow>(
        `SELECT title, body, occurred_at
           FROM source_documents
          WHERE source_type = 'zoom_transcript' AND source_id = $1
          LIMIT 1`,
        [sourceId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const occurredAt = row.occurred_at ? row.occurred_at.toISOString() : undefined;
      const segments = parseTranscript(row.body, occurredAt).map(({ speaker, text, at }) => ({
        speaker,
        text,
        ...(at ? { at } : {}),
      }));
      return { title: row.title ?? sourceId, segments };
    },
  };
}
