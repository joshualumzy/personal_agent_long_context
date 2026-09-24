#!/usr/bin/env python3
"""
Ingest the HuggingFace `aeriesec/orgforge` corpus into a Postgres + pgvector
knowledge base defined by docs/OrgForge_Database_Schema.sql.

What it loads (from corpus/corpus-00000.parquet, one row per document):
  • actors            — the ~76 unique actors extracted from the `actors` JSON list
  • documents         — all 22,530 corpus rows, cleaned and type-mapped
  • document_actors   — the M:N junction between the two above
  • document_embeddings (optional) — a vector per document body, via a
                        pluggable embedding backend

The script is idempotent: it upserts on the natural keys (actors.name,
documents.doc_id) so re-running it will not duplicate rows.

Usage
-----
    # 1. structured data only, no embeddings (fastest; good first run)
    python ingest_orgforge.py --embeddings none --limit 200

    # 2. full corpus, offline deterministic embeddings (no AWS needed)
    python ingest_orgforge.py --embeddings hash

    # 3. full corpus, real Amazon Titan v2 embeddings (needs boto3 + AWS creds)
    python ingest_orgforge.py --embeddings bedrock

Embeddings are INCREMENTAL by default: a document is only (re-)embedded when it
has no vector yet, or when its text or the embedding model changed. Re-running
therefore skips unchanged documents and does not re-bill the whole corpus.
Switching backends (e.g. hash -> bedrock) re-embeds everything once, because the
model is part of the change check. Use --force-embed to re-embed regardless.

Connection is taken from the standard libpq env vars (PGHOST, PGDATABASE, ...)
or from --dsn. Defaults to dbname=orgforge on the local socket.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys
from typing import Any, Iterable, Optional

import pandas as pd
import psycopg2
import psycopg2.extras

# --- The embedding dimension MUST match document_embeddings.embedding vector(N)
#     in the schema. Amazon Titan Text Embeddings v2 -> 1024.
EMBED_DIM = 1024

HF_REPO = "aeriesec/orgforge"
CORPUS_FILE = "corpus/corpus-00000.parquet"

# doc_types the OrgForge README classifies as retrievable artifacts. Everything
# else is a sim_event; the single `sim_config` row is its own category. We use
# this only to fill `category` where the source left it null.
ARTIFACT_DOC_TYPES = {
    "confluence", "datadog_alert", "dept_plans", "email", "invoice", "jira",
    "nps_survey", "pr", "sf_account", "sf_opp", "slack", "zd_ticket",
    "zoom_transcript",
}


# ---------------------------------------------------------------------------
# Loading + cleaning
# ---------------------------------------------------------------------------
def download_corpus() -> str:
    """Return a local path to the corpus parquet, downloading + caching it."""
    from huggingface_hub import hf_hub_download

    return hf_hub_download(HF_REPO, CORPUS_FILE, repo_type="dataset")


def clean_str(value: Any) -> Optional[str]:
    """Empty string / NaN -> None; otherwise the stripped string.

    Also strips NUL (0x00) bytes: Postgres text/varchar columns cannot store
    them, and a few OrgForge document bodies contain stray NULs.
    """
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    text = str(value).replace("\x00", "").strip()
    return text or None


# Unicode dash variants that appear in some corpus date strings (e.g. the
# non-breaking hyphen U+2011) but that Postgres cannot parse as DATE/TIMESTAMP.
_DASH_CHARS = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"
_DASH_TABLE = {ord(ch): "-" for ch in _DASH_CHARS}


def clean_temporal(value: Any, want: str = "datetime") -> Optional[str]:
    """Normalize a date/timestamp field to something libpq can parse.

    Handles three real OrgForge forms:
      • ISO strings ("2026-01-01", "2026-01-01T10:30:00") -> passed through
      • Unicode dash variants ("2026‑04‑10") -> normalized to ASCII '-'
      • Unix epoch seconds as a string ("1767225600", the datadog_metric rows)
        -> converted to ISO. `want='date'` returns YYYY-MM-DD; `want='datetime'`
        returns a full ISO timestamp (UTC).
    """
    text = clean_str(value)
    if text is None:
        return None
    text = text.translate(_DASH_TABLE)
    if text.isdigit() and len(text) >= 9:  # epoch seconds stored as a string
        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(int(text), tz=timezone.utc)
        return dt.date().isoformat() if want == "date" else dt.isoformat()
    return text


def json_dumps_safe(obj: Any) -> str:
    """Serialize to JSON with any NUL (0x00) bytes stripped, since Postgres
    JSONB/text cannot store them. NULs occasionally appear inside OrgForge
    string values nested in tags/artifact_ids/facts."""
    return json.dumps(obj).replace("\\u0000", "").replace("\x00", "")


def parse_json(value: Any, fallback: Any) -> Any:
    """Parse a JSON string column, tolerating empty string / NaN."""
    if value is None:
        return fallback
    if isinstance(value, float) and math.isnan(value):
        return fallback
    text = str(value).strip()
    if not text:
        return fallback
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return fallback


def derive_category(raw_category: Any, doc_type: str) -> str:
    """The schema requires category NOT NULL in (artifact, sim_event, sim_config).

    ~6.6k corpus rows leave it null (datadog_metric, dept_plan, ...). Derive it
    from doc_type so those rows still satisfy the CHECK constraint.
    """
    cat = clean_str(raw_category)
    if cat in ("artifact", "sim_event", "sim_config"):
        return cat
    if doc_type == "sim_config":
        return "sim_config"
    if doc_type in ARTIFACT_DOC_TYPES:
        return "artifact"
    return "sim_event"


def load_rows(limit: Optional[int]) -> pd.DataFrame:
    path = download_corpus()
    print(f"corpus parquet: {path}", file=sys.stderr)
    df = pd.read_parquet(path)
    if limit is not None:
        df = df.head(limit).copy()
    print(f"loaded {len(df)} rows", file=sys.stderr)
    return df


# ---------------------------------------------------------------------------
# Embedding backends (pluggable)
# ---------------------------------------------------------------------------
class Embedder:
    """Base: turns text into a fixed-dim vector, or None to skip."""

    model_name = "none"

    def embed(self, text: str) -> Optional[list[float]]:
        return None


class HashEmbedder(Embedder):
    """Deterministic, offline, dependency-free pseudo-embedding.

    NOT semantically meaningful — it just gives every doc a stable unit vector
    so the pgvector plumbing (insert, HNSW index, <=> queries) can be exercised
    end-to-end without any external model or network. Good enough to demo the
    pipeline; swap for `bedrock` for real retrieval quality.
    """

    model_name = "hash-sha256-v1"

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * EMBED_DIM
        if not text:
            text = " "
        # Expand a SHA-256 stream deterministically across the dimensions.
        counter = 0
        i = 0
        buf = b""
        while i < EMBED_DIM:
            if not buf:
                buf = hashlib.sha256(f"{counter}:{text}".encode("utf-8")).digest()
                counter += 1
            # take 4 bytes -> float in [-1, 1]
            chunk, buf = buf[:4], buf[4:]
            if len(chunk) < 4:
                buf = b""
                continue
            val = struct.unpack(">I", chunk)[0] / 0xFFFFFFFF
            vec[i] = val * 2.0 - 1.0
            i += 1
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]


class BedrockTitanEmbedder(Embedder):
    """Amazon Titan Text Embeddings v2 via Bedrock Runtime (1024 dims)."""

    model_name = "amazon.titan-embed-text-v2:0"

    def __init__(self, region: Optional[str] = None):
        import boto3  # imported lazily so `hash`/`none` need no boto3

        self.client = boto3.client(
            "bedrock-runtime",
            region_name=region or os.environ.get("AWS_REGION", "us-east-1"),
        )

    def embed(self, text: str) -> list[float]:
        body = json.dumps({"inputText": text[:8000], "dimensions": EMBED_DIM,
                            "normalize": True})
        resp = self.client.invoke_model(modelId=self.model_name, body=body)
        payload = json.loads(resp["body"].read())
        return payload["embedding"]


def make_embedder(kind: str) -> Embedder:
    if kind == "none":
        return Embedder()
    if kind == "hash":
        return HashEmbedder()
    if kind == "bedrock":
        return BedrockTitanEmbedder()
    raise ValueError(f"unknown embeddings backend: {kind}")


def vector_literal(vec: list[float]) -> str:
    """pgvector text input format: '[0.1,0.2,...]'."""
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


# ---------------------------------------------------------------------------
# Database writes
# ---------------------------------------------------------------------------
def connect(dsn: Optional[str]):
    if dsn:
        return psycopg2.connect(dsn)
    # Fall back to libpq env vars; default dbname to orgforge.
    return psycopg2.connect(dbname=os.environ.get("PGDATABASE", "orgforge"))


def collect_actors(df: pd.DataFrame) -> list[str]:
    names: set[str] = set()
    for raw in df["actors"]:
        for name in parse_json(raw, []):
            if isinstance(name, str) and name.strip():
                names.add(name.strip())
    return sorted(names)


def upsert_actors(cur, names: Iterable[str]) -> dict[str, int]:
    """Insert actor names (idempotent) and return name -> actor_id."""
    rows = [(n,) for n in names]
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO actors (name)
        VALUES %s
        ON CONFLICT (name) DO NOTHING
        """,
        rows,
        page_size=500,
    )
    cur.execute("SELECT name, actor_id FROM actors")
    return {name: actor_id for name, actor_id in cur.fetchall()}


