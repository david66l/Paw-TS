from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


LEGACY_COMPARATOR_POLICY = "paw.longmemeval-paired-comparator.v1:content-free-exact"
COST_COMPARATOR_POLICY = (
    "paw.longmemeval-paired-comparator.v2:content-free-cost-audited"
)
ACCURACY_PROJECT_RELEASE_GATE_V1 = {
    "minimumTreatmentAccuracy": 0.75,
    "minimumQuestionTypeAccuracy": 0.60,
    "minimumPairedAccuracyGain": 0.075,
    "maximumRetrievalDegradation": 0.02,
}
DEFAULT_PROJECT_RELEASE_GATE = {
    **ACCURACY_PROJECT_RELEASE_GATE_V1,
    "maximumContextTokenIncreaseRatio": 0.50,
    "maximumTreatmentMemoryCallsPerQuery": 2.0,
    "maximumTreatmentMemoryWorkloadTokensPerQuery": 4_000.0,
}
QUESTION_TYPES = (
    "single-session-user",
    "single-session-assistant",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
    "single-session-preference",
)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def exact_mcnemar_p(baseline_only: int, treatment_only: int) -> float:
    discordant = baseline_only + treatment_only
    if discordant == 0:
        return 1.0
    tail = min(baseline_only, treatment_only)
    return min(
        1.0,
        2.0
        * sum(math.comb(discordant, index) for index in range(tail + 1))
        / (2**discordant),
    )


def verified_rows(
    *,
    public: dict[str, Any],
    sealed: dict[str, Any],
    sealed_path: Path,
    expected_arm: str,
) -> dict[str, dict[str, Any]]:
    manifest = sealed.get("manifest")
    rows = sealed.get("rows")
    if not isinstance(manifest, dict) or manifest.get("contentFree") is not True:
        raise ValueError(f"{expected_arm} sealed manifest is incompatible")
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"{expected_arm} sealed rows are missing")
    blind_plan = manifest.get("blindPlan")
    if not isinstance(blind_plan, dict) or blind_plan.get("arm") != expected_arm:
        raise ValueError(f"{expected_arm} arm binding is incompatible")
    public_ledger = public.get("sealedLedger")
    if (
        not isinstance(public_ledger, dict)
        or public_ledger.get("sha256") != file_sha256(sealed_path)
        or public_ledger.get("rowCount") != len(rows)
    ):
        raise ValueError(f"{expected_arm} public/sealed binding is invalid")

    indexed: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError(f"{expected_arm} row is invalid")
        query_hmac = row.get("queryHmac")
        question_type = row.get("questionType")
        if (
            not isinstance(query_hmac, str)
            or not query_hmac
            or question_type not in QUESTION_TYPES
            or not isinstance(row.get("answerCorrect"), bool)
            or query_hmac in indexed
        ):
            raise ValueError(f"{expected_arm} row identity is invalid")
        indexed[query_hmac] = row

    public_correct = public.get("answerMetrics", {}).get("overall", {}).get("correct")
    aggregate = sealed_aggregate(rows)
    public_answer = public.get("answerMetrics", {}).get("overall", {})
    public_retrieval = public.get("metrics", {}).get("overall", {})
    if (
        public_correct != aggregate["correct"]
        or public_answer.get("queries") != aggregate["queries"]
        or not same_number(public_answer.get("accuracy"), aggregate["accuracy"])
        or public_retrieval.get("queries") != aggregate["queries"]
        or not same_number(public_retrieval.get("hitRate"), aggregate["hitRate"])
        or not same_number(
            public_retrieval.get("macroRecall"), aggregate["macroRecall"]
        )
    ):
        raise ValueError(f"{expected_arm} public metrics do not match sealed rows")
    return indexed


