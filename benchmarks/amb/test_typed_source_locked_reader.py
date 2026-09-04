from __future__ import annotations

from dataclasses import dataclass
import inspect
import json
import unittest

import typed_source_locked_reader as reader


@dataclass(frozen=True)
class Document:
    id: str
    content: str
    timestamp: str


def document(source_id: str, date: str, *turns: tuple[str, str]) -> Document:
    return Document(
        source_id,
        json.dumps([{"role": role, "content": text} for role, text in turns]),
        date,
    )


class TypedSourceLockedReaderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.earlier = document(
            "source-a",
            "2025-01-01",
            ("user", "Please suggest a name"),
            ("assistant", "I suggested Aurora"),
        )
        self.later = document(
            "source-b",
            "2025-01-02",
            ("user", "I bought two red books"),
            ("assistant", "Noted"),
            ("user", "I bought three blue books"),
        )
        self.documents = {item.id: item for item in (self.earlier, self.later)}

    def route(self, question: str, raw: dict, recalled=None):
        return reader.route_typed_source_locked_reader(
            question=question,
            query_timestamp="2025-01-03",
            recalled=recalled or [self.later, self.earlier],
            documents_by_id=self.documents,
            raw=raw,
            legacy_context="legacy",
        )

    def test_assistant_route_preserves_adjacent_roles_and_time_order(self) -> None:
        result = self.route(
            "What did you suggest in our previous conversation?",
            {"evidenceFirstQueryAnswerOriginKind": "explicit_assistant"},
        )
        self.assertEqual("assistant_dialogue", result.route)
        self.assertLess(result.context.index("source-a") if "source-a" in result.context else result.context.index("S01"), result.context.index("S02"))
        self.assertIn("USER: Please suggest a name", result.context)
        self.assertIn("ASSISTANT: I suggested Aurora", result.context)
        self.assertEqual(5, result.turn_count)

    def test_set_route_hydrates_complete_user_sessions_and_omits_assistant_noise(self) -> None:
        result = self.route("How many books did I buy in total?", {})
        self.assertEqual("evidence_set", result.route)
        self.assertIn("two red books", result.context)
        self.assertIn("three blue books", result.context)
        self.assertNotIn("Noted", result.context)
        self.assertEqual("count_members", result.plan["operator"])

    def test_authority_and_set_shape_are_orthogonal(self) -> None:
        result = self.route(
            "How many names did you suggest in our previous conversation?",
            {"evidenceFirstQueryAnswerOriginKind": "explicit_assistant"},
        )
        self.assertEqual("assistant_dialogue_set", result.route)
        self.assertIn("ASSISTANT: I suggested Aurora", result.context)
        self.assertIn("prior-dialogue artifact protocol", result.protocol)
        self.assertIn("typed evidence-set execution protocol", result.protocol)

    def test_lookup_stays_legacy_and_post_cutoff_hydration_falls_back_atomically(self) -> None:
        self.assertEqual("legacy", self.route("What color is my bicycle?", {}).route)
        future = document("future", "2025-02-01", ("user", "future fact"))
        result = reader.route_typed_source_locked_reader(
            question="How many books did I buy?",
            query_timestamp="2025-01-03",
            recalled=[future],
            documents_by_id={future.id: future},
            raw={},
            legacy_context="legacy",
        )
        self.assertEqual("legacy", result.route)
        self.assertEqual("legacy", result.context)
        self.assertIsNotNone(result.fallback_reason)

    def test_router_is_invariant_to_evaluation_metadata(self) -> None:
        baseline = self.route("How many books did I buy?", {})
        poisoned = self.route(
            "How many books did I buy?",
            {
                "question_type": "single-session-assistant",
                "gold_answers": ["999"],
                "has_answer": False,
                "historical_correctness": 1.0,
            },
        )
        self.assertEqual(baseline, poisoned)
        source = inspect.getsource(reader.route_typed_source_locked_reader)
        for forbidden in ("question_type", "gold_answers", "has_answer", "historical_correctness"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