def upsert_documents(cur, df: pd.DataFrame) -> dict[str, int]:
    """Upsert all corpus rows into `documents`; return doc_id -> document_id."""
    records = []
    for _, row in df.iterrows():
        doc_type = clean_str(row["doc_type"]) or "unknown"
        records.append((
            clean_str(row["doc_id"]),
            derive_category(row["category"], doc_type),
            doc_type,
            clean_str(row["title"]),
            clean_str(row["body"]),
            int(row["day"]) if pd.notna(row["day"]) else None,
            clean_temporal(row["date"], want="date"),      # DATE
            clean_temporal(row["timestamp"], want="datetime"), # TIMESTAMPTZ
            clean_str(row["dept"]),
            bool(row["is_incident"]),
            bool(row["is_external"]),
            json_dumps_safe(parse_json(row["tags"], [])),
            json_dumps_safe(parse_json(row["artifact_ids"], {})),
            json_dumps_safe(parse_json(row["facts"], {})),
        ))

    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO documents
            (doc_id, category, doc_type, title, body, sim_day, doc_date, ts,
             dept, is_incident, is_external, tags, artifact_ids, facts)
        VALUES %s
        ON CONFLICT (doc_id) DO UPDATE SET
            category     = EXCLUDED.category,
            doc_type     = EXCLUDED.doc_type,
            title        = EXCLUDED.title,
            body         = EXCLUDED.body,
            sim_day      = EXCLUDED.sim_day,
            doc_date     = EXCLUDED.doc_date,
            ts           = EXCLUDED.ts,
            dept         = EXCLUDED.dept,
            is_incident  = EXCLUDED.is_incident,
            is_external  = EXCLUDED.is_external,
            tags         = EXCLUDED.tags,
            artifact_ids = EXCLUDED.artifact_ids,
            facts        = EXCLUDED.facts
        """,
        records,
        template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb)",
        page_size=500,
    )
    cur.execute("SELECT doc_id, document_id FROM documents")
    return {doc_id: document_id for doc_id, document_id in cur.fetchall()}


def upsert_document_actors(cur, df: pd.DataFrame,
                           doc_ids: dict[str, int],
                           actor_ids: dict[str, int]) -> int:
    pairs: list[tuple[int, int]] = []
    for _, row in df.iterrows():
        document_id = doc_ids.get(clean_str(row["doc_id"]))
        if document_id is None:
            continue
        for name in parse_json(row["actors"], []):
            if not isinstance(name, str):
                continue
            actor_id = actor_ids.get(name.strip())
            if actor_id is not None:
                pairs.append((document_id, actor_id))
    # de-dup within batch
    pairs = list(set(pairs))
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO document_actors (document_id, actor_id)
        VALUES %s
        ON CONFLICT (document_id, actor_id) DO NOTHING
        """,
        pairs,
        page_size=1000,
    )
    return len(pairs)


