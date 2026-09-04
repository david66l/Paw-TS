import inspect
import json
import tempfile
import unittest
from pathlib import Path

from preference_user_authority_gold_evaluator import evaluate
from preference_user_authority_shadow import (
    SCHEMA_VERSION,
    UserSession,
    content_free_source_certificate,
    load_checkpoint,
    project_complete_anchor_sessions,
    projection_candidate_sources,
    rank_sessions_bm25,
    stable_union,
    user_only_sessions,
)
from temporal_event_ledger_shadow import eval_hmac, hmac_ref, sha256_text


def item(*, assistant_text: str = "assistant noise"):
    return {
        "question_id": "q1",
        "question": "Which hiking trail did I enjoy?",
        "question_date": "2025-01-10",
        "haystack_sessions": [
            [
                {"role": "user", "content": "I enjoyed the ridge hiking trail."},
                {"role": "assistant", "content": assistant_text},
            ],
            [{"role": "user", "content": "I disliked the city walk."}],
            [{"role": "user", "content": "I enjoyed a later hiking trail."}],
        ],
        "haystack_session_ids": ["dup", "dup", "late"],
        "haystack_dates": ["2025-01-01", "2025-01-02", "2025-02-01"],
    }


class PreferenceUserAuthorityShadowTest(unittest.TestCase):
    def test_assistant_noise_does_not_change_user_stream_or_bm25(self) -> None:
        first = user_only_sessions(item(assistant_text="unrelated response"), "2025-01-10T00:00:00Z")
        second = user_only_sessions(item(assistant_text="very different assistant output"), "2025-01-10T00:00:00Z")

        self.assertEqual(first, second)
        self.assertEqual(
            rank_sessions_bm25("hiking trail", first, 4),
            rank_sessions_bm25("hiking trail", second, 4),
        )

    def test_selector_path_does_not_reference_label_turn_marker(self) -> None:
        source = inspect.getsource(user_only_sessions)

        self.assertNotIn("has" + "_answer", source)
        self.assertNotIn("question" + "_type", source)

    def test_duplicate_session_ids_are_collision_safe_and_cutoff_is_enforced(self) -> None:
        sessions = user_only_sessions(item(), "2025-01-10T00:00:00Z")

        self.assertEqual(2, len(sessions))
        self.assertEqual(["q1_dup~occurrence-1", "q1_dup~occurrence-2"], [x.source_id for x in sessions])
        self.assertNotIn("late", " ".join(x.source_id for x in sessions))

    def test_baseline_union_keeps_identity_order_and_cap(self) -> None:
        baseline = tuple(f"source-{index}" for index in range(8))
        auxiliary = [
            UserSession("duplicate", "source-7", "2025-01-01T00:00:00Z", 1, ()),
            UserSession("new-a", "source-8", "2025-01-02T00:00:00Z", 2, ()),
            UserSession("new-b", "source-9", "2025-01-03T00:00:00Z", 3, ()),
            UserSession("new-c", "source-10", "2025-01-04T00:00:00Z", 4, ()),
            UserSession("new-d", "source-11", "2025-01-05T00:00:00Z", 5, ()),
            UserSession("over-cap", "source-12", "2025-01-06T00:00:00Z", 6, ()),
        ]

        union = stable_union(baseline, auxiliary)

        self.assertEqual(baseline, union[:8])
        self.assertEqual(tuple(f"source-{index}" for index in range(12)), union)

    def test_same_inputs_make_same_certificate(self) -> None:
        sessions = user_only_sessions(item(), "2025-01-10T00:00:00Z")
        baseline = tuple(session.source_hash for session in sessions)
        first = content_free_source_certificate(
            sessions, baseline, [], baseline, baseline, baseline, 1000, False, 0, b"key"
        )
        second = content_free_source_certificate(
            sessions, baseline, [], baseline, baseline, baseline, 1000, False, 0, b"key"
        )

        self.assertEqual(first, second)
        self.assertEqual(first["hydratedUserTurnCount"], 2)

    def test_projection_keeps_complete_source_order_under_context_budget(self) -> None:
        sessions = user_only_sessions(item(), "2025-01-10T00:00:00Z")
        baseline = tuple(session.source_hash for session in sessions)
        first_size = len(sessions[0].document)
        projection, fallback, omitted = project_complete_anchor_sessions(
            sessions, baseline, first_size
        )

        self.assertEqual((baseline[0],), projection)
        self.assertTrue(fallback)
        self.assertEqual(1, omitted)

    def test_projection_candidates_add_locked_lexical_rescue_after_baseline_four(self) -> None:
        raw = item()
        raw["haystack_sessions"] = [
            [{"role": "user", "content": f"unrelated archive {index}"}]
            for index in range(5)
        ] + [[{"role": "user", "content": "Denver live music memory"}]]
        raw["haystack_session_ids"] = [f"s{index}" for index in range(6)]
        raw["haystack_dates"] = [f"2025-01-{index + 1:02d}" for index in range(6)]
        sessions = user_only_sessions(raw, "2025-01-10T00:00:00Z")
        baseline = tuple(session.source_hash for session in sessions)

        candidates = projection_candidate_sources("What should I do in Denver?", sessions, baseline)

        self.assertEqual(baseline[:4], candidates[:4])
        self.assertIn(baseline[5], candidates[4:])

    def test_checkpoint_rejects_forbidden_evaluation_field(self) -> None:
        policy = {"version": "test"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            path.write_text(
                json.dumps(
                    {
                        "schemaVersion": f"{SCHEMA_VERSION}:checkpoint",
                        "contentFree": True,
                        "policy": policy,
                        "rows": [{"queryHmac": "q", "questionType": "forbidden"}],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                load_checkpoint(path, policy, {"q"})

    def test_gold_evaluator_is_post_freeze_and_proves_no_assistant_turn(self) -> None:
        key = b"key"
        dataset_item = item()
        dataset_item["haystack_sessions"][0][0]["has_answer"] = True
        dataset_item["answer_session_ids"] = ["dup"]
        query_hmac = eval_hmac("q1", key)
        source_id = "q1_dup~occurrence-1"
        source_hash = sha256_text(source_id)
        second_source_id = "q1_dup~occurrence-2"
        second_source_hash = sha256_text(second_source_id)
        selection = {
            "schemaVersion": SCHEMA_VERSION,
            "contentFree": True,
            "rows": [
                {
                    "queryHmac": query_hmac,
                    "certificate": {
                        "stableUnionSourceDocumentHashes": [source_hash, second_source_hash],
                        "projectionSourceDocumentHashes": [source_hash, second_source_hash],
                        "hydratedUserEvidenceRefHmacs": [
                            hmac_ref(f"{source_id}#turn-1", key),
                            hmac_ref(f"{second_source_id}#turn-1", key),
                        ],
                        "rawContextCharCount": len("I enjoyed the ridge hiking trail.") + len("I disliked the city walk."),
                    },
                }
            ],
        }

        output = evaluate(selection, [dataset_item], key)

        self.assertTrue(output["postFreezeOnly"])
        self.assertTrue(output["rows"][0]["sourceCoverageComplete"])
        self.assertTrue(output["rows"][0]["projectionSourceCoverageComplete"])
        self.assertTrue(output["rows"][0]["userEndpointCoverageComplete"])
        self.assertEqual(0, output["rows"][0]["assistantTurnCountInProjectedContext"])


if __name__ == "__main__":
    unittest.main()
