"""Strict tests for the frozen multi-session user-evidence set path."""

from __future__ import annotations

import copy
import inspect
import json
import tempfile
import unittest
from pathlib import Path

import multi_session_evidence_set_reader as reader
import multi_session_evidence_set_shadow as shadow
from preference_user_authority_shadow import keyed_revision, sha256_file, user_only_sessions
from temporal_event_ledger_shadow import eval_hmac, sha256_text


KEY = b"test-multi-session-key"


def sample_item() -> dict:
    sessions = []
    for index in range(1, 9):
        sessions.append(
            [
                {"role": "user", "content": f"user evidence {index} first"},
                {"role": "assistant", "content": f"assistant noise {index}"},
                {"role": "user", "content": f"user evidence {index} second"},
            ]
        )
    sessions.append([{"role": "user", "content": "after cutoff"}])
    return {
        "question_id": "multi-1",
        "question": "Compare all recorded options",
        "question_date": "2024-12-31",
        "haystack_session_ids": [f"session-{index}" for index in range(1, 9)] + ["future"],
        "haystack_dates": [f"2024-01-{index:02d}" for index in range(1, 9)] + ["2025-01-01"],
        "haystack_sessions": sessions,
    }


def sealed_selection(dataset_path: Path, log_path: Path, item: dict) -> tuple[dict, tuple[str, ...]]:
    cutoff = "2024-12-31T00:00:00Z"
    sessions = user_only_sessions(item, cutoff)
    source_lock = tuple(session.source_hash for session in reversed(sessions))
    certificate = shadow.content_free_certificate(sessions, source_lock, KEY)
    query_hmac = eval_hmac(item["question_id"], KEY)
    row = {
        "queryHmac": query_hmac,
        "queryCutoffHmac": keyed_revision(cutoff, KEY, "query-cutoff"),
        "sourceLockRevisionHmac": keyed_revision(json.dumps(list(source_lock)), KEY, "source-lock"),
        "certificate": certificate,
    }
    row["packetRevisionHmac"] = keyed_revision(
        json.dumps(certificate, sort_keys=True, separators=(",", ":")),
        KEY,
        "multi-session-evidence-set-packet",
    )
    policy = {
        "sourcePolicy": {
            "baseline": "v26b_first_retrieve_returned_source_hashes_exact_top_8",
            "hydration": "complete_user_turns_only_per_locked_source_chronological",
            "queryCutoffRequired": True,
            "noRetrievalExpansion": True,
            "noSessionTruncation": True,
        },
        "artifactPolicy": {
            "datasetSha256": sha256_file(dataset_path),
            "v26bRetrievalLogSha256s": [sha256_file(log_path)],
            "hmacKeyId": keyed_revision(shadow.KEY_DOMAIN, KEY, "key-id"),
        },
        "targetQueryHmacs": [query_hmac],
    }
    return {
        "schemaVersion": shadow.SCHEMA_VERSION,
        "contentFree": True,
        "policy": policy,
        "rows": [row],
    }, source_lock


