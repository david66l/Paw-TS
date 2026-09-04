import unittest

from temporal_event_ledger_shadow import TurnCandidate
from temporal_event_slot_shadow import (
    SlotSpec,
    TemporalPlan,
    combine_binding_results,
    compile_plan,
    validate_binding,
)


def candidates(count: int) -> list[TurnCandidate]:
    return [
        TurnCandidate(
            evidence_ref=f"source-{index}#turn-1",
            source_id=f"source-{index}",
            session_timestamp=f"2025-01-{index:02d}T00:00:00Z",
            session_order=index,
            turn_order=1,
            content=f"event {index}",
            has_answer=False,
        )
        for index in range(1, count + 1)
    ]


class TemporalEventSlotShadowTest(unittest.TestCase):
    def test_planner_compiles_lookup_and_ignores_window_unit(self) -> None:
        plan, status = compile_plan(
            {
                "decision": "plan",
                "operator": "locate_event",
                "unit": "week",
                "eventSlots": [
                    {
                        "slotId": "E1",
                        "role": "target_event",
                        "queryMention": "event last week",
                    }
                ],
            }
        )

        self.assertEqual("planned", status)
        self.assertIsNotNone(plan)
        self.assertIsNone(plan.unit)

    def test_planner_requires_directional_duration_slots(self) -> None:
        plan, status = compile_plan(
            {
                "decision": "plan",
                "operator": "duration_between",
                "unit": "months",
                "eventSlots": [
                    {"slotId": "E1", "role": "start_event", "queryMention": "start"},
                    {"slotId": "E2", "role": "end_event", "queryMention": "end"},
                ],
            }
        )

        self.assertEqual("planned", status)
        self.assertEqual("month", plan.unit)

    def test_planner_rejects_wrong_slot_roles(self) -> None:
        plan, status = compile_plan(
            {
                "decision": "plan",
                "operator": "duration_between",
                "unit": "month",
                "eventSlots": [
                    {"slotId": "E1", "role": "target_event", "queryMention": "event"}
                ],
            }
        )

        self.assertIsNone(plan)
        self.assertEqual("invalid_slot_roles", status)

    def test_binding_keeps_primary_and_supporting_turns_per_slot(self) -> None:
        plan = TemporalPlan(
            "duration_between",
            "year",
            (
                SlotSpec("E1", "start_event", "career start"),
                SlotSpec("E2", "end_event", "current job"),
            ),
        )
        pool = candidates(4)
        certified, selected, status = validate_binding(
            {
                "decision": "select",
                "eventSlots": [
                    {
                        "slotId": "E1",
                        "primaryCandidateId": "C01",
                        "supportingCandidateIds": ["C02"],
                    },
                    {
                        "slotId": "E2",
                        "primaryCandidateId": "C02",
                        "supportingCandidateIds": ["C03"],
                    },
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )

        self.assertTrue(certified)
        self.assertEqual("certified", status)
        self.assertEqual(pool[:3], selected)

    def test_binding_rejects_evidence_dumping(self) -> None:
        plan = TemporalPlan(
            "locate_event",
            None,
            (SlotSpec("E1", "target_event", "target"),),
        )
        certified, selected, status = validate_binding(
            {
                "decision": "select",
                "eventSlots": [
                    {
                        "slotId": "E1",
                        "primaryCandidateId": "C01",
                        "supportingCandidateIds": ["C02", "C03", "C04", "C05"],
                    }
                ],
            },
            plan,
            candidates(5),
            "2025-01-31T00:00:00Z",
        )

        self.assertFalse(certified)
        self.assertEqual([], selected)
        self.assertEqual("invalid_slot_binding", status)

    def test_committee_unions_only_certified_bindings_in_rank_order(self) -> None:
        pool = candidates(4)
        certified, selected, statuses, hashes = combine_binding_results(
            [
                (True, [pool[2], pool[0]], "certified", "hash-a"),
                (False, [pool[3]], "invalid_slot_binding", "hash-b"),
                (True, [pool[1]], "certified", "hash-c"),
            ],
            pool,
        )

        self.assertTrue(certified)
        self.assertEqual(pool[:3], selected)
        self.assertEqual(
            ["certified", "invalid_slot_binding", "certified"], statuses
        )
        self.assertEqual(["hash-a", "hash-b", "hash-c"], hashes)


if __name__ == "__main__":
    unittest.main()
