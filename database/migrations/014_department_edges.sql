-- Give departments a place in the graph.
--
-- A department was only ever a string: graph_nodes.props->>'dept' on a person
-- (null for 49 of 54 person nodes, because actors.dept is almost never
-- filled) and source_documents.department on a row. No node stood for a
-- department, so the org structure could not be drawn, and the nearest thing
-- to one — 420 dept_plan_created events, one per department per day — is a
-- day's plan, not a department.
--
-- The corpus states membership outright: every dept_plan_created row lists the
-- department's people in facts.engineer_plans[] and names its lead in
-- facts.lead, every day for 60 days. Each person appears under exactly one
-- department, and the days they appear match employee_hired /
-- employee_departed (Janice from day 7, Jordan until day 11, ...), so
-- membership is read from there with its first and last day rather than
-- guessed from which documents a person's name turns up in.
--
-- Departments are organization nodes (subtype 'department'), beside the
-- customer and vendor organizations; node_subtype is free text, so no CHECK
-- changes for the node. Three edge types are new:
--   member_of   person -> organization(department), props first_day/last_day
--   leads       person -> organization(department), props first_day/last_day
--   belongs_to  item(domain) -> organization(department), from domains.dept
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
        'belongs_to'       -- item(domain) -> organization(department)
    ));

COMMIT;
