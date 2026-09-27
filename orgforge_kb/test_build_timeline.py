"""The planner projection, on small hand-written cases.

    python3 -m unittest orgforge_kb/test_build_timeline.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_timeline import Change, Ticket, plan_changes, plan_entries, work_item_states  # noqa: E402


def plan(event_id: str, day: str, *people: tuple[str, list[dict]]) -> tuple[str, str, dict]:
    return (event_id, day, {
        "dept": "Engineering_Backend",
        "engineer_plans": [{"name": name, "dept": "Engineering_Backend", "agenda": agenda}
                           for name, agenda in people],
    })


def item(description: str, **extra) -> dict:
    return {"description": description, "activity_type": "deep_work", "estimated_hrs": 2.0,
            "collaborator": [], "deferred": False, "defer_reason": None, "related_id": None, **extra}


def state_on(rows: list[dict], key: str, day: str) -> dict | None:
    for row in rows:
        if row["item_key"] == key and row["valid_from"] <= day and (row["valid_to"] is None or row["valid_to"] > day):
            return row
    return None


class DayPlanTests(unittest.TestCase):
    def test_each_agenda_item_becomes_one_entry_in_plan_order(self) -> None:
        rows = plan_entries([
            plan("EVT-2-plan", "2026-01-02",
                 ("Jax", [item("design review", collaborator=["Deepa"], activity_type="design_discussion"),
                          item("refactor", related_id="ENG-107")]),
                 ("Deepa", [item("migration", deferred=True, defer_reason="blocked")])),
        ], artifacts={"ENG-107"})

        jax = [row for row in rows if row["person"] == "Jax"]
        self.assertEqual([row["title"] for row in jax], ["design review", "refactor"])
        self.assertEqual([row["seq"] for row in jax], [1, 2])
        self.assertEqual(jax[0]["collaborators"], ["Deepa"])
        self.assertEqual(jax[1]["item_key"], "ENG-107")
        # A ticket that is an artifact is citable; the plan itself never is.
        self.assertEqual(jax[1]["sources"], ["ENG-107"])
        self.assertEqual(jax[0]["sources"], [])
        self.assertEqual(jax[0]["derived_from"], ["EVT-2-plan"])

        deepa = [row for row in rows if row["person"] == "Deepa"]
        self.assertTrue(deepa[0]["deferred"])
        self.assertEqual(deepa[0]["defer_reason"], "blocked")

    def test_a_reference_to_something_not_in_the_corpus_is_kept_but_not_citable(self) -> None:
        rows = plan_entries([plan("EVT-1", "2026-01-01", ("Jax", [item("x", related_id="GONE-1")]))], artifacts=set())
        self.assertEqual(rows[0]["item_key"], "GONE-1")
        self.assertEqual(rows[0]["sources"], [])

    def test_the_same_input_gives_the_same_rows_in_any_order(self) -> None:
        plans = [plan("EVT-1", "2026-01-01", ("Jax", [item("a")])),
                 plan("EVT-2", "2026-01-02", ("Jax", [item("b")]))]
        self.assertEqual(plan_entries(plans, set()), plan_entries(list(reversed(plans)), set()))


class TicketStateTests(unittest.TestCase):
    ticket = Ticket(key="ENG-107", created="2026-01-01", title="tagging", points=2, sprint_no=1, reporter="Chloe")

    def test_status_on_a_day_is_the_last_progress_on_or_before_it(self) -> None:
        rows = work_item_states([self.ticket], [
            Change(day="2026-01-02", at=17.0, event_id="P1", ticket="ENG-107", status="In Progress", assignee="Taylor"),
            Change(day="2026-01-05", at=18.0, event_id="P2", ticket="ENG-107", status="In Review", assignee="Taylor",
                   cites=("PR-100",)),
            Change(day="2026-01-08", at=9.0, event_id="P3", ticket="ENG-107", status="Done", assignee="Taylor"),
        ])
        self.assertEqual(state_on(rows, "ENG-107", "2026-01-01")["status"], "To Do")
        self.assertIsNone(state_on(rows, "ENG-107", "2026-01-01")["assignee"])
        self.assertEqual(state_on(rows, "ENG-107", "2026-01-02")["status"], "In Progress")
        self.assertEqual(state_on(rows, "ENG-107", "2026-01-04")["status"], "In Progress")
        self.assertEqual(state_on(rows, "ENG-107", "2026-01-07")["status"], "In Review")
        self.assertEqual(state_on(rows, "ENG-107", "2026-03-01")["status"], "Done")
        self.assertIsNone(state_on(rows, "ENG-107", "2025-12-31"), "no state before the ticket existed")
        # The PR only becomes a source from the day it appeared.
        self.assertNotIn("PR-100", state_on(rows, "ENG-107", "2026-01-02")["sources"])
        self.assertIn("PR-100", state_on(rows, "ENG-107", "2026-01-05")["sources"])

    def test_the_reporter_is_not_the_assignee(self) -> None:
        rows = work_item_states([self.ticket], [])
        self.assertEqual(rows[0]["reporter"], "Chloe")
        self.assertIsNone(rows[0]["assignee"])

    def test_after_a_reassignment_the_ticket_leaves_the_old_assignee(self) -> None:
        rows = work_item_states([self.ticket], [
            Change(day="2026-01-02", at=1.0, event_id="P1", ticket="ENG-107", status="In Progress", assignee="Morgan"),
            Change(day="2026-02-17", at=1.0, event_id="R1", ticket="ENG-107", status="To Do", assignee="Jax"),
        ])
        self.assertEqual(state_on(rows, "ENG-107", "2026-02-16")["assignee"], "Morgan")
        self.assertEqual(state_on(rows, "ENG-107", "2026-02-17")["assignee"], "Jax")
        self.assertEqual(state_on(rows, "ENG-107", "2026-02-17")["status"], "To Do")

    def test_a_day_counts_once_at_its_end_and_nothing_changing_starts_no_interval(self) -> None:
        rows = work_item_states([self.ticket], [
            Change(day="2026-01-03", at=1.0, event_id="A", ticket="ENG-107", status="In Progress", assignee="Taylor"),
            Change(day="2026-01-03", at=2.0, event_id="B", ticket="ENG-107", status="In Review", assignee="Taylor"),
            Change(day="2026-01-04", at=1.0, event_id="C", ticket="ENG-107", status="In Review", assignee="Taylor"),
        ])
        self.assertEqual([(row["valid_from"], row["status"]) for row in rows],
                         [("2026-01-01", "To Do"), ("2026-01-03", "In Review")])
        self.assertEqual(rows[1]["derived_from"], ["A", "B", "C"])
        self.assertEqual(rows[0]["valid_to"], "2026-01-03")
        self.assertIsNone(rows[1]["valid_to"])

    def test_a_morning_plan_naming_the_ticket_assigns_it_that_day(self) -> None:
        entries = plan_entries([plan("PLAN-3", "2026-01-03", ("Hanna", [item("work", related_id="ENG-107")]))],
                               artifacts={"ENG-107"})
        rows = work_item_states([self.ticket], plan_changes(entries, {"ENG-107"}))
        today = state_on(rows, "ENG-107", "2026-01-03")
        self.assertEqual((today["status"], today["assignee"]), ("To Do", "Hanna"))
        self.assertEqual(today["derived_from"], ["PLAN-3"])

    def test_something_dated_before_the_ticket_counts_on_its_creation_day(self) -> None:
        rows = work_item_states([Ticket(key="X-1", created="2026-01-05")], [
            Change(day="2026-01-02", at=0.0, event_id="EARLY", ticket="X-1", assignee="Jax"),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["valid_from"], rows[0]["assignee"]), ("2026-01-05", "Jax"))

    def test_intervals_never_overlap_and_only_the_last_is_open(self) -> None:
        rows = work_item_states([self.ticket], [
            Change(day=f"2026-01-{day:02d}", at=0.0, event_id=f"E{day}", ticket="ENG-107",
                   status=status, assignee="Taylor")
            for day, status in [(2, "In Progress"), (3, "In Review"), (6, "In Progress"), (9, "Done")]
        ])
        for earlier, later in zip(rows, rows[1:]):
            self.assertEqual(earlier["valid_to"], later["valid_from"])
        self.assertEqual([row["valid_to"] is None for row in rows], [False] * (len(rows) - 1) + [True])


if __name__ == "__main__":
    unittest.main()