def ensure_content_hash_column(cur) -> None:
    """Add document_embeddings.content_hash if it does not exist.

    The base schema has no such column; we add it (idempotently) so we can tell
    whether a document's text has changed since it was last embedded, and thus
    skip re-embedding unchanged documents. Safe to run every time.
    """
    cur.execute(
        """
        ALTER TABLE document_embeddings
        ADD COLUMN IF NOT EXISTS content_hash TEXT
        """
    )


def embedding_text(row) -> str:
    title = clean_str(row["title"]) or ""
    body = clean_str(row["body"]) or ""
    return f"{title}\n\n{body}".strip()


def content_fingerprint(model_name: str, text: str) -> str:
    """A stable hash of (model, text). Changing either the model or the text
    changes the fingerprint, which is exactly when we must re-embed."""
    h = hashlib.sha256()
    h.update(model_name.encode("utf-8"))
    h.update(b"\x00")
    h.update(text.encode("utf-8"))
    return h.hexdigest()


def upsert_embeddings(cur, df: pd.DataFrame, doc_ids: dict[str, int],
                      embedder: Embedder, batch: int = 100,
                      force: bool = False) -> dict[str, int]:
    """Incrementally embed documents.

    A document is (re-)embedded only when it has no stored vector yet, or when
    its (model, text) fingerprint differs from what is stored — i.e. the text
    changed or the embedding model changed. Unchanged documents are skipped, so
    re-running against Bedrock does not re-bill the whole corpus.

    Pass force=True to re-embed everything regardless.

    Returns counts: {'embedded': N, 'skipped': M}.
    """
    ensure_content_hash_column(cur)

    # Load what we already have: document_id -> (model, content_hash)
    existing: dict[int, tuple[Optional[str], Optional[str]]] = {}
    cur.execute("SELECT document_id, model, content_hash FROM document_embeddings")
    for document_id, model, chash in cur.fetchall():
        existing[document_id] = (model, chash)

    written = 0
    skipped = 0
    records: list[tuple[int, str, str, str]] = []

    def flush():
        nonlocal written
        if not records:
            return
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO document_embeddings (document_id, model, embedding, content_hash)
            VALUES %s
            ON CONFLICT (document_id) DO UPDATE SET
                model        = EXCLUDED.model,
                embedding    = EXCLUDED.embedding,
                content_hash = EXCLUDED.content_hash,
                created_at   = now()
            """,
            records,
            template="(%s,%s,%s::vector,%s)",
            page_size=batch,
        )
        written += len(records)
        records.clear()

    for _, row in df.iterrows():
        document_id = doc_ids.get(clean_str(row["doc_id"]))
        if document_id is None:
            continue
        text = embedding_text(row)
        fingerprint = content_fingerprint(embedder.model_name, text)

        if not force:
            prev = existing.get(document_id)
            # Skip only when the SAME model produced a vector for the SAME text.
            if prev is not None and prev[0] == embedder.model_name and prev[1] == fingerprint:
                skipped += 1
                continue

        vec = embedder.embed(text)
        if vec is None:
            continue
        if len(vec) != EMBED_DIM:
            raise ValueError(
                f"embedding dim {len(vec)} != schema dim {EMBED_DIM} "
                f"for doc {row['doc_id']}"
            )
        records.append((document_id, embedder.model_name, vector_literal(vec), fingerprint))
        if len(records) >= batch:
            flush()
            print(f"  embedded {written} (skipped {skipped})...", file=sys.stderr)
    flush()
    return {"embedded": written, "skipped": skipped}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", help="libpq DSN; defaults to dbname=orgforge")
    ap.add_argument("--limit", type=int, default=None,
                    help="ingest only the first N rows (for a quick smoke run)")
    ap.add_argument("--embeddings", choices=["none", "hash", "bedrock"],
                    default="none", help="embedding backend (default: none)")
    ap.add_argument("--region", help="AWS region for the bedrock backend")
    ap.add_argument("--force-embed", action="store_true",
                    help="re-embed every document even if it is unchanged "
                         "(default: incremental — skip docs already embedded "
                         "with the same model and same text)")
    args = ap.parse_args()

    df = load_rows(args.limit)
    embedder = make_embedder(args.embeddings)
    if args.embeddings == "bedrock" and args.region:
        embedder = BedrockTitanEmbedder(region=args.region)

    conn = connect(args.dsn)
    try:
        with conn:
            with conn.cursor() as cur:
                names = collect_actors(df)
                actor_ids = upsert_actors(cur, names)
                print(f"actors upserted: {len(actor_ids)}", file=sys.stderr)

                doc_ids = upsert_documents(cur, df)
                print(f"documents in table: {len(doc_ids)}", file=sys.stderr)

                pair_count = upsert_document_actors(cur, df, doc_ids, actor_ids)
                print(f"document_actor links: {pair_count}", file=sys.stderr)

                if args.embeddings != "none":
                    mode = "force (all)" if args.force_embed else "incremental"
                    print(f"embedding with backend={args.embeddings} "
                          f"({embedder.model_name}, dim={EMBED_DIM}, {mode})...",
                          file=sys.stderr)
                    result = upsert_embeddings(cur, df, doc_ids, embedder,
                                               force=args.force_embed)
                    print(f"embeddings: {result['embedded']} written, "
                          f"{result['skipped']} skipped (unchanged)",
                          file=sys.stderr)
    finally:
        conn.close()

    print("done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
