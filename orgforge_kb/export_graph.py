#!/usr/bin/env python3
"""Export a slice of the deterministic graph as JSON.

The whole graph is far too large to render — 22,606 nodes and 58,366 edges — so
every export is a slice. Two ways to choose one:

``--seed SOURCE_ID``
    Walk the causal chain outward from one document and export what it reaches.
    This is the view that shows how an incident, ticket or sprint actually
    unfolded, and it is bounded by ``--depth``.

``--category`` / ``--source-type`` / ``--department`` / ``--incidents-only``
    Export a filtered set of documents and every edge between them. Useful for
    "all incident artifacts" or "everything Engineering_Backend touched".

Output is a single JSON object::

    {"nodes": [{"id", "type", "label", ...props}],
     "edges": [{"source", "target", "type", ...props}],
     "meta":  {...how this slice was chosen...}}

Node ids are the natural keys already used in the database, so a document id is
its ``source_id`` and an actor id is the actor's name. The shape feeds a
force-directed front end (vis.js, D3, Cytoscape) directly, and is a reasonable
interchange format for loading the same slice into a graph database.

Usage
-----
    DATABASE_URL=... python3 export_graph.py --seed EVT-1-sprint_planned-49 --depth 3
    DATABASE_URL=... python3 export_graph.py --incidents-only --include-actors
    DATABASE_URL=... python3 export_graph.py --category artifact --limit 300 -o graph.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Optional

import psycopg

# Reads the repository's .env, so DATABASE_URL and the LLM settings do not
# have to be exported by hand. Must precede any use of os.environ.
import _env  # noqa: F401  (imported for its side effect)

# A force-directed layout stops being readable well before this, and the browser
# stops being responsive not long after. Refuse rather than emit a useless file.
MAX_NODES = 5_000


def seed_slice(cursor, seed: str, depth: int) -> list[int]:
    """Node ids reachable from one document along 'references', within depth.

    Cycle-guarded by carrying the visited path, which the corpus needs: chains
    can loop back when two artifacts cite each other.
    """
    cursor.execute(
        """
        WITH RECURSIVE chain AS (
            SELECT node_id, 0 AS depth, ARRAY[node_id] AS path
            FROM graph_nodes
            WHERE node_type = 'document' AND ref_key = %s
          UNION ALL
            SELECT e.dst_node_id, c.depth + 1, c.path || e.dst_node_id
            FROM chain c
            JOIN graph_edges e ON e.src_node_id = c.node_id
                               AND e.edge_type = 'references'
            WHERE c.depth < %s AND NOT e.dst_node_id = ANY(c.path)
        )
        SELECT DISTINCT node_id FROM chain
        """,
        (seed, depth),
    )
    return [row[0] for row in cursor.fetchall()]


def filtered_slice(cursor, category: Optional[str], source_type: Optional[str],
                   department: Optional[str], incidents_only: bool,
                   limit: int) -> list[int]:
    """Document node ids matching the given filters.

    The filters read from graph_nodes.props, which build_graph.py denormalized
    for exactly this reason: no join back to source_documents is needed.
    """
    conditions = ["node_type = 'document'"]
    parameters: list[Any] = []

    if category:
        conditions.append("props->>'category' = %s")
        parameters.append(category)
    if source_type:
        conditions.append("props->>'source_type' = %s")
        parameters.append(source_type)
    if department:
        conditions.append("props->>'department' = %s")
        parameters.append(department)
    if incidents_only:
        conditions.append("(props->>'is_incident')::boolean")

    parameters.append(limit)
    cursor.execute(
        f"""
        SELECT node_id FROM graph_nodes
        WHERE {' AND '.join(conditions)}
        ORDER BY props->>'simulation_day' NULLS LAST, ref_key
        LIMIT %s
        """,
        parameters,
    )
    return [row[0] for row in cursor.fetchall()]


def attached_actors(cursor, node_ids: list[int]) -> list[int]:
    """Actor nodes involved in any of the given documents."""
    if not node_ids:
        return []
    cursor.execute(
        """
        SELECT DISTINCT e.dst_node_id
        FROM graph_edges e
        JOIN graph_nodes n ON n.node_id = e.dst_node_id
        WHERE e.src_node_id = ANY(%s) AND e.edge_type = 'involves'
        """,
        (node_ids,),
    )
    return [row[0] for row in cursor.fetchall()]


def fetch_nodes(cursor, node_ids: list[int]) -> list[dict[str, Any]]:
    if not node_ids:
        return []
    cursor.execute(
        """
        SELECT node_id, node_type, ref_key, label, props
        FROM graph_nodes WHERE node_id = ANY(%s)
        """,
        (node_ids,),
    )
    nodes = []
    for _, node_type, ref_key, label, props in cursor.fetchall():
        node = {"id": ref_key, "type": node_type, "label": label}
        node.update(props or {})
        nodes.append(node)
    return nodes


def fetch_edges(cursor, node_ids: list[int]) -> list[dict[str, Any]]:
    """Every edge whose both endpoints are inside the slice.

    Keeping both ends inside is what makes the result self-contained: a front
    end never receives an edge pointing at a node it was not given.
    """
    if not node_ids:
        return []
    cursor.execute(
        """
        SELECT s.ref_key, t.ref_key, e.edge_type, e.weight, e.props
        FROM graph_edges e
        JOIN graph_nodes s ON s.node_id = e.src_node_id
        JOIN graph_nodes t ON t.node_id = e.dst_node_id
        WHERE e.src_node_id = ANY(%s) AND e.dst_node_id = ANY(%s)
        """,
        (node_ids, node_ids),
    )
    edges = []
    for source, target, edge_type, weight, props in cursor.fetchall():
        edge = {"source": source, "target": target, "type": edge_type}
        if weight is not None:
            edge["weight"] = weight
        edge.update(props or {})
        edges.append(edge)
    return edges


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--seed", help="export the causal chain from this source_id")
    parser.add_argument("--depth", type=int, default=3,
                        help="how far to walk from --seed (default: 3)")
    parser.add_argument("--category", choices=["artifact", "sim_event", "sim_config"])
    parser.add_argument("--source-type", help="e.g. jira, slack, confluence")
    parser.add_argument("--department")
    parser.add_argument("--incidents-only", action="store_true")
    parser.add_argument("--include-actors", action="store_true",
                        help="also export the actors involved, and their edges")
    parser.add_argument("--limit", type=int, default=500,
                        help="cap on documents when filtering (default: 500)")
    parser.add_argument("-o", "--output", help="write here instead of stdout")
    arguments = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required.")

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            if arguments.seed:
                document_ids = seed_slice(cursor, arguments.seed, arguments.depth)
                if not document_ids:
                    raise SystemExit(
                        f"No document node for source_id {arguments.seed!r}."
                    )
                selection = {"seed": arguments.seed, "depth": arguments.depth}
            else:
                document_ids = filtered_slice(
                    cursor, arguments.category, arguments.source_type,
                    arguments.department, arguments.incidents_only, arguments.limit,
                )
                selection = {
                    "category": arguments.category,
                    "source_type": arguments.source_type,
                    "department": arguments.department,
                    "incidents_only": arguments.incidents_only,
                    "limit": arguments.limit,
                }

            node_ids = list(document_ids)
            if arguments.include_actors:
                node_ids += attached_actors(cursor, document_ids)
            node_ids = list(dict.fromkeys(node_ids))

            if len(node_ids) > MAX_NODES:
                raise SystemExit(
                    f"Slice has {len(node_ids)} nodes, over the {MAX_NODES} cap. "
                    "Narrow it with --depth, --limit or a filter."
                )

            nodes = fetch_nodes(cursor, node_ids)
            edges = fetch_edges(cursor, node_ids)

    graph = {
        "nodes": nodes,
        "edges": edges,
        "meta": {
            "selection": {k: v for k, v in selection.items() if v not in (None, False)},
            "includes_actors": arguments.include_actors,
            "node_count": len(nodes),
            "edge_count": len(edges),
        },
    }

    payload = json.dumps(graph, indent=2, ensure_ascii=False, default=str)
    if arguments.output:
        with open(arguments.output, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        print(f"Wrote {len(nodes)} nodes and {len(edges)} edges to "
              f"{arguments.output}.", file=sys.stderr)
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
