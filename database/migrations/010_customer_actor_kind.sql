-- Fix actor_kind for the seven customer organizations, misclassified as
-- 'employee' since the corpus never sets actor_kind and migration 005
-- defaulted every actor to it.
--
-- These seven are proper nouns naming a customer account, not a person, and
-- they are named as such consistently: crm_touchpoint.account_name,
-- proactive_outreach_initiated.account, and zd_ticket_opened.org_name all
-- point at the same seven strings, and every one of them already exists in
-- actors from the involves relationships their team-facing artifacts carry.
--
-- Fixing this here, rather than in build_graph.py, is what lets
-- build_organization_nodes() read actor_kind directly instead of hard-coding
-- the same name list a second time — the classification belongs on the data,
-- not duplicated into the query that consumes it.
--
-- migrate.ts replays every migration on each run, so this is idempotent: an
-- UPDATE that has already run finds no 'employee' rows left to change.

BEGIN;

UPDATE actors SET actor_kind = 'customer'
WHERE actor_kind = 'employee'
  AND name IN (
    'Metro United FC',
    'National Olympic Training Center',
    'Velox Pro Cycling',
    'Blue Wave Swim Club',
    'Future Hoops Academy',
    'Northern University Athletics',
    'Riverside High School'
  );

COMMIT;
