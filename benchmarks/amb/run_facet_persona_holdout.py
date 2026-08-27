"""Evaluate Facet V2 evidence on a frozen, persona-disjoint AMB partition.

The public result stays content-free. Per-persona facet reports are diagnostic
artifacts and intentionally live outside the aggregate score file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
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


RUNNER_POLICY = "paw.amb-facet-persona-runner.v1"
DEFAULT_RUN_KEY = "e62649f4907e5d94ee15"


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def render_facet_context(report: dict) -> tuple[str, dict]:
    diagnostic = report.get("queryDiagnostic")
    selection = diagnostic.get("selection") if isinstance(diagnostic, dict) else None
    support = (
        diagnostic.get("decisionSupport") if isinstance(diagnostic, dict) else None
    )
    evidence = (
        support.get("evidence")
        if isinstance(support, dict) and isinstance(support.get("evidence"), list)
        else selection.get("evidence") if isinstance(selection, dict) else None
    )
    if not isinstance(evidence, list):
        raise ValueError("facet report has no query evidence selection")

    blocks: list[str] = []
    requirements = support.get("requirements", []) if isinstance(support, dict) else []
    assessments = support.get("assessments", []) if isinstance(support, dict) else []
    requirement_labels: dict[str, str] = {}
    if isinstance(requirements, list) and requirements:
        requirement_lines = ["## Evidence requirements"]
        for index, requirement in enumerate(requirements, start=1):
            if not isinstance(requirement, dict):
                continue
            requirement_id = requirement.get("requirementId")
            description = requirement.get("description")
            if isinstance(requirement_id, str) and isinstance(description, str):
                label = f"R{index}"
                requirement_labels[requirement_id] = label
                requirement_lines.append(f"- {label}: {description}")
        blocks.append("\n".join(requirement_lines))
    support_by_memory: dict[str, list[str]] = {}
    contradict_by_memory: dict[str, list[str]] = {}
    if isinstance(assessments, list):
        for assessment in assessments:
            if not isinstance(assessment, dict):
                continue
            label = requirement_labels.get(str(assessment.get("requirementId")))
            if not label:
                continue
            for memory_id in assessment.get("supportingMemoryIds", []):
                support_by_memory.setdefault(str(memory_id), []).append(label)
            for memory_id in assessment.get("contradictingMemoryIds", []):
                contradict_by_memory.setdefault(str(memory_id), []).append(label)
    facet_ids: set[str] = set()
    used_chars = 0
    for index, item in enumerate(evidence, start=1):
        if not isinstance(item, dict) or not isinstance(item.get("state"), dict):
            raise ValueError("facet evidence item is malformed")
        state = item["state"]
        statement = state.get("statement")
        if not isinstance(statement, str) or not statement.strip():
            raise ValueError("facet evidence statement is missing")
        facet_id = item.get("facetId")
        if isinstance(facet_id, str):
            facet_ids.add(facet_id)
        lines = [
            f"## Memory {index}",
            f"Aspect: {item.get('facetKey', 'unknown')}",
            f"Status: {item.get('bucket', 'supporting')}",
            statement.strip(),
        ]
        valid_from = state.get("validFrom")
        valid_to = state.get("validTo")
        if isinstance(valid_from, str) and valid_from:
            lines.append(f"Valid from: {valid_from}")
        if isinstance(valid_to, str) and valid_to:
            lines.append(f"Valid until: {valid_to}")
        memory_id = str(state.get("memoryId", ""))
        if memory_id in support_by_memory:
            lines.append(
                "Verified support: " + ", ".join(support_by_memory[memory_id])
            )
        if memory_id in contradict_by_memory:
            lines.append(
                "Verified contradiction: "
                + ", ".join(contradict_by_memory[memory_id])
            )
        block = "\n".join(lines)
        blocks.append(block)
        used_chars += len(statement.strip())

    context = "\n\n".join(blocks)
    return context, {
        "evidenceCount": len(evidence),
        "facetCount": len(facet_ids),
        "contextChars": len(context),
        "statementChars": used_chars,
        "view": selection.get("view") if isinstance(selection, dict) else None,
        "omittedEvidenceCount": (
            selection.get("omittedEvidenceCount", 0)
            if isinstance(selection, dict)
            else 0
        ),
        "requirementCount": len(requirement_labels),
        "verifiedAssessmentCount": (
            len(assessments) if isinstance(assessments, list) else 0
        ),
    }


def compare_rows(facet_rows: list[dict], baseline_rows: list[dict]) -> dict:
    baseline_by_query = {
        row["queryFingerprint"]: row
        for row in baseline_rows
        if isinstance(row, dict) and isinstance(row.get("queryFingerprint"), str)
    }
    counts = {
        "bothCorrect": 0,
        "bothWrong": 0,
        "facetOnlyCorrect": 0,
        "baselineOnlyCorrect": 0,
    }
    for row in facet_rows:
        query_fingerprint = row.get("queryFingerprint")
        baseline = baseline_by_query.get(query_fingerprint)
        if baseline is None:
            raise ValueError("baseline is missing a selected query fingerprint")
        facet_correct = bool(row.get("correct"))
        baseline_correct = bool(baseline.get("correct"))
        if facet_correct and baseline_correct:
            counts["bothCorrect"] += 1
        elif facet_correct:
            counts["facetOnlyCorrect"] += 1
        elif baseline_correct:
            counts["baselineOnlyCorrect"] += 1
        else:
            counts["bothWrong"] += 1
    return {
        **counts,
        "netCorrectDelta": (
            counts["facetOnlyCorrect"] - counts["baselineOnlyCorrect"]
        ),
    }


def baseline_rows(result: dict, variant: str) -> list[dict]:
    variants = result.get("variants")
    if not isinstance(variants, list):
        raise ValueError("baseline has no variants")
    for item in variants:
        if isinstance(item, dict) and item.get("variant") == variant:
            rows = item.get("rows")
            if isinstance(rows, list):
                return rows
    raise ValueError(f"baseline variant was not found: {variant}")


def run_facet_shadow(
    query,
    *,
    output: Path,
    log_path: Path,
    run_key: str,
    verify_support: bool,
) -> dict:
    bun = shutil.which("bun.cmd") if os.name == "nt" else shutil.which("bun")
    if not bun:
        raise RuntimeError("Bun executable was not found")
    env = os.environ.copy()
    env["PAW_AMB_FACET_RUN_KEY"] = run_key
    env["PAW_AMB_FACET_USER_ID"] = query.user_id
    env["PAW_AMB_FACET_QUERY"] = query.meta.get("retrieval_query") or query.query
    if verify_support:
        env["PAW_AMB_FACET_DECISION_QUERY"] = query.query
    else:
        env.pop("PAW_AMB_FACET_DECISION_QUERY", None)
    env["PAW_AMB_FACET_OUTPUT"] = str(output.resolve())
    env["PAW_AMB_FACET_LOG"] = str(log_path.resolve())
    process = subprocess.run(
        [bun, "run", str(HERE / "run_facet_shadow_backfill.ts")],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if process.returncode != 0:
        detail = (process.stderr or process.stdout).strip()[-2_000:]
        raise RuntimeError(f"facet shadow failed ({process.returncode}): {detail}")
    return load_json(output)


def append_log(path: Path, event: str, **payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event,
        **payload,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def checkpoint_identity(
    *,
    plan: Path,
    partition: str,
    query_fingerprints: list[str],
    run_key: str,
    verify_support: bool,
) -> dict:
    return {
        "runnerPolicy": RUNNER_POLICY,
        "planHash": sha(plan.read_text(encoding="utf-8")),
        "partition": partition,
        "queryFingerprints": query_fingerprints,
        "runKeyHash": sha(run_key)[:20],
        "verifySupport": verify_support,
    }


def aggregate_facet_stats(reports: list[dict]) -> dict:
    keys = (
        "modelCalls",
        "localCacheHits",
        "promptTokens",
        "completionTokens",
        "providerCacheHitTokens",
        "providerCacheMissTokens",
        "repairs",
        "salvages",
        "deferredRetryBatches",
    )
    return {
        key: sum(
            report.get("stats", {}).get(key, 0)
            for report in reports
            if isinstance(report.get("stats"), dict)
        )
        for key in keys
    }


def run(args: argparse.Namespace) -> dict:
    from deepseek_llm import DeepSeekFlashLLM
    from memory_bench.dataset import get_dataset
    from memory_bench.modes.rag import RAGMode

    dataset = get_dataset("personamem")
    all_queries = dataset.load_queries("32k")
    plan = load_json(args.plan)
    validate_persona_disjoint_plan(plan, all_queries)
    queries = queries_for_partition(plan, all_queries, args.partition)
    if args.limit is not None:
        queries = queries[: args.limit]
    query_fingerprints = [sha(query.id)[:20] for query in queries]
    if not queries:
        raise ValueError("selected partition contains no queries")

    baseline = load_json(args.baseline)
    old_rows = baseline_rows(baseline, args.baseline_variant)
    old_by_query = {row["queryFingerprint"]: row for row in old_rows}
    if any(fingerprint not in old_by_query for fingerprint in query_fingerprints):
        raise ValueError("baseline does not cover the selected queries")

    identity = checkpoint_identity(
        plan=args.plan,
        partition=args.partition,
        query_fingerprints=query_fingerprints,
        run_key=args.run_key,
        verify_support=args.verify_support,
    )
    checkpoint_path = args.output.with_name(f"{args.output.stem}-checkpoint.json")
    rows: list[dict] = []
    if args.resume and checkpoint_path.exists():
        checkpoint = load_json(checkpoint_path)
        if checkpoint.get("identity") != identity:
            raise ValueError("facet persona checkpoint identity mismatch")
        raw_rows = checkpoint.get("rows")
        if not isinstance(raw_rows, list):
            raise ValueError("facet persona checkpoint rows are malformed")
        rows = raw_rows

    completed = {row["queryFingerprint"] for row in rows}
    llm = DeepSeekFlashLLM()
    mode = RAGMode(llm)
    reports: list[dict] = []
    started = time.perf_counter()
    diagnostics_dir = args.output.parent / f"{args.output.stem}-diagnostics"
    run_log = ROOT / "logs" / "amb" / f"{args.output.stem}.jsonl"
    append_log(
        run_log,
        "run_started",
        queryCount=len(queries),
        resumedCount=len(rows),
        runKeyHash=sha(args.run_key)[:20],
    )

    for index, query in enumerate(queries, start=1):
        query_fingerprint = sha(query.id)[:20]
        persona_fingerprint = sha(query.user_id)[:20]
        report_path = diagnostics_dir / f"{query_fingerprint}-facet.json"
        facet_log_path = ROOT / "logs" / "amb" / f"{args.output.stem}-{query_fingerprint}-facet.jsonl"
        if query_fingerprint in completed:
            if report_path.exists():
                reports.append(load_json(report_path))
            continue
        append_log(
            run_log,
            "query_started",
            index=index,
            queryFingerprint=query_fingerprint,
            personaFingerprint=persona_fingerprint,
        )
        report = run_facet_shadow(
            query,
            output=report_path,
            log_path=facet_log_path,
            run_key=args.run_key,
            verify_support=args.verify_support,
        )
        reports.append(report)
        context, context_stats = render_facet_context(report)
        meta = {
            **query.meta,
            "_prompt_fn": lambda question, evidence, meta=None: dataset.build_rag_prompt(
                question, evidence, "mcq", "32k", None, meta
            ),
        }
        answer = mode.answer_from_context(
            query.query,
            context,
            task_type="mcq",
            meta=meta,
        )
        correct = correct_mcq(answer.answer, query.gold_answers)
        old_correct = bool(old_by_query[query_fingerprint].get("correct"))
        facet_stats = report.get("stats", {})
        row = {
            "queryFingerprint": query_fingerprint,
            "personaFingerprint": persona_fingerprint,
            "correct": correct,
            "baselineCorrect": old_correct,
            "questionTypes": (
                dataset.get_result_categories(query.meta).get("Question Type") or []
            ),
            **context_stats,
            "facetSourceEntryCount": report.get("sourceEntryCount", 0),
            "facetModelCalls": facet_stats.get("modelCalls", 0),
            "facetLocalCacheHits": facet_stats.get("localCacheHits", 0),
        }
        rows.append(row)
        write_json_atomic(
            checkpoint_path,
            {
                "schemaVersion": "paw.amb-facet-persona-checkpoint.v1",
                "identity": identity,
                "rows": rows,
            },
        )
        append_log(
            run_log,
            "query_completed",
            index=index,
            queryFingerprint=query_fingerprint,
            correct=correct,
            baselineCorrect=old_correct,
            **context_stats,
            facetModelCalls=facet_stats.get("modelCalls", 0),
            facetLocalCacheHits=facet_stats.get("localCacheHits", 0),
        )

    correct = sum(bool(row.get("correct")) for row in rows)
    baseline_correct = sum(
        bool(old_by_query[fingerprint].get("correct"))
        for fingerprint in query_fingerprints
    )
    result = {
        "schemaVersion": "paw.amb-facet-persona-result.v1",
        "dataset": "personamem",
        "split": "32k",
        "partition": args.partition,
        "queryCount": len(rows),
        "personaCount": len({row["personaFingerprint"] for row in rows}),
        "queryFingerprints": query_fingerprints,
        "contentFree": True,
        "supportVerification": args.verify_support,
        "facet": {
            "correct": correct,
            "accuracy": correct / len(rows),
            "averageContextChars": sum(row["contextChars"] for row in rows) / len(rows),
            "averageEvidenceCount": sum(row["evidenceCount"] for row in rows) / len(rows),
            "answerLlmStats": llm.stats(),
            "reconciliationStats": aggregate_facet_stats(reports),
        },
        "baseline": {
            "variant": args.baseline_variant,
            "correct": baseline_correct,
            "accuracy": baseline_correct / len(rows),
        },
        "comparison": compare_rows(rows, old_rows),
        "durationMs": round((time.perf_counter() - started) * 1_000, 1),
        "rows": rows,
        "note": (
            "Frozen persona-disjoint architecture comparison using Facet V2 evidence. "
            "This is not a public AMB leaderboard score."
        ),
    }
    append_log(
        run_log,
        "run_completed",
        queryCount=len(rows),
        correct=correct,
        accuracy=result["facet"]["accuracy"],
        baselineCorrect=baseline_correct,
        comparison=result["comparison"],
        durationMs=result["durationMs"],
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--partition", default="test")
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--baseline-variant", default="tool_driven")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-key", default=DEFAULT_RUN_KEY)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--verify-support", action="store_true")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        raise ValueError("limit must be positive")
    configure_deepseek()
    os.environ.setdefault(
        "DATABASE_URL", "postgresql://postgres@127.0.0.1:54329/paw_memory_test"
    )
    result = run(args)
    write_json_atomic(args.output, result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
