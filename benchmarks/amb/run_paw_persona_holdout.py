"""Run a content-free, persona-disjoint Paw memory architecture comparison."""

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

from persona_holdout_plan import queries_for_partition, validate_persona_disjoint_plan  # noqa: E402
from run_paw_context_probe import configure_deepseek, correct_mcq  # noqa: E402


VARIANTS = (
    "raw_chunk",
    "evidence_l0",
    "evidence_index",
    "evidence_first",
    "tool_l0",
    "tool_driven",
)
RUNNER_POLICY = "paw.amb-persona-runner.v3"
VARIANT_POLICIES = {
    "raw_chunk": "paw.amb-raw-chunk.v1",
    "evidence_l0": "paw.amb-evidence-first.v4-l0-only",
    "evidence_index": "paw.amb-evidence-first.v4-append-only-index",
    "evidence_first": "paw.amb-evidence-first.v4-confirmed-dialogue",
    "tool_l0": "paw.amb-tool-l0.v1",
    "tool_driven": "paw.amb-tool-driven.v1",
}


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class EmptyInitialContextProvider:
    """Keep the answer loop identical while forcing evidence through tools."""

    async def async_retrieve(self, *_args, **_kwargs):
        return [], {"control": "tool_only", "contentFree": True}


def load_plan(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("persona holdout plan must be a JSON object")
    return value


def history_document_ids(queries: list[object]) -> set[str]:
    """Return full pre-query history; one query per persona prevents leakage."""
    personas: set[str] = set()
    document_ids: set[str] = set()
    for query in queries:
        user_id = getattr(query, "user_id", None)
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("selected query is missing a persona/user ID")
        if user_id in personas:
            raise ValueError("runner requires exactly one query per persona")
        personas.add(user_id)
        gold_ids = getattr(query, "gold_ids", None)
        if not isinstance(gold_ids, list) or not gold_ids:
            raise ValueError("selected query has no pre-query history documents")
        document_ids.update(gold_ids)
    return document_ids


def execution_manifest(plan: dict, partition: str, queries: list[object]) -> dict:
    rows = plan["partitions"][partition]
    return {
        "schemaVersion": "paw.amb-persona-holdout-execution.v1",
        "dataset": "personamem",
        "split": "32k",
        "partition": partition,
        "queryCount": len(queries),
        "personaCount": len({getattr(query, "user_id") for query in queries}),
        "historyDocumentCount": len(history_document_ids(queries)),
        "queryFingerprints": [row["queryFingerprint"] for row in rows],
        "personaFingerprints": [row["personaFingerprint"] for row in rows],
        "questionTypeCounts": _question_type_counts(rows),
        "historyPolicy": "full-pre-query-history-one-query-per-persona-v1",
        "contentFree": True,
    }


async def run_variant(
    dataset,
    queries: list[object],
    documents: list[object],
    *,
    partition: str,
    output: Path,
    store_key: str,
    variant: str,
    resume: bool,
) -> dict:
    from deepseek_llm import DeepSeekFlashLLM
    from memory_bench.modes.rag import RAGMode
    from paw_provider import PawMemoryProvider

    if variant not in VARIANTS:
        raise ValueError(f"unsupported persona holdout variant: {variant}")
    atom = variant in {
        "evidence_l0",
        "evidence_index",
        "evidence_first",
        "tool_driven",
    }
    uses_tools = variant in {"tool_l0", "tool_driven"}
    tool_profile = "l0_only" if variant == "tool_l0" else "full"
    os.environ["PAW_AMB_INGEST_MODE"] = "atom" if atom else "raw_chunk"
    os.environ["PAW_AMB_ATOM_CONTEXT_MODE"] = (
        "evidence_first" if variant in {"evidence_l0", "evidence_index"}
        else variant if atom else "atom_only"
    )
    os.environ["PAW_AMB_ATOM_WRITE_MODE"] = (
        "off" if variant == "evidence_l0"
        else "index" if variant == "evidence_index"
        else "full"
    )
    os.environ["PAW_AMB_TOOL_PROFILE"] = tool_profile
    if atom and resume:
        os.environ["PAW_AMB_ATOM_RESUME"] = "1"
    else:
        os.environ.pop("PAW_AMB_ATOM_RESUME", None)
    log_path = (
        ROOT
        / "logs"
        / "amb"
        / f"{output.stem}-{partition}-{variant}.jsonl"
    )
    if not (atom and resume):
        log_path.unlink(missing_ok=True)
    os.environ["PAW_AMB_LOG"] = str(log_path)

    provider = PawMemoryProvider()
    llm = DeepSeekFlashLLM(tool_profile=tool_profile)
    mode = RAGMode(llm)
    initial_provider = (
        EmptyInitialContextProvider() if variant == "tool_l0" else provider
    )
    store_dir = output.parent / f"{store_key}-{partition}-{variant}-store"
    unit_ids = {getattr(document, "user_id") or "default" for document in documents}
    rows = []
    started = time.perf_counter()
    try:
        provider.prepare(store_dir, unit_ids=unit_ids, reset=True)
        provider.ingest(documents)
        ingestion_ms = (time.perf_counter() - started) * 1_000
        for query in queries:
            llm.bind_memory_tools(provider if uses_tools else None, query.user_id)
            meta = {
                **query.meta,
                "_prompt_fn": lambda question,
                context,
                meta=None: dataset.build_rag_prompt(
                    question, context, "mcq", "32k", None, meta
                ),
            }
            answer = await mode.async_answer(
                query.query,
                initial_provider,
                task_type="mcq",
                user_id=query.user_id,
                meta=meta,
            )
            axes = dataset.get_result_categories(query.meta)
            rows.append(
                {
                    "queryFingerprint": sha(query.id)[:20],
                    "personaFingerprint": sha(query.user_id)[:20],
                    "correct": correct_mcq(answer.answer, query.gold_answers),
                    "initialContextTokens": len(answer.context) // 4,
                    "retrieveMs": answer.retrieve_time_ms,
                    "questionTypes": axes.get("Question Type") or [],
                }
            )
        provider_stats = provider.stats()
    finally:
        provider.cleanup()
    correct = sum(row["correct"] for row in rows)
    return {
        "variant": variant,
        "variantPolicy": VARIANT_POLICIES[variant],
        "ingestMode": "atom" if atom else "raw_chunk",
        "toolProfile": tool_profile if uses_tools else None,
        "initialContextPolicy": "empty" if variant == "tool_l0" else "provider",
        "correct": correct,
        "accuracy": correct / len(rows),
        "ingestionMs": round(ingestion_ms, 1),
        "averageInitialContextTokens": sum(row["initialContextTokens"] for row in rows)
        / len(rows),
        "providerStats": provider_stats,
        "llmStats": llm.stats(),
        "rows": rows,
    }


async def run(args: argparse.Namespace) -> dict:
    from memory_bench.dataset import get_dataset

    dataset = get_dataset("personamem")
    all_queries = dataset.load_queries("32k")
    plan = load_plan(args.plan)
    validate_persona_disjoint_plan(plan, all_queries)
    queries = queries_for_partition(plan, all_queries, args.partition)
    manifest = execution_manifest(plan, args.partition, queries)
    if args.dry_run:
        return {**manifest, "variants": list(args.variants), "dryRun": True}

    document_ids = history_document_ids(queries)
    documents = dataset.load_documents("32k", ids=document_ids)
    loaded_ids = {document.id for document in documents}
    if loaded_ids != document_ids:
        raise RuntimeError("full pre-query history document set is incomplete")
    results = []
    for variant in args.variants:
        checkpoint_path = _checkpoint_path(args.output, args.partition, variant)
        checkpoint = (
            _load_variant_checkpoint(
                checkpoint_path,
                variant=variant,
                query_fingerprints=manifest["queryFingerprints"],
            )
            if args.resume and checkpoint_path.exists()
            else None
        )
        if checkpoint is not None:
            results.append(checkpoint["result"])
            continue
        result = await run_variant(
            dataset,
            queries,
            documents,
            partition=args.partition,
            output=args.output,
            store_key=args.store_key or args.output.stem,
            variant=variant,
            resume=args.resume,
        )
        _write_variant_checkpoint(
            checkpoint_path,
            variant=variant,
            query_fingerprints=manifest["queryFingerprints"],
            result=result,
        )
        results.append(result)
    return {
        **manifest,
        "schemaVersion": "paw.amb-persona-holdout-result.v1",
        "variants": results,
        "dryRun": False,
        "note": (
            "Persona-disjoint architecture comparison using full pre-query history. "
            "This is not a public AMB leaderboard score."
        ),
    }


def _question_type_counts(rows: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        for question_type in row.get("questionTypes", []):
            counts[question_type] = counts.get(question_type, 0) + 1
    return dict(sorted(counts.items()))


def _variant(value: str) -> str:
    if value not in VARIANTS:
        raise argparse.ArgumentTypeError(
            f"variant must be one of: {', '.join(VARIANTS)}"
        )
    return value


def _checkpoint_path(output: Path, partition: str, variant: str) -> Path:
    return output.with_name(f"{output.stem}-{partition}-{variant}-checkpoint.json")


def _load_variant_checkpoint(
    path: Path, *, variant: str, query_fingerprints: list[str]
) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != "paw.amb-persona-variant-checkpoint.v1"
        or value.get("runnerPolicy") != RUNNER_POLICY
        or value.get("variant") != variant
        or value.get("variantPolicy") != VARIANT_POLICIES[variant]
        or value.get("queryFingerprints") != query_fingerprints
        or not isinstance(value.get("result"), dict)
    ):
        raise ValueError("persona holdout variant checkpoint identity mismatch")
    return value


def _write_variant_checkpoint(
    path: Path,
    *,
    variant: str,
    query_fingerprints: list[str],
    result: dict,
) -> None:
    value = {
        "schemaVersion": "paw.amb-persona-variant-checkpoint.v1",
        "runnerPolicy": RUNNER_POLICY,
        "variant": variant,
        "variantPolicy": VARIANT_POLICIES[variant],
        "queryFingerprints": query_fingerprints,
        "result": result,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--partition", default="dev")
    parser.add_argument(
        "--variant",
        dest="variants",
        action="append",
        type=_variant,
        default=[],
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--store-key",
        help="Reuse a prior variant store/checkpoint while writing a new report.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    args.variants = args.variants or list(VARIANTS)
    if not args.dry_run:
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
