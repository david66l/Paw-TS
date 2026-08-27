"""Content-free AMB probe for queries that failed a previous first-N result."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
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


def correct_mcq(answer: str, gold_answers: list[str]) -> bool:
    def norm(value: str) -> str:
        return value.strip().lower().strip("(). ")[:1]

    return any(norm(answer) == norm(gold) for gold in gold_answers)


async def run_probe(args: argparse.Namespace) -> dict:
    from deepseek_llm import DeepSeekFlashLLM
    from memory_bench.dataset import get_dataset
    from memory_bench.modes.rag import RAGMode
    from paw_provider import PawMemoryProvider

    baseline = json.loads(args.baseline_result.read_text(encoding="utf-8"))
    failed_ids = {
        item["query_id"]
        for item in baseline.get("results", [])
        if not item.get("correct")
    }
    dataset = get_dataset("personamem")
    all_queries = dataset.load_queries("32k")[: args.query_limit]
    queries = [query for query in all_queries if query.id in failed_ids]
    gold_ids = {document_id for query in all_queries for document_id in query.gold_ids}
    documents = dataset.load_documents("32k", ids=gold_ids)
    provider = PawMemoryProvider()
    mode = RAGMode(DeepSeekFlashLLM())
    store_dir = args.output.parent / "scene-probe-store"
    unit_ids = {document.user_id or "default" for document in documents}
    rows = []
    try:
        provider.prepare(store_dir, unit_ids=unit_ids, reset=True)
        provider.ingest(documents)
        for query in queries:
            meta = {
                **query.meta,
                "_prompt_fn": lambda question, context, meta=None: dataset.build_rag_prompt(
                    question, context, "mcq", "32k", None, meta
                ),
            }
            answer = await mode.async_answer(
                query.query,
                provider,
                task_type="mcq",
                user_id=query.user_id,
                meta=meta,
            )
            axes = dataset.get_result_categories(query.meta)
            rows.append(
                {
                    "queryFingerprint": sha(query.id)[:20],
                    "correct": correct_mcq(answer.answer, query.gold_answers),
                    "contextTokens": len(answer.context) // 4,
                    "retrieveMs": answer.retrieve_time_ms,
                    "questionTypes": axes.get("Question Type") or [],
                }
            )
        stats = provider.stats()
    finally:
        provider.cleanup()
    return {
        "schemaVersion": "paw.amb-context-probe.v1",
        "dataset": "personamem",
        "split": "32k",
        "queryLimit": len(all_queries),
        "baselineFailed": len(failed_ids),
        "probed": len(rows),
        "correct": sum(row["correct"] for row in rows),
        "accuracy": sum(row["correct"] for row in rows) / len(rows) if rows else None,
        "stats": stats,
        "rows": rows,
        "note": "Content-free failed-query probe; no query, memory, reasoning, or answer text.",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-result", required=True, type=Path)
    parser.add_argument("--query-limit", type=int, default=20)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.query_limit < 1 or args.query_limit > 100:
        raise ValueError("query-limit must be between 1 and 100")
    configure_deepseek()
    report = asyncio.run(run_probe(args))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
