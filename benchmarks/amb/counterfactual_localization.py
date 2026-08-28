"""Content-safe counterfactual localization for a frozen LongMemEval run.

This is a diagnostic harness, not a benchmark runner. It reconstructs only the
incorrect rows from a sealed baseline ledger and evaluates four paired arms:

* current_packet: frozen production retrieval with the upstream answer prompt;
* source_locked: gold documents with query-only deterministic turn ranking;
* oracle_span: gold documents with answer-aware deterministic turn ranking;
* structured_synthesis: the current packet with Paw's evidence answer policy.

Questions, accepted answers, retrieved text, and model output are never written
to the report, checkpoint, or JSONL event log. Model prompts may be retained by
the existing private replay-cache implementation selected by the caller.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import importlib.util
import json
import math
import re
import sys
import time
import urllib.request
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Sequence

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
UPSTREAM_SRC = HERE / "upstream" / "src"
sys.path.insert(0, str(UPSTREAM_SRC))
sys.path.insert(0, str(HERE))

SCHEMA_VERSION = "paw.longmemeval-counterfactual-localization.v1"
RANKER_VERSION = "paw.counterfactual-turn-ranker.v1:dense-lexical-role-window"
CONDITIONS = (
    "current_packet",
    "source_locked",
    "oracle_span",
    "structured_synthesis",
)
MAX_CONTEXT_CHARS = 8_192
TOKEN_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def eval_hmac(value: str, key: bytes) -> str:
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canonical_hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@dataclass(frozen=True)
class Turn:
    document_index: int
    turn_index: int
    role: str
    content: str


@dataclass(frozen=True)
class RankedTurn:
    turn: Turn
    score: float


def parse_document_turns(document: object, document_index: int) -> list[Turn]:
    raw = json.loads(str(getattr(document, "content")))
    if not isinstance(raw, list):
        raise ValueError("LongMemEval document content must be a JSON turn list")
    turns: list[Turn] = []
    for turn_index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        content = str(item.get("content", "")).strip()
        if role not in {"user", "assistant", "system", "tool"} or not content:
            continue
        turns.append(Turn(document_index, turn_index, role, content))
    return turns


def lexical_score(query: str, content: str) -> float:
    query_tokens = set(TOKEN_RE.findall(query.lower()))
    content_tokens = set(TOKEN_RE.findall(content.lower()))
    if not query_tokens or not content_tokens:
        return 0.0
    overlap = len(query_tokens & content_tokens)
    return overlap / math.sqrt(len(query_tokens) * len(content_tokens))


def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or not left:
        raise ValueError("embedding dimensions are incompatible")
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def expected_role(question_type: str) -> str:
    return "assistant" if question_type == "single-session-assistant" else "user"


def rank_turns(
    *,
    search_text: str,
    question_type: str,
    turns: Sequence[Turn],
    vectors: Sequence[Sequence[float]],
) -> list[RankedTurn]:
    if len(vectors) != len(turns) + 1:
        raise ValueError("expected one query vector followed by one vector per turn")
    role = expected_role(question_type)
    query_vector = vectors[0]
    ranked = []
    for turn, vector in zip(turns, vectors[1:]):
        dense = cosine(query_vector, vector)
        lexical = lexical_score(search_text, turn.content)
        role_bonus = 0.08 if turn.role == role else 0.0
        ranked.append(RankedTurn(turn, 0.72 * dense + 0.28 * lexical + role_bonus))
    ranked.sort(
        key=lambda item: (
            -item.score,
            item.turn.document_index,
            item.turn.turn_index,
        )
    )
    return ranked


def selected_window(
    turns: Sequence[Turn],
    ranked: Sequence[RankedTurn],
    *,
    max_anchors: int,
    max_chars: int = MAX_CONTEXT_CHARS,
) -> tuple[str, dict]:
    by_position = {(turn.document_index, turn.turn_index): turn for turn in turns}
    selected: set[tuple[int, int]] = set()
    anchors = list(ranked[:max_anchors])
    for item in anchors:
        key = (item.turn.document_index, item.turn.turn_index)
        selected.add(key)
        for neighbor in (item.turn.turn_index - 1, item.turn.turn_index + 1):
            if (item.turn.document_index, neighbor) in by_position:
                selected.add((item.turn.document_index, neighbor))
    ordered = [by_position[key] for key in sorted(selected)]
    parts: list[str] = []
    chars = 0
    included: list[Turn] = []
    for turn in ordered:
        block = (
            f"[document={turn.document_index + 1}; turn={turn.turn_index + 1}; "
            f"role={turn.role}]\n{turn.content}"
        )
        if parts and chars + len(block) + 2 > max_chars:
            continue
        if len(block) > max_chars:
            block = block[:max_chars]
        parts.append(block)
        chars += len(block) + (2 if len(parts) > 1 else 0)
        included.append(turn)
    metadata = {
        "anchorCount": len(anchors),
        "selectedTurnCount": len(included),
        "selectedRoleCounts": dict(Counter(turn.role for turn in included)),
        "contextChars": len("\n\n".join(parts)),
    }
    return "\n\n".join(parts), metadata


def embed_texts(base_url: str, model: str, texts: Sequence[str]) -> list[list[float]]:
    endpoint = base_url.rstrip("/")
    if not endpoint.endswith("/embeddings"):
        endpoint = f"{endpoint}/embeddings"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps({"model": model, "input": list(texts)}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read())
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) != len(texts):
        raise RuntimeError("embedding response cardinality mismatch")
    rows.sort(key=lambda row: int(row.get("index", 0)))
    vectors = [row.get("embedding") for row in rows]
    if any(not isinstance(vector, list) or not vector for vector in vectors):
        raise RuntimeError("embedding response is invalid")
    return vectors


def build_ranked_context(
    *,
    query: object,
    documents: Sequence[object],
    answer_aware: bool,
    embed: Callable[[Sequence[str]], list[list[float]]],
) -> tuple[str, dict]:
    turns = [
        turn
        for document_index, document in enumerate(documents)
        for turn in parse_document_turns(document, document_index)
    ]
    if not turns:
        raise ValueError("gold documents contained no usable turns")
    search_text = str(getattr(query, "query"))
    if answer_aware:
        accepted = " ".join(str(value) for value in getattr(query, "gold_answers"))
        search_text = f"{search_text}\nAccepted answer locator: {accepted[:1024]}"
    vectors = embed([search_text, *(turn.content for turn in turns)])
    ranked = rank_turns(
        search_text=search_text,
        question_type=str(getattr(query, "meta")["question_type"]),
        turns=turns,
        vectors=vectors,
    )
    context, metadata = selected_window(
        turns,
        ranked,
        max_anchors=2 if answer_aware else 4,
    )
    return context, {
        **metadata,
        "rankerVersion": RANKER_VERSION,
        "answerAware": answer_aware,
        "goldDocumentCount": len(documents),
    }


def load_incorrect_queries(dataset, ledger: dict, key: bytes) -> list[tuple[dict, object]]:
    rows = ledger.get("rows")
    if not isinstance(rows, list):
        raise ValueError("baseline ledger rows are missing")
    wrong = [row for row in rows if row.get("answerCorrect") is False]
    by_hmac = {eval_hmac(query.id, key): query for query in dataset.load_queries("s")}
    output = []
    for row in wrong:
        query = by_hmac.get(row.get("queryHmac"))
        if query is None:
            raise ValueError("baseline query cannot be reconstructed with the supplied key")
        output.append((row, query))
    if len(output) != 19:
        raise ValueError(f"expected 19 incorrect baseline rows, found {len(output)}")
    return output


def build_prompt(dataset, query: object, context: str, prefix: str = "") -> str:
    prompt = dataset.build_rag_prompt(
        query.query,
        context,
        "open",
        "s",
        query.meta["question_type"],
        query.meta,
    )
    return prefix + prompt


def summarize(rows: Sequence[dict]) -> dict:
    by_condition: dict[str, dict] = {}
    anchor = {
        row["caseIndex"]: row
        for row in rows
        if row["condition"] == "current_packet"
    }
    for condition in CONDITIONS:
        selected = [row for row in rows if row["condition"] == condition]
        correct = sum(row["correct"] is True for row in selected)
        paired = [
            (anchor[row["caseIndex"]], row)
            for row in selected
            if condition != "current_packet" and row["caseIndex"] in anchor
        ]
        wins = sum(not left["correct"] and right["correct"] for left, right in paired)
        losses = sum(left["correct"] and not right["correct"] for left, right in paired)
        by_condition[condition] = {
            "completed": len(selected),
            "correct": correct,
            "accuracy": correct / len(selected) if selected else None,
            "pairedWinsVsCurrent": wins,
            "pairedLossesVsCurrent": losses,
            "netWinsVsCurrent": wins - losses,
            "averageContextTokens": (
                sum(row["contextTokens"] for row in selected) / len(selected)
                if selected
                else None
            ),
        }
    oracle = by_condition["oracle_span"]
    source = by_condition["source_locked"]
    structured = by_condition["structured_synthesis"]
    diagnosis = {
        "turnLocalizationHypothesisSupported": (
            oracle["completed"] == 19 and oracle["netWinsVsCurrent"] >= 4
        ),
        "sourceLockSignal": source["netWinsVsCurrent"],
        "oracleSpanSignal": oracle["netWinsVsCurrent"],
        "synthesisSignal": structured["netWinsVsCurrent"],
        "decisionRule": (
            "support turn localization only when oracle_span completes all 19 "
            "cases and nets at least four wins over current_packet"
        ),
    }
    return {"byCondition": by_condition, "diagnosis": diagnosis}


def content_safe_event(log_path: Path, event: str, detail: dict) -> None:
    forbidden = {
        "query",
        "question",
        "answer",
        "acceptedAnswers",
        "context",
        "content",
        "queryHmac",
    }
    if forbidden.intersection(detail):
        raise ValueError("content-safe log detail contains a forbidden field")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {"timestamp": utc_now(), "event": event, **detail}
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def save_checkpoint(path: Path, body: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(body, indent=2), encoding="utf-8")
    temporary.replace(path)


def configure_baseline_provider(baseline_root: Path, output: Path, ledger: dict):
    runner = load_module(
        "paw_counterfactual_baseline_runner",
        baseline_root / "benchmarks" / "amb" / "run_paw_longmemeval_retrieval.py",
    )
    provider_module = load_module(
        "paw_counterfactual_baseline_provider",
        baseline_root / "benchmarks" / "amb" / "paw_provider.py",
    )
    embedding = runner.local_embedding_artifact()
    retrieval_environment = runner.resolved_release_provider_env(embedding)
    artifact = ledger["manifest"]["artifactBinding"]["retrievalSourceArtifactSha256"]
    runner.configure_provider(
        output,
        resume=False,
        reuse_index=True,
        query_expansion=True,
        strict=True,
        source_artifact_sha256=artifact,
        retrieval_environment=retrieval_environment,
    )
    return provider_module.PawMemoryProvider(), retrieval_environment


def run(args: argparse.Namespace) -> dict:
    from memory_bench.dataset import get_dataset
    from memory_bench.judge import GeminiJudge
    from memory_bench.modes.rag import RAGMode
    from run_paw_context_probe import configure_deepseek

    configure_deepseek()
    ledger_bytes = args.baseline_ledger.read_bytes()
    ledger = json.loads(ledger_bytes)
    key = args.eval_key_file.read_bytes()
    key_id = hashlib.sha256(key).hexdigest()[:20]
    if ledger.get("manifest", {}).get("evalKeyId") != key_id:
        raise ValueError("evaluation key does not match the baseline ledger")
    dataset = get_dataset("longmemeval")
    cases = load_incorrect_queries(dataset, ledger, key)

    baseline_deepseek = load_module(
        "paw_counterfactual_baseline_deepseek",
        args.baseline_root / "benchmarks" / "amb" / "deepseek_llm.py",
    )
    baseline_runner = load_module(
        "paw_counterfactual_baseline_protocol",
        args.baseline_root / "benchmarks" / "amb" / "run_paw_longmemeval_retrieval.py",
    )
    answer_llm = baseline_deepseek.DeepSeekFlashLLM()
    judge_llm = baseline_deepseek.DeepSeekFlashLLM()
    answer_mode = RAGMode(answer_llm)
    judge = GeminiJudge(judge_llm)

    provider, retrieval_environment = configure_baseline_provider(
        args.baseline_root, args.output, ledger
    )
    embed_base = retrieval_environment["PAW_AMB_EMBEDDING_BASE_URL"]
    embed_model = retrieval_environment["PAW_AMB_EMBEDDING_MODEL"]

    def embed(texts: Sequence[str]) -> list[list[float]]:
        return embed_texts(embed_base, embed_model, texts)

    selected_users = {query.user_id for _, query in cases}
    selected_documents = dataset.load_documents("s", user_ids=selected_users)
    documents_by_id = {document.id: document for document in selected_documents}
    store_dir = args.store_dir.resolve()

    config = {
        "schemaVersion": SCHEMA_VERSION,
        "baselineLedgerSha256": hashlib.sha256(ledger_bytes).hexdigest(),
        "baselineCommit": args.baseline_commit,
        "caseCount": len(cases),
        "conditions": list(CONDITIONS),
        "answerTools": False,
        "rankerVersion": RANKER_VERSION,
        "maxContextChars": MAX_CONTEXT_CHARS,
        "answerModel": answer_llm.model_id,
        "judgeModel": judge_llm.model_id,
        "embeddingArtifactSha256": retrieval_environment[
            "PAW_AMB_EMBEDDING_ARTIFACT_SHA256"
        ],
    }
    config_hash = canonical_hash(config)
    checkpoint = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "running",
        "config": config,
        "configHash": config_hash,
        "startedAt": utc_now(),
        "rows": [],
    }
    if args.sealed_checkpoint.exists():
        existing = json.loads(args.sealed_checkpoint.read_text(encoding="utf-8"))
        if existing.get("configHash") != config_hash:
            raise ValueError("existing checkpoint has an incompatible configuration")
        checkpoint = existing
    completed = {
        (row["queryHmac"], row["condition"]) for row in checkpoint.get("rows", [])
    }

    content_safe_event(
        args.log,
        "counterfactual_start",
        {
            "caseCount": len(cases),
            "conditionCount": len(CONDITIONS),
            "resumedRows": len(completed),
            "configHash": config_hash,
        },
    )
    provider.prepare(store_dir, unit_ids=selected_users, reset=False)
    provider.ingest(selected_documents)
    try:
        for case_index, (baseline_row, query) in enumerate(cases, start=1):
            query_key = eval_hmac(query.id, key)
            gold_documents = [
                documents_by_id[document_id]
                for document_id in query.gold_ids
                if document_id in documents_by_id
            ]
            if len(gold_documents) != len(set(query.gold_ids)):
                raise ValueError("one or more gold documents are missing")

            current_documents, _ = provider.retrieve(
                query.query,
                k=8,
                user_id=query.user_id,
                query_timestamp=query.meta.get("query_timestamp"),
            )
            current_context = "\n\n".join(
                f"## Memory {index + 1}\n{document.content}"
                for index, document in enumerate(current_documents)
            )
            if gold_documents:
                source_context, source_meta = build_ranked_context(
                    query=query,
                    documents=gold_documents,
                    answer_aware=False,
                    embed=embed,
                )
                oracle_context, oracle_meta = build_ranked_context(
                    query=query,
                    documents=gold_documents,
                    answer_aware=True,
                    embed=embed,
                )
            else:
                absence_meta = {
                    "anchorCount": 0,
                    "selectedTurnCount": 0,
                    "selectedRoleCounts": {},
                    "contextChars": 0,
                    "rankerVersion": RANKER_VERSION,
                    "goldDocumentCount": 0,
                }
                source_context = ""
                source_meta = {**absence_meta, "answerAware": False}
                oracle_context = ""
                oracle_meta = {**absence_meta, "answerAware": True}
            condition_inputs = {
                "current_packet": (current_context, "", {}),
                "source_locked": (source_context, "", source_meta),
                "oracle_span": (oracle_context, "", oracle_meta),
                "structured_synthesis": (
                    current_context,
                    baseline_runner.EVIDENCE_ANSWER_PROTOCOL,
                    {},
                ),
            }
            rotation = (case_index - 1) % len(CONDITIONS)
            order = CONDITIONS[rotation:] + CONDITIONS[:rotation]
            for condition in order:
                if (query_key, condition) in completed:
                    continue
                context, prefix, context_meta = condition_inputs[condition]
                started = time.perf_counter()

                def prompt_fn(question: str, packet: str, meta=None) -> str:
                    return build_prompt(dataset, query, packet, prefix)

                answer = answer_mode.answer_from_context(
                    query.query,
                    context,
                    task_type="open",
                    meta={**query.meta, "_prompt_fn": prompt_fn},
                )
                judgment = judge.score(
                    query.query,
                    answer.answer,
                    query.gold_answers,
                    dataset.get_judge_prompt_fn(
                        query.meta["question_type"], query.meta
                    ),
                )
                elapsed_ms = round((time.perf_counter() - started) * 1_000, 1)
                row = {
                    "caseIndex": case_index,
                    "queryHmac": query_key,
                    "questionType": query.meta["question_type"],
                    "condition": condition,
                    "correct": judgment.correct,
                    "baselineCorrect": baseline_row["answerCorrect"],
                    "answerHash": sha256_text(answer.answer),
                    "judgeReasonHash": sha256_text(judgment.reason),
                    "contextTokens": len(context) // 4,
                    "elapsedMs": elapsed_ms,
                    **context_meta,
                }
                checkpoint["rows"].append(row)
                checkpoint["updatedAt"] = utc_now()
                save_checkpoint(args.sealed_checkpoint, checkpoint)
                completed.add((query_key, condition))
                content_safe_event(
                    args.log,
                    "counterfactual_arm_complete",
                    {
                        "caseIndex": case_index,
                        "questionType": query.meta["question_type"],
                        "condition": condition,
                        "correct": judgment.correct,
                        "contextTokens": row["contextTokens"],
                        "elapsedMs": elapsed_ms,
                        "completedRows": len(checkpoint["rows"]),
                        "totalRows": len(cases) * len(CONDITIONS),
                    },
                )
    finally:
        provider.cleanup()

    checkpoint["status"] = "completed"
    checkpoint["completedAt"] = utc_now()
    checkpoint["summary"] = summarize(checkpoint["rows"])
    checkpoint["answerLlmStats"] = answer_llm.stats()
    checkpoint["judgeLlmStats"] = judge_llm.stats()
    save_checkpoint(args.sealed_checkpoint, checkpoint)
    sealed_sha = file_sha256(args.sealed_checkpoint)
    public = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "completed",
        "config": config,
        "configHash": config_hash,
        "sealedCheckpoint": {
            "sha256": sealed_sha,
            "rowCount": len(checkpoint["rows"]),
            "containsRawBenchmarkContent": False,
        },
        "summary": checkpoint["summary"],
        "answerLlmStats": checkpoint["answerLlmStats"],
        "judgeLlmStats": checkpoint["judgeLlmStats"],
        "note": (
            "Diagnostic use only. The 19 cases were selected from known baseline "
            "errors and are not an unseen benchmark result. The oracle-span arm "
            "uses accepted answers only to rank hidden gold-document turns; accepted "
            "answers are never included in the answer-model context."
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(public, indent=2), encoding="utf-8")
    content_safe_event(
        args.log,
        "counterfactual_complete",
        {
            "rowCount": len(checkpoint["rows"]),
            "sealedSha256": sealed_sha,
            "turnLocalizationHypothesisSupported": checkpoint["summary"][
                "diagnosis"
            ]["turnLocalizationHypothesisSupported"],
        },
    )
    return public


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-ledger", required=True, type=Path)
    parser.add_argument("--baseline-root", required=True, type=Path)
    parser.add_argument("--baseline-commit", required=True)
    parser.add_argument("--eval-key-file", required=True, type=Path)
    parser.add_argument("--store-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--sealed-checkpoint", required=True, type=Path)
    parser.add_argument("--log", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.baseline_commit):
        raise ValueError("baseline commit must be a full lowercase Git hash")
    report = run(args)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
