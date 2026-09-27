#!/usr/bin/env python3
"""Build the dated projections: day plans, ticket states and the roster.

No language model is involved, and nothing is guessed: every row comes from a
field the corpus states. Three tables, all rebuilt in full on every run (see
database/migrations/019_asof_projection.sql and 020_employee_roster.sql):

  day_plan_entry   one row per item of one person's plan for one day, read
                   from dept_plan_created.facts.engineer_plans[].agenda[]
  employee_roster  who worked here, with join and leave days (no reason);
                   the staff are everyone in a day plan, dated by hire and
                   departure events
  work_item_state  one row per interval in which a jira ticket's status and
                   assignee held, read from the jira artifact (its creation,
                   first status, title, points, sprint), ticket_progress
                   events (status changes, reassignments) and day plans that
                   name the ticket (who is working on it)

Who a ticket is assigned to is not a field of the jira artifact: its actor is
the person who raised it, a department lead for 262 of 304 tickets, and not
the person who works on it (the two agree for 65 of 352 progress events). The
corpus says who works on a ticket in three places, which never disagree:
the actor of each ticket_progress event, the person whose day plan lists the
ticket (agenda[].related_id), and a reassignment's new_assignee. So:

  reporter   the jira artifact's first actor, fixed
  assignee   empty until one of those three names someone, then that person

States are kept per day, not per event: a day's state is how the ticket stood
at the end of that day, and a new interval starts only when that differs from
the day before. Plans are made in the morning, so a plan naming the ticket
counts at the start of its day.

Only the projected rows are deployed. Neither table is Company Evidence
(docs/mvp.md, "Date-view planner projection"): `derived_from` lists the
simulation events a row came from, for audit, and `sources` the
employee-visible artifacts it is about, which is what an answer may cite.

Usage
-----
    DATABASE_URL=postgresql://... python3 orgforge_kb/build_timeline.py

Run after build_graph.py (it reads the same source_documents rows, not the
graph, so the order is only a convention). Re-running gives the same tables.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from typing import Iterable

try:
    import psycopg
except ImportError:  # the pure functions below are testable without it
    psycopg = None

try:
    import _env  # noqa: F401  (reads the repository's .env)
except ImportError:
    pass

# The simulation's clock is UTC: its working hours run 09:00-17:00 UTC, and
# every artifact's occurred_at agrees with the day in its id when read in UTC.
# document_date is not reliable for this (a slack message carries its channel
# file's date, off by a day for 2,333 of 3,303), so a row's day is the UTC
# date of occurred_at, the same boundary src/as-of.ts filters evidence on.
DAY = "coalesce((occurred_at AT TIME ZONE 'UTC')::date, document_date)::text"

TODO = "To Do"
DONE = "Done"


# ---------------------------------------------------------------------------
# Day plans
# ---------------------------------------------------------------------------
def plan_entries(plans: Iterable[tuple[str, str, dict]], artifacts: set[str]) -> list[dict]:
    """(event id, day, dept_plan_created facts) -> day_plan_entry rows.

    seq numbers a person's items for the day in the order the plan lists
    them, across plans if a person somehow appears in two on the same day.
    """
    rows: list[dict] = []
    next_seq: dict[tuple[str, str], int] = {}
    for event_id, day, facts in sorted(plans, key=lambda plan: (plan[1], plan[0])):
        for person_plan in facts.get("engineer_plans") or []:
            person = (person_plan.get("name") or "").strip()
            if not person:
                continue
            department = person_plan.get("dept") or facts.get("dept")
            for item in person_plan.get("agenda") or []:
                title = (item.get("description") or "").strip()
                if not title:
                    continue
                seq = next_seq.get((person, day), 0) + 1
                next_seq[(person, day)] = seq
                item_key = item.get("related_id") or None
                rows.append({
                    "person": person,
                    "day": day,
                    "seq": seq,
                    "department": department,
                    "title": title,
                    "activity_type": item.get("activity_type"),
                    "est_hours": item.get("estimated_hrs"),
                    "collaborators": [c for c in (item.get("collaborator") or []) if c],
                    "deferred": bool(item.get("deferred")),
                    "defer_reason": item.get("defer_reason"),
                    "item_key": item_key,
                    "derived_from": [event_id],
                    "sources": [item_key] if item_key in artifacts else [],
                })
    return rows


# ---------------------------------------------------------------------------
# Ticket states
# ---------------------------------------------------------------------------
@dataclass
class Ticket:
    key: str
    created: str                  # day, YYYY-MM-DD
    status: str = TODO
    title: str | None = None
    department: str | None = None
    points: int | None = None
    sprint_no: int | None = None
    reporter: str | None = None


@dataclass(order=True)
class Change:
    """Something that happened to a ticket. `at` orders changes within a day:
    plans count at the start of their day (0), events at their own time."""
    day: str
    at: float
    event_id: str
    ticket: str = field(compare=False)
    status: str | None = field(default=None, compare=False)
    assignee: str | None = field(default=None, compare=False)
    cites: tuple[str, ...] = field(default=(), compare=False)


def work_item_states(tickets: Iterable[Ticket], changes: Iterable[Change]) -> list[dict]:
    """Tickets and their changes -> work_item_state rows, one per interval."""
    by_ticket: dict[str, list[Change]] = {}
    for change in changes:
        by_ticket.setdefault(change.ticket, []).append(change)

    rows: list[dict] = []
    for ticket in sorted(tickets, key=lambda t: t.key):
        base = {
            "item_key": ticket.key,
            "title": ticket.title,
            "department": ticket.department,
            "points": ticket.points,
            "sprint_no": ticket.sprint_no,
            "reporter": ticket.reporter,
        }
        status, assignee = ticket.status or TODO, None
        current = {**base, "valid_from": ticket.created, "valid_to": None,
                   "status": status, "assignee": assignee,
                   "derived_from": [], "sources": [ticket.key]}
        intervals = [current]

        # Group by day; a change dated before the ticket existed counts on
        # its creation day.
        days: dict[str, list[Change]] = {}
        for change in sorted(by_ticket.get(ticket.key, [])):
            days.setdefault(max(change.day, ticket.created), []).append(change)

        for day in sorted(days):
            events, cites = [], []
            for change in days[day]:
                if change.status:
                    status = change.status
                if change.assignee:
                    assignee = change.assignee
                events.append(change.event_id)
                cites.extend(change.cites)
            if (status, assignee) == (current["status"], current["assignee"]):
                # Nothing a reader would see changed; still, the interval now
                # rests on these events too.
                _extend(current, events, cites)
                continue
            if day == current["valid_from"]:
                current["status"], current["assignee"] = status, assignee
                _extend(current, events, cites)
                continue
            current["valid_to"] = day
            current = {**base, "valid_from": day, "valid_to": None,
                       "status": status, "assignee": assignee,
                       "derived_from": [], "sources": [ticket.key]}
            _extend(current, events, cites)
            intervals.append(current)
        rows.extend(intervals)
    return rows


def _extend(row: dict, events: list[str], cites: list[str]) -> None:
    for event in events:
        if event not in row["derived_from"]:
            row["derived_from"].append(event)
    for cite in cites:
        if cite not in row["sources"]:
            row["sources"].append(cite)


def roster_rows(entries: Iterable[dict], hires: Iterable[dict], departures: Iterable[dict]) -> list[dict]:
    """Everyone who worked here, and when they joined and left.

    The people named in any day plan are the staff; a hire event gives a
    join day, a departure event a leave day. Someone with neither was there
    all along. The department is the one their latest plan names, else the
    event's. No reason for leaving is kept.
    """
    people: dict[str, dict] = {}

    def person(name: str) -> dict:
        return people.setdefault(name, {
            "person": name, "joined_on": None, "left_on": None,
            "role": None, "department": None, "derived_from": [],
        })

    latest_plan: dict[str, str] = {}
    for entry in sorted(entries, key=lambda row: (row["day"], row["person"], row["seq"])):
        person(entry["person"])
        latest_plan[entry["person"]] = entry.get("department")
    for hire in hires:
        row = person(hire["person"])
        row["joined_on"] = hire["day"]
        row["role"] = row["role"] or hire.get("role")
        row["department"] = row["department"] or hire.get("department")
        row["derived_from"].append(hire["event"])
    for departure in departures:
        row = person(departure["person"])
        row["left_on"] = departure["day"]
        row["role"] = row["role"] or departure.get("role")
        row["department"] = row["department"] or departure.get("department")
        row["derived_from"].append(departure["event"])
    for name, department in latest_plan.items():
        if department:
            people[name]["department"] = department
    return [people[name] for name in sorted(people)]


def plan_changes(entries: Iterable[dict], known: set[str]) -> list[Change]:
    """A day plan listing a ticket says who is working on it that day."""
    return [
        Change(day=entry["day"], at=0.0, event_id=entry["derived_from"][0],
               ticket=entry["item_key"], assignee=entry["person"])
        for entry in entries
        if entry["item_key"] in known
    ]


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def _json(value):
    """jsonb arrives as a dict from psycopg and as text from simpler drivers."""
    if value is None or isinstance(value, (dict, list)):
        return value
    return json.loads(value)


def _int(value):
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def read(cursor) -> tuple[list[dict], list[dict], dict]:
    cursor.execute("SELECT source_id FROM source_documents WHERE category = 'artifact'")
    artifacts = {row[0] for row in cursor.fetchall()}

    cursor.execute(
        f"""
        SELECT source_id, {DAY}, facts::text
        FROM source_documents
        WHERE source_type = 'dept_plan_created' AND {DAY} IS NOT NULL
        """
    )
    plans = [(event_id, day, _json(facts)) for event_id, day, facts in cursor.fetchall()]
    entries = plan_entries(plans, artifacts)

    cursor.execute(
        f"""
        SELECT source_id, {DAY}, facts::text, actors::text
        FROM source_documents
        WHERE source_type = 'jira' AND category = 'artifact' AND {DAY} IS NOT NULL
        """
    )
    tickets = []
    for key, day, facts, actors in cursor.fetchall():
        facts, actors = _json(facts) or {}, _json(actors) or []
        tickets.append(Ticket(
            key=key,
            created=day,
            status=facts.get("status") or TODO,
            title=facts.get("title"),
            department=facts.get("dept"),
            points=_int(facts.get("points")),
            sprint_no=_int(facts.get("sprint_number")),
            reporter=actors[0] if actors else None,
        ))
    known = {ticket.key for ticket in tickets}

    cursor.execute(
        f"""
        SELECT source_id, {DAY}, extract(epoch FROM occurred_at)::text,
               facts::text, actors::text
        FROM source_documents
        WHERE source_type = 'ticket_progress' AND {DAY} IS NOT NULL
        """
    )
    changes: list[Change] = []
    skipped = 0
    for event_id, day, epoch, facts, actors in cursor.fetchall():
        facts, actors = _json(facts) or {}, _json(actors) or []
        ticket = facts.get("ticket_id")
        if ticket not in known:
            skipped += 1
            continue
        if facts.get("new_assignee"):
            changes.append(Change(day=day, at=float(epoch or 0), event_id=event_id, ticket=ticket,
                                  status=facts.get("new_status"), assignee=facts["new_assignee"]))
            continue
        cites = tuple(
            ref for ref in (facts.get("completion_artifact"), facts.get("spawned_pr"))
            if ref in artifacts
        )
        changes.append(Change(day=day, at=float(epoch or 0), event_id=event_id, ticket=ticket,
                              status=facts.get("status"),
                              assignee=actors[0] if actors else None, cites=cites))
    changes.extend(plan_changes(entries, known))
    states = work_item_states(tickets, changes)

    cursor.execute(
        """
        SELECT source_id, source_type FROM source_documents
        WHERE category = 'artifact' AND occurred_at IS NULL ORDER BY source_id
        """
    )
    undated = cursor.fetchall()

    # Joins and departures, for the roster. Only who, when, role and
    # department are read: the events' other fields are the simulator's own
    # account of what the departure cost, which runtime code must not see.
    moves: dict[str, list[dict]] = {"employee_hired": [], "employee_departed": []}
    for kind in moves:
        cursor.execute(
            f"""
            SELECT source_id, {DAY}, facts->>'name', facts->>'role', facts->>'dept', actors->>0
            FROM source_documents WHERE source_type = %s AND {DAY} IS NOT NULL
            ORDER BY occurred_at, source_id
            """,
            (kind,),
        )
        for event_id, day, name, role, department, actor in cursor.fetchall():
            if name or actor:
                moves[kind].append({"person": name or actor, "day": day, "role": role,
                                    "department": department, "event": event_id})
    roster = roster_rows(entries, moves["employee_hired"], moves["employee_departed"])
    return entries, states, {"skipped_progress": skipped, "undated": undated, "roster": roster}


def write(cursor, table: str, rows: list[dict], chunk: int = 200) -> None:
    cursor.execute(f"DELETE FROM {table}")
    for start in range(0, len(rows), chunk):
        cursor.execute(
            f"INSERT INTO {table} SELECT * FROM jsonb_populate_recordset(NULL::{table}, %s::jsonb)",
            (json.dumps(rows[start:start + chunk], ensure_ascii=False),),
        )


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required.")
    if psycopg is None:
        raise RuntimeError("psycopg is required: pip install 'psycopg[binary]'")

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            entries, states, report = read(cursor)
            write(cursor, "day_plan_entry", entries)
            write(cursor, "work_item_state", states)
            write(cursor, "employee_roster", report["roster"])
        connection.commit()

    people = len({entry["person"] for entry in entries})
    days = sorted({entry["day"] for entry in entries})
    print(f"day_plan_entry:  {len(entries)} items, {people} people, "
          f"{len(days)} days ({days[0] if days else '-'} .. {days[-1] if days else '-'})", file=sys.stderr)
    tickets = len({state["item_key"] for state in states})
    assigned = len({state["item_key"] for state in states if state["assignee"]})
    print(f"work_item_state: {len(states)} intervals, {tickets} tickets, "
          f"{assigned} ever assigned", file=sys.stderr)
    roster = report["roster"]
    print(f"employee_roster: {len(roster)} people, {sum(1 for row in roster if row['joined_on'])} joined, "
          f"{sum(1 for row in roster if row['left_on'])} left", file=sys.stderr)
    if report["skipped_progress"]:
        print(f"skipped {report['skipped_progress']} progress events for tickets with no jira artifact",
              file=sys.stderr)
    if report["undated"]:
        print(f"{len(report['undated'])} artifacts have no date and are invisible under any as-of date; "
              "check them by hand:", file=sys.stderr)
        for source_id, source_type in report["undated"]:
            print(f"  {source_type:16} {source_id}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
