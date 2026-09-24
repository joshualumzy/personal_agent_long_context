#!/usr/bin/env python3
"""
Build graph① — the DETERMINISTIC property graph — directly from the already
ingested OrgForge relational core, with zero LLM calls.

It reads `documents` / `actors` / `document_actors` (populated by
ingest_orgforge.py) plus each document's `artifact_ids` cross-references, and
writes:

  • graph_nodes  — one node per document and per actor
  • graph_edges  — 'references' (doc -> doc, from artifact_ids)
                   'involves'   (doc -> actor, from the actors list)

Design decisions (grounded in the real data, see docs/OrgForge_Ingestion_Progress.md):
  • artifact_ids values are mostly single strings, sometimes lists. We only
    create a 'references' edge when the referenced id RESOLVES to an existing
    documents.doc_id. Path-like / external keys (eml_path, slack_path,
    artifact_path, embed_id, source_email, ...) point at export files, not
    documents, so they never resolve and are correctly skipped — no dangling
    edges.
  • dept / tags are NOT turned into edges here. They stay queryable as node
    props and on the documents row; folding them into 'about_domain' would
    conflate them with the real knowledge domains from domain_registry.json.
  • Idempotent: nodes upsert on (node_type, ref_id); edges on
    (src_node_id, dst_node_id, edge_type). Re-running does not duplicate.

This graph lives ENTIRELY in Postgres. Traversal is done with recursive CTEs
(see the retrieval module / schema SECTION 4) — no external graph database.

Usage
-----
    PGDATABASE=orgforge python3 build_graph.py
    PGDATABASE=orgforge python3 build_graph.py --reset   # clear graph first
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import psycopg2
import psycopg2.extras

# artifact_ids keys whose values are file paths or external identifiers rather
# than document ids. Listed for documentation; the resolver skips anything that
# is not a known doc_id anyway, so this is a fast-path filter, not the guard.
NON_DOC_REFERENCE_KEYS = {
    "eml_path", "slack_path", "artifact_path", "embed_id", "source_email",
}


def connect(dsn: Optional[str]):
    if dsn:
        return psycopg2.connect(dsn)
    return psycopg2.connect(dbname=os.environ.get("PGDATABASE", "orgforge"))


def reset_graph(cur) -> None:
    # edges reference nodes; TRUNCATE both, restart identities.
    cur.execute("TRUNCATE graph_edges, graph_nodes RESTART IDENTITY CASCADE")


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------
def build_document_nodes(cur) -> int:
    """One graph node per document. props carries the fields the front-end /
    scheduler wants without a join back to documents."""
    cur.execute(
        """
        INSERT INTO graph_nodes (node_type, ref_id, label, props)
        SELECT
            'document',
            d.document_id,
            coalesce(nullif(d.title, ''), d.doc_id),
            jsonb_build_object(
                'doc_id',      d.doc_id,
                'doc_type',    d.doc_type,
                'category',    d.category,
                'sim_day',     d.sim_day,
                'dept',        d.dept,
                'is_incident', d.is_incident,
                'is_external', d.is_external,
                'tags',        d.tags
            )
        FROM documents d
        ON CONFLICT (node_type, ref_id) DO UPDATE SET
            label = EXCLUDED.label,
            props = EXCLUDED.props
        """
    )
    return cur.rowcount


def build_actor_nodes(cur) -> int:
    cur.execute(
        """
        INSERT INTO graph_nodes (node_type, ref_id, label, props)
        SELECT
            'actor',
            a.actor_id,
            a.name,
            jsonb_build_object(
                'name',       a.name,
                'role',       a.role,
                'dept',       a.dept,
                'actor_kind', a.actor_kind
            )
        FROM actors a
        ON CONFLICT (node_type, ref_id) DO UPDATE SET
            label = EXCLUDED.label,
            props = EXCLUDED.props
        """
    )
    return cur.rowcount


# ---------------------------------------------------------------------------
# Edges
# ---------------------------------------------------------------------------
def build_involves_edges(cur) -> int:
    """doc -> actor, straight from the normalized document_actors junction."""
    cur.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type, props)
        SELECT dn.node_id, an.node_id, 'involves', '{}'::jsonb
        FROM document_actors da
        JOIN graph_nodes dn ON dn.node_type = 'document' AND dn.ref_id = da.document_id
        JOIN graph_nodes an ON an.node_type = 'actor'    AND an.ref_id = da.actor_id
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cur.rowcount


def build_reference_edges(cur) -> int:
    """doc -> doc from artifact_ids, only where the target resolves to an
    existing documents.doc_id. Values may be a string or a list of strings.

    We do the resolution in SQL: expand artifact_ids into (source_doc, target
    doc_id) pairs, join to documents on both ends, insert the edge. Building
    the pair set in Python keeps the JSONB expansion explicit and easy to read.
    """
    # 1. Pull every (source document_id, referenced_id_string) pair.
    cur.execute("SELECT document_id, artifact_ids FROM documents")
    rows = cur.fetchall()

    doc_id_to_pk: dict[str, int] = {}
    cur.execute("SELECT doc_id, document_id FROM documents")
    for doc_id, pk in cur.fetchall():
        doc_id_to_pk[doc_id] = pk

    pairs: set[tuple[int, int]] = set()
    for src_pk, artifact_ids in rows:
        if not artifact_ids:
            continue
        # artifact_ids comes back as a dict (JSONB). Be defensive anyway.
        if isinstance(artifact_ids, str):
            try:
                artifact_ids = json.loads(artifact_ids)
            except (ValueError, TypeError):
                continue
        if not isinstance(artifact_ids, dict):
            continue
        for key, value in artifact_ids.items():
            if key in NON_DOC_REFERENCE_KEYS:
                continue
            targets = value if isinstance(value, list) else [value]
            for target in targets:
                if not isinstance(target, str) or not target.strip():
                    continue
                dst_pk = doc_id_to_pk.get(target.strip())
                if dst_pk is None or dst_pk == src_pk:  # skip unresolved + self
                    continue
                pairs.add((src_pk, dst_pk))

    if not pairs:
        return 0

    # 2. Map document_id -> node_id for both ends and insert edges in bulk.
    cur.execute(
        "SELECT ref_id, node_id FROM graph_nodes WHERE node_type = 'document'"
    )
    doc_pk_to_node = {ref_id: node_id for ref_id, node_id in cur.fetchall()}

    edge_rows = []
    for src_pk, dst_pk in pairs:
        s = doc_pk_to_node.get(src_pk)
        d = doc_pk_to_node.get(dst_pk)
        if s is not None and d is not None:
            edge_rows.append((s, d, "references"))

    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        VALUES %s
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """,
        edge_rows,
        page_size=1000,
    )
    return len(edge_rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", help="libpq DSN; defaults to dbname=orgforge")
    ap.add_argument("--reset", action="store_true",
                    help="TRUNCATE graph_nodes/graph_edges before building")
    args = ap.parse_args()

    conn = connect(args.dsn)
    try:
        with conn:
            with conn.cursor() as cur:
                if args.reset:
                    reset_graph(cur)
                    print("graph cleared.", file=sys.stderr)

                doc_nodes = build_document_nodes(cur)
                actor_nodes = build_actor_nodes(cur)
                print(f"document nodes upserted: {doc_nodes}", file=sys.stderr)
                print(f"actor nodes upserted:    {actor_nodes}", file=sys.stderr)

                involves = build_involves_edges(cur)
                references = build_reference_edges(cur)
                print(f"involves edges inserted:   {involves}", file=sys.stderr)
                print(f"references edges inserted:  {references}", file=sys.stderr)

                cur.execute("SELECT count(*) FROM graph_nodes")
                n_nodes = cur.fetchone()[0]
                cur.execute("SELECT count(*) FROM graph_edges")
                n_edges = cur.fetchone()[0]
                print(f"\ntotal graph_nodes: {n_nodes}", file=sys.stderr)
                print(f"total graph_edges: {n_edges}", file=sys.stderr)
    finally:
        conn.close()

    print("done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
