#!/usr/bin/env python3
"""Copy Titan embeddings from the shared database into the local one.

The shared database holds vectors produced by Amazon Titan, which this machine
cannot generate: its AWS account is not allowlisted for Bedrock yet. The local
database holds the full corpus and the deterministic graph, which the shared one
does not. So rather than move development onto the shared database and lose the
causal layer, this pulls just the vectors across.

The shared database is only ever READ. Nothing is written to it, so this needs no
coordination with whoever else is using it.

Chunks are matched on ``(source_id, chunk_index)`` — the natural key. Matching on
``chunk_id`` would be wrong: it is an identity column, so the same chunk can hold
a different number in each database.

A row is only written when the text matches on both sides. A chunk whose content
differs has been chunked differently, and giving it the other side's vector would
describe text that is not there. Those are reported as mismatches, not copied.

Usage
-----
    # with the SSH tunnel open on port 5434
    SHARED_DATABASE_URL=postgresql://USER:PASS@localhost:5434/DBNAME \
    DATABASE_URL=postgresql://orgforge:orgforge-local@localhost:5433/orgforge \
    python3 sync_embeddings.py

    python3 sync_embeddings.py --dry-run   # report what would change, write nothing
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg

BATCH = 500


def fetch_shared(cursor) -> dict[tuple[str, int], tuple[str, str, str]]:
    """(source_id, chunk_index) -> (embedding, model, content) for embedded chunks.

    The vector comes back as its text form, which is exactly what the local
    insert needs to cast back with ``::vector``.
    """
    cursor.execute(
        """
        SELECT source_id, chunk_index, embedding::text, embedding_model, content
        FROM document_chunks
        WHERE embedding IS NOT NULL
        """
    )
    return {
        (source_id, chunk_index): (embedding, model, content)
        for source_id, chunk_index, embedding, model, content in cursor.fetchall()
    }


def fetch_local(cursor) -> dict[tuple[str, int], tuple[int, str, bool]]:
    """(source_id, chunk_index) -> (chunk_id, content, already_embedded)."""
    cursor.execute(
        """
        SELECT source_id, chunk_index, chunk_id, content, embedding IS NOT NULL
        FROM document_chunks
        """
    )
    return {
        (source_id, chunk_index): (chunk_id, content, embedded)
        for source_id, chunk_index, chunk_id, content, embedded in cursor.fetchall()
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="report the comparison and write nothing")
    parser.add_argument("--overwrite", action="store_true",
                        help="also replace vectors the local database already has")
    arguments = parser.parse_args()

    local_url = os.environ.get("DATABASE_URL")
    shared_url = os.environ.get("SHARED_DATABASE_URL")
    if not local_url:
        raise RuntimeError("DATABASE_URL (the local database) is required.")
    if not shared_url:
        raise RuntimeError(
            "SHARED_DATABASE_URL is required. Open the SSH tunnel first, then point "
            "it at the forwarded port."
        )
    if local_url == shared_url:
        raise RuntimeError("Both URLs point at the same database; nothing to copy.")

    with psycopg.connect(shared_url) as shared_connection:
        with shared_connection.cursor() as cursor:
            cursor.execute("SELECT current_database(), count(*) FROM document_chunks")
            shared_name, shared_chunks = cursor.fetchone()
            shared = fetch_shared(cursor)
    print(f"shared:  {shared_name} — {shared_chunks} chunks, "
          f"{len(shared)} embedded", file=sys.stderr)

    with psycopg.connect(local_url) as local_connection:
        with local_connection.cursor() as cursor:
            cursor.execute("SELECT current_database(), count(*) FROM document_chunks")
            local_name, local_chunks = cursor.fetchone()
            local = fetch_local(cursor)
            print(f"local:   {local_name} — {local_chunks} chunks, "
                  f"{sum(1 for v in local.values() if v[2])} embedded",
                  file=sys.stderr)

            copyable: list[tuple[str, str, int]] = []
            text_mismatch: list[tuple[str, int]] = []
            already: list[tuple[str, int]] = []

            for key, (chunk_id, local_content, embedded) in local.items():
                match = shared.get(key)
                if match is None:
                    continue
                embedding, model, shared_content = match
                if local_content != shared_content:
                    text_mismatch.append(key)
                    continue
                if embedded and not arguments.overwrite:
                    already.append(key)
                    continue
                copyable.append((embedding, model, chunk_id))

            missing_locally = len(set(shared) - set(local))
            absent_in_shared = sum(
                1 for key in local if key not in shared
            )

            print("", file=sys.stderr)
            print(f"matched and copyable:        {len(copyable)}", file=sys.stderr)
            print(f"already embedded locally:    {len(already)}"
                  f"{' (use --overwrite to replace)' if already else ''}",
                  file=sys.stderr)
            print(f"text differs, skipped:       {len(text_mismatch)}", file=sys.stderr)
            print(f"local chunks not in shared:  {absent_in_shared}", file=sys.stderr)
            print(f"shared chunks not in local:  {missing_locally}", file=sys.stderr)

            if text_mismatch:
                print("\n  differing chunks (first 5): "
                      + ", ".join(f"{s}#{i}" for s, i in text_mismatch[:5]),
                      file=sys.stderr)

            if arguments.dry_run:
                print("\nDry run: nothing written.", file=sys.stderr)
                return 0
            if not copyable:
                print("\nNothing to copy.", file=sys.stderr)
                return 0

            written = 0
            for start in range(0, len(copyable), BATCH):
                chunk = copyable[start:start + BATCH]
                cursor.executemany(
                    """
                    UPDATE document_chunks
                    SET embedding = %s::vector,
                        embedding_model = %s,
                        embedded_at = now()
                    WHERE chunk_id = %s
                    """,
                    chunk,
                )
                written += len(chunk)
                print(f"  copied {written}/{len(copyable)}", file=sys.stderr)

            cursor.execute(
                """
                SELECT embedding_model, count(*)
                FROM document_chunks WHERE embedding IS NOT NULL
                GROUP BY embedding_model
                """
            )
            print("", file=sys.stderr)
            for model, count in cursor.fetchall():
                print(f"local now holds {count} vectors from {model}", file=sys.stderr)
        local_connection.commit()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
