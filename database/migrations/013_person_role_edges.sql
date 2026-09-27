-- Give the graph words for what a person actually did.
--
-- Until now one edge type, 'involves', carried every relationship between a
-- person and anything else: 10,790 edges meaning no more than "this person's
-- name is attached to this". That is not a modelling choice so much as an
-- accident of where the edges came from — document_actors is a two-column
-- junction table (source_id, actor_id) with nowhere to put a role, so the role
-- was dropped on the way in.
--
-- The roles were never missing from the corpus. pr_review names an author and
-- a reviewer on the same row — two different people doing opposite jobs, today
-- indistinguishable in the graph. dept_plan_created names the lead of a
-- department. ticket_progress names who a ticket moved from and to. Verified
-- before writing this: document_actors is exactly the flattened union of those
-- role fields (0 rows differ in either direction for design_discussion and
-- pr_review), so naming the roles is a relabelling of edges that already
-- exist, not a second set on top of them.
--
-- 'knows_about' is the exception and the only genuinely new relationship:
-- domain_registry's known_by lists 15-42 people per domain (~335 pairs) and
-- has never been in the graph at all, which left the question "who understands
-- this" unanswerable from the graph alone.
--
-- raised_by / received_by replace the escalation_chain node. That node was 14
-- rows all labelled the literal string "Escalation Chain", joining a pair of
-- people to an incident and carrying nothing else — a hub with no content,
-- unreadable on a diagram. The escalation is a fact about the incident, so it
-- becomes props on the incident plus these two edges naming who raised it and
-- who received it.
--
-- 'escalated_via' stays legal here even though the rebuilt graph will leave it
-- with zero edges; dropping a value is a separate, tightening migration, and
-- this one only widens.
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

ALTER TABLE graph_edges DROP CONSTRAINT IF EXISTS graph_edges_edge_type_check;
ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_edge_type_check
    CHECK (edge_type IN (
        'produced',        -- event -> document/item it resulted in
        'caused_by',       -- event -> the event that caused it
        'escalated_via',   -- retired by this migration's rebuild, kept legal
        'documented_by',   -- event -> the document recording it
        'involves',        -- event/document -> person, role unknown
        'about_domain',    -- document/item -> item(domain)
        'owns_domain',     -- person -> item(domain), from the registry
        'knows_about',     -- person -> item(domain), from the registry's known_by
        'authored_by',     -- event -> the person who wrote the thing it produced
        'reviewed_by',     -- event -> the person who reviewed it
        'led_by',          -- event -> the person leading it
        'assigned_to',     -- event -> the person work moved to
        'raised_by',       -- event(incident) -> who escalated it
        'received_by'      -- event(incident) -> who it was escalated to
    ));

COMMIT;
