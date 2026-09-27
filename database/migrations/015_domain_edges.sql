-- Connect written work to the knowledge domains.
--
-- Until now a domain touched only people (owns_domain, knows_about):
-- about_domain existed with zero edges, so nothing could be asked of the graph
-- like "what has been written or broken in TitanDB".
--
-- Two relationships, kept apart because they rest on different evidence:
--
--   updates_domain  document -> item(domain). confluence_created names, in
--                   facts.domains_updated, which domains' documentation a new
--                   page counted toward — 2,406 pairs over 437 pages. Stated
--                   by the corpus, but broad: 5.5 domains per page on average.
--   about_domain    item/document/event(incident) -> item(domain), when the
--                   thing's own title (or an incident's root_cause) names the
--                   domain by a distinctive term. Built by build_graph.py,
--                   which records the field and term on the edge's props.
--
-- Not used, with reasons, in build_graph.py: facts.knowledge_domains (only on
-- four employee_departed rows) and facts.gap_areas (the departed employee's
-- whole domain list, copied onto every artifact checked against it, including
-- the ones classified as no gap at all).
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

ALTER TABLE graph_edges DROP CONSTRAINT IF EXISTS graph_edges_edge_type_check;
ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_edge_type_check
    CHECK (edge_type IN (
        'produced',        -- event -> document/item it resulted in
        'caused_by',       -- event -> the event that caused it
        'escalated_via',   -- retired by 013's rebuild, kept legal
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
        'received_by',     -- event(incident) -> who it was escalated to
        'member_of',       -- person -> organization(department)
        'leads',           -- person -> organization(department)
        'belongs_to',      -- item(domain) -> organization(department)
        'updates_domain'   -- document -> item(domain), from confluence_created.domains_updated
    ));

COMMIT;