def sealed_aggregate(rows: list[dict[str, Any]]) -> dict[str, float | int | None]:
    answerable = []
    for row in rows:
        if not isinstance(row.get("goldDocumentCount"), int):
            raise ValueError("sealed retrieval metrics are invalid")
        if row["goldDocumentCount"] > 0:
            if not isinstance(row.get("hit"), bool) or not isinstance(
                row.get("goldRecall"), (int, float)
            ):
                raise ValueError("sealed retrieval metrics are invalid")
            answerable.append(row)
    correct = sum(bool(row["answerCorrect"]) for row in rows)
    context_tokens = [row.get("contextTokens") for row in rows]
    average_context_tokens = (
        sum(float(value) for value in context_tokens) / len(context_tokens)
        if context_tokens
        and all(
            isinstance(value, (int, float)) and value >= 0
            for value in context_tokens
        )
        else None
    )
    return {
        "queries": len(rows),
        "correct": correct,
        "accuracy": correct / len(rows),
        "hitRate": (
            sum(bool(row["hit"]) for row in answerable) / len(answerable)
            if answerable
            else 0.0
        ),
        "macroRecall": (
            sum(float(row["goldRecall"]) for row in answerable) / len(answerable)
            if answerable
            else 0.0
        ),
        "averageContextTokens": average_context_tokens,
    }


def paired_cost_metrics(
    *,
    treatment: dict[str, Any],
    baseline_aggregate: dict[str, float | int | None],
    treatment_aggregate: dict[str, float | int | None],
    query_count: int,
) -> dict[str, Any]:
    baseline_context = baseline_aggregate.get("averageContextTokens")
    treatment_context = treatment_aggregate.get("averageContextTokens")
    context_ratio = None
    if isinstance(baseline_context, (int, float)) and isinstance(
        treatment_context, (int, float)
    ):
        context_ratio = (
            (float(treatment_context) - float(baseline_context))
            / float(baseline_context)
            if baseline_context > 0
            else 0.0
            if treatment_context == 0
            else None
        )
    budget = treatment.get("providerStats", {}).get("atomBudget", {})
    remote_calls = budget.get("remoteCalls")
    cache_hits = budget.get("cacheHits")
    workload_tokens = budget.get("workloadTotalTokens")
    budget_evidence_complete = budget.get("costEvidenceComplete") is True
    memory_calls_per_query = (
        (remote_calls + cache_hits) / query_count
        if isinstance(remote_calls, int)
        and remote_calls >= 0
        and isinstance(cache_hits, int)
        and cache_hits >= 0
        else None
    )
    memory_tokens_per_query = (
        float(workload_tokens) / query_count
        if isinstance(workload_tokens, (int, float)) and workload_tokens >= 0
        else None
    )
    provider_hit_tokens = _sum_nonnegative_numbers(
        budget.get("providerCacheHitTokens"),
        budget.get("cachedOriginProviderCacheHitTokens"),
    )
    provider_miss_tokens = _sum_nonnegative_numbers(
        budget.get("providerCacheMissTokens"),
        budget.get("cachedOriginProviderCacheMissTokens"),
    )
    provider_cache_rate = (
        provider_hit_tokens / (provider_hit_tokens + provider_miss_tokens)
        if provider_hit_tokens is not None
        and provider_miss_tokens is not None
        and provider_hit_tokens + provider_miss_tokens > 0
        else None
    )
    evidence_complete = (
        budget_evidence_complete
        and context_ratio is not None
        and memory_calls_per_query is not None
        and memory_tokens_per_query is not None
    )
    return {
        "evidenceComplete": evidence_complete,
        "baselineAverageContextTokens": baseline_context,
        "treatmentAverageContextTokens": treatment_context,
        "contextTokenIncreaseRatio": context_ratio,
        "treatmentMemoryCallsPerQuery": memory_calls_per_query,
        "treatmentMemoryWorkloadTokensPerQuery": memory_tokens_per_query,
        "treatmentLocalSemanticCacheHits": cache_hits,
        "treatmentProviderPromptCacheHitRate": provider_cache_rate,
        "note": (
            "Memory workload tokens include origin usage replayed from local "
            "response-cache envelopes; provider prompt-cache tokens remain separate."
        ),
    }


def _sum_nonnegative_numbers(*values: object) -> float | None:
    if not all(isinstance(value, (int, float)) and value >= 0 for value in values):
        return None
    return sum(float(value) for value in values)


def same_number(value: object, expected: float | int) -> bool:
    return isinstance(value, (int, float)) and math.isclose(
        float(value),
        float(expected),
        rel_tol=0.0,
        abs_tol=1e-12,
    )


