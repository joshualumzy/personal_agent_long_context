-- Fix actor_kind for two more groups that migration 010 missed, found by
-- auditing the full actors table for names that read as organizations
-- rather than people, still tagged 'employee' from migration 005's default.
--
-- Quantum Gaming is an eighth customer account: invoice.title names it
-- exactly the way it names the seven migration 010 already fixed ("Invoice
-- INV-D2E1C00A - Quantum Gaming"), but it never appeared in the
-- crm_touchpoint/proactive_outreach_initiated/zd_ticket_opened fields that
-- migration 010's scan was built from — a real gap in that scan, not a new
-- kind of evidence.
--
-- The eleven others are third-party tools and services, not people:
-- external_contact_summarized.facts names them directly as the external
-- party ({"org": "Datadog", "external_party": "Datadog", ...}), and they
-- otherwise only ever appear as the subject of slack messages (deploy bots,
-- monitoring alerts), never as someone with a role or department. Migration
-- 005's own comment already flagged this ("vendors and tools ... appear in
-- the same list") without anyone acting on it until this audit.
--
-- Both groups become node_type='organization' via the same
-- build_organization_nodes() path migration 010 built (actor_kind IN
-- ('customer','vendor')) — no query change needed, only the data.
--
-- migrate.ts replays every migration on each run, so this is idempotent: an
-- UPDATE that has already run finds no 'employee' rows left to change.

BEGIN;

UPDATE actors SET actor_kind = 'customer'
WHERE actor_kind = 'employee'
  AND name = 'Quantum Gaming';

UPDATE actors SET actor_kind = 'vendor'
WHERE actor_kind = 'employee'
  AND name IN (
    'Amazon Web Services',
    'AWS Cost Explorer',
    'Datadog',
    'PagerDuty',
    'GitHub',
    'GitHub Actions',
    'CloudBees',
    'Confluent',
    'Google Firebase',
    'HashiCorp',
    'Snyk Security'
  );

COMMIT;
