#!/usr/bin/env python3
"""
Verify an OrgForge ingestion and demonstrate a top-k vector RAG query.

    python verify_kb.py                       # counts only
    python verify_kb.py --query "TitanDB incident postmortem" --embeddings hash
    python verify_kb.py --query "..." --embeddings bedrock --as-of-day 30

The --query path embeds the query text with the SAME backend used at ingest
time (embeddings must share a model to be comparable) and runs the schema's
documented RAG query: nearest bodies by cosine distance, optionally filtered
to documents visible on/before a given sim day.
"""
from __future__ import annotations

import argparse
import os
import sys

import psycopg2

# Reuse the embedders and helpers from the ingestion module.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ingest_orgforge import make_embedder, vector_literal, BedrockTitanEmbedder  # noqa: E402


COUNT_QUERIES = {
    "actors": "SELECT count(*) FROM actors",
    "documents": "SELECT count(*) FROM documents",
    "document_actors": "SELECT count(*) FROM document_actors",
    "document_embeddings": "SELECT count(*) FROM document_embeddings",
}


def connect(dsn):
    if dsn:
        return psycopg2.connect(dsn)
    return psycopg2.connect(dbname=os.environ.get("PGDATABASE", "orgforge"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn")
    ap.add_argument("--query", help="run a top-k vector search for this text")
    ap.add_argument("--embeddings", choices=["hash", "bedrock"], default="hash")
    ap.add_argument("--region")
    ap.add_argument("--as-of-day", type=int, default=None,
                    help="only retrieve docs with sim_day <= this")
    ap.add_argument("-k", type=int, default=8)
    args = ap.parse_args()

    conn = connect(args.dsn)
    try:
        with conn.cursor() as cur:
            print("=== row counts ===")
            for label, q in COUNT_QUERIES.items():
                cur.execute(q)
                print(f"  {label:22} {cur.fetchone()[0]}")

            cur.execute("""
                SELECT category, count(*) FROM documents GROUP BY category ORDER BY 2 DESC
            """)
            print("=== documents by category ===")
            for cat, n in cur.fetchall():
                print(f"  {cat:12} {n}")

            if not args.query:
                return 0

            embedder = (BedrockTitanEmbedder(region=args.region)
                        if args.embeddings == "bedrock" and args.region
                        else make_embedder(args.embeddings))
            qvec = vector_literal(embedder.embed(args.query))

            print(f"\n=== top-{args.k} for: {args.query!r} "
                  f"(backend={args.embeddings}"
                  f"{', as_of_day<=%d' % args.as_of_day if args.as_of_day is not None else ''}) ===")
            if args.as_of_day is not None:
                cur.execute(
                    """
                    SELECT d.doc_id, d.doc_type, d.sim_day,
                           left(coalesce(d.title,''), 60) AS title,
                           e.embedding <=> %s::vector AS dist
                    FROM document_embeddings e
                    JOIN documents d USING (document_id)
                    WHERE d.sim_day <= %s
                    ORDER BY e.embedding <=> %s::vector
                    LIMIT %s
                    """,
                    (qvec, args.as_of_day, qvec, args.k),
                )
            else:
                cur.execute(
                    """
                    SELECT d.doc_id, d.doc_type, d.sim_day,
                           left(coalesce(d.title,''), 60) AS title,
                           e.embedding <=> %s::vector AS dist
                    FROM document_embeddings e
                    JOIN documents d USING (document_id)
                    ORDER BY e.embedding <=> %s::vector
                    LIMIT %s
                    """,
                    (qvec, qvec, args.k),
                )
            for doc_id, doc_type, sim_day, title, dist in cur.fetchall():
                print(f"  {dist:.4f}  {doc_id:28} {doc_type:22} d{sim_day}  {title}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
