import type pg from "pg";
import type { Decision, MeetingState, MeetingStatus, MeetingStore, MeetingSummary } from "./domain.js";

// --------------------------------------------------------------- in-memory

/** For tests and local runs. Deep-copies on save/load so callers can't mutate stored state. */
export class InMemoryMeetingStore implements MeetingStore {
  private readonly meetings = new Map<string, MeetingState>();
  /** Save order, newest last; used only to answer list() and priorDecisions() "newest first". */
  private readonly savedAt = new Map<string, number>();
  private tick = 0;

  async load(meetingId: string): Promise<MeetingState | null> {
    const found = this.meetings.get(meetingId);
    return found ? structuredClone(found) : null;
  }

  async save(state: MeetingState): Promise<void> {
    this.meetings.set(state.meetingId, structuredClone(state));
    this.savedAt.set(state.meetingId, (this.tick += 1));
  }

  async list(): Promise<MeetingSummary[]> {
    return [...this.meetings.values()]
      .sort((left, right) => (this.savedAt.get(right.meetingId) ?? 0) - (this.savedAt.get(left.meetingId) ?? 0))
      .map(summaryOf);
  }

  async priorDecisions(
    exceptMeetingId: string,
    limit: number,
  ): Promise<Array<Decision & { meetingId: string; title: string }>> {
    const all: Array<Decision & { meetingId: string; title: string }> = [];
    for (const meeting of this.meetings.values()) {
      if (meeting.meetingId === exceptMeetingId) continue;
      for (const decision of meeting.decisions) {
        all.push({ ...decision, meetingId: meeting.meetingId, title: meeting.title });
      }
    }
    all.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    return all.slice(0, limit);
  }
}

function summaryOf(state: MeetingState): MeetingSummary {
  return {
    meetingId: state.meetingId,
    title: state.title,
    status: state.status,
    startedAt: state.startedAt,
    ...(state.sourceId ? { sourceId: state.sourceId } : {}),
    actionCount: state.actions.length,
  };
}

// ----------------------------------------------------------------- postgres

interface MeetingRow {
  meeting_id: string;
  title: string;
  status: MeetingStatus;
  started_at: Date;
  source_id: string | null;
  state: MeetingState;
  action_count?: string | number;
}

interface DecisionRow {
  meeting_id: string;
  segment_index: number;
  text: string;
  speaker: string;
  at: Date;
  title: string;
}

export interface AuditLogEntry {
  id: number;
  meetingId: string;
  actionId: string;
  kind: string;
  tier: string;
  status: string;
  payloadHash: string;
  at: string;
  detail: unknown;
}

interface AuditLogRow {
  id: string | number;
  meeting_id: string;
  action_id: string;
  kind: string;
  tier: string;
  status: string;
  payload_hash: string;
  at: Date;
  detail: unknown;
}

/** What the log needs to decide whether an action's row changed since the last save. */
interface ActionFingerprint {
  status: string;
  payloadHash: string;
}

/** Postgres-backed MeetingStore. Storage: database/migrations/005_meetings.sql. */
export class PostgresMeetingStore implements MeetingStore {
  /**
   * Last seen (status, payloadHash) per action id, per meeting, so save() only
   * appends a meeting_action_log row when something actually changed. Seeded
   * from the previously stored state JSON on the first save after a cold
   * start (see `fingerprintsOf`), then kept in-process from then on.
   */
  private readonly seen = new Map<string, Map<string, ActionFingerprint>>();

  constructor(private readonly pool: pg.Pool) {}

  async load(meetingId: string): Promise<MeetingState | null> {
    const result = await this.pool.query<MeetingRow>(
      `SELECT meeting_id, title, status, started_at, source_id, state
       FROM meetings
       WHERE meeting_id = $1`,
      [meetingId],
    );
    const row = result.rows[0];
    return row ? row.state : null;
  }

  async save(state: MeetingState): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      let previous = this.seen.get(state.meetingId);
      if (!previous) {
        // Cold start: this process has not seen this meeting yet. Seed the
        // fingerprint cache from whatever is currently stored, so we don't
        // log every action as "changed" just because the process restarted.
        const existing = await client.query<{ state: MeetingState }>(
          `SELECT state FROM meetings WHERE meeting_id = $1`,
          [state.meetingId],
        );
        previous = fingerprintsOf(existing.rows[0]?.state ?? null);
        this.seen.set(state.meetingId, previous);
      }