class MultiSessionEvidenceSetTest(unittest.TestCase):
    def make_files(self) -> tuple[tempfile.TemporaryDirectory, Path, Path, Path, dict]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        item = sample_item()
        dataset_path = root / "dataset.json"
        dataset_path.write_text(json.dumps([item]), encoding="utf-8")
        sessions = user_only_sessions(item, "2024-12-31T00:00:00Z")
        source_lock = [session.source_hash for session in reversed(sessions)]
        log_path = root / "retrieve.jsonl"
        log_path.write_text(
            json.dumps(
                {
                    "event": "retrieve",
                    "detail": {
                        "queryHash": sha256_text(item["question"]),
                        "returnedSourceDocumentHashes": source_lock,
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        selection, _ = sealed_selection(dataset_path, log_path, item)
        selection_path = root / "selection.json"
        selection_path.write_text(json.dumps(selection), encoding="utf-8")
        return temporary, dataset_path, log_path, selection_path, item

    def test_complete_user_only_closure_is_chronological(self) -> None:
        temporary, dataset_path, log_path, selection_path, _ = self.make_files()
        with temporary:
            key_path = dataset_path.parent / "key.bin"
            key_path.write_bytes(KEY)
            packets = reader.load_reader_packets(selection_path, dataset_path, [log_path], key_path)
            packet = next(iter(packets.values()))[1]
            self.assertEqual(packet.source_count, 8)
            self.assertEqual(packet.user_turn_count, 16)
            self.assertIn("[Session S01; source rank 8; session 2024-01-01T00:00:00Z]", packet.context)
            self.assertLess(packet.context.index("source rank 8"), packet.context.index("source rank 1"))
            self.assertIn("[S01T01] USER:", packet.context)
            self.assertEqual(len(packet.evidence_ids), packet.user_turn_count)
            self.assertEqual(len(set(packet.evidence_ids)), packet.user_turn_count)
            self.assertIn("user evidence 1 first", packet.context)
            self.assertNotIn("assistant noise", packet.context)
            self.assertNotIn("after cutoff", packet.context)

    def test_fail_closed_for_tamper_or_bad_certificate_refs(self) -> None:
        temporary, dataset_path, log_path, _, item = self.make_files()
        with temporary:
            selection, _ = sealed_selection(dataset_path, log_path, item)
            tampered = copy.deepcopy(selection)
            tampered["rows"][0]["certificate"]["sourceDocumentHashes"][0] = "different"
            with self.assertRaisesRegex(ValueError, "packet identity"):
                reader.validate_selection_artifact(tampered, dataset_path, [log_path], KEY)
            bad_refs = copy.deepcopy(selection)
            certificate = bad_refs["rows"][0]["certificate"]
            certificate["userEvidenceRefHmacs"][0] = "invalid-ref"
            bad_refs["rows"][0]["packetRevisionHmac"] = keyed_revision(
                json.dumps(certificate, sort_keys=True, separators=(",", ":")),
                KEY,
                "multi-session-evidence-set-packet",
            )
            self.assertIsNotNone(reader.validate_selection_artifact(bad_refs, dataset_path, [log_path], KEY))
            with self.assertRaisesRegex(ValueError, "certificate"):
                reader.render_multi_session_evidence(item, bad_refs["rows"][0], KEY)

    def test_missing_locked_or_post_cutoff_source_fails_closed(self) -> None:
        item = sample_item()
        sessions = user_only_sessions(item, "2024-12-31T00:00:00Z")
        with self.assertRaisesRegex(ValueError, "exactly eight"):
            shadow.content_free_certificate(sessions, tuple(session.source_hash for session in sessions[:7]), KEY)
        future_hash = sha256_text("multi-1_future")
        with self.assertRaisesRegex(ValueError, "cannot hydrate"):
            shadow.content_free_certificate(
                sessions,
                tuple(session.source_hash for session in sessions[:7]) + (future_hash,),
                KEY,
            )

    def test_checkpoint_and_source_are_label_free(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                shadow.save_checkpoint(
                    Path(directory) / "checkpoint.json",
                    {},
                    [{"queryHmac": "q", "has" + "_answer": True}],
                )
        for module in (shadow, reader):
            source = inspect.getsource(module)
            for field in ("has" + "_answer", "answer" + "_session_ids", "question" + "_type"):
                self.assertNotIn(field, source)

    def test_pinned_log_lock_identity_is_enforced(self) -> None:
        temporary, dataset_path, log_path, selection_path, _ = self.make_files()
        with temporary:
            key_path = dataset_path.parent / "key.bin"
            key_path.write_bytes(KEY)
            log_path.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "artifact binding"):
                reader.load_reader_packets(selection_path, dataset_path, [log_path], key_path)


if __name__ == "__main__":
    unittest.main()
