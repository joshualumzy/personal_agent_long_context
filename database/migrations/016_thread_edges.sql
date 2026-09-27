-- Connect incidents and tickets to the work that followed from them.
--
-- facts.causal_chain (4,837 rows) is not a chain of events. It is an
-- artifact's thread, repeated and extended on every later row: a ticket, its
-- comments, the PR that closed it, the page that wrote it up —
--   ["ENG-104", "ENG-104_comment_1", ..., "PR-108", "ENG-104_comment_5"]
--   ["ENG-112", <nine slack alerts>, "ENG-112_comment_1", "PR-106", ..., "CONF-ENG-054"]
-- Comments and slack messages are not graph nodes; the ticket, PR and page
-- are. So the edges this migration allows are read off a thread rooted at a
-- ticket, between its root and the graph nodes later in it:
--
--   tracked_in      event(incident) -> item(jira) with the incident's own key
--   fixed_by        event(incident) -> item(pr) in the incident's thread
--   implemented_by  item(jira) -> item(pr) in the ticket's thread
--   documented_by   item(jira) -> document in the ticket's thread (already
--                   legal: "the document recording it")
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
        'updates_domain',  -- document -> item(domain), from confluence_created.domains_updated
        'tracked_in',      -- event(incident) -> item(jira) it was tracked in
        'fixed_by',        -- event(incident) -> item(pr) in its resolution thread
        'implemented_by'   -- item(jira) -> item(pr) in the ticket's own thread
    ));

COMMIT;
