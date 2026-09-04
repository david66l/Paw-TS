import json
import tempfile
import unittest
from pathlib import Path

from temporal_event_facet_set_shadow import (
    SCHEMA_VERSION,
    Obligation,
    build_event_bundles,
    explicit_collection_members,
    global_trim_and_validate,
    load_checkpoint,
    obligations_for_plan,
    records_from_bundles,
    select_event_packet,
)
from temporal_event_facet_set_gold_evaluator import evaluate
from temporal_event_ledger_shadow import TurnCandidate, eval_hmac, hmac_ref
from temporal_event_slot_shadow import SlotSpec, TemporalPlan


def turn(
    reference: str,
    source: str,
    session: str,
    order: int,
    content: str,
) -> TurnCandidate:
    return TurnCandidate(
        evidence_ref=reference,
        source_id=source,
        session_timestamp=session,
        session_order=order,
        turn_order=order,
        content=content,
        has_answer=False,
    )


def records(*values: TurnCandidate):
    return records_from_bundles(build_event_bundles(list(values)))


class EventBundleSelectorTest(unittest.TestCase):
    def test_full_source_adjacency_is_built_before_retrieval(self) -> None:
        all_records = records(
            turn("a#1", "source-a", "2025-01-01T00:00:00Z", 1, "I attended a concert."),
            turn("a#2", "source-a", "2025-01-01T00:00:00Z", 2, "The concert was outdoors."),
        )
        plan = TemporalPlan("locate_event", None, (SlotSpec("E1", "target_event", "concert"),))
        selected, complete, _, origins = select_event_packet(
            plan, [all_records[1]], all_records, {all_records[1].event_id: 1}
        )

        self.assertTrue(complete)
        self.assertEqual({"a#1", "a#2"}, {x.candidate.evidence_ref for x in selected["E1"]})
        self.assertEqual("source_bounded_closure", origins[("E1", all_records[0].event_id)])

    def test_rank_is_retrieval_tie_break_not_record_state(self) -> None:
        all_records = records(
            turn("a#1", "source-a", "2025-01-01T00:00:00Z", 1, "I started a job."),
            turn("b#1", "source-b", "2025-01-02T00:00:00Z", 1, "I started a job."),
        )
        plan = TemporalPlan("locate_event", None, (SlotSpec("E1", "target_event", "job"),))
        selected, complete, _, _ = select_event_packet(
            plan,
            [all_records[1], all_records[0]],
            all_records,
            {all_records[1].event_id: 1, all_records[0].event_id: 2},
        )

        self.assertTrue(complete)
        self.assertEqual("b#1", selected["E1"][0].candidate.evidence_ref)
        self.assertFalse(hasattr(all_records[0], "initial_rank"))

    def test_event_set_rejects_zero_membership_even_when_lexically_high(self) -> None:
        all_records = records(
            turn("a#1", "source-a", "2025-01-01T00:00:00Z", 1, "Concert notes are blue."),
            turn("b#1", "source-b", "2025-01-02T00:00:00Z", 1, "Concert notes are green."),
        )
        plan = TemporalPlan("order_events", None, (SlotSpec("E1", "event_set", "concert"),))
        _, complete, unmet, _ = select_event_packet(
            plan, all_records, all_records, {record.event_id: index for index, record in enumerate(all_records, 1)}
        )

        self.assertFalse(complete)
        self.assertIn("collection_membership", unmet)

    def test_event_set_prefers_different_sources_over_same_source_high_rank(self) -> None:
        all_records = records(
            turn("a#1", "source-a", "2025-01-01T00:00:00Z", 1, "I attended a concert."),
            turn("a#2", "source-a", "2025-01-01T00:00:00Z", 2, "I attended a concert again."),
            turn("b#1", "source-b", "2025-01-02T00:00:00Z", 1, "I attended a concert."),
        )
        plan = TemporalPlan("order_events", None, (SlotSpec("E1", "event_set", "concert"),))
        selected, complete, _, _ = select_event_packet(
            plan, all_records, all_records, {record.event_id: index for index, record in enumerate(all_records, 1)}
        )

        self.assertTrue(complete)
        self.assertEqual({"source-a", "source-b"}, {x.candidate.source_id for x in selected["E1"]})

    def test_duration_cannot_bind_both_endpoints_to_same_event(self) -> None:
        all_records = records(
            turn("a#1", "source-a", "2025-01-01T00:00:00Z", 1, "I started my job and joined the team."),
        )
        plan = TemporalPlan(
            "duration_between",
            "month",
            (
                SlotSpec("E1", "start_event", "started job"),
                SlotSpec("E2", "end_event", "joined team"),
            ),
        )
        _, complete, _, _ = select_event_packet(plan, all_records, all_records, {all_records[0].event_id: 1})

        self.assertFalse(complete)

    def test_explicit_collection_generates_member_obligations(self) -> None:
        plan = TemporalPlan(
            "order_events",
            None,
            (SlotSpec("E1", "event_set", "What is the order between conference visit and bike ride?"),),
        )
        members = explicit_collection_members(plan.slots[0].query_mention)
        obligations = obligations_for_plan(plan)

        self.assertEqual(2, len(members))
        self.assertEqual(2, sum(item.kind == "collection_member" for item in obligations))

    def test_global_trim_revalidates_and_fails_when_required_slot_is_lost(self) -> None:
        all_records = records(*[
            turn(f"a#{index}", f"source-{index}", f"2025-01-{index:02d}T00:00:00Z", 1, "I attended a concert.")
            for index in range(1, 14)
        ])
        plan = TemporalPlan(
            "locate_event",
            None,
            (
                SlotSpec("E1", "event_set", "concert"),
                SlotSpec("E2", "event_set", "concert"),
                SlotSpec("E3", "target_event", "concert"),
            ),
        )
        obligations = (
            Obligation("E1:event_identity", "E1", "event_identity", ("concert",)),
            Obligation("E2:event_identity", "E2", "event_identity", ("concert",)),
            Obligation("E3:event_identity", "E3", "event_identity", ("concert",)),
        )
        selected = {"E1": all_records[:8], "E2": all_records[8:12], "E3": all_records[12:]}
        ranks = {record.event_id: index for index, record in enumerate(all_records, 1)}
        _, complete, unmet = global_trim_and_validate(plan, obligations, selected, ranks)

        self.assertFalse(complete)
        self.assertIn("event_identity", unmet)

    def test_checkpoint_rejects_gold_or_endpoint_fields(self) -> None:
        policy = {"version": "test"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": f"{SCHEMA_VERSION}:checkpoint",
                        "contentFree": True,
                        "policy": policy,
                        "rows": [{"queryHmac": "query", "goldUserEndpointCount": 1}],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                load_checkpoint(path, policy, {"query"})

    def test_gold_evaluator_is_a_separate_post_freeze_step(self) -> None:
        key = b"test-key"
        dataset = [
            {
                "question_id": "question-1",
                "haystack_sessions": [[{"role": "user", "content": "event", "has_answer": True}]],
                "haystack_session_ids": ["session-1"],
                "haystack_dates": ["2025-01-01"],
            }
        ]
        query_hmac = eval_hmac("question-1", key)
        selection = {
            "schemaVersion": SCHEMA_VERSION,
            "contentFree": True,
            "rows": [
                {
                    "queryHmac": query_hmac,
                    "packetStatus": "facet_complete",
                    "selectedEvidenceRefHmacs": [hmac_ref("question-1_session-1#turn-1", key)],
                }
            ],
        }

        evaluated = evaluate(selection, dataset, key)

        self.assertTrue(evaluated["evaluationIsPostFreezeOnly"])
        self.assertTrue(evaluated["rows"][0]["selectedEndpointCoverageComplete"])


if __name__ == "__main__":
    unittest.main()
