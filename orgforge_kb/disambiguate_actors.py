#!/usr/bin/env python3
"""Merge actor name variants the corpus's own data can support.

Zero LLM. actors.name is exact-match unique, so "Ethan" and "Ethan Patel" are
two rows even where the corpus is naming one person, and 481 documents about
that person are split between them. A wrong merge is just as real a failure —
"GitHub" and "GitHub Actions" share no evidence and must not become one actor —
so nothing here merges automatically without a check that would also reject
that pair.

A candidate pair is a short name and a full name where the short is a strict
prefix of the full ("Ethan" / "Ethan Patel"). It is proposed only when:

  1. the two share at least one department in document_actors, AND
  2. the short name is not itself a domain's known_by/owner entry under a
     different full form (which would mean the corpus is already treating the
     short name as its own identity, not a shorthand for this one), AND
  3. the short name is not an external sender — someone inbound mail names as
     writing on behalf of a vendor or customer. The department check in (1)
     reads the department of the *documents* a name is on, and external mail
     is routed to a department, so on its own it merged a Firebase sales
     contact ("Ethan", writing from day 2) into an engineer hired on day 26
     ("Ethan Patel"). See migration 017.

Evidence is graded, not merged into one bucket:
  - 'asserted': domain_registry.json names the full form as a domain owner or
    in known_by, and never names the short form for the same domain. The
    registry is choosing to write the full name, not abbreviating.
  - 'inferred': only department overlap and the prefix match support it.

Nothing is deleted or renamed. A pair not meeting both checks is printed as a
rejected candidate, never merged.

Usage
-----
    DATABASE_URL=postgresql://... python3 disambiguate_actors.py
    DATABASE_URL=postgresql://... python3 disambiguate_actors.py --dry-run
"""

from __future__ import annotations

import argparse
import sys

import _env  # noqa: F401  (loads .env as a side effect)
import os
import psycopg


def find_candidates(cursor) -> list[tuple[str, str]]:
    """Every (short, full) pair where full starts with 'short '."""
    cursor.execute(
        """
        SELECT a.name AS short, b.name AS full
        FROM actors a JOIN actors b ON b.name LIKE a.name || ' %'
        ORDER BY a.name
        """
    )
    return cursor.fetchall()


def departments_of(cursor, name: str) -> set[str]:
    cursor.execute(
        """
        SELECT DISTINCT d.department
        FROM document_actors da
        JOIN actors a ON a.actor_id = da.actor_id
        JOIN source_documents d ON d.source_id = da.source_id
        WHERE a.name = %s AND d.department IS NOT NULL
        """,
        (name,),
    )
    return {row[0] for row in cursor.fetchall()}


def domains_naming(cursor, name: str) -> set[str]:
    """Domains whose primary_owner/former_owner/known_by names this exact
    string. Used both to find supporting evidence for the full form and to
    check the short form is not already an identity of its own."""
    cursor.execute(
        """
        SELECT name FROM domains
        WHERE primary_owner = %s OR former_owner = %s OR known_by @> to_jsonb(%s::text)
        """,
        (name, name, name),
    )
    return {row[0] for row in cursor.fetchall()}


def is_external_sender(cursor, name: str) -> bool:
    """Whether inbound mail names this person as writing on behalf of a vendor
    or customer organization other than themselves."""
    cursor.execute(
        """
        SELECT 1 FROM source_documents
        WHERE source_type = 'inbound_external_email'
          AND facts->>'category' IN ('vendor', 'customer')
          AND facts->>'source' = %s
          AND facts->>'org' <> %s
        LIMIT 1
        """,
        (name, name),
    )
    return cursor.fetchone() is not None


def evaluate(cursor, short: str, full: str) -> tuple[bool, str, str] | tuple[bool, None, None]:
    """Returns (accept, confidence, evidence) or (False, None, None)."""
    if is_external_sender(cursor, short):
        return False, None, None

    short_depts = departments_of(cursor, short)
    full_depts = departments_of(cursor, full)
    shared = short_depts & full_depts
    if not shared:
        return False, None, None

    # The short form must not be its own identity elsewhere in the corpus's
    # own registries — that would mean the corpus already distinguishes it
    # from the full form rather than using it as shorthand.
    short_domains = domains_naming(cursor, short)
    if short_domains:
        return False, None, None

    full_domains = domains_naming(cursor, full)
    if full_domains:
        confidence = "asserted"
        evidence = (
            f"domain_registry.json names '{full}' as owner/known_by for "
            f"{', '.join(sorted(full_domains))}, and never names '{short}' for "
            f"any domain; shares department(s) {', '.join(sorted(shared))}"
        )
    else:
        confidence = "inferred"
        evidence = (
            f"'{full}' is '{short}' followed by a surname, with no domain-registry "
            f"evidence either way; shares department(s) {', '.join(sorted(shared))}"
        )
    return True, confidence, evidence


def apply_alias(cursor, short: str, full: str, confidence: str, evidence: str) -> None:
    cursor.execute("SELECT actor_id FROM actors WHERE name = %s", (full,))
    (actor_id,) = cursor.fetchone()
    cursor.execute(
        """
        INSERT INTO actor_aliases (alias, actor_id, confidence, evidence)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (alias) DO UPDATE SET
            actor_id = EXCLUDED.actor_id,
            confidence = EXCLUDED.confidence,
            evidence = EXCLUDED.evidence
        """,
        (short, actor_id, confidence, evidence),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true",
                        help="report candidates and decisions, write nothing")
    arguments = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required.")

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            candidates = find_candidates(cursor)
            accepted = 0
            for short, full in candidates:
                accept, confidence, evidence = evaluate(cursor, short, full)
                if accept:
                    print(f"ACCEPT  {short!r} -> {full!r}  [{confidence}]",
                          file=sys.stderr)
                    print(f"        {evidence}", file=sys.stderr)
                    if not arguments.dry_run:
                        apply_alias(cursor, short, full, confidence, evidence)
                    accepted += 1
                else:
                    print(f"REJECT  {short!r} -> {full!r}  "
                          f"(no shared department, the short form has its own "
                          f"domain-registry identity, or it is an external "
                          f"sender)", file=sys.stderr)

            print(f"\n{accepted}/{len(candidates)} candidate pairs accepted.",
                  file=sys.stderr)
        if not arguments.dry_run:
            connection.commit()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
