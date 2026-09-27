#!/usr/bin/env python3
"""The answer key for hiring proposals: OrgForge's own record of knowledge gaps.

OFFLINE ONLY. This reads the simulator's events — who left and what they
knew, who was hired, who took over an orphaned domain, and the 2,435
knowledge_gap_detected detections — which benchmark questions are built on.
Nothing at runtime may read them (docs/mvp.md, "Knowledge gaps and hiring
proposals"). The file this writes is what scripts/backtest-hiring.ts scores
the runtime rules against, and nothing else.

    DATABASE_URL=postgresql://... python3 eval/orgforge/gap_truth.py
    # writes eval/orgforge/gap-truth.json

Days are UTC dates of occurred_at: the simulation's clock is UTC (see
src/as-of.ts). Weeks start on Monday. The output is sorted throughout, so the
same corpus gives the same bytes.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

try:
    import psycopg
except ImportError:
    psycopg = None

OUT = Path(__file__).resolve().parent / "gap-truth.json"
DAY = "(occurred_at AT TIME ZONE 'UTC')::date::text"

# Tags too generic to name one domain on their own: "auth" is two domains,
# "service" and "flow" are half the English language.
GENERIC_TAGS = {"project", "flow", "service", "structure", "infra", "deploy", "legacy", "cost", "auth", "titan"}


def normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


class DomainMatcher:
    """Finds which of the registry's domains a piece of free text is about."""

    def __init__(self, domains: list[dict]):
        self.by_name = {}
        tag_owners: dict[str, set[str]] = defaultdict(set)
        for domain in domains:
            self.by_name[normalise(domain["key"])] = domain["key"]
            self.by_name[normalise(domain["name"])] = domain["key"]
            for tag in domain["system_tags"]:
                tag_owners[tag.lower()].add(domain["key"])
        # A tag counts only if it names exactly one domain and is not generic.
        self.tags = {
            tag: next(iter(owners))
            for tag, owners in tag_owners.items()
            if len(owners) == 1 and tag not in GENERIC_TAGS
        }

    def exact(self, name: str) -> str | None:
        return self.by_name.get(normalise(name))

    def find(self, text: str) -> list[str]:
        if not text:
            return []
        exact = self.exact(text)
        if exact:
            return [exact]
        lowered = text.lower()
        found = {
            key for tag, key in self.tags.items()
            if re.search(rf"(?<![a-z0-9]){re.escape(tag)}(?![a-z0-9])", lowered)
        }
        return sorted(found)


def week_of(day: str) -> str:
    parsed = date.fromisoformat(day)
    return (parsed - timedelta(days=parsed.weekday())).isoformat()


def _json(value):
    if value is None or isinstance(value, (dict, list)):
        return value
    return json.loads(value)


def build(cursor) -> dict:
    cursor.execute("SELECT domain_key, name, dept, system_tags::text FROM domains ORDER BY domain_key")
    domains = [{"key": key, "name": name, "dept": dept, "system_tags": _json(tags) or []}
               for key, name, dept, tags in cursor.fetchall()]
    matcher = DomainMatcher(domains)

    def event_rows(source_type: str):
        cursor.execute(
            f"SELECT source_id, {DAY}, facts::text, actors::text FROM source_documents "
            f"WHERE source_type = %s AND occurred_at IS NOT NULL ORDER BY occurred_at, source_id",
            (source_type,),
        )
        return [(source_id, day, _json(facts) or {}, _json(actors) or []) for source_id, day, facts, actors in cursor.fetchall()]

    departures = []
    for source_id, day, facts, actors in event_rows("employee_departed"):
        departures.append({
            "person": facts.get("name") or (actors[0] if actors else None),
            "day": day,
            "dept": facts.get("dept"),
            "role": facts.get("role"),
            "before_record": bool(facts.get("is_genesis_gap")),
            "domains": sorted({key for name in facts.get("knowledge_domains") or [] if (key := matcher.exact(name))}),
            "event": source_id,
        })

    hires = []
    for source_id, day, facts, actors in event_rows("employee_hired"):
        expertise = facts.get("expertise") or []
        hires.append({
            "person": facts.get("name") or (actors[0] if actors else None),
            "day": day,
            "dept": facts.get("dept"),
            "role": facts.get("role"),
            "expertise": expertise,
            "domains": sorted({key for skill in expertise for key in matcher.find(skill)}),
            "event": source_id,
        })

    handovers = []
    for source_id, day, facts, _actors in event_rows("domain_ownership_claimed"):
        handovers.append({
            "domain": matcher.exact(facts.get("domain") or ""),
            "day": day,
            "new_owner": facts.get("new_owner"),
            "pathway": facts.get("pathway"),
            "event": source_id,
        })

    weekly: dict[tuple[str, str], Counter] = defaultdict(Counter)
    async_total = async_unmapped = 0
    for _source_id, day, facts, _actors in event_rows("knowledge_gap_detected"):
        method = facts.get("detection_method") or "unknown"
        if method == "embedding_similarity":
            keys = {key for name in facts.get("gap_areas") or [] if (key := matcher.exact(name))}
        elif method == "async_thread_classification":
            async_total += 1
            keys = set(matcher.find(facts.get("gap_domain") or "") or matcher.find(facts.get("topic") or ""))
            if not keys:
                async_unmapped += 1
                continue
            method = f"async_{facts.get('outcome') or 'unknown'}"
        elif method in ("author_self_audit", "reviewer_audit"):
            beyond = facts.get("topics_beyond_author_expertise") or facts.get("topics_beyond_expertise") or []
            keys = {key for name in beyond for key in matcher.find(name)}
            if not keys:
                keys = set(matcher.find(facts.get("topic") or "") + matcher.find(facts.get("pr_title") or ""))
        else:
            keys = {key for name in facts.get("domains") or [] if (key := matcher.exact(name))}
        for key in keys:
            weekly[(key, week_of(day))][method] += 1

    return {
        "note": "OFFLINE answer key from OrgForge simulator events. Never deployed, never read at runtime.",
        "domains": domains,
        "departures": departures,
        "hires": hires,
        "handovers": handovers,
        "weekly": [
            {"domain": key, "week": week, **dict(sorted(counts.items()))}
            for (key, week), counts in sorted(weekly.items())
        ],
        "async_questions": {
            "total": async_total,
            "unmapped": async_unmapped,
            "unmapped_share": round(async_unmapped / async_total, 3) if async_total else 0,
        },
    }


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required.")
    if psycopg is None:
        raise RuntimeError("psycopg is required: pip install 'psycopg[binary]'")
    with psycopg.connect(url) as connection, connection.cursor() as cursor:
        truth = build(cursor)
    OUT.write_text(json.dumps(truth, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(truth['departures'])} departures, {len(truth['hires'])} hires, "
          f"{len(truth['handovers'])} hand-overs, {len(truth['weekly'])} domain-weeks; "
          f"async questions unmapped {truth['async_questions']['unmapped']}/{truth['async_questions']['total']}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
