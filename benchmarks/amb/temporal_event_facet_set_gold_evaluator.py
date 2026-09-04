"""Private post-freeze gold evaluator for temporal EventBundle packets.

This program is intentionally separate from the label-free selector and its
checkpoint.  It accepts only a completed content-free selector artifact, then
computes endpoint coverage as an evaluation result; it never feeds a label
back into selection.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

try:
    from .temporal_event_facet_set_shadow import SCHEMA_VERSION, assert_label_free
    from .temporal_event_ledger_shadow import (
        answer_user_evidence_refs,
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        sha256_text,
    )
except ImportError:
    from temporal_event_facet_set_shadow import SCHEMA_VERSION, assert_label_free  # type: ignore[no-redef]
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        answer_user_evidence_refs,
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        sha256_text,
    )


EVALUATOR_SCHEMA_VERSION = "paw.temporal-event-facet-set-gold-evaluator.v1"


def evaluate(selection: dict[str, Any], dataset: list[Any], key: bytes) -> dict[str, Any]:
    if (
        selection.get("schemaVersion") != SCHEMA_VERSION
        or selection.get("contentFree") is not True
        or not isinstance(selection.get("rows"), list)
    ):
        raise ValueError("selection artifact is invalid")
    assert_label_free(selection["rows"])
    by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset
        if isinstance(item, dict)
    }
    rows: list[dict[str, Any]] = []
    for selection_row in selection["rows"]:
        if not isinstance(selection_row, dict):
            raise ValueError("selection row is invalid")
        query_hmac = selection_row.get("queryHmac")
        if not isinstance(query_hmac, str) or query_hmac not in by_hmac:
            raise ValueError("selection query cannot bind to dataset")
        item = by_hmac[query_hmac]
        gold_refs = answer_user_evidence_refs(item)
        selected_hmacs = {
            value
            for value in selection_row.get("selectedEvidenceRefHmacs", [])
            if isinstance(value, str)
        }
        gold_hmacs = {hmac_ref(reference, key) for reference in gold_refs}
        rows.append(
            {
                "queryHmac": query_hmac,
                "packetStatus": selection_row.get("packetStatus"),
                "goldUserEndpointCount": len(gold_hmacs),
                "selectedGoldEndpointCount": len(gold_hmacs & selected_hmacs),
                "selectedEndpointCoverageComplete": bool(gold_hmacs)
                and gold_hmacs.issubset(selected_hmacs),
            }
        )
    rows.sort(key=lambda row: str(row["queryHmac"]))
    return {
        "schemaVersion": EVALUATOR_SCHEMA_VERSION,
        "selectionArtifactSha256": sha256_text(json.dumps(selection, sort_keys=True, separators=(",", ":"))),
        "evaluationIsPostFreezeOnly": True,
        "rows": rows,
        "metrics": {
            "targetCount": len(rows),
            "selectedEndpointCoverageCompleteCount": sum(row["selectedEndpointCoverageComplete"] for row in rows),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-artifact", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    key = args.eval_hmac_key.read_bytes().strip()
    dataset = load_json(args.dataset)
    selection = load_json(args.selection_artifact)
    if not key or not isinstance(dataset, list) or not isinstance(selection, dict):
        raise ValueError("gold evaluator input is invalid")
    output = evaluate(selection, dataset, key)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
