"""Run a content-free, stratified LongMemEval evidence-retrieval evaluation."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
UPSTREAM_SRC = HERE / "upstream" / "src"
sys.path.insert(0, str(UPSTREAM_SRC))
sys.path.insert(0, str(HERE))

QUESTION_TYPES = (
    "single-session-user",
    "single-session-assistant",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
    "single-session-preference",
)
RUNNER_POLICY = "paw.longmemeval-evidence-retrieval.v9:cost-audited-cache-envelope"
MEMORY_POLICY = "paw.amb-evidence-first.v19:fail-closed-triaged-closure"
SEARCH_POLICY = "paw.memory-search-plan.v16:nonempty-plan-verified-root"
RETRIEVAL_PROFILE = "paw.amb-retrieval-profile.v6:dense-turn-initial-packet"
PROJECT_RELEASE_GATE = {
    "minimumTreatmentAccuracy": 0.75,
    "minimumQuestionTypeAccuracy": 0.60,
    "minimumPairedAccuracyGain": 0.075,
    "maximumRetrievalDegradation": 0.02,
    "maximumContextTokenIncreaseRatio": 0.50,
    "maximumTreatmentMemoryCallsPerQuery": 2.0,
    "maximumTreatmentMemoryWorkloadTokensPerQuery": 4_000.0,
}


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def eval_hmac(value: str, key: bytes) -> str:
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def load_or_create_eval_key(path: Path) -> bytes:
    if path.exists():
        key = path.read_bytes()
        if len(key) < 32:
            raise ValueError("evaluation HMAC key must contain at least 32 bytes")
        return key
    path.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    path.write_bytes(key)
    return key


def validated_exclusion_manifest(report: object) -> dict:
    if not isinstance(report, dict):
        raise ValueError("exclusion report must be a JSON object")
    manifest = report.get("manifest")
    if (
        not isinstance(manifest, dict)
        or manifest.get("dataset") != "longmemeval"
        or manifest.get("split") != "s"
        or manifest.get("contentFree") is not True
    ):
        raise ValueError("exclusion report manifest is incompatible")
    return manifest


def public_report(sealed: dict, ledger_sha256: str) -> dict:
    sealed_manifest = sealed["manifest"]
    public_manifest_fields = (
        "schemaVersion",
        "dataset",
        "split",
        "seedCommitment",
        "evalKeyId",
        "perQuestionType",
        "questionTypeTargets",
        "queryCount",
        "documentCount",
        "questionTypeCounts",
        "selectionPolicy",
        "retrievalProfile",
        "evaluationMode",
        "partialRecoveryExecuted",
        "eventIdentityMode",
        "eventKeyCoverageRate",
        "experimentProtocol",
        "artifactBinding",
        "exclusion",
        "blindPlan",
        "claimLevel",
        "contentFree",
    )
    manifest = {
        field: sealed_manifest[field]
        for field in public_manifest_fields
        if field in sealed_manifest
    }
    query_count = len(sealed_manifest.get("queryHmacs", []))
    user_count = len(sealed_manifest.get("userHmacs", []))
    result = {key: value for key, value in sealed.items() if key != "rows"}
    result["manifest"] = manifest
    result["sealedLedger"] = {
        "sha256": ledger_sha256,
        "rowCount": len(sealed.get("rows", [])),
        "selectedQueryCount": query_count,
        "selectedUserCount": user_count,
        "publicContainsPerQueryMetrics": False,
        "sealedContainsPerQueryMetrics": bool(sealed.get("rows")),
    }
    return result


def validate_blind_plan(
    plan: object,
    *,
    manifest: dict,
    eval_key_id: str,
    arm: str,
    query_expansion: bool,
) -> dict:
    if not isinstance(plan, dict) or plan.get("dryRun") is not True:
        raise ValueError("blind plan must be a sealed dry-run ledger")
    plan_manifest = validated_exclusion_manifest(plan)
    expected_expansion = arm == "treatment"
    if query_expansion is not expected_expansion:
        raise ValueError(f"blind arm {arm} has incompatible query expansion setting")
    identity_fields = (
        "seedCommitment",
        "evalKeyId",
        "queryCount",
        "documentCount",
        "questionTypeTargets",
        "questionTypeCounts",
        "queryHmacs",
        "userHmacs",
        "artifactBinding",
        "experimentProtocol",
        "exclusion",
    )
    if eval_key_id != plan_manifest.get("evalKeyId") or any(
        manifest.get(field) != plan_manifest.get(field) for field in identity_fields
    ):
        raise ValueError("blind plan identity does not match this evaluation")
    return plan_manifest


def blind_plan_id(plan_manifest: dict) -> str:
    return canonical_sha256(
        {
            "schemaVersion": "paw.longmemeval-blind-plan-identity.v1",
            "seedCommitment": plan_manifest.get("seedCommitment"),
            "evalKeyId": plan_manifest.get("evalKeyId"),
            "queryHmacs": plan_manifest.get("queryHmacs"),
            "userHmacs": plan_manifest.get("userHmacs"),
            "artifactBinding": plan_manifest.get("artifactBinding"),
            "experimentProtocol": plan_manifest.get("experimentProtocol"),
            "exclusion": plan_manifest.get("exclusion"),
        }
    )


def consume_blind_arm(
    *,
    plan_path: Path,
    plan_sha256: str,
    plan_id: str,
    arm: str,
    output: Path,
    sealed_output: Path,
    recover_claimed: bool,
) -> None:
    spent_path = HERE / "runs" / ".custodian-state" / f"{plan_id}-{arm}.json"
    spent_path.parent.mkdir(parents=True, exist_ok=True)
    if spent_path.exists():
        if not recover_claimed:
            raise ValueError(f"blind arm already consumed: {arm}")
        previous = json.loads(spent_path.read_text(encoding="utf-8"))
        log_path = ROOT / "logs" / "amb" / f"{output.stem}-retrieval.jsonl"
        events = []
        if log_path.exists():
            for line in log_path.read_text(encoding="utf-8").splitlines():
                try:
                    event = json.loads(line).get("event")
                except json.JSONDecodeError:
                    event = None
                if event:
                    events.append(event)
        if (
            previous.get("state") != "claimed"
            or previous.get("planId") != plan_id
            or previous.get("arm") != arm
            or int(previous.get("recoveryCount", 0)) >= 1
            or output.exists()
            or sealed_output.exists()
            or "retrieve" in events
            or "llm_settlement" in events
        ):
            raise ValueError("claimed blind arm is not eligible for infrastructure recovery")
        recovered = {
            **previous,
            "recoveryCount": int(previous.get("recoveryCount", 0)) + 1,
            "recoveredAtUnixMs": int(time.time() * 1000),
            "recoveryEvidence": {
                "outputAbsent": True,
                "sealedOutputAbsent": True,
                "retrievalEvents": 0,
                "llmSettlementEvents": 0,
                "logSha256": file_sha256(log_path) if log_path.exists() else None,
            },
        }
        temp_path = spent_path.with_suffix(f".{os.getpid()}.tmp")
        temp_path.write_text(json.dumps(recovered, indent=2), encoding="utf-8")
        os.replace(temp_path, spent_path)
        return
    payload = {
        "schemaVersion": "paw.longmemeval-blind-spent.v1",
        "state": "claimed",
        "planSha256": plan_sha256,
        "planId": plan_id,
        "planName": plan_path.name,
        "arm": arm,
        "outputName": output.name,
        "consumedAtUnixMs": int(time.time() * 1000),
        "recoveryCount": 0,
    }
    try:
        descriptor = os.open(
            spent_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError as error:
        raise ValueError(f"blind arm already consumed: {arm}") from error
    with os.fdopen(descriptor, "w", encoding="utf-8") as target:
        json.dump(payload, target, indent=2)


def complete_blind_arm(
    *,
    plan_id: str,
    arm: str,
    public_output: Path,
    sealed_output: Path,
) -> None:
    state_path = HERE / "runs" / ".custodian-state" / f"{plan_id}-{arm}.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if (
        state.get("state") != "claimed"
        or state.get("planId") != plan_id
        or state.get("arm") != arm
        or not public_output.exists()
        or not sealed_output.exists()
    ):
        raise ValueError("blind arm completion state is invalid")
    completed = {
        **state,
        "state": "completed",
        "completedAtUnixMs": int(time.time() * 1000),
        "publicOutputSha256": file_sha256(public_output),
        "sealedOutputSha256": file_sha256(sealed_output),
    }
    temp_path = state_path.with_suffix(f".{os.getpid()}.tmp")
    temp_path.write_text(json.dumps(completed, indent=2), encoding="utf-8")
    os.replace(temp_path, state_path)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


SOURCE_ARTIFACT_POLICY = "paw.longmemeval-source-bundle.v2:transitive-workspace"


def source_artifact_paths() -> tuple[Path, ...]:
    files: set[Path] = set()
    for package_src in (ROOT / "packages").glob("*/src"):
        files.update(package_src.rglob("*.ts"))
        files.update(package_src.rglob("*.tsx"))
        package_json = package_src.parent / "package.json"
        if package_json.exists():
            files.add(package_json)
        files.update(package_src.parent.glob("tsconfig*.json"))
        files.update(package_src.rglob("*.sql"))
    cli_src = ROOT / "apps/cli/src"
    files.update(cli_src.rglob("*.ts"))
    files.update(cli_src.rglob("*.tsx"))
    files.update(HERE.glob("*.py"))
    files.update(HERE.glob("*.ts"))
    upstream = HERE / "upstream"
    files.update((upstream / "src").rglob("*.py"))
    for path in (
        ROOT / "package.json",
        ROOT / "bun.lock",
        ROOT / "tsconfig.base.json",
        ROOT / "apps/cli/package.json",
        ROOT / "apps/cli/tsconfig.json",
        HERE / "UPSTREAM_COMMIT",
        upstream / "pyproject.toml",
        upstream / "uv.lock",
    ):
        if path.exists():
            files.add(path)
    return tuple(
        sorted(
            (path.resolve() for path in files if path.is_file()),
            key=lambda path: path.as_posix(),
        )
    )


def source_artifact_sha256(paths: tuple[Path, ...] | None = None) -> str:
    files = paths or source_artifact_paths()
    digest = hashlib.sha256()
    digest.update(SOURCE_ARTIFACT_POLICY.encode("utf-8"))
    digest.update(b"\0")
    for path in files:
        relative = path.resolve().relative_to(ROOT.resolve()).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def artifact_binding(dataset, embedding_artifact: dict) -> dict:
    data_path = Path(dataset._data_path()).resolve()
    source_paths = source_artifact_paths()
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
    except (OSError, subprocess.CalledProcessError):
        commit = None
        dirty = None
    return {
        "gitCommit": commit,
        "gitDirty": dirty,
        "sourceArtifactPolicy": SOURCE_ARTIFACT_POLICY,
        "sourceArtifactFileCount": len(source_paths),
        "sourceArtifactSha256": source_artifact_sha256(source_paths),
        "embeddingArtifact": embedding_artifact,
        "datasetArtifactSha256": file_sha256(data_path),
        "datasetArtifactBytes": data_path.stat().st_size,
    }


def select_queries(
    dataset,
    *,
    count_by_type: dict[str, int],
    seed: str,
    excluded_fingerprints: set[str],
    excluded_user_ids: set[str],
) -> list[object]:
    candidates_by_type: dict[str, list[object]] = {}
    for question_type in QUESTION_TYPES:
        candidates = [
            query
            for query in dataset.load_queries("s", category=question_type)
            if sha(query.id)[:20] not in excluded_fingerprints
            and query.user_id not in excluded_user_ids
        ]
        candidates.sort(key=lambda query: sha(f"{seed}\n{query.id}"))
        # Only the first seeded query for a persona can ever be used for this
        # category. Reducing here makes the global matching deterministic.
        unique_candidates: list[object] = []
        seen_users: set[str] = set()
        for candidate in candidates:
            if not candidate.user_id or candidate.user_id in seen_users:
                continue
            seen_users.add(candidate.user_id)
            unique_candidates.append(candidate)
        candidates_by_type[question_type] = unique_candidates
        target = count_by_type[question_type]
        if len(unique_candidates) < target:
            raise ValueError(
                f"not enough LongMemEval queries for {question_type}: "
                f"need {target}, have {len(unique_candidates)} eligible personas"
            )

    slots = [
        (question_type, slot_index)
        for question_type in QUESTION_TYPES
        for slot_index in range(count_by_type[question_type])
    ]
    # Most constrained category first. A deterministic augmenting-path
    # matching avoids the type-order starvation possible with greedy picking.
    slots.sort(
        key=lambda slot: (
            len(candidates_by_type[slot[0]]) - count_by_type[slot[0]],
            QUESTION_TYPES.index(slot[0]),
            slot[1],
        )
    )
    slot_to_query: dict[tuple[str, int], object] = {}
    user_to_slot: dict[str, tuple[str, int]] = {}

    def assign(slot: tuple[str, int], visited_users: set[str]) -> bool:
        for candidate in candidates_by_type[slot[0]]:
            user_id = candidate.user_id
            if user_id in visited_users:
                continue
            visited_users.add(user_id)
            previous_slot = user_to_slot.get(user_id)
            if previous_slot is None or assign(previous_slot, visited_users):
                user_to_slot[user_id] = slot
                slot_to_query[slot] = candidate
                return True
        return False

    for slot in slots:
        if not assign(slot, set()):
            raise ValueError(
                "not enough globally persona-disjoint LongMemEval queries for "
                f"{slot[0]} under the requested category quotas"
            )

    selected = list(slot_to_query.values())
    selected.sort(key=lambda query: sha(f"{seed}\nrun\n{query.id}"))
    return selected


RELEASE_PROVIDER_ENV = {
    "DATABASE_URL": "postgresql://postgres@127.0.0.1:54329/paw_memory_test",
    "PAW_AMB_RETRIEVAL_POLICY": "rrf",
    "PAW_AMB_EMBEDDING_MODE": "dense",
    "PAW_AMB_EMBEDDING_BASE_URL": "http://127.0.0.1:18081/v1",
    "PAW_AMB_EMBEDDING_MODEL": (
        "sentence-transformers/all-MiniLM-L6-v2-window-mean-180+zero-pad-1536"
    ),
    "PAW_AMB_EMBEDDING_VERSION": "window-mean-v1",
    "PAW_AMB_DENSE_INDEX_LEVEL": "turn",
    "PAW_AMB_EMBEDDING_CACHE_ENTRIES": "2048",
    "PAW_AMB_EMBEDDING_MAX_ATTEMPTS": "3",
    "PAW_AMB_EMBEDDING_RETRY_BASE_MS": "200",
    "PAW_AMB_ATOM_SOURCE_MAX_CHARS": "14000",
    "PAW_AMB_INGEST_MODE": "atom",
    "PAW_AMB_ATOM_CONTEXT_MODE": "evidence_first",
    "PAW_AMB_ATOM_WRITE_MODE": "off",
}

PINNED_EMBEDDING_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"


def local_embedding_artifact() -> dict:
    endpoint = RELEASE_PROVIDER_ENV["PAW_AMB_EMBEDDING_BASE_URL"].rstrip("/")
    with urllib.request.urlopen(f"{endpoint}/health", timeout=10) as response:
        payload = json.loads(response.read())
    expected = {
        "status": "ok",
        "model": "sentence-transformers/all-MiniLM-L6-v2",
        "revision": PINNED_EMBEDDING_REVISION,
        "dimensions": 1536,
        "windowWords": 180,
        "windowOverlapWords": 30,
        "torchThreads": 1,
        "transportMode": "single-thread-bounded",
    }
    if not isinstance(payload, dict) or any(
        payload.get(key) != value for key, value in expected.items()
    ):
        raise ValueError("local embedding server identity is incompatible")
    artifact_sha256 = payload.get("artifactSha256")
    if (
        not isinstance(artifact_sha256, str)
        or len(artifact_sha256) != 64
        or any(character not in "0123456789abcdef" for character in artifact_sha256)
    ):
        raise ValueError("local embedding artifact hash is invalid")
    return {
        **expected,
        "artifactSha256": artifact_sha256,
    }


def resolved_release_provider_env(embedding_artifact: dict) -> dict[str, str]:
    artifact_sha256 = embedding_artifact["artifactSha256"]
    return {
        **RELEASE_PROVIDER_ENV,
        "PAW_AMB_EMBEDDING_VERSION": (
            f"window-mean-v1:{PINNED_EMBEDDING_REVISION}:{artifact_sha256}"
        ),
        "PAW_AMB_EMBEDDING_REVISION": PINNED_EMBEDDING_REVISION,
        "PAW_AMB_EMBEDDING_ARTIFACT_SHA256": artifact_sha256,
    }


def experiment_protocol(
    args: argparse.Namespace,
    *,
    source_artifact_sha256: str,
    retrieval_environment: dict[str, str],
) -> dict:
    model = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash").strip()
    base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip()
    temperature = float(os.environ.get("DEEPSEEK_TEMPERATURE", "0"))
    return {
        "schemaVersion": "paw.longmemeval-paired-experiment.v4",
        "projectReleaseGate": PROJECT_RELEASE_GATE,
        "common": {
            "k": args.k,
            "answerRequired": True,
            "storeKey": args.store_key,
            "retrievalEnvironment": {
                key: value
                for key, value in retrieval_environment.items()
                if key != "DATABASE_URL"
            },
            "answerModel": {
                "modelId": f"deepseek:{model}",
                "endpointSha256": sha(base_url.rstrip("/")),
                "temperature": temperature,
                "thinking": "enabled",
                "reasoningEffort": "max",
            },
            "judgeModel": {
                "modelId": f"deepseek:{model}",
                "endpointSha256": sha(base_url.rstrip("/")),
                "temperature": temperature,
                "thinking": "enabled",
                "reasoningEffort": "max",
            },
            "toolProfile": os.environ.get("PAW_AMB_TOOL_PROFILE", "full"),
            "evidenceLedger": os.environ.get("PAW_AMB_EVIDENCE_LEDGER", "0"),
            "llmCachePolicy": {
                "answerJudge": "prompt-model-config-usage-envelope-v3",
                "memorySemantic": "prompt-model-config-source-artifact-usage-envelope-v3",
                "sourceArtifactSha256": source_artifact_sha256,
            },
            "prebuiltIndexPolicy": "complete-id-and-embedding-coverage-v2",
        },
        "arms": {
            "baseline": {
                "queryExpansion": False,
                "resume": False,
                "reuseIndex": True,
            },
            "treatment": {
                "queryExpansion": True,
                "resume": False,
                "reuseIndex": True,
            },
        },
    }


def validate_arm_configuration(args: argparse.Namespace, protocol: dict) -> None:
    expected = protocol["arms"][args.blind_arm]
    actual = {
        "queryExpansion": args.query_expansion,
        "resume": args.resume,
        "reuseIndex": args.reuse_index,
    }
    if args.answer is not True or actual != expected:
        raise ValueError(f"blind arm {args.blind_arm} configuration is incompatible")


def configure_provider(
    output: Path,
    *,
    resume: bool,
    reuse_index: bool,
    query_expansion: bool,
    strict: bool,
    source_artifact_sha256: str,
    retrieval_environment: dict[str, str],
) -> None:
    # The retained evidence-first result is a dense turn-level configuration.
    # Pin reproducible defaults here so a fresh shell cannot silently run a
    # lexical-only, non-comparable benchmark. Explicit environment overrides
    # remain available for named ablations.
    for key, value in retrieval_environment.items():
        if strict:
            os.environ[key] = value
        else:
            os.environ.setdefault(key, value)
    os.environ["PAW_AMB_INGEST_MODE"] = "atom"
    os.environ["PAW_AMB_ATOM_CONTEXT_MODE"] = "evidence_first"
    os.environ["PAW_AMB_ATOM_WRITE_MODE"] = "off"
    os.environ["PAW_AMB_SOURCE_ARTIFACT_SHA256"] = source_artifact_sha256
    if query_expansion:
        os.environ["PAW_AMB_QUERY_EXPANSION"] = "1"
    else:
        os.environ.pop("PAW_AMB_QUERY_EXPANSION", None)
    if resume:
        os.environ["PAW_AMB_ATOM_RESUME"] = "1"
    else:
        os.environ.pop("PAW_AMB_ATOM_RESUME", None)
    if reuse_index:
        os.environ["PAW_AMB_REUSE_INDEX"] = "1"
    else:
        os.environ.pop("PAW_AMB_REUSE_INDEX", None)
    log_path = ROOT / "logs" / "amb" / f"{output.stem}-retrieval.jsonl"
    if not resume:
        log_path.unlink(missing_ok=True)
    os.environ["PAW_AMB_LOG"] = str(log_path)


def summarize(rows: list[dict]) -> dict:
    by_type: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_type[row["questionType"]].append(row)

    def metrics(items: list[dict]) -> dict:
        answerable = [item for item in items if item["goldDocumentCount"] > 0]
        closure_eligible = [
            item for item in items if isinstance(item.get("evidenceClosed"), bool)
        ]
        closed = [item for item in closure_eligible if item.get("evidenceClosed") is True]
        return {
            "queries": len(items),
            "answerableQueries": len(answerable),
            "unanswerableQueries": len(items) - len(answerable),
            "hitCount": sum(1 for item in answerable if item["hit"]),
            "hitRate": (
                sum(1 for item in answerable if item["hit"]) / len(answerable)
                if answerable
                else None
            ),
            "macroRecall": (
                sum(item["goldRecall"] for item in answerable) / len(answerable)
                if answerable
                else None
            ),
            "meanReciprocalRank": (
                sum(item["reciprocalRank"] for item in answerable) / len(answerable)
                if answerable
                else None
            ),
            "closureEligibleQueries": len(closure_eligible),
            "closedEvidenceQueries": len(closed),
            "evidenceClosureRate": (
                len(closed) / len(closure_eligible) if closure_eligible else None
            ),
            "averageRetrieveMs": (
                sum(item["retrieveMs"] for item in items) / len(items)
                if items
                else None
            ),
            "averageContextTokens": (
                sum(item["contextTokens"] for item in items) / len(items)
                if items
                else None
            ),
        }

    return {
        "overall": metrics(rows),
        "byQuestionType": {
            question_type: metrics(by_type[question_type])
            for question_type in QUESTION_TYPES
        },
    }


def summarize_answers(rows: list[dict]) -> dict | None:
    answered = [row for row in rows if isinstance(row.get("answerCorrect"), bool)]
    if not answered:
        return None

    def metrics(items: list[dict]) -> dict:
        judged = [item for item in items if isinstance(item.get("answerCorrect"), bool)]
        correct = sum(1 for item in judged if item["answerCorrect"])
        source_hit = [item for item in judged if item.get("hit") is True]
        closed = [item for item in judged if item.get("evidenceClosed") is True]
        return {
            "queries": len(judged),
            "correct": correct,
            "accuracy": correct / len(judged) if judged else None,
            "accuracyGivenSourceHit": (
                sum(1 for item in source_hit if item["answerCorrect"]) / len(source_hit)
                if source_hit
                else None
            ),
            "accuracyGivenEvidenceClosure": (
                sum(1 for item in closed if item["answerCorrect"]) / len(closed)
                if closed
                else None
            ),
            "incorrectDespiteEvidenceClosure": sum(
                1 for item in closed if not item["answerCorrect"]
            ),
        }

    return {
        "overall": metrics(answered),
        "byQuestionType": {
            question_type: metrics(
                [row for row in answered if row["questionType"] == question_type]
            )
            for question_type in QUESTION_TYPES
        },
    }


def run(args: argparse.Namespace) -> dict:
    from memory_bench.dataset import get_dataset
    from paw_provider import PawMemoryProvider

    answer_llm = None
    judge_llm = None
    answer_mode = None
    judge = None
    if args.answer:
        from deepseek_llm import DeepSeekFlashLLM
        from memory_bench.judge import GeminiJudge
        from memory_bench.modes.rag import RAGMode

        answer_llm = DeepSeekFlashLLM()
        judge_llm = DeepSeekFlashLLM()
        answer_mode = RAGMode(answer_llm)
        judge = GeminiJudge(judge_llm)

    dataset = get_dataset("longmemeval")
    embedding_artifact = local_embedding_artifact()
    retrieval_environment = resolved_release_provider_env(embedding_artifact)
    artifacts = artifact_binding(dataset, embedding_artifact)
    protocol = experiment_protocol(
        args,
        source_artifact_sha256=artifacts["sourceArtifactSha256"],
        retrieval_environment=retrieval_environment,
    )
    excluded_fingerprints: set[str] = set()
    excluded_query_hmacs: set[str] = set()
    excluded_user_fingerprints: set[str] = set()
    excluded_user_hmacs: set[str] = set()
    exclusion_reports: list[dict] = []
    for exclusion_path in args.exclude_report:
        exclusion_bytes = exclusion_path.read_bytes()
        exclusion_report = json.loads(exclusion_bytes)
        report_manifest = validated_exclusion_manifest(exclusion_report)
        report_queries = set(report_manifest.get("queryFingerprints", []))
        report_query_hmacs = set(report_manifest.get("queryHmacs", []))
        report_users = set(report_manifest.get("userFingerprints", []))
        report_user_hmacs = set(report_manifest.get("userHmacs", []))
        if not report_queries and not report_users:
            raise ValueError(
                "public or empty report cannot be used for exclusion; "
                "pass a sealed ledger with --exclude-ledger"
            )
        excluded_fingerprints.update(report_queries)
        excluded_query_hmacs.update(report_query_hmacs)
        excluded_user_fingerprints.update(report_users)
        excluded_user_hmacs.update(report_user_hmacs)
        exclusion_reports.append(
            {
                "reportSha256": hashlib.sha256(exclusion_bytes).hexdigest(),
                "queryFingerprintCount": len(report_queries),
                "userFingerprintCount": len(report_users),
                "queryHmacCount": len(report_query_hmacs),
                "userHmacCount": len(report_user_hmacs),
            }
        )
    eval_key_id = hashlib.sha256(args.eval_hmac_key).hexdigest()[:20]
    for exclusion_path in args.exclude_ledger:
        exclusion_bytes = exclusion_path.read_bytes()
        exclusion_report = json.loads(exclusion_bytes)
        report_manifest = validated_exclusion_manifest(exclusion_report)
        report_query_hmacs = set(report_manifest.get("queryHmacs", []))
        report_user_hmacs = set(report_manifest.get("userHmacs", []))
        report_binding = report_manifest.get("artifactBinding", {})
        if (
            not report_query_hmacs
            or not report_user_hmacs
            or report_manifest.get("evalKeyId") != eval_key_id
            or report_binding.get("datasetArtifactSha256")
            != artifacts["datasetArtifactSha256"]
        ):
            raise ValueError("sealed exclusion ledger identity is incompatible")
        excluded_query_hmacs.update(report_query_hmacs)
        excluded_user_hmacs.update(report_user_hmacs)
        exclusion_reports.append(
            {
                "ledgerSha256": hashlib.sha256(exclusion_bytes).hexdigest(),
                "queryHmacCount": len(report_query_hmacs),
                "userHmacCount": len(report_user_hmacs),
            }
        )
    # Older content-free reports did not persist user fingerprints. Resolve
    # their query fingerprints back to users in-memory, and never write the raw
    # identifiers to the result. This makes the final holdout persona-disjoint,
    # not merely question-disjoint.
    excluded_user_ids: set[str] = set()
    for question_type in QUESTION_TYPES:
        for candidate in dataset.load_queries("s", category=question_type):
            if candidate.user_id and (
                sha(candidate.id)[:20] in excluded_fingerprints
                or eval_hmac(candidate.id, args.eval_hmac_key)
                in excluded_query_hmacs
                or sha(candidate.user_id)[:20] in excluded_user_fingerprints
                or eval_hmac(candidate.user_id, args.eval_hmac_key)
                in excluded_user_hmacs
            ):
                excluded_user_ids.add(candidate.user_id)
    exclusion_manifest = {
        "reports": exclusion_reports,
        "excludedQueryCount": len(excluded_fingerprints),
        "excludedUserCount": len(excluded_user_ids),
    }
    count_by_type = {
        question_type: (
            args.preference_count
            if question_type == "single-session-preference"
            and args.preference_count is not None
            else args.per_type
        )
        for question_type in QUESTION_TYPES
    }
    queries = select_queries(
        dataset,
        count_by_type=count_by_type,
        seed=args.seed,
        excluded_fingerprints=excluded_fingerprints,
        excluded_user_ids=excluded_user_ids,
    )
    user_ids = {query.user_id for query in queries if query.user_id}
    documents = dataset.load_documents("s", user_ids=user_ids)
    document_counts = Counter(document.user_id for document in documents)
    manifest = {
        "schemaVersion": "paw.longmemeval-stratified-manifest.v2",
        "dataset": "longmemeval",
        "split": "s",
        "seed": args.seed,
        "seedCommitment": eval_hmac(f"seed:{args.seed}", args.eval_hmac_key),
        "evalKeyId": eval_key_id,
        "perQuestionType": args.per_type,
        "questionTypeTargets": count_by_type,
        "queryCount": len(queries),
        "documentCount": len(documents),
        "queryHmacs": [eval_hmac(query.id, args.eval_hmac_key) for query in queries],
        "userHmacs": sorted(
            eval_hmac(user_id, args.eval_hmac_key) for user_id in user_ids
        ),
        "questionTypeCounts": dict(Counter(query.meta["question_type"] for query in queries)),
        "historyDocumentCounts": sorted(document_counts.values()),
        "selectionPolicy": "sha256-seeded-global-persona-bipartite-matching-v3",
        "retrievalProfile": RETRIEVAL_PROFILE,
        "evaluationMode": "static-initial-evidence-packet",
        "partialRecoveryExecuted": False,
        "eventIdentityMode": "episode-fallback",
        "eventKeyCoverageRate": 0.0,
        "experimentProtocol": protocol,
        "artifactBinding": artifacts,
        "exclusion": exclusion_manifest,
        "claimLevel": (
            "release-blind-plan"
            if args.release_blind and args.dry_run
            else "local-one-shot-blind"
            if args.release_blind
            else "development"
        ),
        "contentFree": True,
    }
    blind_plan_sha256 = None
    if args.blind_plan is not None:
        plan_bytes = args.blind_plan.read_bytes()
        blind_plan_sha256 = hashlib.sha256(plan_bytes).hexdigest()
        plan = json.loads(plan_bytes)
        plan_manifest = validate_blind_plan(
            plan,
            manifest=manifest,
            eval_key_id=eval_key_id,
            arm=args.blind_arm,
            query_expansion=args.query_expansion,
        )
        plan_id = blind_plan_id(plan_manifest)
        validate_arm_configuration(args, protocol)
        manifest["blindPlan"] = {
            "sha256": blind_plan_sha256,
            "planId": plan_id,
            "arm": args.blind_arm,
            "oneShot": True,
            "custody": "local-fixed-ledger",
        }
    if args.dry_run:
        return {
            "schemaVersion": "paw.longmemeval-evidence-retrieval-result.v1",
            "runnerPolicy": RUNNER_POLICY,
            "memoryPolicy": MEMORY_POLICY,
            "searchPolicy": SEARCH_POLICY,
            "manifest": manifest,
            "dryRun": True,
        }

    if args.blind_plan is not None:
        consume_blind_arm(
            plan_path=args.blind_plan,
            plan_sha256=blind_plan_sha256,
            plan_id=plan_id,
            arm=args.blind_arm,
            output=args.output,
            sealed_output=args.sealed_ledger,
            recover_claimed=args.recover_claimed_arm,
        )

    configure_provider(
        args.output,
        resume=args.resume or args.reuse_index,
        reuse_index=args.reuse_index,
        query_expansion=args.query_expansion,
        strict=args.release_blind,
        source_artifact_sha256=artifacts["sourceArtifactSha256"],
        retrieval_environment=retrieval_environment,
    )
    provider = PawMemoryProvider()
    store_dir = args.output.parent / f"{args.store_key}-store"
    rows: list[dict] = []
    ingestion_started = time.perf_counter()
    try:
        provider.prepare(
            store_dir,
            unit_ids=user_ids,
            reset=not (args.resume or args.reuse_index),
        )
        provider.ingest(documents)
        ingestion_ms = (time.perf_counter() - ingestion_started) * 1_000
        for query in queries:
            started = time.perf_counter()
            recalled, raw = provider.retrieve(
                query.query,
                k=args.k,
                user_id=query.user_id,
                query_timestamp=query.meta.get("query_timestamp"),
            )
            retrieve_ms = (time.perf_counter() - started) * 1_000
            recalled_ids = list(dict.fromkeys(document.id for document in recalled))
            gold_ids = set(query.gold_ids)
            matched = gold_ids.intersection(recalled_ids)
            first_rank = next(
                (index for index, document_id in enumerate(recalled_ids, start=1) if document_id in gold_ids),
                None,
            )
            answerable = bool(gold_ids)
            rows.append(
                row := {
                    "queryHmac": eval_hmac(query.id, args.eval_hmac_key),
                    "questionType": query.meta["question_type"],
                    "goldDocumentCount": len(gold_ids),
                    "recalledDocumentCount": len(recalled_ids),
                    "matchedGoldCount": len(matched),
                    "answerable": answerable,
                    "hit": bool(matched) if answerable else None,
                    "goldRecall": (
                        len(matched) / len(gold_ids) if answerable else None
                    ),
                    "reciprocalRank": (
                        1 / first_rank if first_rank else 0 if answerable else None
                    ),
                    "contextTokens": sum(len(document.content) for document in recalled) // 4,
                    "retrieveMs": round(retrieve_ms, 1),
                    "route": raw.get("memoryRoute") if isinstance(raw, dict) else None,
                    "selectedSourceCount": (
                        raw.get("evidenceFirstSelectedSourceCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "evidenceRequirementCount": (
                        raw.get("evidenceFirstPlanRequirementCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "evidenceCoveredCount": (
                        raw.get("evidenceFirstNotebookCoveredCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "evidencePartialCount": (
                        raw.get("evidenceFirstNotebookPartialCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "evidenceMissingCount": (
                        raw.get("evidenceFirstNotebookMissingCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "independentEvidenceCount": (
                        raw.get("evidenceFirstNotebookIndependentEvidenceCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "closureEvidenceCount": (
                        raw.get("evidenceFirstNotebookClosureEvidenceCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "unresolvedEvidenceCount": (
                        raw.get("evidenceFirstNotebookUnresolvedEvidenceCount")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "plannerStatus": (
                        raw.get("evidenceFirstQueryExpansionStatus")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "supportSelectorStatus": (
                        raw.get("evidenceFirstSupportSelectorStatus")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "directCertificateStatus": (
                        raw.get("evidenceFirstDirectCertificateStatus")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "contextStop": (
                        raw.get("evidenceFirstContextStop")
                        if isinstance(raw, dict)
                        else None
                    ),
                    "verificationStatus": (
                        raw.get("evidenceFirstVerificationStatus")
                        if isinstance(raw, dict)
                        else None
                    ),
                }
            )
            row["evidenceClosed"] = row.get("contextStop") == "sufficient"
            if answer_mode is not None and judge is not None:
                context = "\n\n".join(
                    f"## Memory {index + 1}\n{document.content}"
                    for index, document in enumerate(recalled)
                )

                def prompt_fn(question: str, packet: str, meta=None) -> str:
                    return dataset.build_rag_prompt(
                        question,
                        packet,
                        "open",
                        "s",
                        query.meta["question_type"],
                        meta,
                    )

                answer = answer_mode.answer_from_context(
                    query.query,
                    context,
                    task_type="open",
                    meta={**query.meta, "_prompt_fn": prompt_fn},
                )
                prompt = dataset.get_judge_prompt_fn(
                    query.meta["question_type"], query.meta
                )
                judgment = judge.score(
                    query.query,
                    answer.answer,
                    query.gold_answers,
                    prompt,
                )
                row.update(
                    {
                        "answerCorrect": judgment.correct,
                        "answerHash": sha(answer.answer),
                        "answerChars": len(answer.answer),
                        "judgeReasonHash": sha(judgment.reason),
                    }
                )
        stats = provider.stats()
    finally:
        provider.cleanup()

    return {
        "schemaVersion": "paw.longmemeval-evidence-retrieval-result.v1",
        "runnerPolicy": RUNNER_POLICY,
        "memoryPolicy": MEMORY_POLICY,
        "searchPolicy": SEARCH_POLICY,
        "queryExpansionEnabled": args.query_expansion,
        "manifest": manifest,
        "k": args.k,
        "ingestionMs": round(ingestion_ms, 1),
        "metrics": summarize(rows),
        "answerMetrics": summarize_answers(rows),
        "providerStats": stats,
        "answerLlmStats": answer_llm.stats() if answer_llm is not None else None,
        "judgeLlmStats": judge_llm.stats() if judge_llm is not None else None,
        "rows": rows,
        "dryRun": False,
        "note": (
            "Content-free static initial-packet evaluation against LongMemEval "
            "has_answer session labels; partial product recovery is not executed, and no "
            "question, answer, conversation, or retrieved text is persisted. Event identity "
            "currently falls back to episode diversity because no eventKey producer is active."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--store-key", default="paw-longmemeval-retrieval-v1")
    parser.add_argument(
        "--seed",
        required=True,
        help="High-entropy secret selection seed; never publish before split retirement.",
    )
    parser.add_argument("--per-type", type=int, default=2)
    parser.add_argument(
        "--preference-count",
        type=int,
        help="Optional explicit target for the smaller preference category.",
    )
    parser.add_argument("--k", type=int, default=8)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--reuse-index", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--answer", action="store_true")
    parser.add_argument("--sealed-ledger", type=Path)
    parser.add_argument("--eval-key-file", type=Path)
    parser.add_argument(
        "--blind-plan",
        type=Path,
        help="Consume a sealed dry-run plan for a one-shot paired blind arm.",
    )
    parser.add_argument(
        "--blind-arm",
        choices=("baseline", "treatment"),
        help="Named arm authorized by --blind-plan.",
    )
    parser.add_argument(
        "--release-blind",
        action="store_true",
        help="Enable the strict release protocol and require a sealed plan for execution.",
    )
    parser.add_argument(
        "--recover-claimed-arm",
        action="store_true",
        help=(
            "Allow one audited retry only when a claimed arm produced no retrieval, "
            "LLM, public, or sealed result."
        ),
    )
    parser.add_argument(
        "--exclude-report",
        type=Path,
        action="append",
        default=[],
        help="Exclude queries and their users from a prior content-free report; repeatable.",
    )
    parser.add_argument(
        "--exclude-ledger",
        type=Path,
        action="append",
        default=[],
        help="Exclude a prior sealed HMAC ledger; repeatable.",
    )
    parser.add_argument(
        "--query-expansion",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    args = parser.parse_args()
    if (args.blind_plan is None) != (args.blind_arm is None):
        raise ValueError("--blind-plan and --blind-arm must be supplied together")
    if args.dry_run and args.blind_plan is not None:
        raise ValueError("a dry run creates a blind plan and cannot consume one")
    if args.release_blind and not args.dry_run and args.blind_plan is None:
        raise ValueError("release blind execution requires --blind-plan")
    if args.blind_plan is not None and not args.release_blind:
        raise ValueError("--blind-plan may only be consumed in --release-blind mode")
    if args.recover_claimed_arm and args.blind_plan is None:
        raise ValueError("--recover-claimed-arm requires --blind-plan")
    if args.release_blind and args.dry_run and not args.answer:
        raise ValueError("release blind plan must bind an answered evaluation")
    if args.eval_key_file is None:
        args.eval_key_file = (
            Path("benchmarks/amb/runs/.secrets/longmemeval-eval-hmac.key")
        )
    args.eval_hmac_key = load_or_create_eval_key(args.eval_key_file)
    if args.sealed_ledger is None:
        args.sealed_ledger = (
            args.output.parent / ".sealed" / f"{args.output.stem}-ledger.json"
        )
    if args.per_type < 1 or args.per_type > 32:
        raise ValueError("per-type must be between 1 and 32")
    if args.preference_count is not None and not 1 <= args.preference_count <= 32:
        raise ValueError("preference-count must be between 1 and 32")
    if args.k < 1 or args.k > 16:
        raise ValueError("k must be between 1 and 16")
    if args.answer:
        from run_paw_context_probe import configure_deepseek

        configure_deepseek()
    sealed_report = run(args)
    args.sealed_ledger.parent.mkdir(parents=True, exist_ok=True)
    sealed_bytes = json.dumps(sealed_report, indent=2).encode("utf-8")
    args.sealed_ledger.write_bytes(sealed_bytes)
    report = public_report(
        sealed_report,
        hashlib.sha256(sealed_bytes).hexdigest(),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.blind_plan is not None:
        complete_blind_arm(
            plan_id=report["manifest"]["blindPlan"]["planId"],
            arm=args.blind_arm,
            public_output=args.output,
            sealed_output=args.sealed_ledger,
        )
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
