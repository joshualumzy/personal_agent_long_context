"""Import employee-visible OrgForge artifacts into the runtime database.

Evaluation and oracle material is rejected by construction: only rows whose
category is ``artifact`` and whose type is explicitly allow-listed can enter.
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


def is_runtime_artifact(row: dict[str, object]) -> bool:
    """Admit only declared employee-visible Company Artifacts."""
    source_id = str(row.get("doc_id") or "")
    return (
        row.get("category") == "artifact"
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


def main() -> None:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required.")

    dataset = load_dataset(DATASET_NAME, revision=DATASET_REVISION, split="train")
    batch_id = uuid.uuid4()
    accepted = 0
    rejected = 0

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
                if not is_runtime_artifact(row):
                    rejected += 1
                    continue

                source_id = str(row["doc_id"])
                title = str(row.get("title") or "").strip()
                body = str(row.get("body") or title).strip()
                if not source_id or not body:
                    rejected += 1
                    continue

                actors = parse_json(row.get("actors"), [])
                tags = parse_json(row.get("tags"), [])
                links = parse_json(row.get("artifact_ids"), {})
                occurred_at = parse_timestamp(row.get("timestamp"))

                cursor.execute(
                    """
                    INSERT INTO source_documents (
                        source_id, source_type, title, body, simulation_day,
                        document_date, occurred_at, department, actors, tags,
                        original_links, metadata, is_incident, is_external,
                        dataset_revision, batch_id
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, NULLIF(%s, ''),
                        %s::jsonb, %s::jsonb, %s::jsonb, '{}'::jsonb,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (source_id) DO UPDATE SET
                        source_type = EXCLUDED.source_type,
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
                        title or None,
                        body,
                        row.get("day"),
                        parse_date(row.get("date")),
                        occurred_at,
                        row.get("dept") or "",
                        json.dumps(actors),
                        json.dumps(tags),
                        json.dumps(links),
                        bool(row.get("is_incident")),
                        bool(row.get("is_external")),
                        DATASET_REVISION,
                        batch_id,
                    ),
                )

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
                (accepted, rejected, batch_id),
            )
        connection.commit()

    print(f"Imported {accepted} employee-visible artifacts; rejected {rejected} non-runtime rows.")


if __name__ == "__main__":
    main()
