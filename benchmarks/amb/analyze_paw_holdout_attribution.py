"""Content-free source-document attribution for Paw holdout reports."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "upstream" / "src"))


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_segments(path: Path) -> list[set[str]]:
    segments: list[set[str]] = []
    current: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") == "retrieve":
            detail = event.get("detail") or {}
            hashes = detail.get("returnedSourceDocumentHashes")
            if not isinstance(hashes, list):
                hashes = detail.get("returnedDocumentHashes") or []
            current.update(value for value in hashes if isinstance(value, str))
        elif event.get("event") == "llm_settlement":
            segments.append(current)
            current = set()
    return segments


def summarize(rows: list[dict]) -> dict:
    hits = [row for row in rows if row["goldDocumentHit"]]
    return {
        "queries": len(rows),
        "goldDocumentHits": len(hits),
        "goldDocumentHitRate": len(hits) / len(rows) if rows else None,
        "macroGoldDocumentRecall": (
            sum(row["goldDocumentRecall"] for row in rows) / len(rows)
            if rows
            else None
        ),
        "correctGivenGoldHit": (
            sum(row["correct"] for row in hits) / len(hits) if hits else None
        ),
    }


def summarize_pairwise(raw_rows: list[dict], tool_rows: list[dict]) -> dict:
    rows = []
    for raw, tool in zip(raw_rows, tool_rows, strict=True):
        if raw["correct"] and tool["correct"]:
            outcome = "both_correct"
        elif raw["correct"] and not tool["correct"]:
            outcome = "regression"
        elif not raw["correct"] and tool["correct"]:
            outcome = "improvement"
        else:
            outcome = "both_wrong"
        rows.append(
            {
                "queryFingerprint": raw["queryFingerprint"],
                "outcome": outcome,
                "rawGoldDocumentHit": raw["goldDocumentHit"],
                "toolGoldDocumentHit": tool["goldDocumentHit"],
                "rawGoldDocumentRecall": raw["goldDocumentRecall"],
                "toolGoldDocumentRecall": tool["goldDocumentRecall"],
                "questionTypes": raw["questionTypes"],
            }
        )
    regressions = [row for row in rows if row["outcome"] == "regression"]
    improvements = [row for row in rows if row["outcome"] == "improvement"]
    return {
        "summary": {
            "bothCorrect": sum(row["outcome"] == "both_correct" for row in rows),
            "bothWrong": sum(row["outcome"] == "both_wrong" for row in rows),
            "improvements": len(improvements),
            "regressions": len(regressions),
            "regressionsWithToolGoldHit": sum(
                row["toolGoldDocumentHit"] for row in regressions
            ),
            "improvementsWithToolGoldHit": sum(
                row["toolGoldDocumentHit"] for row in improvements
            ),
        },
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--raw-log", required=True, type=Path)
    parser.add_argument("--tool-log", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    report = json.loads(args.report.read_text(encoding="utf-8"))
    from memory_bench.dataset import get_dataset

    queries = get_dataset(report["dataset"]).load_queries(report["split"])[
        report["offset"] : report["offset"] + report["count"]
    ]
    raw_segments = load_segments(args.raw_log)
    tool_segments = load_segments(args.tool_log)
    if len(raw_segments) != len(queries) or len(tool_segments) != len(queries):
        raise RuntimeError("retrieval segment count does not match report")

    paths: dict[str, list[dict]] = {"raw": [], "tool": []}
    for index, query in enumerate(queries):
        gold = {sha(document_id) for document_id in query.gold_ids}
        for name, segments, result_rows in (
            ("raw", raw_segments, report["raw"]["rows"]),
            ("tool", tool_segments, report["scene"]["rows"]),
        ):
            returned = segments[index]
            matched = returned & gold
            paths[name].append(
                {
                    "queryFingerprint": sha(query.id)[:20],
                    "correct": bool(result_rows[index]["correct"]),
                    "goldDocumentHit": bool(matched),
                    "goldDocumentCount": len(gold),
                    "goldDocumentsReturned": len(matched),
                    "goldDocumentRecall": len(matched) / len(gold) if gold else 0,
                    "returnedSourceDocumentCount": len(returned),
                    "questionTypes": result_rows[index]["questionTypes"],
                }
            )

    output = {
        "schemaVersion": "paw.amb-holdout-attribution.v1",
        "dataset": report["dataset"],
        "split": report["split"],
        "offset": report["offset"],
        "count": report["count"],
        "raw": {"summary": summarize(paths["raw"]), "rows": paths["raw"]},
        "tool": {"summary": summarize(paths["tool"]), "rows": paths["tool"]},
        "pairwise": summarize_pairwise(paths["raw"], paths["tool"]),
        "note": "Hash-only source attribution; no query, context, answer, or reasoning text.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "raw": output["raw"]["summary"],
                "tool": output["tool"]["summary"],
                "pairwise": output["pairwise"]["summary"],
            }
        )
    )


if __name__ == "__main__":
    main()