def compare_reports(
    *,
    baseline_public_path: Path,
    baseline_sealed_path: Path,
    treatment_public_path: Path,
    treatment_sealed_path: Path,
) -> dict[str, Any]:
    baseline_public = load_json(baseline_public_path)
    baseline_sealed = load_json(baseline_sealed_path)
    treatment_public = load_json(treatment_public_path)
    treatment_sealed = load_json(treatment_sealed_path)
    baseline_rows = verified_rows(
        public=baseline_public,
        sealed=baseline_sealed,
        sealed_path=baseline_sealed_path,
        expected_arm="baseline",
    )
    treatment_rows = verified_rows(
        public=treatment_public,
        sealed=treatment_sealed,
        sealed_path=treatment_sealed_path,
        expected_arm="treatment",
    )
    if baseline_rows.keys() != treatment_rows.keys():
        raise ValueError("paired reports do not contain the same query identities")

    baseline_plan = baseline_sealed["manifest"]["blindPlan"]
    treatment_plan = treatment_sealed["manifest"]["blindPlan"]
    if baseline_plan.get("planId") != treatment_plan.get("planId"):
        raise ValueError("paired reports do not share one blind plan")
    for field in ("artifactBinding", "experimentProtocol", "questionTypeCounts"):
        if baseline_sealed["manifest"].get(field) != treatment_sealed["manifest"].get(field):
            raise ValueError(f"paired reports disagree on {field}")

    contingency = {
        "bothWrong": 0,
        "baselineWrongTreatmentCorrect": 0,
        "baselineCorrectTreatmentWrong": 0,
        "bothCorrect": 0,
    }
    per_type = {
        question_type: {
            "queries": 0,
            "baselineCorrect": 0,
            "treatmentCorrect": 0,
        }
        for question_type in QUESTION_TYPES
    }
    for query_hmac, baseline_row in baseline_rows.items():
        treatment_row = treatment_rows[query_hmac]
        if baseline_row["questionType"] != treatment_row["questionType"]:
            raise ValueError("paired row question types disagree")
        baseline_correct = baseline_row["answerCorrect"]
        treatment_correct = treatment_row["answerCorrect"]
        if baseline_correct and treatment_correct:
            contingency["bothCorrect"] += 1
        elif baseline_correct:
            contingency["baselineCorrectTreatmentWrong"] += 1
        elif treatment_correct:
            contingency["baselineWrongTreatmentCorrect"] += 1
        else:
            contingency["bothWrong"] += 1
        bucket = per_type[baseline_row["questionType"]]
        bucket["queries"] += 1
        bucket["baselineCorrect"] += int(baseline_correct)
        bucket["treatmentCorrect"] += int(treatment_correct)

    query_count = len(baseline_rows)
    baseline_aggregate = sealed_aggregate(list(baseline_rows.values()))
    treatment_aggregate = sealed_aggregate(list(treatment_rows.values()))
    baseline_accuracy = baseline_aggregate["accuracy"]
    treatment_accuracy = treatment_aggregate["accuracy"]
    baseline_retrieval = baseline_aggregate
    treatment_retrieval = treatment_aggregate
    for bucket in per_type.values():
        count = bucket["queries"]
        bucket["baselineAccuracy"] = bucket.pop("baselineCorrect") / count
        bucket["treatmentAccuracy"] = bucket.pop("treatmentCorrect") / count
        bucket["accuracyDelta"] = (
            bucket["treatmentAccuracy"] - bucket["baselineAccuracy"]
        )

    treatment_only = contingency["baselineWrongTreatmentCorrect"]
    baseline_only = contingency["baselineCorrectTreatmentWrong"]
    protocol = baseline_sealed["manifest"]["experimentProtocol"]
    bound_thresholds = protocol.get("projectReleaseGate")
    if bound_thresholds is None:
        thresholds = ACCURACY_PROJECT_RELEASE_GATE_V1
        gate_binding = "post-hoc-default"
        cost_gate_bound = False
    elif bound_thresholds == ACCURACY_PROJECT_RELEASE_GATE_V1:
        thresholds = bound_thresholds
        gate_binding = "blind-plan"
        cost_gate_bound = False
    elif bound_thresholds == DEFAULT_PROJECT_RELEASE_GATE:
        thresholds = bound_thresholds
        gate_binding = "blind-plan"
        cost_gate_bound = True
    else:
        raise ValueError("paired reports contain an unsupported project release gate")
    cost = paired_cost_metrics(
        treatment=treatment_sealed,
        baseline_aggregate=baseline_aggregate,
        treatment_aggregate=treatment_aggregate,
        query_count=query_count,
    )
    gate_checks = {
        "treatmentAccuracy": treatment_accuracy >= thresholds["minimumTreatmentAccuracy"],
        "everyQuestionType": all(
            bucket["treatmentAccuracy"] >= thresholds["minimumQuestionTypeAccuracy"]
            for bucket in per_type.values()
        ),
        "pairedAccuracyGain": (
            treatment_accuracy - baseline_accuracy
            >= thresholds["minimumPairedAccuracyGain"]
        ),
        "hitRate": (
            treatment_retrieval["hitRate"]
            >= baseline_retrieval["hitRate"]
            - thresholds["maximumRetrievalDegradation"]
        ),
        "macroRecall": (
            treatment_retrieval["macroRecall"]
            >= baseline_retrieval["macroRecall"]
            - thresholds["maximumRetrievalDegradation"]
        ),
    }
    if cost_gate_bound:
        gate_checks.update(
            {
                "costEvidence": cost["evidenceComplete"],
                "contextTokens": (
                    cost["contextTokenIncreaseRatio"] is not None
                    and cost["contextTokenIncreaseRatio"]
                    <= thresholds["maximumContextTokenIncreaseRatio"]
                ),
                "memoryCalls": (
                    cost["treatmentMemoryCallsPerQuery"] is not None
                    and cost["treatmentMemoryCallsPerQuery"]
                    <= thresholds["maximumTreatmentMemoryCallsPerQuery"]
                ),
                "memoryWorkloadTokens": (
                    cost["treatmentMemoryWorkloadTokensPerQuery"] is not None
                    and cost["treatmentMemoryWorkloadTokensPerQuery"]
                    <= thresholds[
                        "maximumTreatmentMemoryWorkloadTokensPerQuery"
                    ]
                ),
            }
        )
    return {
        "schemaVersion": "paw.longmemeval-paired-comparison.v1",
        "comparatorPolicy": (
            COST_COMPARATOR_POLICY if cost_gate_bound else LEGACY_COMPARATOR_POLICY
        ),
        "contentFree": True,
        "inputs": {
            "baselinePublicSha256": file_sha256(baseline_public_path),
            "baselineSealedSha256": file_sha256(baseline_sealed_path),
            "treatmentPublicSha256": file_sha256(treatment_public_path),
            "treatmentSealedSha256": file_sha256(treatment_sealed_path),
            "blindPlanIdSha256": hashlib.sha256(
                baseline_plan["planId"].encode("utf-8")
            ).hexdigest(),
        },
        "queries": query_count,
        "contingency": contingency,
        "pairedStatistics": {
            "baselineAccuracy": baseline_accuracy,
            "treatmentAccuracy": treatment_accuracy,
            "absoluteAccuracyDelta": treatment_accuracy - baseline_accuracy,
            "relativeErrorReduction": (
                (treatment_accuracy - baseline_accuracy) / (1.0 - baseline_accuracy)
                if baseline_accuracy < 1.0
                else None
            ),
            "discordantPairs": baseline_only + treatment_only,
            "exactMcNemarPValueTwoSided": exact_mcnemar_p(
                baseline_only,
                treatment_only,
            ),
        },
        "retrieval": {
            "baselineHitRate": baseline_retrieval["hitRate"],
            "treatmentHitRate": treatment_retrieval["hitRate"],
            "hitRateDelta": treatment_retrieval["hitRate"] - baseline_retrieval["hitRate"],
            "baselineMacroRecall": baseline_retrieval["macroRecall"],
            "treatmentMacroRecall": treatment_retrieval["macroRecall"],
            "macroRecallDelta": (
                treatment_retrieval["macroRecall"] - baseline_retrieval["macroRecall"]
            ),
        },
        **({"cost": cost} if cost_gate_bound else {}),
        "byQuestionType": per_type,
        "projectReleaseGate": {
            "binding": gate_binding,
            "thresholds": thresholds,
            "checks": gate_checks,
            "passed": all(gate_checks.values()),
            "note": "Project gate, not an official AMB leaderboard threshold.",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-public", required=True, type=Path)
    parser.add_argument("--baseline-sealed", required=True, type=Path)
    parser.add_argument("--treatment-public", required=True, type=Path)
    parser.add_argument("--treatment-sealed", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = compare_reports(
        baseline_public_path=args.baseline_public,
        baseline_sealed_path=args.baseline_sealed,
        treatment_public_path=args.treatment_public,
        treatment_sealed_path=args.treatment_sealed,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
