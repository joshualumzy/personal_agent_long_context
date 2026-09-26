#!/usr/bin/env python3
"""Build the deterministic property graph from the imported OrgForge corpus.

No language model is involved. Every node and edge comes from a field the corpus
already states, so the graph is exact and reproducible:

  graph_nodes   one node per document (``source_documents``) and per actor
  graph_edges   'references' document -> document, from ``document_links``
                'involves'   document -> actor,    from ``document_actors``

The graph spans the whole corpus, simulation events included, because their
causal chains are the point: they are what the scheduler orders work by, and
they are the export surface for the emergent-graph work. Retrieval stays
artifact-only and is unaffected by what lives here.

Traversal is plain SQL. A recursive CTE over 'references' walks a causal chain
forward from any seed document, depth-bounded and cycle-guarded:

    WITH RECURSIVE chain AS (
        SELECT node_id, label, 0 AS depth, ARRAY[node_id] AS path
        FROM graph_nodes WHERE node_type = 'document' AND ref_key = :seed
      UNION ALL
        SELECT e.dst_node_id, n.label, c.depth + 1, c.path || e.dst_node_id
        FROM chain c
        JOIN graph_edges e ON e.src_node_id = c.node_id
                           AND e.edge_type = 'references'
        JOIN graph_nodes n ON n.node_id = e.dst_node_id
        WHERE c.depth < 8 AND NOT e.dst_node_id = ANY(c.path)
    )
    SELECT DISTINCT node_id, label, depth FROM chain ORDER BY depth;

Nodes are keyed by their natural key, so ``ref_key`` is a ``source_id`` for a
document and a name for an actor. Re-running is safe: nodes upsert on
(node_type, ref_key) and edges on (src, dst, edge_type).

Usage
-----
    DATABASE_URL=postgresql://... python3 build_graph.py
    DATABASE_URL=postgresql://... python3 build_graph.py --reset
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg

# Reads the repository's .env, so DATABASE_URL and the LLM settings do not
# have to be exported by hand. Must precede any use of os.environ.
import _env  # noqa: F401  (imported for its side effect)


def reset_graph(cursor) -> None:
    cursor.execute("TRUNCATE graph_edges, graph_nodes RESTART IDENTITY CASCADE")


def build_document_nodes(cursor) -> int:
    """One node per document. props is denormalized so graph export and the
    front end need no joins."""
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, ref_key, label, props)
        SELECT
            'document',
            d.source_id,
            coalesce(nullif(d.title, ''), d.source_id),
            jsonb_build_object(
                'source_type',    d.source_type,
                'category',       d.category,
                'simulation_day', d.simulation_day,
                'department',     d.department,
                'is_incident',    d.is_incident,
                'is_external',    d.is_external,
                'tags',           d.tags
            )
        FROM source_documents d
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label,
            props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_actor_nodes(cursor) -> int:
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, ref_key, label, props)
        SELECT
            'actor',
            a.name,
            a.name,
            jsonb_build_object(
                'role',       a.role,
                'dept',       a.dept,
                'actor_kind', a.actor_kind
            )
        FROM actors a
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label,
            props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_involves_edges(cursor) -> int:
    """document -> actor, from the normalized junction."""
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT dn.node_id, an.node_id, 'involves'
        FROM document_actors da
        JOIN actors a       ON a.actor_id = da.actor_id
        JOIN graph_nodes dn ON dn.node_type = 'document' AND dn.ref_key = da.source_id
        JOIN graph_nodes an ON an.node_type = 'actor'    AND an.ref_key = a.name
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


def build_reference_edges(cursor) -> int:
    """document -> document, from the corpus cross-references.

    ``document_links`` also records links whose target is an export file path or
    an identifier with no document of its own. Joining both ends to
    ``graph_nodes`` drops those, so the graph never carries a dangling edge. The
    relationship type is kept in props: several types can connect the same pair,
    and the edge itself stays a single 'references' edge.
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type, props)
        SELECT
            sn.node_id,
            tn.node_id,
            'references',
            jsonb_build_object('relationship_types',
                               jsonb_agg(DISTINCT l.relationship_type))
        FROM document_links l
        JOIN graph_nodes sn ON sn.node_type = 'document' AND sn.ref_key = l.source_id
        JOIN graph_nodes tn ON tn.node_type = 'document' AND tn.ref_key = l.related_source_id
        WHERE l.source_id <> l.related_source_id
        GROUP BY sn.node_id, tn.node_id
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO UPDATE SET
            props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="empty graph_nodes and graph_edges before building",
    )
    arguments = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required.")

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            if arguments.reset:
                reset_graph(cursor)
                print("Cleared the existing graph.", file=sys.stderr)

            documents = build_document_nodes(cursor)
            actors = build_actor_nodes(cursor)
            print(f"Document nodes: {documents}", file=sys.stderr)
            print(f"Actor nodes:    {actors}", file=sys.stderr)

            involves = build_involves_edges(cursor)
            references = build_reference_edges(cursor)
            print(f"involves edges:   {involves}", file=sys.stderr)
            print(f"references edges: {references}", file=sys.stderr)

            cursor.execute("SELECT count(*) FROM graph_nodes")
            node_total = cursor.fetchone()[0]
            cursor.execute("SELECT count(*) FROM graph_edges")
            edge_total = cursor.fetchone()[0]
        connection.commit()

    print(f"\nGraph holds {node_total} nodes and {edge_total} edges.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
