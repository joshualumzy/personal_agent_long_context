-- Import the two supplemental registries the corpus itself provides.
--
-- domain_registry.json names an actor as a domain's owner or one of the people
-- who know it, by string. That is direct evidence for actor disambiguation
-- (finding 3 in issue #11) — better than guessing "Ethan" and "Ethan Patel" are
-- the same person from string similarity, which also has to avoid merging
-- "GitHub" and "GitHub Actions".
--
-- simulation_snapshot.json's resolved_incidents names which 12 jira ids are the
-- P1/P2 incidents. Their timing and root cause are not repeated here: they
-- already sit in source_documents.facts on the matching incident_opened /
-- postmortem_created rows, imported in migration 006, and are read from there.
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS domains (
    domain_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain_key             TEXT NOT NULL UNIQUE,   -- registry's _id, e.g. "titandb"
    name                   TEXT NOT NULL,           -- "TitanDB"
    dept                   TEXT,
    -- Not a foreign key to actors: an owner can be a departed genesis-gap
    -- employee who never appears in source_documents.actors and so was never
    -- inserted into actors either.
    primary_owner          TEXT,
    former_owner           TEXT,
    documentation_coverage NUMERIC(4,3)
                              CHECK (documentation_coverage BETWEEN 0 AND 1),
    is_genesis_gap          BOOLEAN NOT NULL DEFAULT FALSE,
    last_updated_day        INTEGER,
    known_by                JSONB NOT NULL DEFAULT '[]'::jsonb,  -- actor names
    system_tags             JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["titan","titandb"]
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS domains_dept_idx ON domains (dept);
CREATE INDEX IF NOT EXISTS domains_known_by_gin ON domains USING GIN (known_by);

-- The 12 P1/P2 incidents. incident_key is the jira id simulation_snapshot.json
-- names as the incident. Not every one of those ids is itself an ingested row —
-- six of the twelve never appear as their own jira artifact, only as a
-- derived confluence postmortem (CONF-ENG-123) or datadog alert (DD-ENG-123) —
-- so this is not a foreign key to source_documents. What ties the incident to
-- its facts is the matching incident_opened row, found by
-- facts->'causal_chain'->>0 = incident_key.
CREATE TABLE IF NOT EXISTS incidents (
    incident_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_key TEXT NOT NULL UNIQUE,
    root_domain  BIGINT REFERENCES domains(domain_id),
    opened_at    TIMESTAMPTZ,
    resolved_at  TIMESTAMPTZ,
    root_cause   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_domain_idx ON incidents (root_domain);

COMMIT;
