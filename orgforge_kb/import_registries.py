#!/usr/bin/env python3
"""Import domain_registry.json and simulation_snapshot.json's incident list.

Zero LLM. Both files are the corpus's own stated ground truth: a domain names
its owner and everyone who knows it by string, which is direct evidence for
actor disambiguation (issue #11, finding 3) rather than a guess from name
similarity — the same technique has to tell "Ethan" / "Ethan Patel" (same
person) apart from "GitHub" / "GitHub Actions" (not), and string similarity
alone cannot.

An incident's timing and root cause are not repeated from the snapshot: they
already sit in source_documents.facts on the matching incident_opened /
incident_resolved rows (migration 006), keyed by facts->'causal_chain'->>0,
which is always the incident's own jira id. This reads them from there rather
than duplicating what the corpus already states once.

Six of the twelve incident ids named by the snapshot are never ingested as
their own row — only as a derived confluence postmortem or datadog alert — so
incidents.incident_key is not a foreign key. What is looked up is the
incident_opened row whose causal_chain starts with that id.

Usage
-----
    DATABASE_URL=postgresql://... python3 import_registries.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import _env  # noqa: F401  (loads .env as a side effect)
import psycopg
from huggingface_hub import hf_hub_download

DATASET_NAME = "aeriesec/orgforge"


def load_json(path: str) -> object:
    local = hf_hub_download(DATASET_NAME, path, repo_type="dataset")
    return json.loads(Path(local).read_text(encoding="utf-8"))


def import_domains(cursor) -> int:
    domains = load_json("supplemental/domain_registry.json")
    rows = [
        (
            d["_id"],
            d["domain"],
            d.get("dept"),
            d.get("primary_owner"),
            d.get("former_owner"),
            d.get("documentation_coverage"),
            bool(d.get("is_genesis_gap", False)),
            d.get("last_updated_day"),
            json.dumps(d.get("known_by", [])),
            json.dumps(d.get("system_tags", [])),
        )
        for d in domains
    ]
    cursor.executemany(
        """
        INSERT INTO domains (
            domain_key, name, dept, primary_owner, former_owner,
            documentation_coverage, is_genesis_gap, last_updated_day,
            known_by, system_tags
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
        ON CONFLICT (domain_key) DO UPDATE SET
            name = EXCLUDED.name,
            dept = EXCLUDED.dept,
            primary_owner = EXCLUDED.primary_owner,
            former_owner = EXCLUDED.former_owner,
            documentation_coverage = EXCLUDED.documentation_coverage,
            is_genesis_gap = EXCLUDED.is_genesis_gap,
            last_updated_day = EXCLUDED.last_updated_day,
            known_by = EXCLUDED.known_by,
            system_tags = EXCLUDED.system_tags
        """,
        rows,
    )
    return len(rows)


def as_timestamp(value: object) -> str | None:
    """source_documents.occurred_at is already a timestamptz; psycopg hands
    back a datetime, which needs no reparsing, but the row may not exist."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def import_incidents(cursor) -> tuple[int, int]:
    snapshot = load_json("supplemental/simulation_snapshot.json")
    incident_keys: list[str] = snapshot["resolved_incidents"]

    matched = 0
    for incident_key in incident_keys:
        cursor.execute(
            """
            SELECT facts->>'root_cause', occurred_at
            FROM source_documents
            WHERE source_type = 'incident_opened'
              AND facts->'causal_chain'->>0 = %s
            LIMIT 1
            """,
            (incident_key,),
        )
        opened_row = cursor.fetchone()
        root_cause = opened_row[0] if opened_row else None
        opened_at = as_timestamp(opened_row[1]) if opened_row else None

        cursor.execute(
            """
            SELECT occurred_at
            FROM source_documents
            WHERE source_type = 'incident_resolved'
              AND facts->'causal_chain'->>0 = %s
            LIMIT 1
            """,
            (incident_key,),
        )
        resolved_row = cursor.fetchone()
        resolved_at = as_timestamp(resolved_row[0]) if resolved_row else None

        if opened_row is not None:
            matched += 1

        # root_domain is deliberately left unset: matching root_cause prose to
        # a domain by keyword would be a guess this table should not assert.
        cursor.execute(
            """
            INSERT INTO incidents (incident_key, opened_at, resolved_at, root_cause)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (incident_key) DO UPDATE SET
                opened_at = EXCLUDED.opened_at,
                resolved_at = EXCLUDED.resolved_at,
                root_cause = EXCLUDED.root_cause
            """,
            (incident_key, opened_at, resolved_at, root_cause),
        )

    return len(incident_keys), matched


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required.")

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            domain_count = import_domains(cursor)
            print(f"domains: {domain_count} upserted", file=sys.stderr)

            incident_count, matched = import_incidents(cursor)
            print(
                f"incidents: {incident_count} named by the snapshot, "
                f"{matched} matched to an incident_opened row",
                file=sys.stderr,
            )
            if matched < incident_count:
                print(
                    f"  {incident_count - matched} incident(s) named by the "
                    "snapshot have no matching incident_opened row — recorded "
                    "with no timing or root cause rather than guessed.",
                    file=sys.stderr,
                )
        connection.commit()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
