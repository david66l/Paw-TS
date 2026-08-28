from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from counterfactual_localization import (
    Turn,
    content_safe_event,
    lexical_score,
    load_incorrect_queries,
    rank_turns,
    selected_window,
    summarize,
)


class CounterfactualLocalizationTest(unittest.TestCase):
    def test_ranker_combines_dense_lexical_and_role_signals(self) -> None:
        turns = [
            Turn(0, 0, "user", "I prefer tea"),
            Turn(0, 1, "assistant", "You asked for coffee"),
        ]
        ranked = rank_turns(
            search_text="What drink did I prefer?",
            question_type="single-session-user",
            turns=turns,
            vectors=[[1.0, 0.0], [0.9, 0.1], [1.0, 0.0]],
        )
        self.assertEqual(ranked[0].turn.role, "user")
        self.assertGreater(lexical_score("prefer tea", "I prefer tea"), 0)

    def test_window_adds_only_bounded_adjacent_turns(self) -> None:
        turns = [
            Turn(0, 0, "user", "request"),
            Turn(0, 1, "assistant", "answer"),
            Turn(0, 2, "user", "correction"),
            Turn(0, 3, "assistant", "revision"),
        ]
        ranked = rank_turns(
            search_text="answer",
            question_type="single-session-assistant",
            turns=turns,
            vectors=[[1.0], [0.1], [1.0], [0.1], [0.1]],
        )
        context, metadata = selected_window(turns, ranked, max_anchors=1)
        self.assertIn("request", context)
        self.assertIn("answer", context)
        self.assertIn("correction", context)
        self.assertNotIn("revision", context)
        self.assertEqual(metadata["selectedTurnCount"], 3)

    def test_summary_uses_paired_net_wins_and_four_case_threshold(self) -> None:
        rows = []
        for case_index in range(1, 6):
            rows.append(
                {
                    "caseIndex": case_index,
                    "condition": "current_packet",
                    "correct": False,
                    "contextTokens": 10,
                }
            )
            for condition in (
                "source_locked",
                "oracle_span",
                "structured_synthesis",
            ):
                rows.append(
                    {
                        "caseIndex": case_index,
                        "condition": condition,
                        "correct": condition == "oracle_span" and case_index <= 4,
                        "contextTokens": 10,
                    }
                )
        result = summarize(rows)
        self.assertEqual(result["byCondition"]["oracle_span"]["netWinsVsCurrent"], 4)
        self.assertFalse(result["diagnosis"]["turnLocalizationHypothesisSupported"])

    def test_content_safe_log_rejects_raw_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            content_safe_event(path, "ok", {"caseIndex": 1})
            self.assertEqual(json.loads(path.read_text())["caseIndex"], 1)
            with self.assertRaises(ValueError):
                content_safe_event(path, "bad", {"question": "secret"})

    def test_summary_requires_all_nineteen_cases_for_the_oracle_decision(self) -> None:
        rows = []
        for case_index in range(1, 20):
            for condition in (
                "current_packet",
                "source_locked",
                "oracle_span",
                "structured_synthesis",
            ):
                rows.append(
                    {
                        "caseIndex": case_index,
                        "condition": condition,
                        "correct": condition == "oracle_span" and case_index <= 4,
                        "contextTokens": 10,
                    }
                )
        result = summarize(rows)
        self.assertTrue(result["diagnosis"]["turnLocalizationHypothesisSupported"])

    def test_reconstructs_only_incorrect_queries(self) -> None:
        key = b"k" * 32
        queries = [
            SimpleNamespace(id="a"),
            SimpleNamespace(id="b"),
        ]
        from counterfactual_localization import eval_hmac

        ledger = {
            "rows": [
                {"answerCorrect": False, "queryHmac": eval_hmac("a", key)}
                for _ in range(19)
            ]
        }
        dataset = SimpleNamespace(load_queries=lambda split: queries)
        reconstructed = load_incorrect_queries(dataset, ledger, key)
        self.assertEqual(len(reconstructed), 19)
        self.assertTrue(all(item[1].id == "a" for item in reconstructed))


if __name__ == "__main__":
    unittest.main()
