from __future__ import annotations

import unittest
from dataclasses import dataclass, field
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from persona_holdout_plan import (
    build_persona_disjoint_plan,
    parse_range,
    queries_for_partition,
    validate_persona_disjoint_plan,
)


@dataclass
class FakeQuery:
    id: str
    user_id: str
    gold_ids: list[str]
    meta: dict = field(default_factory=dict)


class PersonaHoldoutPlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.queries = [
            FakeQuery(
                f"q-{index}",
                f"persona-{index // 2}",
                [f"doc-{index}"],
                {"question_type": "fact"},
            )
            for index in range(12)
        ]

    def test_excludes_every_persona_seen_in_prior_ranges(self) -> None:
        plan = build_persona_disjoint_plan(
            self.queries,
            excluded_ranges=[(0, 3)],
            partition_sizes={"dev": 2, "test": 2},
            seed="stable",
        )
        selected = [row for rows in plan["partitions"].values() for row in rows]
        self.assertEqual(4, len(selected))
        self.assertTrue(all(row["queryIndex"] >= 4 for row in selected))
        self.assertEqual(4, len({row["personaFingerprint"] for row in selected}))

    def test_selection_is_deterministic_and_content_free(self) -> None:
        first = build_persona_disjoint_plan(
            self.queries,
            excluded_ranges=[],
            partition_sizes={"dev": 2},
            seed="stable",
        )
        second = build_persona_disjoint_plan(
            self.queries,
            excluded_ranges=[],
            partition_sizes={"dev": 2},
            seed="stable",
        )
        self.assertEqual(first, second)
        encoded = str(first)
        for query in self.queries:
            self.assertNotIn(query.user_id, encoded)
            self.assertNotIn(query.gold_ids[0], encoded)

    def test_validation_rejects_persona_reuse(self) -> None:
        plan = build_persona_disjoint_plan(
            self.queries,
            excluded_ranges=[],
            partition_sizes={"dev": 1, "test": 1},
            seed="stable",
        )
        plan["partitions"]["test"][0] = dict(plan["partitions"]["dev"][0])
        with self.assertRaisesRegex(
            ValueError, "selected more than once|reused a persona"
        ):
            validate_persona_disjoint_plan(plan, self.queries)

    def test_partition_lookup_revalidates_fingerprints(self) -> None:
        plan = build_persona_disjoint_plan(
            self.queries,
            excluded_ranges=[],
            partition_sizes={"dev": 1},
            seed="stable",
        )
        selected = queries_for_partition(plan, self.queries, "dev")
        self.assertEqual(1, len(selected))
        plan["partitions"]["dev"][0]["queryFingerprint"] = "drifted"
        with self.assertRaisesRegex(ValueError, "fingerprint drifted"):
            queries_for_partition(plan, self.queries, "dev")

    def test_parse_range_is_half_open(self) -> None:
        self.assertEqual((0, 189), parse_range("0:189"))


if __name__ == "__main__":
    unittest.main()
