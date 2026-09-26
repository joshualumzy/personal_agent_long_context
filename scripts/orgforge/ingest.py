"""Import the OrgForge corpus into the runtime database.

Two layers come out of one pass:

* **Retrieval layer** — only employee-visible Company Artifacts are chunked and
  embedded, so only they can ever surface as evidence. Simulation events carry
  god's-eye facts (causal chains, the ticket a PR will spawn) and must never
  reach it.
* **Causal layer** — every row is admitted to ``source_documents`` and linked in
  ``document_links``, because the simulation's causal chains are what the
  scheduler reasons over, and the graph builder derives its nodes and edges
  from them.

``category`` records which layer a row belongs to. The corpus leaves it empty on
thousands of rows, so it is derived from the document type when missing.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from collections.abc import Iterable
from datetime import date, datetime

import psycopg
from datasets import load_dataset


DATASET_NAME = "aeriesec/orgforge"
DATASET_REVISION = os.environ.get("ORGFORGE_REVISION", "main")
DATABASE_URL = os.environ.get("DATABASE_URL")

# Document types the corpus documents as employee-visible artifacts. These are
# the only ones allowed into the retrieval layer.
ALLOWED_TYPES = {
    "confluence",
    "datadog_alert",
    "email",
    "invoice",
    "jira",
    "nps_survey",
    "pr",
    "sf_account",
    "sf_opp",
    "slack",
    "zd_ticket",
    "zoom_transcript",
}

CATEGORIES = ("artifact", "sim_event", "sim_config")


def without_nul(value: str) -> str:
    """Strip NUL bytes. Postgres text and jsonb reject 0x00, and a few corpus
    bodies carry stray ones."""
    return value.replace("\x00", "")


def dump_json(value: object) -> str:
    """Serialize for a jsonb parameter, with NUL bytes removed from nested
    strings as well as from the escaped form json.dumps produces."""
    return json.dumps(value).replace("\\u0000", "").replace("\x00", "")


def parse_json(value: object, fallback: object) -> object:
    if value is None or value == "":
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except json.JSONDecodeError:
        return fallback


def parse_timestamp(value: object) -> datetime | None:
    if not value:
        return None
    normalized = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def parse_date(value: object) -> date | None:
    if not value:
        return None
    normalized = str(value)
    for dash in ("‑", "–", "—", "−"):
        normalized = normalized.replace(dash, "-")
    try:
        return date.fromisoformat(normalized)
    except ValueError:
        return None


def derive_category(row: dict[str, object]) -> str:
    """Return the corpus category, deriving it when the row leaves it empty.

    Thousands of rows carry no category (datadog_metric, dept_plan,
    dept_plan_reasoning, and a handful of artifacts). Routing depends on this
    value, so fall back to the document type: allow-listed types are artifacts,
    the configuration row is its own category, everything else is a simulation
    event.
    """
    category = str(row.get("category") or "").strip()
    if category in CATEGORIES:
        return category
    doc_type = str(row.get("doc_type") or "")
    if doc_type == "sim_config":
        return "sim_config"
    return "artifact" if doc_type in ALLOWED_TYPES else "sim_event"


def is_retrievable_artifact(row: dict[str, object], category: str) -> bool:
    """Admit only declared employee-visible Company Artifacts to the retrieval
    layer. Simulation events are excluded even when their type looks familiar,
    because their identifiers are prefixed ``EVT-`` and their payload is oracle
    material."""
    source_id = str(row.get("doc_id") or "")
    return (
        category == "artifact"
        and row.get("doc_type") in ALLOWED_TYPES
        and not source_id.startswith("EVT-")
    )


def chunks(body: str, target: int = 1_600) -> Iterable[str]:
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", body) if part.strip()]
    current: list[str] = []
    length = 0
    for paragraph in paragraphs or [body]:
        if current and length + len(paragraph) > target:
            yield "\n\n".join(current)
            current = []
            length = 0
        while len(paragraph) > target:
            if current:
                yield "\n\n".join(current)
                current = []
                length = 0
            yield paragraph[:target]
            paragraph = paragraph[target:]
        if paragraph:
            current.append(paragraph)
            length += len(paragraph)
    if current:
        yield "\n\n".join(current)


def link_pairs(source_id: str, raw_links: object) -> Iterable[tuple[str, str, str]]:
    links = parse_json(raw_links, {})
    if not isinstance(links, dict):
        return
    for relationship, target in links.items():
        targets = target if isinstance(target, list) else [target]
        for related in targets:
            if isinstance(related, str) and related and related != source_id:
                yield source_id, related, str(relationship)


def actor_names(raw_actors: object) -> list[str]:
    """Distinct, ordered actor names from the corpus list."""
    actors = parse_json(raw_actors, [])
    if not isinstance(actors, list):
        return []
    seen: dict[str, None] = {}
    for actor in actors:
        if isinstance(actor, str) and actor.strip():
            seen.setdefault(actor.strip(), None)
    return list(seen)


def main() -> None:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required.")

    dataset = load_dataset(DATASET_NAME, revision=DATASET_REVISION, split="train")
    batch_id = uuid.uuid4()
    accepted = 0
    rejected = 0
    artifacts = 0
    events = 0

    with psycopg.connect(DATABASE_URL) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ingestion_batches
                    (batch_id, dataset_name, dataset_revision)
                VALUES (%s, %s, %s)
                ON CONFLICT (dataset_name, dataset_revision)
                DO UPDATE SET started_at = now(), completed_at = NULL,
                              artifact_count = 0, rejected_count = 0
                RETURNING batch_id
                """,
                (batch_id, DATASET_NAME, DATASET_REVISION),
            )
            batch_id = cursor.fetchone()[0]

            cursor.execute(
                """
                INSERT INTO employees
                    (employee_id, display_name, role, department, current_assignments)
                VALUES ('jax', 'Jax', 'Backend Engineer', 'Engineering_Backend', '[]')
                ON CONFLICT (employee_id) DO NOTHING
                """
            )

            cursor.execute(
                "DELETE FROM source_documents WHERE dataset_revision = %s",
                (DATASET_REVISION,),
            )

            for row in dataset:
                source_id = str(row["doc_id"])
                title = without_nul(str(row.get("title") or "")).strip()
                body = without_nul(str(row.get("body") or title)).strip()
                if not source_id or not body:
                    rejected += 1
                    continue

                category = derive_category(row)
                retrievable = is_retrievable_artifact(row, category)

                actors = parse_json(row.get("actors"), [])
                tags = parse_json(row.get("tags"), [])
                links = parse_json(row.get("artifact_ids"), {})
                occurred_at = parse_timestamp(row.get("timestamp"))

                cursor.execute(
                    """
                    INSERT INTO source_documents (
                        source_id, source_type, category, title, body,
                        simulation_day, document_date, occurred_at, department,
                        actors, tags, original_links, metadata, is_incident,
                        is_external, dataset_revision, batch_id
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, NULLIF(%s, ''),
                        %s::jsonb, %s::jsonb, %s::jsonb, '{}'::jsonb,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (source_id) DO UPDATE SET
                        source_type = EXCLUDED.source_type,
                        category = EXCLUDED.category,
                        title = EXCLUDED.title,
                        body = EXCLUDED.body,
                        simulation_day = EXCLUDED.simulation_day,
                        document_date = EXCLUDED.document_date,
                        occurred_at = EXCLUDED.occurred_at,
                        department = EXCLUDED.department,
                        actors = EXCLUDED.actors,
                        tags = EXCLUDED.tags,
                        original_links = EXCLUDED.original_links,
                        is_incident = EXCLUDED.is_incident,
                        is_external = EXCLUDED.is_external,
                        dataset_revision = EXCLUDED.dataset_revision,
                        batch_id = EXCLUDED.batch_id
                    """,
                    (
                        source_id,
                        row["doc_type"],
                        category,
                        title or None,
                        body,
                        row.get("day"),
                        parse_date(row.get("date")),
                        occurred_at,
                        row.get("dept") or "",
                        dump_json(actors),
                        dump_json(tags),
                        dump_json(links),
                        bool(row.get("is_incident")),
                        bool(row.get("is_external")),
                        DATASET_REVISION,
                        batch_id,
                    ),
                )

                # Only employee-visible artifacts become retrievable evidence.
                if retrievable:
                    for chunk_index, content in enumerate(chunks(body)):
                        cursor.execute(
                            """
                            INSERT INTO document_chunks (source_id, chunk_index, content)
                            VALUES (%s, %s, %s)
                            ON CONFLICT (source_id, chunk_index)
                            DO UPDATE SET content = EXCLUDED.content
                            """,
                            (source_id, chunk_index, content),
                        )
                    artifacts += 1
                else:
                    events += 1

                for name in actor_names(row.get("actors")):
                    cursor.execute(
                        """
                        INSERT INTO actors (name) VALUES (%s)
                        ON CONFLICT (name) DO NOTHING
                        """,
                        (name,),
                    )
                    cursor.execute(
                        """
                        INSERT INTO document_actors (source_id, actor_id)
                        SELECT %s, actor_id FROM actors WHERE name = %s
                        ON CONFLICT DO NOTHING
                        """,
                        (source_id, name),
                    )

                for link in link_pairs(source_id, links):
                    cursor.execute(
                        """
                        INSERT INTO document_links
                            (source_id, related_source_id, relationship_type)
                        VALUES (%s, %s, %s)
                        ON CONFLICT DO NOTHING
                        """,
                        link,
                    )

                accepted += 1

            cursor.execute(
                """
                UPDATE ingestion_batches
                SET completed_at = now(), artifact_count = %s, rejected_count = %s
                WHERE batch_id = %s
                """,
                (artifacts, rejected, batch_id),
            )
        connection.commit()

    print(
        f"Imported {accepted} documents: {artifacts} retrievable artifacts "
        f"(chunked and embeddable), {events} causal-layer rows (never chunked); "
        f"skipped {rejected} rows without a usable body."
    )


if __name__ == "__main__":
    main()
