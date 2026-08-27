from types import SimpleNamespace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from compare_paw_longmemeval_blind import DEFAULT_PROJECT_RELEASE_GATE
from run_paw_longmemeval_retrieval import (
    PROJECT_RELEASE_GATE,
    QUESTION_TYPES,
    complete_blind_arm,
    consume_blind_arm,
    experiment_protocol,
    local_embedding_health_url,
    public_report,
    resolved_release_provider_env,
    select_full_split_queries,
    select_queries,
    source_artifact_paths,
    source_artifact_sha256,
    validate_blind_plan,
    validated_exclusion_manifest,
)


class FakeDataset:
    def __init__(self) -> None:
        self.by_type = {
            question_type: [
                SimpleNamespace(
                    id=f"{question_type}-shared",
                    user_id="shared-user",
                ),
                SimpleNamespace(
                    id=f"{question_type}-unique",
                    user_id=f"{question_type}-user",
                ),
            ]
            for question_type in QUESTION_TYPES
        }

    def load_queries(self, _split: str, category: str):
        return self.by_type[category]


class LongMemEvalRunnerTest(unittest.TestCase):
    def test_runner_and_comparator_share_the_exact_release_gate(self) -> None:
        self.assertEqual(DEFAULT_PROJECT_RELEASE_GATE, PROJECT_RELEASE_GATE)

    def test_source_artifact_covers_runtime_and_benchmark_dependencies(self) -> None:
        root = Path(__file__).resolve().parents[2]
        relative = {
            path.relative_to(root).as_posix() for path in source_artifact_paths()
        }

        self.assertIn("packages/memory-plugin/src/evidence-first.ts", relative)
        self.assertIn("packages/memory/src/longterm/store/postgres-engine.ts", relative)
        self.assertIn(
            "packages/memory/src/db/migrations/V026__longterm_memory_v2.sql",
            relative,
        )
        self.assertIn("packages/protocol/src/index.ts", relative)
        self.assertIn("packages/memory-plugin/tsconfig.json", relative)
        self.assertIn("apps/cli/src/paw-next/composition.ts", relative)
        self.assertIn("apps/cli/package.json", relative)
        self.assertIn("tsconfig.base.json", relative)
        self.assertIn("benchmarks/amb/paw_provider.py", relative)
        self.assertIn("benchmarks/amb/atom-ingest-control.ts", relative)
        self.assertIn("benchmarks/amb/upstream/pyproject.toml", relative)
        self.assertIn("bun.lock", relative)
        sql_path = next(
            path for path in source_artifact_paths() if path.suffix == ".sql"
        )
        all_paths = source_artifact_paths()
        self.assertNotEqual(
            source_artifact_sha256(all_paths),
            source_artifact_sha256(
                tuple(path for path in all_paths if path != sql_path)
            ),
        )

    def test_semantic_cache_protocol_binds_the_source_artifact(self) -> None:
        protocol = experiment_protocol(
            SimpleNamespace(k=8, store_key="test-store"),
            source_artifact_sha256="source-artifact",
            retrieval_environment={"PAW_AMB_EMBEDDING_VERSION": "pinned"},
        )

        self.assertEqual(
            "paw.longmemeval-paired-experiment.v4",
            protocol["schemaVersion"],
        )
        self.assertEqual(0.75, protocol["projectReleaseGate"]["minimumTreatmentAccuracy"])
        self.assertEqual(
            4_000.0,
            protocol["projectReleaseGate"][
                "maximumTreatmentMemoryWorkloadTokensPerQuery"
            ],
        )
        self.assertEqual(
            {
                "answerJudge": "prompt-model-config-usage-envelope-v3",
                "memorySemantic": "prompt-model-config-source-artifact-usage-envelope-v3",
                "sourceArtifactSha256": "source-artifact",
            },
            protocol["common"]["llmCachePolicy"],
        )

    def test_embedding_version_binds_revision_and_artifact(self) -> None:
        environment = resolved_release_provider_env(
            {"artifactSha256": "a" * 64}
        )

        self.assertIn("1110a243fdf4706b3f48f1d95db1a4f5529b4d41", environment["PAW_AMB_EMBEDDING_VERSION"])
        self.assertTrue(environment["PAW_AMB_EMBEDDING_VERSION"].endswith("a" * 64))

    def test_embedding_health_url_uses_server_root_not_openai_v1(self) -> None:
        self.assertEqual(
            "http://127.0.0.1:18081/health",
            local_embedding_health_url("http://127.0.0.1:18081/v1"),
        )
        self.assertEqual(
            "http://127.0.0.1:18081/health",
            local_embedding_health_url("http://127.0.0.1:18081"),
        )

    def test_selection_keeps_users_unique_across_question_types(self) -> None:
        selected = select_queries(
            FakeDataset(),
            count_by_type={question_type: 1 for question_type in QUESTION_TYPES},
            seed="test-seed",
            excluded_fingerprints=set(),
            excluded_user_ids=set(),
        )

        self.assertEqual(len(QUESTION_TYPES), len(selected))
        self.assertEqual(len(selected), len({query.user_id for query in selected}))

    def test_selection_finds_global_assignment_when_greedy_type_order_cannot(self) -> None:
        dataset = FakeDataset()
        first_type, second_type = QUESTION_TYPES[:2]
        dataset.by_type[first_type] = [
            SimpleNamespace(id="first-shared", user_id="shared-user"),
            SimpleNamespace(id="first-only", user_id="first-only-user"),
        ]
        dataset.by_type[second_type] = [
            SimpleNamespace(id="second-shared", user_id="shared-user"),
        ]

        selected = select_queries(
            dataset,
            count_by_type={question_type: 1 for question_type in QUESTION_TYPES},
            seed="matching-test",
            excluded_fingerprints=set(),
            excluded_user_ids=set(),
        )

        selected_ids = {query.id for query in selected}
        self.assertIn("first-only", selected_ids)
        self.assertIn("second-shared", selected_ids)

    def test_full_split_requires_exact_unique_official_identity(self) -> None:
        queries = [
            SimpleNamespace(
                id=f"query-{index}",
                user_id=f"user-{index}",
                meta={"question_type": QUESTION_TYPES[index % len(QUESTION_TYPES)]},
            )
            for index in range(500)
        ]

        class FullDataset:
            def load_queries(self, split: str):
                self.observed_split = split
                return queries

        dataset = FullDataset()
        selected = select_full_split_queries(dataset, seed="full-seed")

        self.assertEqual("s", dataset.observed_split)
        self.assertEqual(500, len(selected))
        self.assertEqual(500, len({query.id for query in selected}))
        self.assertEqual(500, len({query.user_id for query in selected}))
        self.assertEqual(
            [query.id for query in selected],
            [query.id for query in select_full_split_queries(dataset, seed="full-seed")],
        )

    def test_full_split_rejects_partial_or_shared_user_data(self) -> None:
        class PartialDataset:
            def load_queries(self, _split: str):
                return []

        with self.assertRaisesRegex(ValueError, "expected 500"):
            select_full_split_queries(PartialDataset(), seed="full-seed")

        queries = [
            SimpleNamespace(
                id=f"query-{index}",
                user_id="shared" if index < 2 else f"user-{index}",
                meta={"question_type": QUESTION_TYPES[index % len(QUESTION_TYPES)]},
            )
            for index in range(500)
        ]

        class SharedUserDataset:
            def load_queries(self, _split: str):
                return queries

        with self.assertRaisesRegex(ValueError, "one non-empty isolated user"):
            select_full_split_queries(SharedUserDataset(), seed="full-seed")

    def test_public_report_removes_per_query_or_reversible_identifiers(self) -> None:
        sealed = {
            "manifest": {
                "dataset": "longmemeval",
                "split": "s",
                "contentFree": True,
                "seed": "must-stay-sealed",
                "seedCommitment": "public-commitment",
                "queryHmacs": ["query-secret"],
                "userHmacs": ["user-secret"],
                "historyDocumentCounts": [7],
            },
            "metrics": {"overall": {"queries": 1}},
            "rows": [{"queryHmac": "query-secret", "answerCorrect": False}],
        }

        public = public_report(sealed, "ledger-sha")

        self.assertNotIn("rows", public)
        self.assertNotIn("queryHmacs", public["manifest"])
        self.assertNotIn("userHmacs", public["manifest"])
        self.assertNotIn("seed", public["manifest"])
        self.assertNotIn("historyDocumentCounts", public["manifest"])
        self.assertEqual("public-commitment", public["manifest"]["seedCommitment"])
        self.assertEqual(1, public["sealedLedger"]["rowCount"])
        self.assertFalse(
            public["sealedLedger"]["publicContainsPerQueryMetrics"]
        )
        self.assertTrue(public["sealedLedger"]["sealedContainsPerQueryMetrics"])

    def test_exclusion_manifest_fails_closed_on_wrong_dataset(self) -> None:
        with self.assertRaisesRegex(ValueError, "incompatible"):
            validated_exclusion_manifest(
                {
                    "manifest": {
                        "dataset": "another-dataset",
                        "split": "s",
                        "contentFree": True,
                    }
                }
            )

    def test_blind_plan_validates_identity_and_arm_policy(self) -> None:
        manifest = {
            "dataset": "longmemeval",
            "split": "s",
            "contentFree": True,
            "seedCommitment": "seed-commitment",
            "evalKeyId": "key-id",
            "queryCount": 1,
            "documentCount": 2,
            "questionTypeTargets": {"multi-session": 1},
            "questionTypeCounts": {"multi-session": 1},
            "queryHmacs": ["query-hmac"],
            "userHmacs": ["user-hmac"],
            "artifactBinding": {"datasetArtifactSha256": "data", "sourceArtifactSha256": "source"},
            "experimentProtocol": {"schemaVersion": "test-protocol"},
            "exclusion": {"reports": []},
        }
        plan = {"dryRun": True, "manifest": dict(manifest)}

        validated = validate_blind_plan(
            plan,
            manifest=manifest,
            eval_key_id="key-id",
            arm="treatment",
            query_expansion=True,
        )
        self.assertEqual("seed-commitment", validated["seedCommitment"])
        with self.assertRaisesRegex(ValueError, "incompatible query expansion"):
            validate_blind_plan(
                plan,
                manifest=manifest,
                eval_key_id="key-id",
                arm="baseline",
                query_expansion=True,
            )

    def test_blind_arm_can_only_be_consumed_once(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            arguments = {
                "plan_path": root / "plan-ledger.json",
                "plan_sha256": "plan-sha",
                "plan_id": f"test-{root.name}",
                "arm": "treatment",
                "output": root / "result.json",
                "sealed_output": root / "sealed.json",
                "recover_claimed": False,
            }
            spent_path = (
                Path(__file__).resolve().parent
                / "runs"
                / ".custodian-state"
                / f"{arguments['plan_id']}-treatment.json"
            )
            try:
                consume_blind_arm(**arguments)
                with self.assertRaisesRegex(ValueError, "already consumed"):
                    consume_blind_arm(**arguments)
            finally:
                spent_path.unlink(missing_ok=True)

    def test_blind_claim_completes_only_after_both_outputs_exist(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            plan_id = f"complete-{root.name}"
            public_output = root / "result.json"
            sealed_output = root / "sealed.json"
            state_path = (
                Path(__file__).resolve().parent
                / "runs"
                / ".custodian-state"
                / f"{plan_id}-baseline.json"
            )
            try:
                consume_blind_arm(
                    plan_path=root / "plan.json",
                    plan_sha256="plan-sha",
                    plan_id=plan_id,
                    arm="baseline",
                    output=public_output,
                    sealed_output=sealed_output,
                    recover_claimed=False,
                )
                with self.assertRaisesRegex(ValueError, "completion state"):
                    complete_blind_arm(
                        plan_id=plan_id,
                        arm="baseline",
                        public_output=public_output,
                        sealed_output=sealed_output,
                    )
                public_output.write_text("{}", encoding="utf-8")
                sealed_output.write_text("{}", encoding="utf-8")
                complete_blind_arm(
                    plan_id=plan_id,
                    arm="baseline",
                    public_output=public_output,
                    sealed_output=sealed_output,
                )
                state = json.loads(state_path.read_text(encoding="utf-8"))
                self.assertEqual("completed", state["state"])
            finally:
                state_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
