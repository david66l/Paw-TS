"""Content-free source attribution for persona-disjoint Paw comparisons."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "upstream" / "src"))

from persona_holdout_plan import queries_for_partition  # noqa: E402


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def completed_segments(path: Path, expected: int) -> list[set[str]]:
    segments: list[set[str]] = []
    current: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") == "retrieve":
            detail = event.get("detail") or {}
            values = detail.get("returnedSourceDocumentHashes") or []
            current.update(value for value in values if isinstance(value, str))
        elif event.get("event") == "llm_settlement":
            detail = event.get("detail") or {}
            if detail.get("status") == "success":
                segments.append(current)
            current = set()
    if len(segments) < expected:
        raise RuntimeError(f"{path} has fewer completed answer segments than expected")
    return segments[-expected:]


def parse_variant_log(value: str) -> tuple[str, Path]:
    pieces = value.split("=", 1)
    if len(pieces) != 2 or not pieces[0] or not pieces[1]:
        raise argparse.ArgumentTypeError("variant log must use NAME=PATH")
    return pieces[0], Path(pieces[1])


def summarize(rows: list[dict]) -> dict:
    return {
        "queryCount": len(rows),
        "goldDocumentHitRate": (
            sum(row["goldDocumentHit"] for row in rows) / len(rows) if rows else None
        ),
        "macroGoldDocumentRecall": (
            sum(row["goldDocumentRecall"] for row in rows) / len(rows)
            if rows
            else None
        ),
        "correctGivenGoldHit": (
            sum(row["correct"] for row in rows if row["goldDocumentHit"])
            / sum(row["goldDocumentHit"] for row in rows)
            if any(row["goldDocumentHit"] for row in rows)
            else None
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--partition", required=True)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument(
        "--variant-log", action="append", type=parse_variant_log, default=[]
    )
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    from memory_bench.dataset import get_dataset

    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    report = json.loads(args.report.read_text(encoding="utf-8"))
    dataset = get_dataset(report["dataset"])
    all_queries = dataset.load_queries(report["split"])
    queries = queries_for_partition(plan, all_queries, args.partition)
    if report.get("queryFingerprints") != [sha(query.id)[:20] for query in queries]:
        raise RuntimeError("report does not match the frozen persona plan")
    result_by_variant = {
        variant["variant"]: variant for variant in report.get("variants", [])
    }
    output_variants: dict[str, dict] = {}
    for name, path in args.variant_log:
        result = result_by_variant.get(name)
        if result is None:
            raise RuntimeError(f"report has no variant named {name}")
        segments = completed_segments(path, len(queries))
        rows = []
        for index, query in enumerate(queries):
            gold = {sha(document_id) for document_id in query.gold_ids}
            returned = segments[index]
            matched = gold & returned
            rows.append(
                {
                    "queryFingerprint": sha(query.id)[:20],
                    "correct": bool(result["rows"][index]["correct"]),
                    "goldDocumentHit": bool(matched),
                    "goldDocumentCount": len(gold),
                    "goldDocumentsReturned": len(matched),
                    "goldDocumentRecall": len(matched) / len(gold) if gold else 0,
                    "returnedSourceDocumentCount": len(returned),
                    "questionTypes": result["rows"][index]["questionTypes"],
                }
            )
        output_variants[name] = {"summary": summarize(rows), "rows": rows}
    output = {
        "schemaVersion": "paw.amb-persona-attribution.v1",
        "dataset": report["dataset"],
        "split": report["split"],
        "partition": args.partition,
        "variants": output_variants,
        "contentFree": True,
        "note": "Hash-only source attribution; no query, context, answer, or reasoning text.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(json.dumps({name: value["summary"] for name, value in output_variants.items()}))


if __name__ == "__main__":
    main()
