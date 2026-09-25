BEGIN;

-- The MVP validates citations in the live request and does not retain question
-- or answer history. Remove the earlier optional debugging journal.
DROP TABLE IF EXISTS agent_run_sources;
DROP TABLE IF EXISTS agent_runs;

COMMIT;
