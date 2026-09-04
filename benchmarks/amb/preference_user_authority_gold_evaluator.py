"""Private post-freeze evaluator for preference user-authority source packets."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

try:
    from .preference_user_authority_shadow import SCHEMA_VERSION, assert_label_free
    from .temporal_event_ledger_shadow import eval_hmac, hmac_ref, load_json, required_string, sha256_text
except ImportError:
    from preference_user_authority_shadow import SCHEMA_VERSION, assert_label_free  # type: ignore[no-redef]
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        sha256_text,
    )


SCHEMA = "paw.preference-user-authority-gold-evaluator.v1"


def canonical_sources(item: dict[str, Any]) -> list[tuple[str, str, list[Any]]]:
    question_id = required_string(item, "question_id")
    sessions = item.get("haystack_sessions")
    session_ids = item.get("haystack_session_ids")
    dates = item.get("haystack_dates")
    if not isinstance(sessions, list) or not isinstance(session_ids, list) or not isinstance(dates, list):
        raise ValueError("history is invalid")
    if not len(sessions) == len(session_ids) == len(dates):
        raise ValueError("history lengths are invalid")
    totals = Counter(session_ids)
    occurrences: Counter[str] = Counter()
    output: list[tuple[str, str, list[Any]]] = []
    for session_id, date, turns in zip(session_ids, dates, sessions):
        if not isinstance(session_id, str) or not isinstance(date, str) or not isinstance(turns, list):
            raise ValueError("history session is invalid")
        occurrences[session_id] += 1
        suffix = f"~occurrence-{occurrences[session_id]}" if totals[session_id] > 1 else ""
        output.append((f"{question_id}_{session_id}{suffix}", session_id, turns))
    return output


def evaluate(selection: dict[str, Any], dataset: list[Any], key: bytes) -> dict[str, Any]:
    if (
        selection.get("schemaVersion") != SCHEMA_VERSION
        or selection.get("contentFree") is not True
        or not isinstance(selection.get("rows"), list)
    ):
        raise ValueError("selection artifact is invalid")
    assert_label_free(selection["rows"])
    dataset_by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset if isinstance(item, dict)
    }
    rows: list[dict[str, Any]] = []
    for packet in selection["rows"]:
        if not isinstance(packet, dict):
            raise ValueError("selection packet is invalid")
        query_hmac = packet.get("queryHmac")
        certificate = packet.get("certificate")
        if not isinstance(query_hmac, str) or not isinstance(certificate, dict):
            raise ValueError("selection packet cannot bind")
        item = dataset_by_hmac.get(query_hmac)
        if item is None:
            raise ValueError("selection query cannot bind to dataset")
        locked_sources = {
            value for value in certificate.get("stableUnionSourceDocumentHashes", []) if isinstance(value, str)
        }
        selected_sources = {
            value for value in certificate.get("projectionSourceDocumentHashes", []) if isinstance(value, str)
        }
        selected_refs = {
            value for value in certificate.get("hydratedUserEvidenceRefHmacs", []) if isinstance(value, str)
        }
        source_rows = canonical_sources(item)
        selected_user_refs: set[str] = set()
        gold_user_refs: set[str] = set()
        assistant_in_projection = 0
        for source_id, raw_session_id, turns in source_rows:
            source_hash = sha256_text(source_id)
            for turn_order, turn in enumerate(turns, start=1):
                if not isinstance(turn, dict):
                    continue
                role = str(turn.get("role", "")).strip().casefold()
                evidence_ref = f"{source_id}#turn-{turn_order}"
                if source_hash in selected_sources and role == "user":
                    selected_user_refs.add(hmac_ref(evidence_ref, key))
                if source_hash in selected_sources and role == "assistant" and hmac_ref(evidence_ref, key) in selected_refs:
                    assistant_in_projection += 1
                if role == "user" and turn.get("has_answer") is True:
                    gold_user_refs.add(hmac_ref(evidence_ref, key))
        answer_session_ids = item.get("answer_session_ids")
        if not isinstance(answer_session_ids, list) or any(not isinstance(value, str) for value in answer_session_ids):
            raise ValueError("gold source labels are invalid")
        gold_sources = {
            sha256_text(source_id)
            for source_id, raw_session_id, _ in source_rows
            if raw_session_id in set(answer_session_ids)
        }
        if selected_refs != selected_user_refs:
            raise ValueError("projection is not the complete user-only closure")
        rows.append(
            {
                "queryHmac": query_hmac,
                "goldSourceCount": len(gold_sources),
                "sourceCoverageComplete": bool(gold_sources) and gold_sources.issubset(locked_sources),
                "projectionSourceCoverageComplete": bool(gold_sources) and gold_sources.issubset(selected_sources),
                "goldUserEndpointCount": len(gold_user_refs),
                "coveredGoldUserEndpointCount": len(gold_user_refs & selected_refs),
                "userEndpointCoverageComplete": bool(gold_user_refs) and gold_user_refs.issubset(selected_refs),
                "assistantTurnCountInProjectedContext": assistant_in_projection,
                "contextUserTurnCount": len(selected_user_refs),
                "contextRawCharCount": certificate.get("rawContextCharCount"),
            }
        )
    rows.sort(key=lambda row: str(row["queryHmac"]))
    return {
        "schemaVersion": SCHEMA,
        "postFreezeOnly": True,
        "rows": rows,
        "metrics": {
            "targetCount": len(rows),
            "sourceCoverageCompleteCount": sum(row["sourceCoverageComplete"] for row in rows),
            "projectionSourceCoverageCompleteCount": sum(
                row["projectionSourceCoverageComplete"] for row in rows
            ),
            "goldUserEndpointCount": sum(row["goldUserEndpointCount"] for row in rows),
            "coveredGoldUserEndpointCount": sum(
                row["coveredGoldUserEndpointCount"] for row in rows
            ),
            "userEndpointCoverageCompleteCount": sum(row["userEndpointCoverageComplete"] for row in rows),
            "multiSupportQuestionCount": sum(row["goldUserEndpointCount"] > 1 for row in rows),
            "multiSupportClosureCompleteCount": sum(
                row["goldUserEndpointCount"] > 1 and row["userEndpointCoverageComplete"]
                for row in rows
            ),
            "zeroAssistantTurnCount": sum(row["assistantTurnCountInProjectedContext"] == 0 for row in rows),
            "totalContextRawChars": sum(int(row["contextRawCharCount"] or 0) for row in rows),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-artifact", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    key = args.eval_hmac_key.read_bytes()
    selection = load_json(args.selection_artifact)
    dataset = load_json(args.dataset)
    if not key or not isinstance(selection, dict) or not isinstance(dataset, list):
        raise ValueError("gold evaluator input is invalid")
    output = evaluate(selection, dataset, key)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
