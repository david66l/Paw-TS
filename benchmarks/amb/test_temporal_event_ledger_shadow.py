import unittest

from temporal_event_ledger_shadow import (
    TurnCandidate,
    rank_semantic_rrf,
    selector_prompt,
    validate_selection,
)


def candidate(evidence_ref: str, order: int) -> TurnCandidate:
    return TurnCandidate(
        evidence_ref=evidence_ref,
        source_id=f"source-{order}",
        session_timestamp=f"2025-01-{order:02d}T00:00:00Z",
        session_order=order,
        turn_order=1,
        content=f"event {order}",
        has_answer=False,
    )


class TemporalEventLedgerSelectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.candidates = [candidate("long-private-ref-a", 1), candidate("long-private-ref-b", 2)]
        self.cutoff = "2025-01-31T00:00:00Z"

    def test_prompt_exposes_short_slots_not_evidence_refs(self) -> None:
        prompt = selector_prompt("What happened last week?", self.cutoff, self.candidates)

        self.assertIn("[candidate C01]", prompt)
        self.assertIn("[candidate C02]", prompt)
        self.assertNotIn("long-private-ref-a", prompt)

    def test_locate_event_accepts_one_or_more_slots(self) -> None:
        certified, selected, status = validate_selection(
            {
                "decision": "select",
                "operator": "locate_event",
                "candidateIds": ["C01"],
                "unit": None,
            },
            self.candidates,
            self.cutoff,
        )

        self.assertTrue(certified)
        self.assertEqual("certified", status)
        self.assertEqual([self.candidates[0]], selected)

    def test_duration_requires_two_slots_and_unit(self) -> None:
        certified, selected, status = validate_selection(
            {
                "decision": "select",
                "operator": "duration_between",
                "candidateIds": ["C01", "C02"],
                "unit": "month",
            },
            self.candidates,
            self.cutoff,
        )

        self.assertTrue(certified)
        self.assertEqual("certified", status)
        self.assertEqual(self.candidates, selected)

    def test_unknown_slot_is_rejected(self) -> None:
        certified, selected, status = validate_selection(
            {
                "decision": "select",
                "operator": "locate_event",
                "candidateIds": ["C99"],
                "unit": None,
            },
            self.candidates,
            self.cutoff,
        )

        self.assertFalse(certified)
        self.assertEqual([], selected)
        self.assertEqual("out_of_scope_address", status)

    def test_semantic_rrf_fuses_full_lexical_and_semantic_ranks(self) -> None:
        candidates = [
            TurnCandidate(
                **{
                    **candidate(f"ref-{index}", index).__dict__,
                    "content": "alpha" if index < 3 else "unrelated",
                }
            )
            for index in range(1, 4)
        ]

        class FakeReranker:
            def predict(self, pairs, *, batch_size, show_progress_bar):
                self.call = (pairs, batch_size, show_progress_bar)
                return [0.0, 2.0, 1.0]

        reranker = FakeReranker()
        ranked = rank_semantic_rrf("alpha", candidates, 2, reranker, 8)

        self.assertEqual(["ref-2", "ref-1"], [item.evidence_ref for item in ranked])
        self.assertEqual(8, reranker.call[1])
        self.assertFalse(reranker.call[2])


if __name__ == "__main__":
    unittest.main()
