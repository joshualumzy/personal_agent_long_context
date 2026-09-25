"""Focused regression checks for the OrgForge import boundary."""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from ingest import is_runtime_artifact, parse_timestamp


class IngestTests(unittest.TestCase):
    def test_parses_iso_timestamp_and_z_suffix(self) -> None:
        self.assertEqual(
            parse_timestamp("2026-09-24T03:04:05Z"),
            datetime(2026, 9, 24, 3, 4, 5, tzinfo=timezone.utc),
        )

    def test_rejects_every_non_artifact_or_oracle_row(self) -> None:
        self.assertTrue(is_runtime_artifact({"category": "artifact", "doc_type": "jira", "doc_id": "JIRA-1"}))
        self.assertFalse(is_runtime_artifact({"category": None, "doc_type": "jira", "doc_id": "JIRA-1"}))
        self.assertFalse(is_runtime_artifact({"category": "sim_event", "doc_type": "jira", "doc_id": "EVT-1"}))
        self.assertFalse(
            is_runtime_artifact({"category": "artifact", "doc_type": "datadog_metric", "doc_id": "METRIC-1"})
        )


if __name__ == "__main__":
    unittest.main()
