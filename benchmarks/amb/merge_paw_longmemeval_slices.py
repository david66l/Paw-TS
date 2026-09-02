"""Merge sharded paw longmemeval slice reports into one combined report.

Each slice is a full runner result envelope produced with
``--query-slice-index/--query-slice-count``. The merged report concatenates
the sealed per-query rows in slice order and recomputes every summary from
the rows, so headline metrics are identical to an unsharded run up to
provider nondeterminism.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_runner_module():
    spec = importlib.util.spec_from_file_location(
        "paw_run_longmemeval", HERE / "run_paw_longmemeval_retrieval.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slices", nargs="+", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    rows: list[dict] = []
    slice_meta: list[dict] = []
    for slice_path in args.slices:
        sealed_path = Path(str(slice_path).replace(".json", "-sealed.json"))
        sealed = json.loads(sealed_path.read_text(encoding="utf-8"))
        rows.extend(sealed["rows"])
        slice_meta.append(
            {
                "path": str(slice_path),
                "rows": len(sealed["rows"]),
                "answerProtocol": sealed.get("manifest", {}).get(
                    "answerProtocol"
                ),
            }
        )

    runner = _load_runner_module()
    metrics = runner.summarize(rows)
    answer_metrics = (
        runner.summarize_answers(rows) if any("answerCorrect" in r for r in rows) else None
    )
    error_audit_metrics = runner.summarize_error_audits(rows)
    answer_review_metrics = runner.summarize_answer_reviews(rows)

    report = {
        "schemaVersion": "paw.longmemeval-merged-slices.v1",
        "slices": slice_meta,
        "rowCount": len(rows),
        "metrics": metrics,
        "answerMetrics": answer_metrics,
        "answerReviewMetrics": answer_review_metrics,
        "errorAuditMetrics": error_audit_metrics,
        "note": "Merged from independently executed deterministic query slices.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=1, sort_keys=True), encoding="utf-8"
    )
    overall = answer_metrics["overall"] if answer_metrics else {}
    print(
        json.dumps(
            {
                "rows": len(rows),
                "answerCorrect": overall.get("correct"),
                "accuracy": overall.get("accuracy"),
                "byQuestionType": (answer_metrics or {}).get("byQuestionType"),
            },
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
