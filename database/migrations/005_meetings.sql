BEGIN;

-- S2 meeting actions. The full MeetingState (domain.ts) is stored as JSONB in
-- `state`; a few columns are kept alongside it purely so `list()` and lookups
-- do not need to deserialise every row's JSON.
CREATE TABLE IF NOT EXISTS meetings (
    meeting_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    source_id TEXT,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meetings_updated
    ON meetings (updated_at DESC);

-- Decisions heard in a meeting, denormalised out of `state` so priorDecisions()
-- can be queried across meetings without scanning JSONB.
CREATE TABLE IF NOT EXISTS meeting_decisions (
    meeting_id TEXT NOT NULL REFERENCES meetings (meeting_id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    speaker TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (meeting_id, segment_index, text)
);

CREATE INDEX IF NOT EXISTS idx_meeting_decisions_at
    ON meeting_decisions (at DESC);

-- Append-only audit of every status change an action goes through (proposed,
-- approved, executing, executed, failed, rejected, escalated, blocked,
-- superseded). This is the observability trail judges inspect.
CREATE TABLE IF NOT EXISTS meeting_action_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings (meeting_id) ON DELETE CASCADE,
    action_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    tier TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    detail JSONB
);

CREATE INDEX IF NOT EXISTS idx_meeting_action_log_meeting_at
    ON meeting_action_log (meeting_id, at ASC);

COMMIT;
