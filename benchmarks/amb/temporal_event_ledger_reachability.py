"""Label-blind reachability audit for the isolated temporal event ledger.

The ranker never reads ``has_answer``. Labels are accessed only after rankings
are frozen to measure whether source acquisition or in-lock endpoint ranking is
the limiting stage. The report contains HMACs, counts, and booleans only.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

try:  # Supports both `python file.py` and package-level smoke tests.
    from .temporal_event_ledger_shadow import (
        SCHEMA_VERSION,
        answer_user_evidence_refs,
        canonical_session_sources,
        enumerate_locked_user_turns,
        load_initial_retrieval_sources,
        load_temporal_source_lane_sources,
        rank_bm25,
    )
except ImportError:
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        SCHEMA_VERSION,
        answer_user_evidence_refs,
        canonical_session_sources,
        enumerate_locked_user_turns,
        load_initial_retrieval_sources,
        load_temporal_source_lane_sources,
        rank_bm25,
    )


AUDIT_SCHEMA_VERSION = "paw.temporal-event-ledger-reachability.v1"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def required_string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ValueError(f"LongMemEval {key} is invalid")
    return result


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def eval_hmac(value: str, key: bytes) -> str:
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def sealed_error_hmacs(paths: list[Path]) -> set[str]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        payload = load_json(path)
        values = payload.get("rows") if isinstance(payload, dict) else None
        if not isinstance(values, list):
            raise ValueError(f"sealed ledger has no rows: {path}")
        rows.extend(value for value in values if isinstance(value, dict))
    output = {
        row.get("queryHmac")
        for row in rows
        if row.get("answerCorrect") is False and isinstance(row.get("queryHmac"), str)
    }
    if not output:
        raise ValueError("baseline ledger has no failed rows")
    return output


def all_history_source_hashes(item: dict[str, Any]) -> set[str]:
    return {
        sha256_text(source_id)
        for source_id, _, _ in canonical_session_sources(item)
    }


def scope_audit(
    *,
    item: dict[str, Any],
    returned_document_hashes: set[str],
    top_ks: tuple[int, ...],
) -> dict[str, Any]:
    question = required_string(item, "question")
    gold_refs = answer_user_evidence_refs(item)
    candidates = enumerate_locked_user_turns(item, returned_document_hashes)
    candidate_refs = {candidate.evidence_ref for candidate in candidates}
    ranks = {
        str(top_k): {
            candidate.evidence_ref
            for candidate in rank_bm25(question, candidates, top_k)
        }
        for top_k in top_ks
    }
    return {
        "candidateCount": len(candidates),
        "goldUserEndpointCount": len(gold_refs),
        "sourcePoolCoversAllEndpoints": bool(gold_refs) and gold_refs.issubset(candidate_refs),
        "rankedEndpointCoverage": {
            top_k: bool(gold_refs) and gold_refs.issubset(refs)
            for top_k, refs in ranks.items()
        },
    }


def summarize(rows: list[dict[str, Any]], scope: str, top_ks: tuple[int, ...]) -> dict[str, Any]:
    values = [row["scopes"][scope] for row in rows]
    return {
        "queryCount": len(values),
        "sourcePoolCoversAllEndpointsCount": sum(
            value["sourcePoolCoversAllEndpoints"] for value in values
        ),
        "rankedEndpointCoverageCount": {
            str(top_k): sum(
                value["rankedEndpointCoverage"][str(top_k)] for value in values
            )
            for top_k in top_ks
        },
        "meanCandidateCount": sum(value["candidateCount"] for value in values)
        / len(values),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--baseline-ledger", type=Path, nargs="+", required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--v36-retrieval-log", type=Path, nargs="+", required=True)
    parser.add_argument("--v48-retrieval-log", type=Path, nargs="+", required=True)
    parser.add_argument("--temporal-source-lane-log", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--top-k", type=int, nargs="+", default=[8, 12, 16, 24])
    args = parser.parse_args()
    top_ks = tuple(sorted({value for value in args.top_k if 1 <= value <= 128}))
    if not top_ks:
        raise ValueError("--top-k must contain a value between 1 and 128")
    key = args.eval_hmac_key.read_bytes().strip()
    if not key:
        raise ValueError("evaluation HMAC key is empty")
    dataset = load_json(args.dataset)
    if not isinstance(dataset, list):
        raise ValueError("dataset is invalid")
    errors = sealed_error_hmacs(args.baseline_ledger)
    dataset_by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset
        if isinstance(item, dict)
    }
    if not errors.issubset(dataset_by_hmac):
        raise ValueError("baseline errors cannot be bound to the pinned dataset")
    source_locks = {
        "v36_source_lock": load_initial_retrieval_sources(args.v36_retrieval_log),
        "v48_source_lock": load_initial_retrieval_sources(args.v48_retrieval_log),
    }
    if args.temporal_source_lane_log:
        source_locks["temporal_source_lane_lock"] = load_temporal_source_lane_sources(
            args.temporal_source_lane_log
        )
    rows: list[dict[str, Any]] = []
    for query_hmac in sorted(errors):
        item = dataset_by_hmac[query_hmac]
        question_hash = sha256_text(required_string(item, "question"))
        scopes: dict[str, dict[str, Any]] = {
            name: scope_audit(
                item=item,
                returned_document_hashes=locks.get(question_hash, set()),
                top_ks=top_ks,
            )
            for name, locks in source_locks.items()
        }
        scopes["all_history"] = scope_audit(
            item=item,
            returned_document_hashes=all_history_source_hashes(item),
            top_ks=top_ks,
        )
        rows.append(
            {
                "queryHmac": query_hmac,
                "questionType": item.get("question_type"),
                "scopes": scopes,
            }
        )
    output = {
        "schemaVersion": AUDIT_SCHEMA_VERSION,
        "contentFree": True,
        "diagnosticOnly": True,
        "ranker": "label_blind_exact_turn_bm25_v1",
        "rankerSource": SCHEMA_VERSION,
        "topKs": list(top_ks),
        "rows": rows,
        "metrics": {
            scope: summarize(rows, scope, top_ks)
            for scope in (*source_locks, "all_history")
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
