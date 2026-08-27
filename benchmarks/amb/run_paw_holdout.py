"""Content-free raw-vs-routed-scene holdout on an untouched PersonaMem slice."""

from __future__ import annotations

import argparse
import asyncio
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

from run_paw_context_probe import configure_deepseek, correct_mcq  # noqa: E402


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


async def run_variant(dataset, queries, documents, args, variant: str) -> dict:
    from deepseek_llm import DeepSeekFlashLLM
    from memory_bench.modes.rag import RAGMode
    from paw_provider import PawMemoryProvider

    atom = variant in {
        "evidence_first",
        "scene_hybrid",
        "scene_routed",
        "topic_evidence",
        "tool_driven",
    }
    os.environ["PAW_AMB_INGEST_MODE"] = "atom" if atom else "raw_chunk"
    os.environ["PAW_AMB_ATOM_CONTEXT_MODE"] = variant if atom else "atom_only"
    log_path = (
        ROOT
        / "logs"
        / "amb"
        / f"paw-holdout-q{args.offset}-{args.offset + args.count}-{variant}.jsonl"
    )
    log_path.unlink(missing_ok=True)
    os.environ["PAW_AMB_LOG"] = str(log_path)
    provider = PawMemoryProvider()
    llm = DeepSeekFlashLLM()
    mode = RAGMode(llm)
    store_dir = args.output.parent / f"holdout-q{args.offset}-{args.offset + args.count}-{variant}-store"
    unit_ids = {document.user_id or "default" for document in documents}
    rows = []
    started = time.perf_counter()
    try:
        provider.prepare(store_dir, unit_ids=unit_ids, reset=True)
        provider.ingest(documents)
        ingestion_ms = (time.perf_counter() - started) * 1_000
        for query in queries:
            if variant == "tool_driven":
                llm.bind_memory_tools(provider, query.user_id)
            else:
                llm.bind_memory_tools(None, None)
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
        "variant": variant,
        "correct": sum(row["correct"] for row in rows),
        "accuracy": sum(row["correct"] for row in rows) / len(rows),
        "ingestionMs": round(ingestion_ms, 1),
        "averageContextTokens": sum(row["contextTokens"] for row in rows)
        / len(rows),
        "stats": stats,
        "rows": rows,
    }


async def run(args: argparse.Namespace) -> dict:
    from memory_bench.dataset import get_dataset

    dataset = get_dataset("personamem")
    all_queries = dataset.load_queries("32k")
    queries = all_queries[args.offset : args.offset + args.count]
    if len(queries) != args.count:
        raise RuntimeError("Requested holdout slice is incomplete")
    gold_ids = {document_id for query in queries for document_id in query.gold_ids}
    documents = dataset.load_documents("32k", ids=gold_ids)
    raw = await run_variant(dataset, queries, documents, args, "raw_chunk")
    scene = await run_variant(dataset, queries, documents, args, args.scene_variant)
    return {
        "schemaVersion": "paw.amb-holdout.v1",
        "dataset": "personamem",
        "split": "32k",
        "offset": args.offset,
        "count": len(queries),
        "goldDocuments": len(documents),
        "raw": raw,
        "scene": scene,
        "accuracyDelta": scene["accuracy"] - raw["accuracy"],
        "note": "Content-free bounded oracle comparison; not a leaderboard score.",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--offset", type=int, default=20)
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument(
        "--scene-variant",
        choices=(
            "evidence_first",
            "scene_hybrid",
            "scene_routed",
            "topic_evidence",
            "tool_driven",
        ),
        default="scene_routed",
    )
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.offset < 0 or args.count < 1 or args.count > 20:
        raise ValueError("offset/count is outside the bounded holdout range")
    configure_deepseek()
    os.environ.setdefault(
        "DATABASE_URL",
        "postgresql://postgres@127.0.0.1:54329/paw_memory_test",
    )
    report = asyncio.run(run(args))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
