"""Content-free gold-document attribution for a completed Paw AMB run."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM_SRC = HERE / "upstream" / "src"
sys.path.insert(0, str(UPSTREAM_SRC))


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    result = json.loads(args.result.read_text(encoding="utf-8"))
    retrieve_by_identity: dict[tuple[str, str], dict] = {}
    for line in args.log.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") != "retrieve":
            continue
        detail = event.get("detail") or {}
        query_hash = detail.get("queryHash")
        user_fingerprint = detail.get("userFingerprint")
        if isinstance(query_hash, str) and isinstance(user_fingerprint, str):
            retrieve_by_identity[(query_hash, user_fingerprint)] = detail

    from memory_bench.dataset import get_dataset

    dataset = get_dataset(result["dataset"])
    queries = {query.id: query for query in dataset.load_queries(result["split"])}
    rows = []
    for item in result.get("results", []):
        query = queries.get(item.get("query_id"))
        if query is None:
            raise RuntimeError("Result query is absent from the pinned dataset")
        meta = item.get("meta") or {}
        retrieval_query = meta.get("retrieval_query") or item.get("query")
        user_fingerprint = sha(str(query.user_id or "default"))[:20]
        detail = retrieve_by_identity.get(
            (sha(str(retrieval_query)), user_fingerprint)
        )
        if detail is None:
            raise RuntimeError("Content-free retrieval event is missing")
        returned_hashes = set(detail.get("returnedDocumentHashes") or [])
        gold_hashes = {sha(document_id) for document_id in query.gold_ids}
        returned_gold = returned_hashes & gold_hashes
        hit = bool(returned_gold)
        axes = item.get("category_axes") or {}
        rows.append(
            {
                "queryFingerprint": sha(query.id)[:20],
                "correct": bool(item.get("correct")),
                "goldDocumentHit": hit,
                "goldDocumentCount": len(gold_hashes),
                "goldDocumentsReturned": len(returned_gold),
                "goldDocumentRecall": (
                    len(returned_gold) / len(gold_hashes) if gold_hashes else None
                ),
                "returnedDocumentCount": len(returned_hashes),
                "questionTypes": axes.get("Question Type") or [],
            }
        )

    hits = [row for row in rows if row["goldDocumentHit"]]
    misses = [row for row in rows if not row["goldDocumentHit"]]
    report = {
        "schemaVersion": "paw.amb-attribution.v1",
        "dataset": result["dataset"],
        "split": result["split"],
        "runName": result.get("run_name"),
        "totalQueries": len(rows),
        "goldDocumentHits": len(hits),
        "goldDocumentHitRate": len(hits) / len(rows) if rows else None,
        "macroGoldDocumentRecall": (
            sum(row["goldDocumentRecall"] or 0 for row in rows) / len(rows)
            if rows
            else None
        ),
        "correctGivenGoldHit": (
            sum(row["correct"] for row in hits) / len(hits) if hits else None
        ),
        "correctGivenGoldMiss": (
            sum(row["correct"] for row in misses) / len(misses) if misses else None
        ),
        "rows": rows,
        "note": "Hash-only retrieval attribution; no query, memory, or answer text.",
    }
    output = args.output or args.result.with_name("attribution.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
