import copy
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path

from freeze_temporal_treatment_manifest import freeze_manifest, validate_replay
from sanitize_temporal_replay_manifest import canonical, sanitize_replay


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def token(value: bytes) -> str:
    return hashlib.md5(value).hexdigest()  # nosec: synthetic fixed-width test token


def shadow_revision(value: str, key: bytes, domain: str) -> str:
    return hmac.new(
        key, f"{domain}:{value}".encode(), hashlib.sha256
    ).hexdigest()[:32]


class TemporalTreatmentManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key = b"test-evaluation-key"
        self.dataset = self.write("dataset.json", b"dataset")
        self.baseline = self.write(
            "baseline.json",
            json.dumps({"rows": [{"queryHmac": token(b"query")}]}).encode(),
        )
        self.source = self.write("source.jsonl", b"source")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write(self, name: str, content: bytes) -> Path:
        path = self.root / name
        path.write_bytes(content)
        return path

    def key_id(self) -> str:
        return hmac.new(
            self.key, b"key-id:paw.temporal.v1", hashlib.sha256
        ).hexdigest()[:32]

    def raw_row(self, query: str, evidence: str | None = None) -> dict:
        evidence = evidence or token(b"evidence")
        selected_slots = [
            {
                "slotId": "E1",
                "role": "target_event",
                "evidenceRefHmacs": [evidence],
            }
        ]
        return {
            "queryHmac": query,
            "queryCutoffHmac": token(b"cutoff"),
            "sourceLockRevisionHmac": token(b"source-lock"),
            "rankedCandidateSetRevisionHmac": token(b"ranked"),
            "plannerStatus": "compiled",
            "planRevisionHmac": token(b"plan"),
            "planOperator": "locate_event",
            "planUnit": None,
            "planSlots": [
                {
                    "slotId": "E1",
                    "role": "target_event",
                    "queryStart": 4,
                    "queryEnd": 9,
                    "queryMentionHmac": token(b"event"),
                }
            ],
            "binderStatus": "consensus_address_valid",
            "allReplicasValid": True,
            "validReplicaCount": 2,
            "committeeUnionWithinBudget": True,
            "consensusBindingRevisionHmac": shadow_revision(
                json.dumps(selected_slots, sort_keys=True, separators=(",", ":")),
                self.key,
                "consensus-binding",
            ),
            "selectedSlotEvidenceRefHmacs": selected_slots,
            "selectedEvidenceRefHmacs": [evidence],
            "selectedCandidateCount": 1,
            "plannerResponseHmac": token(b"planner-response"),
            "binderResponseHmacs": [
                token(b"binder-response-1"),
                token(b"binder-response-2"),
            ],
            "binderRequestHmacs": [],
            "answerCorrect": False,
            "questionType": "temporal-reasoning",
            "goldUserEndpointCount": 1,
        }

    def raw_artifact(
        self, name: str, run_id: str, rows: list[dict]
    ) -> Path:
        for index, row in enumerate(rows):
            row["binderRequestHmacs"] = [
                token(f"{run_id}:{index}:{replica}".encode())
                for replica in range(2)
            ]
        value = {
            "schemaVersion": "paw.temporal-event-slot-shadow.v8",
            "contentFree": True,
            "diagnosticOnly": True,
            "answerPathChanged": False,
            "targetScope": "ledger",
            "targetQueryHmacs": [row["queryHmac"] for row in rows],
            "candidatePolicy": {
                "sourceBoundary": "frozen",
                "role": "user_only",
                "ranker": "frozen-ranker",
                "topK": 48,
                "usesBenchmarkHasAnswerBeforeSelection": False,
            },
            "modelPolicy": {
                "model": "test-model",
                "providerEndpointHmac": token(b"provider"),
                "planner": {
                    "mode": "deterministic",
                    "schemaVersion": "planner-v1",
                },
                "binder": {
                    "mode": "event_packet",
                    "schemaVersion": "binder-v1",
                    "maxCompletionTokens": 4096,
                    "thinking": "high",
                    "sampling": "greedy",
                    "replicas": 2,
                },
            },
            "packetConstructionPolicy": {
                "policyVersion": "packet-v1",
                "timeBasis": "source_timeline",
                "queryCutoffRequired": True,
                "readerInjection": False,
                "semanticRelevanceProven": False,
                "eventSetCompletenessProven": False,
                "answerCorrectnessProven": False,
                "committeeSelectionPolicy": "per_slot_intersection_consensus",
                "bindingAssurance": "address_only",
                "maxSelectedCandidates": 12,
            },
            "artifactPolicy": {
                "datasetSha256": sha(self.dataset.read_bytes()),
                "baselineLedgerSha256s": [sha(self.baseline.read_bytes())],
                "sourceLockLogSha256s": [sha(self.source.read_bytes())],
                "producerCodeSha256": sha(b"producer"),
                "helperCodeSha256": sha(b"helper"),
                "plannerTemplateSha256": sha(b"planner-template"),
                "binderTemplateSha256": sha(b"binder-template"),
                "hmacKeyId": self.key_id(),
            },
            "executionPolicy": {
                "runInstanceId": run_id,
                "clientCacheReuse": False,
                "perReplicaRequestNonceInjected": True,
            },
            "executionEvidence": {
                "runInstanceId": run_id,
                "clientCacheReuse": False,
                "perReplicaRequestNonceInjected": True,
                "remoteBinderLogicalCallCount": len(rows) * 2,
            },
            "rows": rows,
            "metrics": {"baselineErrorCount": 999},
        }
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def sanitized(self, artifact: Path) -> dict:
        return sanitize_replay(
            [artifact], self.dataset, [self.baseline], [self.source], 1
        )

    def validated(self, manifest: dict, name: str) -> dict:
        path = self.root / name
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return validate_replay(manifest, path)

    def change_run_id(self, manifest: dict, run_id: str) -> dict:
        changed = copy.deepcopy(manifest)
        changed["runInstanceId"] = run_id
        changed["executionEvidence"]["runInstanceId"] = run_id
        execution = {
            key: value
            for key, value in changed["executionEvidence"].items()
            if key != "executionRevision"
        }
        changed["executionEvidence"]["executionRevision"] = sha(
            canonical(execution).encode()
        )
        return changed

    def change_operator(self, raw: dict, operator: str) -> dict:
        changed = copy.deepcopy(raw)
        changed["planOperator"] = operator
        changed["planSlots"][0]["role"] = "event_set"
        changed["selectedSlotEvidenceRefHmacs"][0]["role"] = "event_set"
        selected = changed["selectedSlotEvidenceRefHmacs"]
        changed["consensusBindingRevisionHmac"] = shadow_revision(
            json.dumps(selected, sort_keys=True, separators=(",", ":")),
            self.key,
            "consensus-binding",
        )
        return changed

    def test_sanitizer_removes_all_label_bearing_fields(self) -> None:
        query = token(b"query")
        manifest = self.sanitized(
            self.raw_artifact("raw.json", "run-instance-a", [self.raw_row(query)])
        )

        rendered = json.dumps(manifest).casefold()
        self.assertNotIn("answercorrect", rendered)
        self.assertNotIn("golduser", rendered)
        self.assertNotIn("questiontype", rendered)
        self.assertNotIn("endpointcoverage", rendered)
        self.assertEqual(1, manifest["inputBinding"]["targetQueryCount"])

    def test_exact_independent_replays_create_treatment(self) -> None:
        query = token(b"query")
        first = self.sanitized(
            self.raw_artifact("first-raw.json", "run-instance-a", [self.raw_row(query)])
        )
        second = self.sanitized(
            self.raw_artifact("second-raw.json", "run-instance-b", [self.raw_row(query)])
        )
        first_valid = self.validated(first, "first.json")
        second_valid = self.validated(second, "second.json")

        ledger = freeze_manifest(
            first_valid, second_valid, self.key, sha(b"first"), sha(b"second")
        )

        self.assertEqual(1, ledger["treatmentCount"])
        self.assertEqual("treat", ledger["rows"][0]["decision"])
        self.assertEqual(0, ledger["fallbackCount"])

    def test_different_slot_evidence_falls_back(self) -> None:
        query = token(b"query")
        first = self.sanitized(
            self.raw_artifact("first-raw.json", "run-instance-a", [self.raw_row(query)])
        )
        changed = self.raw_row(query, token(b"different-evidence"))
        second = self.sanitized(
            self.raw_artifact("second-raw.json", "run-instance-b", [changed])
        )

        ledger = freeze_manifest(
            self.validated(first, "first.json"),
            self.validated(second, "second.json"),
            self.key,
            sha(b"first"),
            sha(b"second"),
        )

        self.assertEqual(0, ledger["treatmentCount"])
        self.assertEqual(
            "selected_slot_set_mismatch", ledger["rows"][0]["reasonCode"]
        )

    def test_gold_diagnostic_changes_cannot_change_selection(self) -> None:
        query = token(b"query")
        original = self.raw_row(query)
        changed = copy.deepcopy(original)
        changed["answerCorrect"] = True
        changed["goldUserEndpointCount"] = 500
        same_run_original = self.sanitized(
            self.raw_artifact("same-run-original.json", "run-instance-c", [original])
        )
        same_run_changed = self.sanitized(
            self.raw_artifact("same-run-changed.json", "run-instance-c", [changed])
        )
        self.assertEqual(same_run_original, same_run_changed)

    def test_same_run_instance_cannot_be_frozen_twice(self) -> None:
        query = token(b"query")
        first = self.sanitized(
            self.raw_artifact("first-raw.json", "same-instance", [self.raw_row(query)])
        )
        second = self.sanitized(
            self.raw_artifact("second-raw.json", "same-instance", [self.raw_row(query)])
        )

        with self.assertRaisesRegex(ValueError, "distinct run instance"):
            freeze_manifest(
                self.validated(first, "first.json"),
                self.validated(second, "second.json"),
                self.key,
                sha(b"first"),
                sha(b"second"),
            )

    def test_cloned_manifest_with_only_changed_run_id_is_rejected(self) -> None:
        query = token(b"query")
        original = self.sanitized(
            self.raw_artifact("raw.json", "run-instance-a", [self.raw_row(query)])
        )
        forged = copy.deepcopy(original)
        forged["runInstanceId"] = "run-instance-b"

        with self.assertRaisesRegex(ValueError, "execution run ID differs"):
            self.validated(forged, "forged.json")

    def test_overlapping_settled_shards_are_rejected(self) -> None:
        query = token(b"query")
        first = self.sanitized(
            self.raw_artifact("first-raw.json", "run-instance-a", [self.raw_row(query)])
        )
        second = self.change_run_id(first, "run-instance-b")

        with self.assertRaisesRegex(ValueError, "settlements overlap"):
            freeze_manifest(
                self.validated(first, "first.json"),
                self.validated(second, "second.json"),
                self.key,
                sha(b"first"),
                sha(b"second"),
            )

    def test_replay_missing_baseline_query_is_rejected(self) -> None:
        raw = self.raw_artifact("empty-raw.json", "run-instance-a", [])

        with self.assertRaisesRegex(ValueError, "differs from the baseline ledger"):
            sanitize_replay(
                [raw], self.dataset, [self.baseline], [self.source], 1
            )

    def test_stable_collection_operators_are_supported(self) -> None:
        query = token(b"query")
        for operator in ("argmax_by_count", "count_before"):
            first_raw = self.change_operator(self.raw_row(query), operator)
            second_raw = self.change_operator(self.raw_row(query), operator)
            first = self.sanitized(
                self.raw_artifact(
                    f"{operator}-a-raw.json", "run-instance-a", [first_raw]
                )
            )
            second = self.sanitized(
                self.raw_artifact(
                    f"{operator}-b-raw.json", "run-instance-b", [second_raw]
                )
            )

            ledger = freeze_manifest(
                self.validated(first, f"{operator}-a.json"),
                self.validated(second, f"{operator}-b.json"),
                self.key,
                sha(f"{operator}-a".encode()),
                sha(f"{operator}-b".encode()),
            )

            self.assertEqual("treat", ledger["rows"][0]["decision"])

    def test_tampered_binding_revision_falls_back(self) -> None:
        query = token(b"query")
        first = self.sanitized(
            self.raw_artifact("first-raw.json", "run-instance-a", [self.raw_row(query)])
        )
        second = self.sanitized(
            self.raw_artifact("second-raw.json", "run-instance-b", [self.raw_row(query)])
        )
        first["rows"][0]["bindingRevisionHmac"] = token(b"tampered")
        second["rows"][0]["bindingRevisionHmac"] = token(b"tampered")

        ledger = freeze_manifest(
            self.validated(first, "first.json"),
            self.validated(second, "second.json"),
            self.key,
            sha(b"first"),
            sha(b"second"),
        )

        self.assertEqual("binding_revision_invalid", ledger["rows"][0]["reasonCode"])

    def test_unknown_candidate_policy_field_is_rejected(self) -> None:
        query = token(b"query")
        path = self.raw_artifact("raw.json", "run-instance-a", [self.raw_row(query)])
        artifact = json.loads(path.read_text())
        artifact["candidatePolicy"]["futureBehaviorSwitch"] = True
        path.write_text(json.dumps(artifact))

        with self.assertRaisesRegex(ValueError, "candidate policy"):
            self.sanitized(path)

    def test_negative_plan_span_is_rejected(self) -> None:
        query = token(b"query")
        raw = self.raw_row(query)
        raw["planSlots"][0]["queryStart"] = -1

        with self.assertRaisesRegex(ValueError, "query span"):
            self.sanitized(
                self.raw_artifact("raw.json", "run-instance-a", [raw])
            )

    def test_incomplete_binder_response_settlement_is_rejected(self) -> None:
        query = token(b"query")
        path = self.raw_artifact("raw.json", "run-instance-a", [self.raw_row(query)])
        artifact = json.loads(path.read_text())
        artifact["rows"][0]["binderResponseHmacs"].pop()
        path.write_text(json.dumps(artifact))

        with self.assertRaisesRegex(ValueError, "settlement is incomplete"):
            self.sanitized(path)

    def test_deterministic_planner_rejects_legacy_planned_status(self) -> None:
        query = token(b"query")
        raw = self.raw_row(query)
        raw["plannerStatus"] = "planned"

        with self.assertRaisesRegex(ValueError, "planner status"):
            self.sanitized(
                self.raw_artifact("raw.json", "run-instance-a", [raw])
            )

    def test_replay_loader_rejects_extra_fields(self) -> None:
        query = token(b"query")
        manifest = self.sanitized(
            self.raw_artifact("raw.json", "run-instance-a", [self.raw_row(query)])
        )
        manifest["rows"][0]["answerCorrect"] = False

        with self.assertRaises(ValueError):
            self.validated(manifest, "manifest.json")


if __name__ == "__main__":
    unittest.main()
