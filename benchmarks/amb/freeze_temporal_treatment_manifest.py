"""Freeze two sanitized replay manifests into one sealed treatment ledger."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
from pathlib import Path
from typing import Any

from sanitize_temporal_replay_manifest import (
    SCHEMA_VERSION as REPLAY_SCHEMA_VERSION,
    assert_label_blind,
    canonical,
    load_object,
    require_hex,
    sha256_file,
)


SCHEMA_VERSION = "paw.temporal-cross-replay-treatment-ledger.v1"
SELECTION_POLICY = "exact-cross-replay-slot-consensus.v1"
LEDGER_KEYS = {
    "schemaVersion",
    "contentFree",
    "answerPathChanged",
    "selectionPolicy",
    "inputBinding",
    "rows",
    "treatmentCount",
    "fallbackCount",
    "ledgerRevision",
}
REPLAY_KEYS = {
    "schemaVersion",
    "contentFree",
    "diagnosticOnly",
    "runInstanceId",
    "executionEvidence",
    "inputBinding",
    "rows",
}
ROW_KEYS = {
    "queryHmac",
    "queryCutoffHmac",
    "sourceLockRevisionHmac",
    "rankedCandidateSetRevisionHmac",
    "plannerStatus",
    "plan",
    "binderStatus",
    "allReplicasValid",
    "validReplicaCount",
    "committeeUnionWithinBudget",
    "bindingRevisionHmac",
    "selectedSlots",
    "selectedEvidenceRefHmacs",
    "selectedCandidateCount",
}
EXECUTION_KEYS = {
    "runInstanceId",
    "clientCacheReuse",
    "perReplicaRequestNonceInjected",
    "remoteBinderLogicalCallCount",
    "settledRequestHmacs",
    "settledShardProjectionSha256s",
    "executionRevision",
}
INPUT_BINDING_KEYS = {
    "datasetSha256",
    "baselineLedgerSha256s",
    "sourceLockLogSha256s",
    "targetQueryCount",
    "expectedTargetQueryCount",
    "targetQuerySetRevision",
    "hmacKeyId",
    "candidatePolicy",
    "modelPolicy",
    "packetPolicy",
    "producerCodeSha256",
    "helperCodeSha256",
    "plannerTemplateSha256",
    "binderTemplateSha256",
    "runInputRevision",
}
RUN_INSTANCE = re.compile(r"^[A-Za-z0-9._-]{8,128}$")


def keyed_revision(value: Any, key: bytes, domain: str) -> str:
    message = f"{domain}:{canonical(value)}".encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def shadow_keyed_revision(value: str, key: bytes, domain: str) -> str:
    return hmac.new(
        key, f"{domain}:{value}".encode("utf-8"), hashlib.sha256
    ).hexdigest()[:32]


def hmac_key_id(key: bytes) -> str:
    return hmac.new(
        key, b"key-id:paw.temporal.v1", hashlib.sha256
    ).hexdigest()[:32]


def require_exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    if set(value) != expected:
        missing = sorted(expected - set(value))
        extra = sorted(set(value) - expected)
        raise ValueError(f"{context} keys differ; missing={missing}, extra={extra}")


def validate_replay(value: dict[str, Any], artifact: Path) -> dict[str, Any]:
    require_exact_keys(value, REPLAY_KEYS, "replay manifest")
    assert_label_blind(value)
    if value.get("schemaVersion") != REPLAY_SCHEMA_VERSION:
        raise ValueError(f"replay manifest schema differs: {artifact}")
    if value.get("contentFree") is not True or value.get("diagnosticOnly") is not True:
        raise ValueError(f"replay manifest safety flags differ: {artifact}")
    run_id = value.get("runInstanceId")
    if not isinstance(run_id, str) or RUN_INSTANCE.fullmatch(run_id) is None:
        raise ValueError(f"replay run instance ID is invalid: {artifact}")
    execution = value.get("executionEvidence")
    binding = value.get("inputBinding")
    rows = value.get("rows")
    if not isinstance(execution, dict) or not isinstance(binding, dict):
        raise ValueError(f"replay policy is missing: {artifact}")
    require_exact_keys(execution, EXECUTION_KEYS, "execution evidence")
    require_exact_keys(binding, INPUT_BINDING_KEYS, "input binding")
    if execution.get("runInstanceId") != run_id:
        raise ValueError(f"execution run ID differs: {artifact}")
    if execution.get("clientCacheReuse") is not False:
        raise ValueError(f"replay reports client cache reuse: {artifact}")
    if execution.get("perReplicaRequestNonceInjected") is not True:
        raise ValueError(f"replay lacks per-replica request nonces: {artifact}")
    if not isinstance(execution.get("remoteBinderLogicalCallCount"), int):
        raise ValueError(f"replay call settlement is missing: {artifact}")
    settled = execution.get("settledShardProjectionSha256s")
    if not isinstance(settled, list) or not settled:
        raise ValueError(f"replay artifact settlement is missing: {artifact}")
    for digest in settled:
        require_hex(digest, "settledArtifactSha256", 64)
    requests = execution.get("settledRequestHmacs")
    if not isinstance(requests, list):
        raise ValueError(f"replay request settlement is missing: {artifact}")
    for request in requests:
        require_hex(request, "settledRequestHmac", 32)
    if len(requests) != len(set(requests)):
        raise ValueError(f"replay request settlement is duplicated: {artifact}")
    execution_without_revision = {
        key: item for key, item in execution.items() if key != "executionRevision"
    }
    expected_execution_revision = hashlib.sha256(
        canonical(execution_without_revision).encode("utf-8")
    ).hexdigest()
    if execution.get("executionRevision") != expected_execution_revision:
        raise ValueError(f"replay execution revision differs: {artifact}")
    if not isinstance(rows, list):
        raise ValueError(f"replay rows are missing: {artifact}")
    indexed: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError(f"replay row is invalid: {artifact}")
        require_exact_keys(row, ROW_KEYS, "replay row")
        query_hmac = require_hex(row.get("queryHmac"), "queryHmac", 32)
        if query_hmac in indexed:
            raise ValueError(f"duplicate query HMAC in replay: {artifact}")
        indexed[query_hmac] = row
    if binding.get("targetQueryCount") != len(indexed):
        raise ValueError(f"replay target count differs from rows: {artifact}")
    if binding.get("expectedTargetQueryCount") != len(indexed):
        raise ValueError(f"replay preregistered target count differs: {artifact}")
    for field in (
        "datasetSha256",
        "targetQuerySetRevision",
        "producerCodeSha256",
        "helperCodeSha256",
        "plannerTemplateSha256",
        "binderTemplateSha256",
        "runInputRevision",
    ):
        require_hex(binding.get(field), field, 64)
    require_hex(binding.get("hmacKeyId"), "hmacKeyId", 32)
    for field in ("baselineLedgerSha256s", "sourceLockLogSha256s"):
        values = binding.get(field)
        if not isinstance(values, list) or not values:
            raise ValueError(f"replay {field} is missing: {artifact}")
        for digest in values:
            require_hex(digest, field, 64)
    target_revision = hashlib.sha256(
        canonical(sorted(indexed)).encode("utf-8")
    ).hexdigest()
    if binding.get("targetQuerySetRevision") != target_revision:
        raise ValueError(f"replay target set revision differs: {artifact}")
    input_without_revision = {
        key: item for key, item in binding.items() if key != "runInputRevision"
    }
    expected_input_revision = hashlib.sha256(
        canonical(input_without_revision).encode("utf-8")
    ).hexdigest()
    if binding.get("runInputRevision") != expected_input_revision:
        raise ValueError(f"replay input revision differs: {artifact}")
    replicas = binding.get("modelPolicy", {}).get("binder", {}).get("replicas")
    if not isinstance(replicas, int) or replicas < 2:
        raise ValueError(f"replay binder replica policy is invalid: {artifact}")
    expected_calls = sum(
        row.get("plannerStatus") == "compiled" for row in indexed.values()
    ) * replicas
    if execution.get("remoteBinderLogicalCallCount") != expected_calls:
        raise ValueError(f"replay call settlement differs from rows: {artifact}")
    if len(requests) != expected_calls:
        raise ValueError(f"replay request count differs from rows: {artifact}")
    return {**value, "indexedRows": indexed, "artifactSha256": sha256_file(artifact)}


def validate_plan_shape(plan: Any) -> tuple[bool, str | None]:
    if not isinstance(plan, dict):
        return False, "plan_missing"
    if set(plan) != {"revisionHmac", "operator", "unit", "slots"}:
        return False, "plan_shape_invalid"
    try:
        require_hex(plan.get("revisionHmac"), "plan revision", 32)
    except ValueError:
        return False, "plan_shape_invalid"
    operator = plan.get("operator")
    unit = plan.get("unit")
    slots = plan.get("slots")
    if not isinstance(operator, str) or not isinstance(slots, list) or not slots:
        return False, "plan_shape_invalid"
    expected_roles = {
        "duration_between": ["start_event", "end_event"],
        "elapsed_since": ["target_event"],
        "locate_event": ["target_event"],
        "order_events": ["event_set"],
        "first_event": ["event_set"],
        "latest_event": ["event_set"],
        "argmax_by_count": ["event_set"],
        "count_before": ["event_set"],
    }
    if operator not in expected_roles:
        return False, "plan_shape_invalid"
    if operator in {"duration_between", "elapsed_since"}:
        if unit not in {"day", "week", "month", "year"}:
            return False, "plan_shape_invalid"
    elif unit is not None:
        return False, "plan_shape_invalid"
    roles = [slot.get("role") for slot in slots if isinstance(slot, dict)]
    if roles != expected_roles[operator]:
        return False, "slot_role_mismatch"
    slot_ids = [slot.get("slotId") for slot in slots if isinstance(slot, dict)]
    if len(slot_ids) != len(slots) or len(slot_ids) != len(set(slot_ids)):
        return False, "plan_shape_invalid"
    return True, None


def normalize_selected_slots(
    selected: Any, plan: dict[str, Any], max_selected: int
) -> tuple[list[dict[str, Any]] | None, list[str] | None, str | None]:
    if not isinstance(selected, list) or len(selected) != len(plan["slots"]):
        return None, None, "selected_slot_shape_invalid"
    normalized: list[dict[str, Any]] = []
    evidence: set[str] = set()
    for selected_slot, plan_slot in zip(selected, plan["slots"], strict=True):
        if not isinstance(selected_slot, dict):
            return None, None, "selected_slot_shape_invalid"
        if selected_slot.get("slotId") != plan_slot.get("slotId"):
            return None, None, "selected_slot_shape_invalid"
        if selected_slot.get("role") != plan_slot.get("role"):
            return None, None, "slot_role_mismatch"
        refs = selected_slot.get("evidenceRefHmacs")
        if not isinstance(refs, list) or not refs:
            return None, None, "selected_slot_empty"
        try:
            checked = sorted(require_hex(ref, "evidenceRefHmac", 32) for ref in refs)
        except ValueError:
            return None, None, "selected_slot_shape_invalid"
        if len(checked) != len(set(checked)):
            return None, None, "selected_slot_shape_invalid"
        slot_limit = 12 if plan_slot.get("role") == "event_set" else 8
        if len(checked) > slot_limit:
            return None, None, "packet_budget_invalid"
        evidence.update(checked)
        normalized.append(
            {
                "slotId": plan_slot["slotId"],
                "role": plan_slot["role"],
                "evidenceRefHmacs": checked,
            }
        )
    flattened = sorted(evidence)
    if not flattened or len(flattened) > max_selected:
        return None, None, "packet_budget_invalid"
    return normalized, flattened, None


def treatment_or_fallback(
    query_hmac: str,
    first: dict[str, Any],
    second: dict[str, Any],
    replicas: int,
    max_selected: int,
    key: bytes,
) -> dict[str, Any]:
    if first.get("plannerStatus") != "compiled":
        return {"queryHmac": query_hmac, "decision": "fallback", "reasonCode": "no_plan_replay_a"}
    if second.get("plannerStatus") != "compiled":
        return {"queryHmac": query_hmac, "decision": "fallback", "reasonCode": "no_plan_replay_b"}
    first_plan = first.get("plan")
    second_plan = second.get("plan")
    valid, reason = validate_plan_shape(first_plan)
    if not valid:
        return {"queryHmac": query_hmac, "decision": "fallback", "reasonCode": reason}
    valid, reason = validate_plan_shape(second_plan)
    if not valid:
        return {"queryHmac": query_hmac, "decision": "fallback", "reasonCode": reason}
    if canonical(first_plan) != canonical(second_plan):
        return {"queryHmac": query_hmac, "decision": "fallback", "reasonCode": "plan_mismatch"}
    identity_fields = (
        "queryCutoffHmac",
        "sourceLockRevisionHmac",
        "rankedCandidateSetRevisionHmac",
    )
    if any(first.get(field) != second.get(field) for field in identity_fields):
        return {
            "queryHmac": query_hmac,
            "decision": "fallback",
            "reasonCode": "source_or_candidate_revision_mismatch",
        }
    for suffix, row in (("a", first), ("b", second)):
        if row.get("binderStatus") != "consensus_address_valid":
            return {
                "queryHmac": query_hmac,
                "decision": "fallback",
                "reasonCode": f"no_consensus_replay_{suffix}",
            }
        if (
            row.get("allReplicasValid") is not True
            or row.get("validReplicaCount") != replicas
        ):
            return {
                "queryHmac": query_hmac,
                "decision": "fallback",
                "reasonCode": f"replica_set_invalid_{suffix}",
            }
        if row.get("committeeUnionWithinBudget") is not True:
            return {
                "queryHmac": query_hmac,
                "decision": "fallback",
                "reasonCode": "packet_budget_invalid",
            }
    first_slots, first_flat, reason = normalize_selected_slots(
        first.get("selectedSlots"), first_plan, max_selected
    )
    if reason:
        return {"queryHmac": query_hmac, "decision": "fallback", "reasonCode": reason}
    second_slots, second_flat, reason = normalize_selected_slots(
        second.get("selectedSlots"), second_plan, max_selected
    )
    if reason:
        return {"queryHmac": query_hmac, "decision": "fallback", "reasonCode": reason}
    if canonical(first_slots) != canonical(second_slots):
        return {
            "queryHmac": query_hmac,
            "decision": "fallback",
            "reasonCode": "selected_slot_set_mismatch",
        }
    for row, flattened in ((first, first_flat), (second, second_flat)):
        if row.get("selectedEvidenceRefHmacs") != flattened:
            return {
                "queryHmac": query_hmac,
                "decision": "fallback",
                "reasonCode": "selected_flat_set_invalid",
            }
        if row.get("selectedCandidateCount") != len(flattened):
            return {
                "queryHmac": query_hmac,
                "decision": "fallback",
                "reasonCode": "selected_count_invalid",
            }
    binding_revision = first.get("bindingRevisionHmac")
    if binding_revision != second.get("bindingRevisionHmac"):
        return {
            "queryHmac": query_hmac,
            "decision": "fallback",
            "reasonCode": "binding_revision_mismatch",
        }
    require_hex(binding_revision, "bindingRevisionHmac", 32)
    expected_binding_revision = shadow_keyed_revision(
        json.dumps(first_slots, sort_keys=True, separators=(",", ":")),
        key,
        "consensus-binding",
    )
    if binding_revision != expected_binding_revision:
        return {
            "queryHmac": query_hmac,
            "decision": "fallback",
            "reasonCode": "binding_revision_invalid",
        }
    packet = {
        "queryHmac": query_hmac,
        "decision": "treat",
        "queryCutoffHmac": first["queryCutoffHmac"],
        "sourceLockRevisionHmac": first["sourceLockRevisionHmac"],
        "rankedCandidateSetRevisionHmac": first[
            "rankedCandidateSetRevisionHmac"
        ],
        "plan": first_plan,
        "selectedSlots": first_slots,
        "selectedEvidenceRefHmacs": first_flat,
        "selectedCandidateCount": len(first_flat),
        "bindingRevisionHmac": binding_revision,
    }
    packet["packetRevisionHmac"] = keyed_revision(packet, key, "treatment-packet")
    return packet


def freeze_manifest(
    reference: dict[str, Any],
    replay: dict[str, Any],
    key: bytes,
    reference_sha256: str,
    replay_sha256: str,
) -> dict[str, Any]:
    if not key:
        raise ValueError("evaluation HMAC key is empty")
    if reference["runInstanceId"] == replay["runInstanceId"]:
        raise ValueError("cross-replay freeze requires distinct run instance IDs")
    first_settlements = set(
        reference["executionEvidence"]["settledShardProjectionSha256s"]
    )
    second_settlements = set(
        replay["executionEvidence"]["settledShardProjectionSha256s"]
    )
    if first_settlements & second_settlements:
        raise ValueError("cross-replay settlements overlap")
    first_requests = set(reference["executionEvidence"]["settledRequestHmacs"])
    second_requests = set(replay["executionEvidence"]["settledRequestHmacs"])
    if first_requests & second_requests:
        raise ValueError("cross-replay request settlements overlap")
    if canonical(reference["inputBinding"]) != canonical(replay["inputBinding"]):
        raise ValueError("input bindings differ across replays")
    binding = reference["inputBinding"]
    if binding.get("hmacKeyId") != hmac_key_id(key):
        raise ValueError("evaluation HMAC key identity differs")
    first_rows = reference["indexedRows"]
    second_rows = replay["indexedRows"]
    if set(first_rows) != set(second_rows):
        raise ValueError("target query sets differ across replays")
    binder_policy = binding.get("modelPolicy", {}).get("binder", {})
    packet_policy = binding.get("packetPolicy", {})
    replicas = binder_policy.get("replicas")
    max_selected = packet_policy.get("maxSelectedCandidates")
    if not isinstance(replicas, int) or replicas < 2:
        raise ValueError("binder replica policy is invalid")
    if not isinstance(max_selected, int) or max_selected < 1:
        raise ValueError("packet budget policy is invalid")
    rows = [
        treatment_or_fallback(
            query_hmac,
            first_rows[query_hmac],
            second_rows[query_hmac],
            replicas,
            max_selected,
            key,
        )
        for query_hmac in sorted(first_rows)
    ]
    treatment_count = sum(row["decision"] == "treat" for row in rows)
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "contentFree": True,
        "answerPathChanged": False,
        "selectionPolicy": SELECTION_POLICY,
        "inputBinding": {
            **binding,
            "referenceReplayManifestSha256": reference_sha256,
            "replayManifestSha256": replay_sha256,
        },
        "rows": rows,
        "treatmentCount": treatment_count,
        "fallbackCount": len(rows) - treatment_count,
    }
    # answerPathChanged is an explicit invariant, not benchmark answer data.
    safety_projection = {key: value for key, value in output.items() if key != "answerPathChanged"}
    assert_label_blind(safety_projection)
    output["ledgerRevision"] = hashlib.sha256(
        canonical(output).encode("utf-8")
    ).hexdigest()
    require_exact_keys(output, LEDGER_KEYS, "treatment ledger")
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-replay", type=Path, required=True)
    parser.add_argument("--replay", type=Path, required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    reference = validate_replay(load_object(args.reference_replay), args.reference_replay)
    replay = validate_replay(load_object(args.replay), args.replay)
    manifest = freeze_manifest(
        reference,
        replay,
        args.eval_hmac_key.read_bytes().strip(),
        sha256_file(args.reference_replay),
        sha256_file(args.replay),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
