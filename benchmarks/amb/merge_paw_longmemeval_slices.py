"""Merge sharded paw longmemeval slice reports into one combined report.

Each slice is a full runner result envelope produced with
``--query-slice-index/--query-slice-count``. The merged report concatenates
the sealed per-query rows in slice order and recomputes every summary from
the rows, so headline metrics are identical to an unsharded run up to
provider nondeterminism.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
OFFICIAL_FULL_SPLIT_COUNTS = {
    "single-session-user": 70,
    "single-session-assistant": 56,
    "multi-session": 133,
    "temporal-reasoning": 133,
    "knowledge-update": 78,
    "single-session-preference": 30,
}
SLICE_SUFFIX = re.compile(r"\+query-slice-(\d+)-of-(\d+)$")


def _load_runner_module():
    spec = importlib.util.spec_from_file_location(
        "paw_run_longmemeval", HERE / "run_paw_longmemeval_retrieval.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sealed_path(public_path: Path) -> Path:
    return Path(str(public_path).replace(".json", "-sealed.json"))


def _stable_configuration(sealed: dict[str, Any]) -> dict[str, Any]:
    manifest = dict(sealed.get("manifest") or {})
    for key in (
        "queryHmacs",
        "userHmacs",
        "questionTypeCounts",
        "questionTypeTargets",
        "historyDocumentCounts",
        "queryCount",
        "documentCount",
        "selectionPolicy",
    ):
        manifest.pop(key, None)
    # This is an observed, shard-local data statistic rather than a runner
    # setting. Keep it in each sealed ledger for auditability, but do not make
    # naturally different shard populations fail the configuration gate.
    if isinstance(manifest.get("longMemEvalProtocol"), dict):
        longmemeval_protocol = dict(manifest["longMemEvalProtocol"])
        longmemeval_protocol.pop("physicalDocumentIdCollisionCount", None)
        manifest["longMemEvalProtocol"] = longmemeval_protocol
    return {
        "schemaVersion": sealed.get("schemaVersion"),
        "runnerPolicy": sealed.get("runnerPolicy"),
        "memoryPolicy": sealed.get("memoryPolicy"),
        "searchPolicy": sealed.get("searchPolicy"),
        "queryExpansionEnabled": sealed.get("queryExpansionEnabled"),
        "k": sealed.get("k"),
        "manifest": manifest,
    }


def load_validated_slices(
    public_paths: list[Path],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    if len(public_paths) < 2:
        raise ValueError("at least two slice reports are required")

    rows: list[dict[str, Any]] = []
    slice_meta: list[dict[str, Any]] = []
    expected_configuration: dict[str, Any] | None = None
    expected_slice_count: int | None = None
    observed_indices: set[int] = set()
    observed_query_hmacs: set[str] = set()

    for public_path in public_paths:
        public = json.loads(public_path.read_text(encoding="utf-8"))
        sealed_path = _sealed_path(public_path)
        sealed_bytes = sealed_path.read_bytes()
        sealed = json.loads(sealed_bytes)
        shard_rows = sealed.get("rows")
        manifest = sealed.get("manifest")
        if not isinstance(shard_rows, list) or not isinstance(manifest, dict):
            raise ValueError(f"invalid sealed slice: {sealed_path}")

        ledger = public.get("sealedLedger") or {}
        if ledger.get("sha256") != hashlib.sha256(sealed_bytes).hexdigest():
            raise ValueError(f"public ledger hash mismatch: {public_path}")
        if ledger.get("rowCount") != len(shard_rows):
            raise ValueError(f"public ledger row count mismatch: {public_path}")

        match = SLICE_SUFFIX.search(str(manifest.get("selectionPolicy", "")))
        if match is None:
            raise ValueError(f"missing deterministic slice identity: {sealed_path}")
        slice_index, slice_count = map(int, match.groups())
        if expected_slice_count is None:
            expected_slice_count = slice_count
        if slice_count != expected_slice_count or slice_index in observed_indices:
            raise ValueError("slice identities are duplicated or inconsistent")
        observed_indices.add(slice_index)

        configuration = _stable_configuration(sealed)
        if expected_configuration is None:
            expected_configuration = configuration
        elif configuration != expected_configuration:
            raise ValueError("slice configurations are inconsistent")

        manifest_hmacs = manifest.get("queryHmacs")
        row_hmacs = [row.get("queryHmac") for row in shard_rows]
        if (
            manifest.get("queryCount") != len(shard_rows)
            or not isinstance(manifest_hmacs, list)
            or len(set(row_hmacs)) != len(row_hmacs)
            or set(row_hmacs) != set(manifest_hmacs)
        ):
            raise ValueError(f"slice rows do not match its manifest: {sealed_path}")
        duplicate_hmacs = observed_query_hmacs.intersection(row_hmacs)
        if duplicate_hmacs:
            raise ValueError("query HMAC appears in more than one slice")
        observed_query_hmacs.update(row_hmacs)

        type_counts = dict(Counter(row.get("questionType") for row in shard_rows))
        if type_counts != manifest.get("questionTypeCounts"):
            raise ValueError(f"slice question type counts are invalid: {sealed_path}")

        rows.extend(shard_rows)
        slice_meta.append(
            {
                "path": str(public_path),
                "sealedSha256": _sha256(sealed_path),
                "sliceIndex": slice_index,
                "sliceCount": slice_count,
                "rows": len(shard_rows),
                "answerProtocol": manifest.get("answerProtocol"),
            }
        )

    assert expected_slice_count is not None
    assert expected_configuration is not None
    if len(public_paths) != expected_slice_count or observed_indices != set(
        range(expected_slice_count)
    ):
        raise ValueError("slice set is incomplete")
    if expected_configuration["manifest"].get("fullSplit") is not True:
        raise ValueError("merged release report must cover the official full split")
    if len(rows) != 500 or dict(Counter(row["questionType"] for row in rows)) != (
        OFFICIAL_FULL_SPLIT_COUNTS
    ):
        raise ValueError("slice union does not match the official 500-query split")
    slice_meta.sort(key=lambda item: item["sliceIndex"])
    return rows, slice_meta, expected_configuration


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slices", nargs="+", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    rows, slice_meta, configuration = load_validated_slices(args.slices)

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
        "configurationSha256": hashlib.sha256(
            json.dumps(configuration, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
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
