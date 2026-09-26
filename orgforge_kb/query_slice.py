#!/usr/bin/env python3
"""Choose the slice of the corpus that one question is about.

Emergent memory is built per question, not over the whole corpus: extracting a
graph from 4,988 artifacts with a language model would be slow and expensive,
and almost all of it would be irrelevant to whatever was asked. So a question
first selects a small slice, and only that slice is handed to the extractor.

A slice is grown in three ways, each of which works without being able to embed
the question itself — this machine cannot reach Bedrock, so query-side vectors
are unavailable, but stored document vectors are not:

seeds        full-text search over artifact chunks
graph        the seeds' direct cross-references, plus the artifacts that share a
             cause with them (through the simulation event that produced them,
             which is traversed and never returned)
semantic     the stored vectors nearest to the seeds' own vectors, which is
             document-to-document similarity and needs no query vector

Every document carries `why`, listing which of the three found it. Nothing that
is not an employee-visible artifact can enter a slice.

Usage
-----
    DATABASE_URL=... python3 query_slice.py "why did the TiDB migration slip?"
    DATABASE_URL=... python3 query_slice.py "cost tagging" --seeds 4 --graph 6 --semantic 6
    DATABASE_URL=... python3 query_slice.py "..." --bodies -o slice.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

import psycopg

# Guard rails. A slice is meant to be small: it is about to be read by a
# language model, and cost scales with what goes in.
MAX_DOCUMENTS = 60
EXCERPT = 1_800


def find_seeds(cursor, query: str, limit: int) -> tuple[list[str], str]:
    """Best-matching artifacts by full-text search.

    Two passes. The first requires every term, which is precise but brittle
    against a real question: "why did the TiDB migration slip" asks for three
    terms in one chunk and finds nothing. The second pass rewrites the same
    query to accept any term, which recovers the question at the cost of some
    precision — acceptable, because the graph and similarity passes are what
    give the slice its shape, and these seeds only have to land in the right
    neighbourhood.

    Ranked per document rather than per chunk, so one long document with several
    matching chunks does not crowd out everything else.
    """
    statement = """
        WITH asked AS (SELECT {expression} AS query),
        ranked AS (
            SELECT c.source_id,
                   max(ts_rank_cd(c.search_vector, asked.query)) AS score
            FROM document_chunks c CROSS JOIN asked
            WHERE c.search_vector @@ asked.query
            GROUP BY c.source_id
        )
        SELECT r.source_id
        FROM ranked r JOIN source_documents d USING (source_id)
        WHERE d.category = 'artifact'
        ORDER BY r.score DESC
        LIMIT %s
    """
    # Rewriting the parsed query's '&' operators to '|' turns "all of these
    # terms" into "any of these terms" without having to tokenize by hand.
    attempts = [
        ("all terms", "websearch_to_tsquery('english', %s)"),
        ("any term",
         "to_tsquery('english', replace(plainto_tsquery('english', %s)::text, '&', '|'))"),
    ]
    for label, expression in attempts:
        cursor.execute(statement.format(expression=expression), (query, limit))
        found = [row[0] for row in cursor.fetchall()]
        if found:
            return found, label
    return [], "no match"



def expand_by_graph(cursor, seeds: list[str], limit: int) -> list[str]:
    """Directly linked artifacts, plus artifacts that share a cause.

    The second kind matters more than it sounds: links run overwhelmingly from a
    simulation event to the artifacts it produced, so a ticket and the call it
    came out of are siblings under one event rather than neighbours. The event is
    only stepped through.
    """
    if not seeds:
        return []
    cursor.execute(
        """
        WITH seed_nodes AS (
            SELECT node_id FROM graph_nodes
            WHERE node_type = 'document' AND ref_key = ANY(%s::text[])
        ),
        direct AS (
            SELECT e.dst_node_id AS node_id
            FROM graph_edges e JOIN seed_nodes s ON e.src_node_id = s.node_id
            WHERE e.edge_type = 'references'
            UNION
            SELECT e.src_node_id
            FROM graph_edges e JOIN seed_nodes s ON e.dst_node_id = s.node_id
            WHERE e.edge_type = 'references'
        ),
        causes AS (
            SELECT e.src_node_id AS node_id
            FROM graph_edges e JOIN seed_nodes s ON e.dst_node_id = s.node_id
            WHERE e.edge_type = 'references'
        ),
        siblings AS (
            SELECT e.dst_node_id AS node_id
            FROM graph_edges e JOIN causes c ON e.src_node_id = c.node_id
            WHERE e.edge_type = 'references'
        ),
        reached AS (
            SELECT node_id FROM direct UNION SELECT node_id FROM siblings
        )
        SELECT DISTINCT n.ref_key
        FROM reached r
        JOIN graph_nodes n ON n.node_id = r.node_id AND n.node_type = 'document'
        JOIN source_documents d ON d.source_id = n.ref_key
        WHERE d.category = 'artifact'
          AND NOT (n.ref_key = ANY(%s::text[]))
        ORDER BY n.ref_key
        LIMIT %s
        """,
        (seeds, seeds, limit),
    )
    return [row[0] for row in cursor.fetchall()]


def expand_by_similarity(cursor, seeds: list[str], exclude: list[str],
                         limit: int) -> list[str]:
    """Artifacts whose stored vectors sit nearest the seeds' own vectors.

    Document-to-document similarity, so no vector has to be produced for the
    question. This reaches material that shares no wording and no link with the
    seeds, which is exactly what full-text search and the graph both miss.
    """
    if not seeds:
        return []
    cursor.execute(
        """
        WITH seed_vectors AS (
            SELECT embedding FROM document_chunks
            WHERE source_id = ANY(%s::text[]) AND embedding IS NOT NULL
        ),
        scored AS (
            SELECT c.source_id, min(c.embedding <=> v.embedding) AS distance
            FROM document_chunks c CROSS JOIN seed_vectors v
            WHERE c.embedding IS NOT NULL
            GROUP BY c.source_id
        )
        SELECT s.source_id
        FROM scored s JOIN source_documents d USING (source_id)
        WHERE d.category = 'artifact'
          AND NOT (s.source_id = ANY(%s::text[]))
        ORDER BY s.distance
        LIMIT %s
        """,
        (seeds, exclude, limit),
    )
    return [row[0] for row in cursor.fetchall()]


def fetch_documents(cursor, source_ids: list[str],
                    full_bodies: bool) -> list[dict[str, Any]]:
    if not source_ids:
        return []
    column = "d.body" if full_bodies else f"left(d.body, {EXCERPT})"
    cursor.execute(
        f"""
        SELECT d.source_id, d.source_type, d.title, {column} AS text,
               d.occurred_at, d.department, d.is_incident
        FROM source_documents d
        WHERE d.source_id = ANY(%s::text[]) AND d.category = 'artifact'
        ORDER BY d.occurred_at NULLS LAST, d.source_id
        """,
        (source_ids,),
    )
    documents = []
    for source_id, source_type, title, text, occurred_at, department, incident in cursor.fetchall():
        documents.append({
            "source_id": source_id,
            "source_type": source_type,
            "title": title or source_id,
            "text": text or "",
            "occurred_at": occurred_at.isoformat() if occurred_at else None,
            "department": department,
            "is_incident": incident,
        })
    return documents


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("question", help="the question this slice is for")
    parser.add_argument("--seeds", type=int, default=4,
                        help="how many full-text hits to start from (default: 4)")
    parser.add_argument("--graph", type=int, default=8,
                        help="cap on graph-reached artifacts (default: 8)")
    parser.add_argument("--semantic", type=int, default=6,
                        help="cap on similarity-reached artifacts (default: 6)")
    parser.add_argument("--bodies", action="store_true",
                        help="include full document bodies instead of excerpts")
    parser.add_argument("-o", "--output", help="write here instead of stdout")
    arguments = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required.")

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            seeds, match_mode = find_seeds(cursor, arguments.question, arguments.seeds)
            if not seeds:
                raise SystemExit(
                    "Full-text search matched nothing, even accepting any single "
                    "term, so there is no slice to build. Try different wording."
                )

            graph_reached = expand_by_graph(cursor, seeds, arguments.graph)
            similar = expand_by_similarity(
                cursor, seeds, seeds + graph_reached, arguments.semantic
            )

            why: dict[str, list[str]] = {}
            for source_id in seeds:
                why.setdefault(source_id, []).append("seed")
            for source_id in graph_reached:
                why.setdefault(source_id, []).append("graph")
            for source_id in similar:
                why.setdefault(source_id, []).append("semantic")

            selected = list(why)
            if len(selected) > MAX_DOCUMENTS:
                raise SystemExit(
                    f"Slice reached {len(selected)} documents, over the "
                    f"{MAX_DOCUMENTS} cap. Lower --graph or --semantic."
                )

            documents = fetch_documents(cursor, selected, arguments.bodies)

    for document in documents:
        document["why"] = why[document["source_id"]]

    slice_payload = {
        "question": arguments.question,
        "documents": documents,
        "meta": {
            "seeds": seeds,
            "seed_match": match_mode,
            "counts": {
                "seed": len(seeds),
                "graph": len(graph_reached),
                "semantic": len(similar),
                "total": len(documents),
            },
            "characters": sum(len(d["text"]) for d in documents),
            "full_bodies": arguments.bodies,
        },
    }

    payload = json.dumps(slice_payload, indent=2, ensure_ascii=False)
    if arguments.output:
        with open(arguments.output, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        print(f"Wrote {len(documents)} documents "
              f"({slice_payload['meta']['characters']} characters) to "
              f"{arguments.output}.", file=sys.stderr)
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
