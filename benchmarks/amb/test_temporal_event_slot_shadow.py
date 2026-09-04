import unittest

from temporal_event_ledger_shadow import TurnCandidate
from temporal_event_slot_shadow import (
    SlotSpec,
    TemporalPlan,
    combine_binding_results,
    compile_question_plan,
    compile_plan,
    content_free_consensus_slots,
    content_free_plan_slots,
    directional_slots,
    intersect_event_packet_bindings,
    select_target_query_hmacs,
    validate_binding,
    validate_event_packet_binding,
    validate_event_packet_proposal,
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
    def test_ledger_target_scope_does_not_filter_on_answer_correctness(self) -> None:
        rows = [
            {"queryHmac": "a", "answerCorrect": True},
            {"queryHmac": "b", "answerCorrect": False},
            {"queryHmac": "c"},
        ]

        targets, historical_errors = select_target_query_hmacs(rows, "ledger")

        self.assertEqual({"a", "b", "c"}, targets)
        self.assertEqual({"b"}, historical_errors)

    def test_error_target_scope_retains_residual_development_mode(self) -> None:
        rows = [
            {"queryHmac": "a", "answerCorrect": True},
            {"queryHmac": "b", "answerCorrect": False},
        ]

        targets, historical_errors = select_target_query_hmacs(
            rows, "baseline-errors"
        )

        self.assertEqual({"b"}, targets)
        self.assertEqual({"b"}, historical_errors)

    def test_deterministic_planner_compiles_two_event_since_when_interval(self) -> None:
        plan = compile_question_plan(
            "How many weeks had passed since I recovered from the flu when I went on my 10th jog outdoors?"
        )

        self.assertEqual("duration_between", plan.operator)
        self.assertEqual("week", plan.unit)
        self.assertEqual(["start_event", "end_event"], [slot.role for slot in plan.slots])
        for slot in plan.slots:
            self.assertEqual(
                slot.query_mention,
                "How many weeks had passed since I recovered from the flu when I went on my 10th jog outdoors?"[
                    slot.query_start : slot.query_end
                ],
            )

    def test_directional_before_slots_preserve_semantic_direction(self) -> None:
        question = (
            "How many days before my friend's party did I order the birthday gift?"
        )
        slots = directional_slots(question)

        self.assertIsNotNone(slots)
        self.assertEqual("I order the birthday gift", slots[0].query_mention)
        self.assertEqual("my friend's party", slots[1].query_mention)

    def test_deterministic_planner_compiles_latest_collection(self) -> None:
        plan = compile_question_plan(
            "Which streaming service did I start using most recently?"
        )

        self.assertEqual("latest_event", plan.operator)
        self.assertEqual("event_set", plan.slots[0].role)

    def test_deterministic_planner_compiles_declarative_attribute_lookup(self) -> None:
        plan = compile_question_plan(
            "I received a piece of jewelry last Saturday from whom?"
        )

        self.assertIsNotNone(plan)
        self.assertEqual("locate_event", plan.operator)
        self.assertEqual("target_event", plan.slots[0].role)

    def test_deterministic_planner_does_not_confuse_relative_first_noun(self) -> None:
        plan = compile_question_plan(
            "How many days ago did I harvest my first batch of fresh herbs?"
        )

        self.assertEqual("elapsed_since", plan.operator)
        self.assertEqual("target_event", plan.slots[0].role)

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

    def test_event_packet_accepts_bounded_multi_turn_event(self) -> None:
        plan = TemporalPlan(
            "locate_event",
            None,
            (SlotSpec("E1", "target_event", "event last week"),),
        )
        valid, selected, status = validate_event_packet_binding(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C03", "C01", "C02"]}
                ],
            },
            plan,
            candidates(4),
            "2025-01-31T00:00:00Z",
        )

        self.assertTrue(valid)
        self.assertEqual("address_valid", status)
        self.assertEqual([candidates(4)[2], candidates(4)[0], candidates(4)[1]], selected)

    def test_event_packet_revision_preserves_slot_roles(self) -> None:
        plan = TemporalPlan(
            "duration_between",
            "day",
            (
                SlotSpec("E1", "start_event", "start"),
                SlotSpec("E2", "end_event", "end"),
            ),
        )
        pool = candidates(2)
        first, _ = validate_event_packet_proposal(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C01"]},
                    {"slotId": "E2", "candidateIds": ["C02"]},
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )
        swapped, _ = validate_event_packet_proposal(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C02"]},
                    {"slotId": "E2", "candidateIds": ["C01"]},
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )

        self.assertIsNotNone(first)
        self.assertIsNotNone(swapped)
        self.assertNotEqual(first.canonical_revision(), swapped.canonical_revision())

    def test_content_free_packet_keeps_slot_roles_without_raw_addresses(self) -> None:
        plan = TemporalPlan(
            "duration_between",
            "day",
            (
                SlotSpec("E1", "start_event", "start", 10, 15),
                SlotSpec("E2", "end_event", "end", 20, 23),
            ),
        )
        pool = candidates(2)
        binding, _ = validate_event_packet_proposal(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C01"]},
                    {"slotId": "E2", "candidateIds": ["C02"]},
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )

        plan_slots = content_free_plan_slots(plan)
        packet_slots = content_free_consensus_slots(binding, plan, b"test-key")

        self.assertEqual(["start_event", "end_event"], [x["role"] for x in plan_slots])
        self.assertEqual(["start_event", "end_event"], [x["role"] for x in packet_slots])
        rendered = str(packet_slots)
        self.assertNotIn("source-1#turn-1", rendered)
        self.assertNotIn("source-2#turn-1", rendered)

    def test_packet_consensus_keeps_only_per_slot_intersection(self) -> None:
        plan = TemporalPlan(
            "duration_between",
            "day",
            (
                SlotSpec("E1", "start_event", "start"),
                SlotSpec("E2", "end_event", "end"),
            ),
        )
        pool = candidates(5)
        first, _ = validate_event_packet_proposal(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C01", "C03"]},
                    {"slotId": "E2", "candidateIds": ["C02", "C04"]},
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )
        second, _ = validate_event_packet_proposal(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C01"]},
                    {"slotId": "E2", "candidateIds": ["C02", "C05"]},
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )

        consensus, status = intersect_event_packet_bindings(
            [first, second], 2, plan, pool
        )

        self.assertEqual("consensus_address_valid", status)
        self.assertIsNotNone(consensus)
        self.assertEqual((pool[0], pool[1]), consensus.selected())

    def test_packet_consensus_rejects_role_swaps(self) -> None:
        plan = TemporalPlan(
            "duration_between",
            "day",
            (
                SlotSpec("E1", "start_event", "start"),
                SlotSpec("E2", "end_event", "end"),
            ),
        )
        pool = candidates(2)
        first, _ = validate_event_packet_proposal(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C01"]},
                    {"slotId": "E2", "candidateIds": ["C02"]},
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )
        swapped, _ = validate_event_packet_proposal(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": ["C02"]},
                    {"slotId": "E2", "candidateIds": ["C01"]},
                ],
            },
            plan,
            pool,
            "2025-01-31T00:00:00Z",
        )

        consensus, status = intersect_event_packet_bindings(
            [first, swapped], 2, plan, pool
        )

        self.assertIsNone(consensus)
        self.assertEqual("empty_slot_consensus", status)

    def test_event_packet_rejects_global_budget_overflow(self) -> None:
        plan = TemporalPlan(
            "duration_between",
            "day",
            (
                SlotSpec("E1", "start_event", "start"),
                SlotSpec("E2", "end_event", "end"),
            ),
        )
        valid, selected, status = validate_event_packet_binding(
            {
                "decision": "select",
                "eventSlots": [
                    {"slotId": "E1", "candidateIds": [f"C{i:02d}" for i in range(1, 8)]},
                    {"slotId": "E2", "candidateIds": [f"C{i:02d}" for i in range(8, 14)]},
                ],
            },
            plan,
            candidates(13),
            "2025-01-31T00:00:00Z",
        )

        self.assertFalse(valid)
        self.assertEqual([], selected)
        self.assertEqual("packet_budget_exceeded", status)

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

    def test_committee_applies_rank_order_packet_budget(self) -> None:
        pool = candidates(4)
        valid, selected, _, _ = combine_binding_results(
            [
                (True, [pool[3], pool[1]], "address_valid", "hash-a"),
                (True, [pool[2], pool[0]], "address_valid", "hash-b"),
            ],
            pool,
            max_selected=3,
        )

        self.assertTrue(valid)
        self.assertEqual(pool[:3], selected)


if __name__ == "__main__":
    unittest.main()