      const changed = state.actions.filter((action) => {
        const last = previous!.get(action.id);
        return !last || last.status !== action.status || last.payloadHash !== action.payloadHash;
      });

      await client.query(
        `INSERT INTO meetings (meeting_id, title, employee_id, status, started_at, ended_at, source_id, state, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
         ON CONFLICT (meeting_id) DO UPDATE SET
           title = EXCLUDED.title,
           employee_id = EXCLUDED.employee_id,
           status = EXCLUDED.status,
           started_at = EXCLUDED.started_at,
           ended_at = EXCLUDED.ended_at,
           source_id = EXCLUDED.source_id,
           state = EXCLUDED.state,
           updated_at = now()`,
        [
          state.meetingId,
          state.title,
          state.employeeId,
          state.status,
          state.startedAt,
          state.endedAt ?? null,
          state.sourceId ?? null,
          JSON.stringify(state),
        ],
      );

      await client.query(`DELETE FROM meeting_decisions WHERE meeting_id = $1`, [state.meetingId]);
      for (const decision of state.decisions) {
        await client.query(
          `INSERT INTO meeting_decisions (meeting_id, segment_index, text, speaker, at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (meeting_id, segment_index, text) DO NOTHING`,
          [state.meetingId, decision.segmentIndex, decision.text, decision.speaker, decision.at],
        );
      }

      for (const action of changed) {
        await client.query(
          `INSERT INTO meeting_action_log (meeting_id, action_id, kind, tier, status, payload_hash, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            state.meetingId,
            action.id,
            action.kind,
            action.tier,
            action.status,
            action.payloadHash,
            JSON.stringify({ title: action.title, summary: action.result?.summary, error: action.error }),
          ],
        );
      }

      await client.query("COMMIT");

      const cache = this.seen.get(state.meetingId)!;
      for (const action of state.actions) {
        cache.set(action.id, { status: action.status, payloadHash: action.payloadHash });
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<MeetingSummary[]> {
    const result = await this.pool.query<MeetingRow>(
      `SELECT meeting_id, title, status, started_at, source_id,
              jsonb_array_length(state->'actions') AS action_count
       FROM meetings
       ORDER BY updated_at DESC`,
    );
    return result.rows.map((row) => ({
      meetingId: row.meeting_id,
      title: row.title,
      status: row.status,
      startedAt: row.started_at.toISOString(),
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      actionCount: Number(row.action_count ?? 0),
    }));
  }

  async priorDecisions(
    exceptMeetingId: string,
    limit: number,
  ): Promise<Array<Decision & { meetingId: string; title: string }>> {
    const result = await this.pool.query<DecisionRow>(
      `SELECT d.meeting_id, d.segment_index, d.text, d.speaker, d.at, m.title
       FROM meeting_decisions d
       JOIN meetings m ON m.meeting_id = d.meeting_id
       WHERE d.meeting_id != $1
       ORDER BY d.at DESC
       LIMIT $2`,
      [exceptMeetingId, limit],
    );
    return result.rows.map((row) => ({
      text: row.text,
      segmentIndex: row.segment_index,
      speaker: row.speaker,
      at: row.at.toISOString(),
      meetingId: row.meeting_id,
      title: row.title,
    }));
  }
}

function fingerprintsOf(state: MeetingState | null): Map<string, ActionFingerprint> {
  const map = new Map<string, ActionFingerprint>();
  if (!state) return map;
  for (const action of state.actions) {
    map.set(action.id, { status: action.status, payloadHash: action.payloadHash });
  }
  return map;
}

/** The full status-change trail for one meeting's actions, oldest first. For a trace/audit endpoint. */
export async function auditLog(pool: pg.Pool, meetingId: string): Promise<AuditLogEntry[]> {
  const result = await pool.query<AuditLogRow>(
    `SELECT id, meeting_id, action_id, kind, tier, status, payload_hash, at, detail
     FROM meeting_action_log
     WHERE meeting_id = $1
     ORDER BY at ASC, id ASC`,
    [meetingId],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    meetingId: row.meeting_id,
    actionId: row.action_id,
    kind: row.kind,
    tier: row.tier,
    status: row.status,
    payloadHash: row.payload_hash,
    at: row.at.toISOString(),
    detail: row.detail,
  }));
}
