-- Widen the node/edge taxonomy to what the causal layer actually needs.
--
-- 'document' and 'actor' covered two of five real kinds, and an event that
-- produced an artifact was being called a 'document' with category='sim_event'
-- read off its props — an edge from that row meaning "produced this" was
-- indistinguishable from one meaning "cites this", both written as
-- 'references'. The five kinds below match what causal_chain and
-- design_discussion actually connect: people, organizations named in actors,
-- concepts and work items, events, and the documents people wrote.
--
-- This migration only widens what the CHECK constraints allow. It does NOT
-- migrate the existing 22,606 nodes / 58,366 edges — build_graph.py is
-- rewritten separately and verified against the old graph before anything
-- currently working is replaced. The old values ('document', 'actor',
-- 'references') stay legal for that reason: a CHECK is validated against every
-- existing row the moment it is added, so dropping them now would fail this
-- migration outright rather than merely widening it. A follow-up migration
-- removes them once the rebuilt graph has replaced the old rows.
--
-- migrate.ts replays every migration on each run, so this is idempotent:
-- dropping a constraint that is not there, or adding a column that already
-- exists, is a no-op rather than an error.

BEGIN;

ALTER TABLE graph_nodes DROP CONSTRAINT IF EXISTS graph_nodes_node_type_check;
ALTER TABLE graph_nodes ADD CONSTRAINT graph_nodes_node_type_check
    CHECK (node_type IN (
        'person', 'organization', 'item', 'event', 'document',
        'actor'  -- old value, kept only until the rebuilt graph replaces it
    ));

-- Free text on purpose: a new kind of item or event should not need a
-- migration. Not part of the identity key — graph_nodes already enforces
-- UNIQUE (node_type, ref_key), so two events of different subtype sharing a
-- ref_key would still collide, which is correct.
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS node_subtype TEXT;
CREATE INDEX IF NOT EXISTS graph_nodes_subtype_idx ON graph_nodes (node_subtype);

ALTER TABLE graph_edges DROP CONSTRAINT IF EXISTS graph_edges_edge_type_check;
ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_edge_type_check
    CHECK (edge_type IN (
        'produced',       -- event -> document/item it resulted in
        'caused_by',       -- event -> item/domain that caused it
        'escalated_via',   -- event(incident) -> event(escalation_chain)
        'documented_by',   -- event(incident) -> event(postmortem)
        'involves',        -- event/document -> person
        'about_domain',    -- document/item -> item(domain)
        'owns_domain',     -- person -> item(domain)
        'authored_by',     -- document -> person
        'references'       -- old value, kept only until the rebuilt graph replaces it
    ));

COMMIT;
