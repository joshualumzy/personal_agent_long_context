"""Focused regression checks for the OrgForge import boundary."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from ingest import is_retrievable_artifact, parse_timestamp


class IngestTests(unittest.TestCase):
    def test_parses_iso_timestamp_and_z_suffix(self) -> None:
        self.assertEqual(
            parse_timestamp("2026-09-24T03:04:05Z"),
            datetime(2026, 9, 24, 3, 4, 5, tzinfo=timezone.utc),
        )

    def test_rejects_every_non_artifact_or_oracle_row(self) -> None:
        self.assertTrue(is_retrievable_artifact({"doc_type": "jira", "doc_id": "JIRA-1"}, "artifact"))
        self.assertFalse(is_retrievable_artifact({"doc_type": "jira", "doc_id": "JIRA-1"}, None))
        self.assertFalse(is_retrievable_artifact({"doc_type": "jira", "doc_id": "EVT-1"}, "sim_event"))
        self.assertFalse(
            is_retrievable_artifact({"doc_type": "datadog_metric", "doc_id": "METRIC-1"}, "artifact")
        )

    def test_rejects_an_event_id_even_with_an_allowed_type_and_artifact_category(self) -> None:
        # The exact shape of tonight's incident: a row that looks admissible by
        # category and doc_type alone, but whose EVT- id marks it as oracle
        # material that must never reach the retrieval layer.
        self.assertFalse(
            is_retrievable_artifact(
                {"doc_type": "jira", "doc_id": "EVT-38-jira_ticket_created-9001"}, "artifact"
            )
        )


if __name__ == "__main__":
    unittest.main()
