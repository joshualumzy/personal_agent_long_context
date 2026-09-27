-- Cut over: drop the transitional 'actor'/'references' values that migration
-- 009 kept legal only so the old graph would not fail validation while
-- build_graph.py was being rewritten.
--
-- build_graph.py has since been rewritten (rebuilt with --reset) and re-run
-- multiple times across tasks 4-9, and zero rows have used 'actor' or
-- 'references' since that first rebuild — verified directly before writing
-- this migration:
--   SELECT node_type, count(*) FROM graph_nodes GROUP BY 1;
--     -> document 479, event 1932, item 386, organization 7, person 66
--   SELECT edge_type, count(*) FROM graph_edges GROUP BY 1;
--     -> caused_by 10, documented_by 1, escalated_via 12, involves 8154,
--        owns_domain 20, produced 1608
-- Neither list contains the old values, so tightening the CHECK now validates
-- cleanly against every existing row — the same validate-on-ALTER behavior
-- that made 009 keep them in the first place (a CHECK is checked against
-- every row the instant it is added, not just future inserts).
--
-- about_domain and authored_by are declared in the taxonomy but have zero
-- edges in this corpus (about_domain: incidents.root_domain was deliberately
-- left NULL rather than guessed from root_cause prose; authored_by: no
-- verified field to build it from yet). Both stay legal values — being
-- unused is not the same as being wrong, and dropping them would just
-- reintroduce the same problem this migration is fixing if either gets
-- populated later.
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

ALTER TABLE graph_nodes DROP CONSTRAINT IF EXISTS graph_nodes_node_type_check;
ALTER TABLE graph_nodes ADD CONSTRAINT graph_nodes_node_type_check
    CHECK (node_type IN (
        'person', 'organization', 'item', 'event', 'document'
    ));

ALTER TABLE graph_edges DROP CONSTRAINT IF EXISTS graph_edges_edge_type_check;
ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_edge_type_check
    CHECK (edge_type IN (
        'produced',
        'caused_by',
        'escalated_via',
        'documented_by',
        'involves',
        'about_domain',
        'owns_domain',
        'authored_by'
    ));

COMMIT;
