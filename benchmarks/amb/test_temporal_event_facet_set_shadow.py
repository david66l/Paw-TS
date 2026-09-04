import unittest

from temporal_event_ledger_shadow import TurnCandidate
from temporal_event_slot_shadow import SlotSpec, TemporalPlan
from temporal_event_facet_set_shadow import (
    MAX_EVENT_SET_TURNS,
    MAX_PACKET_TURNS,
    _assert_content_free,
    build_event_facet_records,
    content_free_facet_certificate,
    select_event_facet_packet,
    select_slot_facets,
)


def candidate(
    reference: str,
    order: int,
    content: str,
    *,
    source: str = "source-a",
    has_answer: bool = False,
) -> TurnCandidate:
    return TurnCandidate(
        evidence_ref=reference,
        source_id=source,
        session_timestamp="2025-01-01T00:00:00Z",
        session_order=order,
        turn_order=order,
        content=content,
        has_answer=has_answer,
    )


class EventFacetSetSelectorTest(unittest.TestCase):
    def test_records_keep_same_source_neighbors(self) -> None:
        records = build_event_facet_records(
            [
                candidate("a#1", 1, "I started jogging last Saturday."),
                candidate("a#2", 2, "My knees felt fine after jogging."),
                candidate("b#1", 1, "I watched a movie.", source="source-b"),
            ]
        )

        self.assertEqual(("a#2",), records[0].adjacent_refs)
        self.assertEqual(("a#1",), records[1].adjacent_refs)
        self.assertEqual((), records[2].adjacent_refs)
        self.assertIn("last", records[0].temporal_cues)

    def test_selection_is_invariant_to_gold_marker(self) -> None:
        base = [
            candidate("a#1", 1, "I adopted a cat named Luna last Tuesday."),
            candidate("b#1", 2, "I bought groceries yesterday.", source="source-b"),
        ]
        marked = [
            TurnCandidate(**{**value.__dict__, "has_answer": True}) for value in base
        ]
        slot = SlotSpec("E1", "target_event", "I adopted a cat named Luna")

        first = select_slot_facets(slot, build_event_facet_records(base))
        second = select_slot_facets(slot, build_event_facet_records(marked))

        self.assertEqual(
            [item.candidate.evidence_ref for item in first.selected],
            [item.candidate.evidence_ref for item in second.selected],
        )

    def test_ordinary_slot_stops_after_observable_facet_cover(self) -> None:
        records = build_event_facet_records(
            [
                candidate("a#1", 1, "I adopted Luna from the shelter."),
                candidate("b#1", 2, "I adopted a dog from the shelter.", source="source-b"),
                candidate("c#1", 3, "Luna slept all day.", source="source-c"),
                candidate("d#1", 4, "The weather was sunny.", source="source-d"),
            ]
        )
        selection = select_slot_facets(
            SlotSpec("E1", "target_event", "I adopted Luna from the shelter"), records
        )

        self.assertLessEqual(len(selection.selected), 4)
        self.assertEqual(["a#1"], [item.candidate.evidence_ref for item in selection.selected])

    def test_event_set_and_packet_budgets_are_hard_limited(self) -> None:
        records = build_event_facet_records(
            [
                candidate(
                    f"s{index}#1",
                    index,
                    f"I took flight {index} during january before vacation {index}.",
                    source=f"s{index}",
                )
                for index in range(1, 18)
            ]
        )
        plan = TemporalPlan(
            "order_events",
            None,
            (SlotSpec("E1", "event_set", "flight vacation january before"),),
        )
        selections = select_event_facet_packet(plan, records)
        selected = {
            item.candidate.evidence_ref
            for selection in selections
            for item in selection.selected
        }

        self.assertLessEqual(len(selections[0].selected), MAX_EVENT_SET_TURNS)
        self.assertLessEqual(len(selected), MAX_PACKET_TURNS)

    def test_event_set_prefers_cross_source_competitors(self) -> None:
        records = build_event_facet_records(
            [
                candidate("a#1", 1, "I attended a concert in January."),
                candidate("a#2", 2, "I attended another concert in January."),
                candidate(
                    "b#1", 3, "I attended a concert in January.", source="source-b"
                ),
                candidate(
                    "c#1", 4, "I attended a concert in January.", source="source-c"
                ),
            ]
        )
        selection = select_slot_facets(
            SlotSpec("E1", "event_set", "concert January"), records
        )

        sources = [item.candidate.source_id for item in selection.selected]
        self.assertEqual(["source-a", "source-b", "source-c"], sources[:3])

    def test_certificate_has_only_hmac_addresses_and_shallow_hmac_facets(self) -> None:
        selection = select_slot_facets(
            SlotSpec("E1", "target_event", "adopted Luna"),
            build_event_facet_records([candidate("private-source#turn-1", 1, "I adopted Luna.")]),
        )
        certificate = content_free_facet_certificate(selection, b"test-key")

        self.assertNotIn("private-source#turn-1", str(certificate))
        self.assertNotIn("I adopted Luna.", str(certificate))
        _assert_content_free(certificate)
        with self.assertRaises(ValueError):
            _assert_content_free({"content": "not allowed"})


if __name__ == "__main__":
    unittest.main()
