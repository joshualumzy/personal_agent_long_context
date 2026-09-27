-- Make the document chain walkable, and say which graph nodes each piece of
-- evidence belongs to.
--
-- Who wrote a page was only reachable in two hops (person <- authored_by -
-- event - produced -> page), and only for the 219 pages a confluence_created
-- event names. Every page's own header states its author ("**Author:**
-- Nadia") — 473 of 479 pages, agreeing with the event on all 219 where both
-- exist, every name resolving to a known person. 'wrote' is person ->
-- document, direct.
--
-- Pages cite each other by id in their bodies ("Relevant Artifacts: -
-- CONF-ENG-314 ..."): 94 citations of pages that exist, across 66 pages.
-- 'cites' is document -> document. A chunk's reference to its parent
-- (facts.parent_id, 2 pages) is 'part_of' instead.
--
-- evidence_nodes is not part of the graph: it maps each employee-visible
-- artifact — including the ~4,100 slack messages, emails, transcripts and
-- alerts that are not graph nodes — to the nodes it belongs to, so a question
-- whose best evidence is a slack thread can be placed on the graph. `via`
-- names the field that said so. Rebuilt by build_graph.py with the graph;
-- graph_nodes' ON DELETE CASCADE clears it on --reset.
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
        'implemented_by',  -- item(jira) -> item(pr) in the ticket's own thread
        'for_customer',    -- item/event -> organization(customer) it is for
        'from_vendor',     -- item(jira) -> organization(vendor) whose email opened it
        'contact_for',     -- person(external_contact) -> organization they write for
        'wrote',           -- person -> document they are the author of
        'cites',           -- document -> document its body names by id
        'part_of'          -- document(chunk) -> document(parent page)
    ));


CREATE TABLE IF NOT EXISTS evidence_nodes (
    source_id TEXT   NOT NULL REFERENCES source_documents(source_id) ON DELETE CASCADE,
    node_id   BIGINT NOT NULL REFERENCES graph_nodes(node_id)       ON DELETE CASCADE,
    via       TEXT   NOT NULL CHECK (via IN (
                  'self',        -- the artifact is this node
                  'event',       -- a graph event's own links name the artifact
                  'link',        -- a document link joins it to an item/document node
                  'thread',      -- it is in a causal_chain thread rooted at this node
                  'organization',-- its facts name this customer/vendor
                  'department',  -- its department, or its slack channel's
                  'person'       -- its actors list names this person
              )),
    PRIMARY KEY (source_id, node_id, via)
);
CREATE INDEX IF NOT EXISTS evidence_nodes_node_idx ON evidence_nodes (node_id);

COMMIT;
