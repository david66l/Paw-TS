from types import SimpleNamespace
import json
from pathlib import Path
import os
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from longmemeval_protocol import (
    canonicalize_longmemeval_documents,
    load_longmemeval_protocol,
    official_longmemeval_judge_prompt_fn,
)

from compare_paw_longmemeval_blind import DEFAULT_PROJECT_RELEASE_GATE
from run_paw_longmemeval_retrieval import (
    PROJECT_RELEASE_GATE,
    QUESTION_TYPES,
    complete_blind_arm,
    consume_blind_arm,
    experiment_protocol,
    index_writer_identity_protocol,
    local_embedding_health_url,
    order_longmemeval_reader_documents,
    public_report,
    resolve_index_store_dir,
    resolved_release_provider_env,
    retrieval_source_artifact_paths,
    retrieval_source_artifact_sha256,
    select_category_queries,
    select_diagnostic_queries,
    select_full_split_queries,
    select_queries,
    source_artifact_paths,
    source_artifact_sha256,
    summarize,
    validate_blind_plan,
    validated_diagnostic_include_manifest,
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
    def test_index_writer_identity_can_be_frozen_independently(self) -> None:
        with patch.dict(
            os.environ,
            {
                "DEEPSEEK_MODEL": "glm-5.3-flash",
                "DEEPSEEK_BASE_URL": "https://glm.example/v4",
                "PAW_AMB_INDEX_WRITER_MODEL": "deepseek-v4-flash",
                "PAW_AMB_INDEX_WRITER_BASE_URL": "https://api.deepseek.com/",
            },
            clear=True,
        ):
            self.assertEqual(
                {
                    "modelId": "deepseek:deepseek-v4-flash",
                    "endpointSha256": "a34e2a4708ed1c61008a151688838dcf1c44d4e7f08054633e72ba7c0b16cfc1",
                    "overrideActive": True,
                },
                index_writer_identity_protocol(),
            )
        with patch.dict(
            os.environ,
            {"PAW_AMB_INDEX_WRITER_MODEL": "deepseek-v4-flash"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "must be configured together"):
                index_writer_identity_protocol()

    def test_reader_context_is_chronological_without_changing_retrieval_rank(self) -> None:
        documents = [
            SimpleNamespace(id="later", content="later"),
            SimpleNamespace(id="unknown", content="unknown"),
            SimpleNamespace(id="earlier", content="earlier"),
        ]

        ordered = order_longmemeval_reader_documents(
            documents,
            {
                "later": "2025-01-03T00:00:00+00:00",
                "earlier": "2025-01-01T00:00:00+00:00",
            },
        )

        self.assertEqual(
            ["earlier", "later", "unknown"], [item.id for item in ordered]
        )
        self.assertEqual(
            ["later", "unknown", "earlier"], [item.id for item in documents]
        )

    def test_duplicate_official_session_ids_get_unique_physical_ids(self) -> None:
        from dataclasses import dataclass

        @dataclass
        class Document:
            id: str
            content: str
            user_id: str

        documents, physical_to_logical, collisions = (
            canonicalize_longmemeval_documents(
                [
                    Document("query_session", "first", "query"),
                    Document("query_session", "second", "query"),
                    Document("query_unique", "third", "query"),
                ]
            )
        )

        self.assertEqual(1, collisions)
        self.assertEqual(3, len({document.id for document in documents}))
        self.assertEqual(
            ["query_session", "query_session", "query_unique"],
            [physical_to_logical[document.id] for document in documents],
        )

    def test_protocol_uses_declared_sessions_and_suffix_for_abstention(self) -> None:
        rows = [
            {
                "question_id": "answerable",
                "question_type": "multi-session",
                "answer_session_ids": ["session-a", "session-b"],
                "haystack_session_ids": ["session-a", "session-b"],
                "haystack_dates": ["2025-01-01", "2025-01-02"],
                "haystack_sessions": [
                    [{"role": "user", "content": "a", "has_answer": True}],
                    [{"role": "assistant", "content": "b"}],
                ],
            },
            {
                "question_id": "missing_fact_abs",
                "question_type": "single-session-user",
                "answer_session_ids": ["session-c"],
                "haystack_session_ids": ["session-c"],
                "haystack_dates": ["2025-01-03"],
                "haystack_sessions": [
                    [{"role": "user", "content": "c"}],
                ],
            },
        ]
        with TemporaryDirectory() as directory:
            path = Path(directory) / "longmemeval.json"
            path.write_text(json.dumps(rows), encoding="utf-8")
            records, audit = load_longmemeval_protocol(path)

        self.assertEqual(
            (
                "answerable_session-a",
                "answerable_session-b",
            ),
            records["answerable"].gold_document_ids,
        )
        self.assertFalse(records["answerable"].abstention)
        self.assertTrue(records["missing_fact_abs"].abstention)
        self.assertEqual((), records["missing_fact_abs"].gold_document_ids)
        self.assertEqual(2, audit.turn_label_mismatch_count)
        self.assertEqual(1, audit.abstention_count)

    def test_abstention_judge_uses_official_unanswerable_semantics(self) -> None:
        prompt = official_longmemeval_judge_prompt_fn(
            question_type="multi-session", abstention=True
        )("question", ["explanation"], "answer")

        self.assertIn("unanswerable question", prompt)
        self.assertIn("correctly identifies", prompt)
        self.assertIn('"correct" (boolean)', prompt)

    def test_retrieval_summary_excludes_abstention_from_recall_metrics(self) -> None:
        summary = summarize(
            [
                {
                    "questionType": "multi-session",
                    "answerable": True,
                    "goldDocumentCount": 2,
                    "hit": True,
                    "goldRecall": 0.5,
                    "reciprocalRank": 1.0,
                    "evidenceClosed": True,
                    "retrieveMs": 10,
                    "contextTokens": 100,
                },
                {
                    "questionType": "multi-session",
                    "answerable": False,
                    "goldDocumentCount": 0,
                    "hit": None,
                    "goldRecall": None,
                    "reciprocalRank": None,
                    "evidenceClosed": False,
                    "retrieveMs": 20,
                    "contextTokens": 50,
                },
            ]
        )["overall"]

        self.assertEqual(1, summary["answerableQueries"])
        self.assertEqual(1, summary["unanswerableQueries"])
        self.assertEqual(0.5, summary["macroRecall"])

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
            SimpleNamespace(
                k=8,
                store_key="test-store",
                answer_protocol="upstream",
                answer_review=False,
                answer_tools=True,
                error_audit=False,
            ),
            source_artifact_sha256="source-artifact",
            retrieval_environment={"PAW_AMB_EMBEDDING_VERSION": "pinned"},
            index_store_binding={
                "policy": "test-policy",
                "mode": "output-local",
                "storeKey": "test-store",
                "directoryName": "test-store-store",
            },
        )
        self.assertEqual(
            "paw.longmemeval-paired-experiment.v5",
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
        self.assertEqual("upstream", protocol["common"]["answerProtocol"])
        self.assertTrue(protocol["common"]["answerTools"])
        self.assertEqual("required", protocol["common"]["sourceLocalLocator"])
        self.assertEqual(
            {
                "recommendationUserAuthorityMode": "off",
                "executionReaderProjectionInject": "0",
                "evidenceRoleLateBinding": "0",
                "temporalRoundFrontier": "0",
            },
            protocol["common"]["readerFeatureFlags"],
        )
        self.assertEqual(
            "output-local", protocol["common"]["indexStoreBinding"]["mode"]
        )

    def test_explicit_index_store_is_separate_from_result_directory(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            store_dir = root / "shared" / "test-store-store"
            store_dir.mkdir(parents=True)
            resolved, binding = resolve_index_store_dir(
                SimpleNamespace(
                    output=root / "results" / "report.json",
                    store_key="test-store",
                    index_store_dir=store_dir,
                    reuse_index=True,
                )
            )

        self.assertEqual(store_dir.resolve(), resolved)
        self.assertEqual("explicit", binding["mode"])
        self.assertEqual("test-store-store", binding["directoryName"])

    def test_explicit_reuse_rejects_mismatched_or_missing_store(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "must match"):
                resolve_index_store_dir(
                    SimpleNamespace(
                        output=root / "results" / "report.json",
                        store_key="test-store",
                        index_store_dir=root / "wrong-store",
                        reuse_index=True,
                    )
                )
            with self.assertRaisesRegex(ValueError, "requires an existing"):
                resolve_index_store_dir(
                    SimpleNamespace(
                        output=root / "results" / "report.json",
                        store_key="test-store",
                        index_store_dir=root / "test-store-store",
                        reuse_index=True,
                    )
                )

    def test_retrieval_cache_artifact_excludes_answer_only_code(self) -> None:
        root = Path(__file__).resolve().parents[2]
        paths = retrieval_source_artifact_paths()
        relative = {path.relative_to(root).as_posix() for path in paths}
        self.assertIn("benchmarks/amb/paw-memory-bridge.ts", relative)
        self.assertIn("benchmarks/amb/evidence-execution-profile.ts", relative)
        self.assertIn("packages/memory-core/src/evidence-resolver.ts", relative)
        self.assertNotIn("benchmarks/amb/evidence_answer_review.py", relative)
        self.assertNotIn("benchmarks/amb/run_paw_longmemeval_retrieval.py", relative)
        bridge = next(path for path in paths if path.name == "paw-memory-bridge.ts")
        self.assertNotEqual(
            retrieval_source_artifact_sha256(paths),
            retrieval_source_artifact_sha256(
                tuple(path for path in paths if path != bridge)
            ),
        )

    def test_embedding_version_binds_revision_and_artifact(self) -> None:
        environment = resolved_release_provider_env(
            {"artifactSha256": "a" * 64}
        )

        self.assertEqual("1", environment["PAW_AMB_SOURCE_LOCAL_LOCATOR"])
        self.assertEqual("research_dense", environment["PAW_AMB_EVIDENCE_PROFILE"])
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

    def test_category_selection_filters_the_validated_full_split(self) -> None:
        target_type = QUESTION_TYPES[0]
        queries = [
            SimpleNamespace(
                id=f"query-{index}",
                user_id=f"user-{index}",
                meta={"question_type": QUESTION_TYPES[index % len(QUESTION_TYPES)]},
            )
            for index in range(500)
        ]

        class FullDataset:
            def load_queries(self, _split: str):
                return queries

        selected = select_category_queries(
            FullDataset(),
            seed="category-seed",
            question_type=target_type,
        )

        self.assertTrue(selected)
        self.assertTrue(
            all(query.meta["question_type"] == target_type for query in selected)
        )
        self.assertEqual(
            sum(query.meta["question_type"] == target_type for query in queries),
            len(selected),
        )

    def test_category_selection_rejects_unknown_type(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported"):
            select_category_queries(
                FakeDataset(),
                seed="category-seed",
                question_type="unknown",
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
                "longMemEvalProtocol": {
                    "contentFree": True,
                    "productBehavioralParity": False,
                },
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
        self.assertEqual(
            {"contentFree": True, "productBehavioralParity": False},
            public["manifest"]["longMemEvalProtocol"],
        )
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

    def test_diagnostic_inclusion_validates_identity_and_selects_exact_hmacs(self) -> None:
        from run_paw_longmemeval_retrieval import eval_hmac

        key = b"k" * 32
        queries = [
            SimpleNamespace(id="q-1"),
            SimpleNamespace(id="q-2"),
            SimpleNamespace(id="q-3"),
        ]
        included = {eval_hmac("q-1", key), eval_hmac("q-3", key)}
        report = {
            "manifest": {
                "dataset": "longmemeval",
                "split": "s",
                "contentFree": True,
                "evalKeyId": "key-id",
                "queryHmacs": sorted(included),
                "artifactBinding": {"datasetArtifactSha256": "dataset"},
            }
        }
        manifest = validated_diagnostic_include_manifest(
            report,
            eval_key_id="key-id",
            dataset_artifact_sha256="dataset",
        )
        selected = select_diagnostic_queries(
            queries,
            query_hmacs=set(manifest["queryHmacs"]),
            eval_hmac_key=key,
        )
        self.assertEqual(["q-1", "q-3"], [query.id for query in selected])
        with self.assertRaisesRegex(ValueError, "incomplete"):
            select_diagnostic_queries(
                queries,
                query_hmacs=included | {"missing"},
                eval_hmac_key=key,
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
