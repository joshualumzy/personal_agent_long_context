-- Who was the designated owner of each knowledge domain, from which day.
--
-- The graph's owns_domain edges hold every owner a domain ever had, with no
-- dates: kubernetes-deploy is owned by both Morgan and Sanjay. This table
-- dates them, so "the owner on day D" has one answer. Built by
-- orgforge_kb/build_timeline.py from the domain registry's former and current
-- owner, the hand-overs the corpus records, and the roster: a hand-over takes
-- effect on its day; a current owner with no recorded hand-over takes over
-- when the former owner leaves, or when they themselves join if later.
--
-- An owner who is no longer employed on D (employee_roster) leaves the domain
-- orphaned on D; that is decided when reading, not stored.
--
-- Approved on the roster's terms (docs/mvp.md): shown, never cited.
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS domain_owner_history (
    domain_key    text   NOT NULL,
    owner         text   NOT NULL,
    valid_from    date,            -- NULL: owner since before the record
    valid_to      date,            -- NULL: still the designated owner
    derived_from  text[] NOT NULL DEFAULT '{}',
    UNIQUE NULLS NOT DISTINCT (domain_key, owner, valid_from),
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from)
);

COMMIT;
