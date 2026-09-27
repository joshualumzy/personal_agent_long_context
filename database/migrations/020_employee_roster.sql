-- Who worked at the company on which day: the employee roster projection.
--
-- Built offline by orgforge_kb/build_timeline.py from the simulation's hire
-- and departure events, plus everyone named in a department plan. Approved on
-- the planner projection's terms (docs/mvp.md, "Knowledge gaps and hiring
-- proposals"): it may be shown, and it is never Company Evidence. It holds no
-- reason for leaving — who was laid off is not company-wide information.
--
--   joined_on  NULL for someone already there when the record starts
--   left_on    the first day they were no longer employed; NULL if still there
--
-- Employed on D: (joined_on IS NULL OR joined_on <= D) AND (left_on IS NULL OR left_on > D).
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS employee_roster (
    person        text     PRIMARY KEY,
    joined_on     date,
    left_on       date,
    role          text,
    department    text,
    derived_from  text[]   NOT NULL DEFAULT '{}',
    CHECK (joined_on IS NULL OR left_on IS NULL OR left_on > joined_on)
);

COMMIT;
