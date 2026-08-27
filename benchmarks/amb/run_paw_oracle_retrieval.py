"""First-N gold-document retrieval attribution without answer-model calls."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
UPSTREAM_SRC = HERE / "upstream" / "src"
sys.path.insert(0, str(UPSTREAM_SRC))
sys.path.insert(0, str(HERE))


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def configure_deepseek() -> None:
    settings_path = ROOT / ".paw" / "settings.local.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        provider_name = settings.get("provider", "deepseekv4flash")
        config = settings.get("models", {}).get(provider_name, {})
        if config.get("apiKey"):
            os.environ.setdefault("DEEPSEEK_API_KEY", config["apiKey"])
        if config.get("baseUrl"):
            os.environ.setdefault("DEEPSEEK_BASE_URL", config["baseUrl"])
        if config.get("model"):
            os.environ.setdefault("DEEPSEEK_MODEL", config["model"])
    if not os.environ.get("DEEPSEEK_API_KEY"):
        raise RuntimeError("DeepSeek credential is not configured")


def run_variant(
    dataset, queries, documents, mode: str, output_dir: Path, resume_atom: bool
) -> dict:
    from paw_provider import PawMemoryProvider

    os.environ["PAW_AMB_INGEST_MODE"] = mode
    os.environ["PAW_AMB_RETRIEVAL_POLICY"] = "rrf"
    os.environ["PAW_AMB_LOG"] = str(
        ROOT / "logs" / "amb" / f"paw-oracle-retrieval-q{len(queries)}-{mode}.jsonl"
    )
    store_dir = output_dir / f"{mode}-store"
    unit_ids = {document.user_id or "default" for document in documents}
    if mode == "atom" and resume_atom:
        os.environ["PAW_AMB_ATOM_RESUME"] = "1"
    else:
        os.environ.pop("PAW_AMB_ATOM_RESUME", None)
    provider = PawMemoryProvider()
    rows = []
    ingestion_started = time.perf_counter()
    completed = False
    try:
        provider.prepare(store_dir, unit_ids=unit_ids, reset=True)
        provider.ingest(documents)
        ingestion_ms = (time.perf_counter() - ingestion_started) * 1000
        for query in queries:
            retrieval_query = query.meta.get("retrieval_query") or query.query
            returned, _ = provider.retrieve(
                retrieval_query,
                k=10,
                user_id=query.user_id,
            )
            returned_ids = {document.id for document in returned}
            gold_ids = set(query.gold_ids)
            returned_gold = returned_ids & gold_ids
            axes = dataset.get_result_categories(query.meta)
            rows.append(
                {
                    "queryFingerprint": sha(query.id)[:20],
                    "goldDocumentHit": bool(returned_gold),
                    "goldDocumentCount": len(gold_ids),
                    "goldDocumentsReturned": len(returned_gold),
                    "goldDocumentRecall": (
                        len(returned_gold) / len(gold_ids) if gold_ids else None
                    ),
                    "returnedDocumentCount": len(returned_ids),
                    "questionTypes": axes.get("Question Type") or [],
                }
            )
        stats = provider.stats()
        completed = True
    finally:
        provider.cleanup()
        if completed:
            os.environ.pop("PAW_AMB_ATOM_RESUME", None)
            cleanup_provider = PawMemoryProvider()
            try:
                cleanup_provider.prepare(store_dir, unit_ids=unit_ids, reset=True)
            finally:
                cleanup_provider.cleanup()

    recalls = [row["goldDocumentRecall"] for row in rows]
    return {
        "mode": mode,
        "queries": len(rows),
        "goldDocumentHits": sum(row["goldDocumentHit"] for row in rows),
        "goldDocumentHitRate": (
            sum(row["goldDocumentHit"] for row in rows) / len(rows) if rows else None
        ),
        "macroGoldDocumentRecall": (
            sum(recall for recall in recalls if recall is not None) / len(recalls)
            if recalls
            else None
        ),
        "ingestionMs": round(ingestion_ms, 1),
        "atomBudget": stats.get("atomBudget"),
        "atomCheckpoint": stats.get("atomCheckpoint"),
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query-limit", type=int, default=20)
    parser.add_argument("--resume-atom", action="store_true")
    parser.add_argument(
        "--output",
        type=Path,
        default=HERE / "runs" / "personamem" / "paw-oracle-retrieval-q20.json",
    )
    args = parser.parse_args()
    if args.query_limit < 1 or args.query_limit > 100:
        raise ValueError("query-limit must be between 1 and 100")

    configure_deepseek()
    os.environ.setdefault(
        "DATABASE_URL", "postgresql://postgres@127.0.0.1:54329/paw_memory_test"
    )
    os.environ.setdefault("PAW_AMB_LLM_CACHE_DIR", "benchmarks/amb/runs/.llm-cache-t0")
    os.environ.setdefault("PAW_AMB_ATOM_MAX_REMOTE_CALLS", "32")
    os.environ.setdefault("PAW_AMB_ATOM_MAX_PROMPT_TOKENS", "300000")
    os.environ.setdefault("PAW_AMB_ATOM_MAX_COMPLETION_TOKENS", "100000")
    os.environ.setdefault("PAW_AMB_ATOM_CONCURRENCY", "2")

    from memory_bench.dataset import get_dataset

    dataset = get_dataset("personamem")
    queries = dataset.load_queries("32k")[: args.query_limit]
    gold_ids = {document_id for query in queries for document_id in query.gold_ids}
    documents = dataset.load_documents("32k", ids=gold_ids)
    raw = run_variant(
        dataset, queries, documents, "raw_chunk", args.output.parent, False
    )
    atom = run_variant(
        dataset, queries, documents, "atom", args.output.parent, args.resume_atom
    )
    report = {
        "schemaVersion": "paw.amb-oracle-retrieval.v1",
        "dataset": "personamem",
        "split": "32k",
        "queryLimit": len(queries),
        "goldDocuments": len(documents),
        "raw": raw,
        "atom": atom,
        "delta": {
            "goldDocumentHitRate": atom["goldDocumentHitRate"]
            - raw["goldDocumentHitRate"],
            "macroGoldDocumentRecall": atom["macroGoldDocumentRecall"]
            - raw["macroGoldDocumentRecall"],
        },
        "note": (
            "Gold-document retrieval attribution only; no answer model was called "
            "and this is not an AMB accuracy score."
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
