import copy
import inspect
import json
import tempfile
import unittest
from pathlib import Path

import preference_user_authority_reader as reader
from preference_user_authority_shadow import keyed_revision, sha256_file, user_only_sessions
from temporal_event_ledger_shadow import eval_hmac, hmac_ref, timestamp


def dataset_item(assistant_text: str = "assistant-private-noise"):
    return {
        "question_id": "q1",
        "question": "Which trail did I enjoy?",
        "question_date": "2025-01-10",
        "haystack_sessions": [
            [
                {"role": "user", "content": "I enjoyed the ridge trail."},
                {"role": "assistant", "content": assistant_text},
            ],
            [{"role": "user", "content": "I disliked the noisy city walk."}],
        ] + [[{"role": "user", "content": f"archive note {index}"}] for index in range(2, 8)],
        "haystack_session_ids": [f"s{index}" for index in range(8)],
        "haystack_dates": [f"2025-01-{index + 1:02d}" for index in range(8)],
    }


def selection_for(item, dataset_path: Path, key: bytes):
    cutoff = timestamp(item["question_date"])
    sessions = user_only_sessions(item, cutoff)
    baseline = [session.source_hash for session in sessions]
    projection = baseline[:2]
    turns = [turn for session in sessions[:2] for turn in session.turns]
    certificate = {
        "baselineSourceDocumentHashes": baseline,
        "stableUnionSourceDocumentHashes": baseline,
        "projectionCandidateSourceDocumentHashes": projection,
        "projectionSourceDocumentHashes": projection,
        "hydratedUserEvidenceRefHmacs": [hmac_ref(turn.evidence_ref, key) for turn in turns],
        "rawContextCharCount": sum(len(turn.content) for turn in turns),
        "projectionBudgetChars": 1000,
        "completeSessionProjection": True,
        "outOfLockUserTurnCount": 0,
        "postCutoffUserTurnCount": 0,
        "duplicateEvidenceRefCount": 0,
    }
    query_hmac = eval_hmac(item["question_id"], key)
    row = {
        "queryHmac": query_hmac,
        "queryCutoffHmac": keyed_revision(cutoff, key, "query-cutoff"),
        "sourceLockRevisionHmac": keyed_revision(json.dumps(baseline), key, "source-lock"),
        "packetRevisionHmac": keyed_revision(
            json.dumps(certificate, sort_keys=True, separators=(",", ":")), key, "preference-user-projection-packet"
        ),
        "sourceLockIdentityPreserved": True,
        "certificate": certificate,
    }
    return {
        "schemaVersion": "paw.preference-user-authority-shadow.v1",
        "contentFree": True,
        "policy": {
            "artifactPolicy": {
                "datasetSha256": sha256_file(dataset_path),
                "hmacKeyId": keyed_revision("paw.preference.authority.v1", key, "key-id"),
            },
            "sourcePolicy": {
                "baseline": "v26b_first_retrieve_returned_source_hashes_first_8",
                "hydration": "full_user_turns_only_chronological",
                "readerMode": "replace_legacy_packet_when_projection_is_complete",
                "projection": "stable_baseline_first_4_then_locked_user_bm25_top_2_max_6",
                "queryCutoffRequired": True,
            },
        },
        "rows": [row],
    }, row


class PreferenceReaderTest(unittest.TestCase):
    def with_fixture(self):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        item = dataset_item()
        dataset_path = root / "dataset.json"
        key_path = root / "key"
        dataset_path.write_text(json.dumps([item]), encoding="utf-8")
        key_path.write_bytes(b"key")
        selection, row = selection_for(item, dataset_path, b"key")
        return temporary, item, dataset_path, key_path, selection, row

    def test_identity_tampering_fails_closed(self) -> None:
        temporary, _, dataset_path, _, selection, _ = self.with_fixture()
        with temporary:
            selection["rows"][0]["packetRevisionHmac"] = "tampered"
            with self.assertRaises(ValueError):
                reader.validate_selection_artifact(selection, dataset_path, b"key")

    def test_assistant_noise_is_invariant_and_never_rendered(self) -> None:
        temporary, item, _, _, _, row = self.with_fixture()
        with temporary:
            noisy = dataset_item("different assistant text")
            first = reader.render_user_authored_memory(item, row, b"key")
            second = reader.render_user_authored_memory(noisy, row, b"key")

            self.assertEqual(first.context, second.context)
            self.assertEqual(first.addressed_context, second.addressed_context)
            self.assertNotIn("assistant-private-noise", first.context)
            self.assertNotIn("different assistant text", second.context)
            self.assertNotIn("assistant-private-noise", first.addressed_context)

    def test_certificate_reference_mismatch_is_rejected(self) -> None:
        temporary, item, _, _, _, row = self.with_fixture()
        with temporary:
            changed = copy.deepcopy(row)
            changed["certificate"]["hydratedUserEvidenceRefHmacs"] = ["wrong"]
            changed["packetRevisionHmac"] = keyed_revision(
                json.dumps(changed["certificate"], sort_keys=True, separators=(",", ":")),
                b"key",
                "preference-user-projection-packet",
            )
            with self.assertRaises(ValueError):
                reader.render_user_authored_memory(item, changed, b"key")

    def test_reader_source_path_has_no_label_fields(self) -> None:
        source = inspect.getsource(reader)

        for forbidden in ("has" + "_answer", "answer" + "_session_ids", "question" + "_type"):
            self.assertNotIn(forbidden, source)

    def test_context_is_deterministic_and_source_rank_ordered(self) -> None:
        temporary, item, _, _, _, row = self.with_fixture()
        with temporary:
            first = reader.render_user_authored_memory(item, row, b"key")
            second = reader.render_user_authored_memory(item, row, b"key")

            self.assertEqual(first, second)
            self.assertTrue(first.context.startswith("USER_AUTHORED_MEMORY"))
            self.assertIn("[M01T001] I enjoyed the ridge trail.", first.addressed_context)
            self.assertEqual(first.evidence_items[0], ("M01T001", "I enjoyed the ridge trail."))
            self.assertLess(first.context.index("ridge trail"), first.context.index("noisy city walk"))


if __name__ == "__main__":
    unittest.main()
