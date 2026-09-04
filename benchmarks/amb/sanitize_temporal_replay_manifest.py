"""Project raw temporal shadow shards into a strict label-blind replay manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable, Sequence


SCHEMA_VERSION = "paw.temporal-treatment-replay-manifest.v1"
SHADOW_SCHEMA_VERSION = "paw.temporal-event-slot-shadow.v8"
HEX_32 = re.compile(r"^[0-9a-f]{32}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
RUN_INSTANCE = re.compile(r"^[A-Za-z0-9._-]{8,128}$")
FORBIDDEN_KEYS = {
    "answer",
    "baselineerror",
    "category",
    "endpoint",
    "gold",
    "hasanswer",
    "questiontype",
    "residual",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256_canonical(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def require_hex(value: Any, field: str, length: int) -> str:
    pattern = HEX_32 if length == 32 else HEX_64
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ValueError(f"{field} must be a lowercase {length}-hex value")
    return value


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"artifact is not a JSON object: {path}")
    return value


def assert_label_blind(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z]", "", str(key).casefold())
            if normalized != "providerendpointhmac" and any(
                token in normalized for token in FORBIDDEN_KEYS
            ):
                raise ValueError(f"forbidden label-bearing key at {path}.{key}")
            assert_label_blind(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_label_blind(child, f"{path}[{index}]")


def project_candidate_policy(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("candidate policy is missing")
    base_keys = {
        "sourceBoundary",
        "role",
        "ranker",
        "topK",
        "usesBenchmarkHasAnswerBeforeSelection",
    }
    reranker_keys = {
        "crossEncoderModel",
        "crossEncoderRevision",
        "crossEncoderMaxLength",
        "crossEncoderBatchSize",
        "rrfK",
        "crossEncoderArtifactSha256",
        "crossEncoderRuntimeVersions",
    }
    expected = base_keys | (reranker_keys if "crossEncoderModel" in raw else set())
    if set(raw) != expected:
        raise ValueError("candidate policy contains unknown or missing fields")
    if raw.get("usesBenchmarkHasAnswerBeforeSelection") is not False:
        raise ValueError("candidate policy is not label-blind")
    if (
        raw.get("role") != "user_only"
        or isinstance(raw.get("topK"), bool)
        or not isinstance(raw.get("topK"), int)
        or raw["topK"] < 1
    ):
        raise ValueError("candidate policy role or topK is invalid")
    if reranker_keys.issubset(raw):
        artifact_sha = raw.get("crossEncoderArtifactSha256")
        if artifact_sha is not None:
            require_hex(artifact_sha, "crossEncoderArtifactSha256", 64)
        versions = raw.get("crossEncoderRuntimeVersions")
        if not isinstance(versions, dict) or set(versions) != {
            "sentence-transformers",
            "transformers",
            "torch",
        }:
            raise ValueError("cross-encoder runtime versions are invalid")
        if any(not isinstance(value, str) or not value for value in versions.values()):
            raise ValueError("cross-encoder runtime version is invalid")
    projected = {key: raw[key] for key in sorted(expected - {"usesBenchmarkHasAnswerBeforeSelection"})}
    projected["benchmarkLabelsVisibleBeforeSelection"] = False
    return projected


def project_packet_policy(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("packet policy is missing")
    expected = {
        "policyVersion",
        "timeBasis",
        "queryCutoffRequired",
        "readerInjection",
        "semanticRelevanceProven",
        "eventSetCompletenessProven",
        "answerCorrectnessProven",
        "committeeSelectionPolicy",
        "bindingAssurance",
        "maxSelectedCandidates",
    }
    if set(raw) != expected:
        raise ValueError("packet policy contains unknown or missing fields")
    if (
        raw.get("queryCutoffRequired") is not True
        or raw.get("readerInjection") is not False
        or raw.get("semanticRelevanceProven") is not False
        or raw.get("eventSetCompletenessProven") is not False
        or raw.get("answerCorrectnessProven") is not False
        or raw.get("committeeSelectionPolicy") != "per_slot_intersection_consensus"
        or raw.get("bindingAssurance") != "address_only"
        or isinstance(raw.get("maxSelectedCandidates"), bool)
        or not isinstance(raw.get("maxSelectedCandidates"), int)
        or raw["maxSelectedCandidates"] < 1
    ):
        raise ValueError("packet policy safety invariants differ")
    return {
        key: raw[key]
        for key in sorted(expected - {"answerCorrectnessProven"})
    }


def project_model_policy(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {
        "model",
        "providerEndpointHmac",
        "planner",
        "binder",
    }:
        raise ValueError("model policy contains unknown or missing fields")
    planner = raw.get("planner")
    binder = raw.get("binder")
    if not isinstance(planner, dict) or not isinstance(binder, dict):
        raise ValueError("planner or binder policy is invalid")
    deterministic = planner.get("mode") == "deterministic"
    planner_keys = {"mode", "schemaVersion"}
    if not deterministic:
        raise ValueError("treatment replay requires the deterministic planner")
    if set(planner) != planner_keys:
        raise ValueError("planner policy contains unknown or missing fields")
    binder_keys = {
        "mode",
        "schemaVersion",
        "maxCompletionTokens",
        "thinking",
        "sampling",
        "replicas",
    }
    if set(binder) != binder_keys or binder.get("mode") != "event_packet":
        raise ValueError("binder policy contains unknown, missing, or unsafe fields")
    if not isinstance(binder.get("replicas"), int) or binder["replicas"] < 2:
        raise ValueError("binder replica count is invalid")
    if not isinstance(raw.get("model"), str) or not raw["model"]:
        raise ValueError("model identity is invalid")
    require_hex(raw.get("providerEndpointHmac"), "providerEndpointHmac", 32)
    return raw


def project_plan_slots(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("compiled plan must have slots")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for slot in raw:
        if not isinstance(slot, dict):
            raise ValueError("plan slot must be an object")
        slot_id = slot.get("slotId")
        role = slot.get("role")
        start = slot.get("queryStart")
        end = slot.get("queryEnd")
        if not isinstance(slot_id, str) or not slot_id or slot_id in seen:
            raise ValueError("plan slot IDs must be unique strings")
        if not isinstance(role, str) or not role:
            raise ValueError("plan slot role must be a string")
        if (
            isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, int)
            or not isinstance(end, int)
            or start < 0
            or start >= end
        ):
            raise ValueError("plan slot query span is invalid")
        if set(slot) != {
            "slotId",
            "role",
            "queryStart",
            "queryEnd",
            "queryMentionHmac",
        }:
            raise ValueError("plan slot contains unknown or missing fields")
        seen.add(slot_id)
        result.append(
            {
                "slotId": slot_id,
                "role": role,
                "queryStart": start,
                "queryEnd": end,
                "queryMentionHmac": require_hex(
                    slot.get("queryMentionHmac"), "queryMentionHmac", 32
                ),
            }
        )
    if [slot["slotId"] for slot in result] != [
        f"E{index}" for index in range(1, len(result) + 1)
    ]:
        raise ValueError("plan slot IDs must be consecutive")
    return result


def project_selected_slots(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise ValueError("selected slots must be a list")
    result: list[dict[str, Any]] = []
    for slot in raw:
        if not isinstance(slot, dict):
            raise ValueError("selected slot must be an object")
        slot_id = slot.get("slotId")
        role = slot.get("role")
        refs = slot.get("evidenceRefHmacs")
        if not isinstance(slot_id, str) or not isinstance(role, str):
            raise ValueError("selected slot identity is invalid")
        if not isinstance(refs, list):
            raise ValueError("selected slot evidence must be a list")
        checked = sorted(require_hex(ref, "evidenceRefHmac", 32) for ref in refs)
        result.append(
            {"slotId": slot_id, "role": role, "evidenceRefHmacs": checked}
        )
    return result


def project_row(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("shadow row must be an object")
    planner_status = raw.get("plannerStatus")
    compiled = planner_status in {"compiled", "planned"}
    plan = None
    if compiled:
        operator = raw.get("planOperator")
        unit = raw.get("planUnit")
        if not isinstance(operator, str) or not operator:
            raise ValueError("compiled plan operator is invalid")
        if unit is not None and not isinstance(unit, str):
            raise ValueError("compiled plan unit is invalid")
        plan = {
            "revisionHmac": require_hex(
                raw.get("planRevisionHmac"), "planRevisionHmac", 32
            ),
            "operator": operator,
            "unit": unit,
            "slots": project_plan_slots(raw.get("planSlots")),
        }
    selected = raw.get("selectedEvidenceRefHmacs")
    if not isinstance(selected, list):
        raise ValueError("selected evidence HMACs must be a list")
    binding_revision = raw.get("consensusBindingRevisionHmac")
    if binding_revision is not None:
        binding_revision = require_hex(
            binding_revision, "consensusBindingRevisionHmac", 32
        )
    return {
        "queryHmac": require_hex(raw.get("queryHmac"), "queryHmac", 32),
        "queryCutoffHmac": require_hex(
            raw.get("queryCutoffHmac"), "queryCutoffHmac", 32
        ),
        "sourceLockRevisionHmac": require_hex(
            raw.get("sourceLockRevisionHmac"), "sourceLockRevisionHmac", 32
        ),
        "rankedCandidateSetRevisionHmac": require_hex(
            raw.get("rankedCandidateSetRevisionHmac"),
            "rankedCandidateSetRevisionHmac",
            32,
        ),
        "plannerStatus": planner_status,
        "plan": plan,
        "binderStatus": raw.get("binderStatus"),
        "allReplicasValid": raw.get("allReplicasValid"),
        "validReplicaCount": raw.get("validReplicaCount"),
        "committeeUnionWithinBudget": raw.get("committeeUnionWithinBudget"),
        "bindingRevisionHmac": binding_revision,
        "selectedSlots": project_selected_slots(
            raw.get("selectedSlotEvidenceRefHmacs")
        ),
        "selectedEvidenceRefHmacs": sorted(
            require_hex(ref, "selectedEvidenceRefHmac", 32) for ref in selected
        ),
        "selectedCandidateCount": raw.get("selectedCandidateCount"),
    }


def sanitize_replay(
    shadow_paths: Sequence[Path],
    dataset: Path,
    baseline_ledgers: Sequence[Path],
    source_logs: Sequence[Path],
    expected_target_count: int,
) -> dict[str, Any]:
    if not shadow_paths or not baseline_ledgers or not source_logs:
        raise ValueError("shadow, baseline, and source inputs are required")
    dataset_sha = sha256_file(dataset)
    baseline_shas = {sha256_file(path) for path in baseline_ledgers}
    source_shas = {sha256_file(path) for path in source_logs}
    observed_baselines: set[str] = set()
    rows: dict[str, dict[str, Any]] = {}
    settled_shard_shas: list[str] = []
    candidate_policy = None
    model_policy = None
    packet_policy = None
    producer_sha = None
    helper_sha = None
    planner_template_sha = None
    binder_template_sha = None
    hmac_key_id = None
    run_instance_id = None
    remote_calls = 0
    settled_request_hmacs: list[str] = []
    for path in shadow_paths:
        artifact = load_object(path)
        if artifact.get("schemaVersion") != SHADOW_SCHEMA_VERSION:
            raise ValueError(f"shadow artifact schema is not v8: {path}")
        if artifact.get("contentFree") is not True:
            raise ValueError(f"shadow artifact is not content-free: {path}")
        if artifact.get("diagnosticOnly") is not True:
            raise ValueError(f"shadow artifact is not diagnostic-only: {path}")
        if artifact.get("answerPathChanged") is not False:
            raise ValueError(f"shadow artifact changed the answer path: {path}")
        if artifact.get("targetScope") != "ledger":
            raise ValueError(f"shadow artifact did not use ledger scope: {path}")
        artifact_policy = artifact.get("artifactPolicy")
        execution_policy = artifact.get("executionPolicy")
        execution_evidence = artifact.get("executionEvidence")
        if not all(
            isinstance(value, dict)
            for value in (artifact_policy, execution_policy, execution_evidence)
        ):
            raise ValueError(f"identity or execution policy is missing: {path}")
        if set(artifact_policy) != {
            "datasetSha256",
            "baselineLedgerSha256s",
            "sourceLockLogSha256s",
            "producerCodeSha256",
            "helperCodeSha256",
            "plannerTemplateSha256",
            "binderTemplateSha256",
            "hmacKeyId",
        }:
            raise ValueError(f"artifact policy contains unknown or missing fields: {path}")
        if set(execution_policy) != {
            "runInstanceId",
            "clientCacheReuse",
            "perReplicaRequestNonceInjected",
        }:
            raise ValueError(f"execution policy contains unknown or missing fields: {path}")
        if set(execution_evidence) != {
            "runInstanceId",
            "clientCacheReuse",
            "perReplicaRequestNonceInjected",
            "remoteBinderLogicalCallCount",
        }:
            raise ValueError(f"execution evidence contains unknown or missing fields: {path}")
        if artifact_policy.get("datasetSha256") != dataset_sha:
            raise ValueError(f"dataset revision differs: {path}")
        shard_baselines = set(artifact_policy.get("baselineLedgerSha256s", []))
        if not shard_baselines or not shard_baselines.issubset(baseline_shas):
            raise ValueError(f"baseline revisions differ: {path}")
        observed_baselines.update(shard_baselines)
        if set(artifact_policy.get("sourceLockLogSha256s", [])) != source_shas:
            raise ValueError(f"source-lock revisions differ: {path}")
        shard_producer = require_hex(
            artifact_policy.get("producerCodeSha256"), "producerCodeSha256", 64
        )
        shard_helper = require_hex(
            artifact_policy.get("helperCodeSha256"), "helperCodeSha256", 64
        )
        shard_planner_template = require_hex(
            artifact_policy.get("plannerTemplateSha256"),
            "plannerTemplateSha256",
            64,
        )
        shard_binder_template = require_hex(
            artifact_policy.get("binderTemplateSha256"),
            "binderTemplateSha256",
            64,
        )
        shard_key_id = require_hex(
            artifact_policy.get("hmacKeyId"), "hmacKeyId", 32
        )
        shard_run_id = execution_policy.get("runInstanceId")
        if not isinstance(shard_run_id, str) or RUN_INSTANCE.fullmatch(shard_run_id) is None:
            raise ValueError(f"run instance ID is invalid: {path}")
        if execution_policy.get("clientCacheReuse") is not False:
            raise ValueError(f"client cache reuse was not disabled: {path}")
        if execution_policy.get("perReplicaRequestNonceInjected") is not True:
            raise ValueError(f"request nonce was not injected: {path}")
        if execution_evidence.get("runInstanceId") != shard_run_id:
            raise ValueError(f"execution evidence run ID differs: {path}")
        if execution_evidence.get("clientCacheReuse") is not False:
            raise ValueError(f"execution evidence reports cache reuse: {path}")
        if execution_evidence.get("perReplicaRequestNonceInjected") is not True:
            raise ValueError(f"execution evidence lacks request nonces: {path}")
        shard_candidate_policy = project_candidate_policy(
            artifact.get("candidatePolicy")
        )
        shard_model_policy = project_model_policy(artifact.get("modelPolicy"))
        shard_packet_policy = project_packet_policy(
            artifact.get("packetConstructionPolicy")
        )
        if not isinstance(shard_model_policy, dict):
            raise ValueError(f"model policy is missing: {path}")
        candidate_policy = candidate_policy or shard_candidate_policy
        model_policy = model_policy or shard_model_policy
        packet_policy = packet_policy or shard_packet_policy
        producer_sha = producer_sha or shard_producer
        helper_sha = helper_sha or shard_helper
        planner_template_sha = planner_template_sha or shard_planner_template
        binder_template_sha = binder_template_sha or shard_binder_template
        hmac_key_id = hmac_key_id or shard_key_id
        run_instance_id = run_instance_id or shard_run_id
        if canonical(candidate_policy) != canonical(shard_candidate_policy):
            raise ValueError("candidate policy differs across shards")
        if canonical(model_policy) != canonical(shard_model_policy):
            raise ValueError("model policy differs across shards")
        if canonical(packet_policy) != canonical(shard_packet_policy):
            raise ValueError("packet policy differs across shards")
        if (
            producer_sha != shard_producer
            or helper_sha != shard_helper
            or planner_template_sha != shard_planner_template
            or binder_template_sha != shard_binder_template
            or hmac_key_id != shard_key_id
        ):
            raise ValueError("code, template, or HMAC identity differs across shards")
        if run_instance_id != shard_run_id:
            raise ValueError("run instance ID differs across shards")
        raw_rows = artifact.get("rows")
        raw_targets = artifact.get("targetQueryHmacs")
        if not isinstance(raw_rows, list) or not isinstance(raw_targets, list):
            raise ValueError(f"rows or target set is missing: {path}")
        projected_rows = [project_row(row) for row in raw_rows]
        response_settlements = []
        for raw_row, projected_row in zip(raw_rows, projected_rows, strict=True):
            planner_response = raw_row.get("plannerResponseHmac")
            if planner_response != "unsupported":
                require_hex(planner_response, "plannerResponseHmac", 32)
            binder_responses = raw_row.get("binderResponseHmacs")
            binder_requests = raw_row.get("binderRequestHmacs")
            if not isinstance(binder_responses, list):
                raise ValueError(f"binder response settlement is missing: {path}")
            if not isinstance(binder_requests, list):
                raise ValueError(f"binder request settlement is missing: {path}")
            for response in binder_responses:
                require_hex(response, "binderResponseHmac", 32)
            for request in binder_requests:
                require_hex(request, "binderRequestHmac", 32)
            if len(binder_requests) != len(set(binder_requests)):
                raise ValueError(f"binder request settlement is duplicated: {path}")
            settled_request_hmacs.extend(binder_requests)
            response_settlements.append(
                {
                    "queryHmac": projected_row["queryHmac"],
                    "plannerResponseHmac": planner_response,
                    "binderRequestHmacs": binder_requests,
                    "binderResponseHmacs": binder_responses,
                }
            )
        shard_rows = {row["queryHmac"]: row for row in projected_rows}
        if len(shard_rows) != len(projected_rows):
            raise ValueError(f"duplicate query HMAC within shard: {path}")
        targets = {require_hex(value, "targetQueryHmac", 32) for value in raw_targets}
        if targets != set(shard_rows):
            raise ValueError(f"target set differs from rows: {path}")
        if rows.keys() & shard_rows.keys():
            raise ValueError("query HMAC appears in more than one shard")
        rows.update(shard_rows)
        shard_calls = execution_evidence.get("remoteBinderLogicalCallCount")
        replicas = shard_model_policy.get("binder", {}).get("replicas")
        expected_calls = sum(
            row["plannerStatus"] in {"compiled", "planned"}
            for row in projected_rows
        ) * replicas
        if not isinstance(shard_calls, int) or shard_calls != expected_calls:
            raise ValueError(f"remote binder call settlement differs: {path}")
        if sum(len(item["binderRequestHmacs"]) for item in response_settlements) != shard_calls:
            raise ValueError(f"binder request count differs from settlement: {path}")
        remote_calls += shard_calls
        settled_shard_shas.append(
            sha256_canonical(
                {
                    "runInstanceId": shard_run_id,
                    "targetQueryHmacs": sorted(targets),
                    "rows": projected_rows,
                    "responseSettlements": response_settlements,
                }
            )
        )
    if observed_baselines != baseline_shas:
        raise ValueError("replay did not cover the complete baseline ledger")
    target_hmacs = sorted(rows)
    baseline_query_hmacs: set[str] = set()
    for path in baseline_ledgers:
        payload = load_object(path)
        baseline_rows = payload.get("rows")
        if not isinstance(baseline_rows, list):
            raise ValueError(f"baseline ledger has no rows: {path}")
        for baseline_row in baseline_rows:
            if not isinstance(baseline_row, dict):
                raise ValueError(f"baseline ledger row is invalid: {path}")
            query_hmac = require_hex(
                baseline_row.get("queryHmac"), "baseline queryHmac", 32
            )
            if query_hmac in baseline_query_hmacs:
                raise ValueError("baseline ledger query HMAC is duplicated")
            baseline_query_hmacs.add(query_hmac)
    if set(target_hmacs) != baseline_query_hmacs:
        raise ValueError("replay target set differs from the baseline ledger")
    if len(target_hmacs) != expected_target_count:
        raise ValueError("replay target count differs from the preregistered count")
    input_binding = {
        "datasetSha256": dataset_sha,
        "baselineLedgerSha256s": sorted(baseline_shas),
        "sourceLockLogSha256s": sorted(source_shas),
        "targetQueryCount": len(target_hmacs),
        "expectedTargetQueryCount": expected_target_count,
        "targetQuerySetRevision": sha256_canonical(target_hmacs),
        "hmacKeyId": hmac_key_id,
        "candidatePolicy": candidate_policy,
        "modelPolicy": model_policy,
        "packetPolicy": packet_policy,
        "producerCodeSha256": producer_sha,
        "helperCodeSha256": helper_sha,
        "plannerTemplateSha256": planner_template_sha,
        "binderTemplateSha256": binder_template_sha,
    }
    input_binding["runInputRevision"] = sha256_canonical(input_binding)
    execution_body = {
        "runInstanceId": run_instance_id,
        "clientCacheReuse": False,
        "perReplicaRequestNonceInjected": True,
        "remoteBinderLogicalCallCount": remote_calls,
        "settledRequestHmacs": sorted(settled_request_hmacs),
        "settledShardProjectionSha256s": sorted(settled_shard_shas),
    }
    if len(execution_body["settledRequestHmacs"]) != remote_calls:
        raise ValueError("binder request HMACs are not globally unique")
    execution_body["executionRevision"] = sha256_canonical(execution_body)
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "contentFree": True,
        "diagnosticOnly": True,
        "runInstanceId": run_instance_id,
        "executionEvidence": execution_body,
        "inputBinding": input_binding,
        "rows": [rows[query_hmac] for query_hmac in target_hmacs],
    }
    assert_label_blind(output)
    return output


def existing_paths(values: Iterable[str]) -> list[Path]:
    paths = [Path(value) for value in values]
    for path in paths:
        if not path.is_file():
            raise ValueError(f"input file does not exist: {path}")
    return paths


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shadow", nargs="+", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--baseline-ledger", nargs="+", required=True)
    parser.add_argument("--source-log", nargs="+", required=True)
    parser.add_argument("--expected-target-count", type=int, default=133)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_path = Path(args.output)
    manifest = sanitize_replay(
        existing_paths(args.shadow),
        existing_paths([args.dataset])[0],
        existing_paths(args.baseline_ledger),
        existing_paths(args.source_log),
        args.expected_target_count,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
