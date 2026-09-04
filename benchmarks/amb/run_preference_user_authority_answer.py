"""Standalone sealed answer harness for frozen preference user-authority packets.

The reader owns all pre-generation hydration and is label-free.  This harness
generates with memory tools unbound, then—and only then—loads judge material.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
UPSTREAM_SRC = HERE / "upstream" / "src"
sys.path.insert(0, str(UPSTREAM_SRC))
sys.path.insert(0, str(HERE))

try:
    from .preference_user_authority_reader import load_reader_packets
    from .temporal_event_ledger_shadow import load_json, required_string
except ImportError:
    from preference_user_authority_reader import load_reader_packets  # type: ignore[no-redef]
    from temporal_event_ledger_shadow import load_json, required_string  # type: ignore[no-redef]


SCHEMA_VERSION = "paw.preference-user-authority-answer-harness.v1"
ANSWER_PROFILES = ("legacy", "evidence_commitment_v2")


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def slice_hmacs(values: list[str], index: int, count: int) -> list[str]:
    if count < 1 or not 0 <= index < count:
        raise ValueError("query slice is invalid")
    return [value for position, value in enumerate(values) if position % count == index]


def judge_values(item: dict[str, Any]) -> tuple[list[str], str, str]:
    """Called after generation; this is the first label-reading boundary."""

    answers = item.get("answer")
    question_type = item.get("question_type")
    if isinstance(answers, str):
        accepted = [answers]
    elif isinstance(answers, list) and all(isinstance(value, str) for value in answers):
        accepted = answers
    else:
        raise ValueError("judge answers are invalid")
    if not isinstance(question_type, str):
        raise ValueError("judge question type is invalid")
    return accepted, question_type, "open"


def load_historical_correctness(path: Path | None) -> dict[str, bool]:
    if path is None:
        return {}
    payload = load_json(path)
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("historical ledger is invalid")
    return {
        row["queryHmac"]: row["answerCorrect"]
        for row in rows
        if isinstance(row, dict)
        and isinstance(row.get("queryHmac"), str)
        and isinstance(row.get("answerCorrect"), bool)
    }


def answer_instruction(profile: str) -> str:
    if profile == "legacy":
        return (
            "The supplied memory is authoritative only for facts about the user, not a catalog "
            "of ready-made answers. Answer the question directly and personalize it with the "
            "most relevant supported user facts. You may use general knowledge to create advice "
            "or recommendations, but never invent additional user facts. Do not refuse merely "
            "because the exact recommendation is absent from memory."
        )
    if profile != "evidence_commitment_v2":
        raise ValueError("answer profile is invalid")
    return (
        "The supplied block contains user-authored memory, not ready-made answers. Before "
        "answering, silently scan every supplied source and form a compact set of all facts "
        "that are directly relevant to the requested domain. Preserve every explicit like, "
        "dislike, comparison, goal, constraint, prior attempt and effect, and named item that "
        "materially constrains the answer. Prefer firsthand experiences and explicit choices "
        "over topics the user merely asked about or considered. Distinguish experienced, liked, "
        "asked-about, considered, and planned: never strengthen one into another.\n\n"
        "Give a short direct answer with only a few well-targeted options. Tie each option to an "
        "exactly supported user fact or constraint, and cover jointly relevant facts rather than "
        "following only the first match. Any clause phrased as 'you', 'your', or 'you have' must "
        "be entailed by a user statement in the memory. General knowledge may supply a new "
        "recommendation, but must not be presented as the user's history. Omit tangential "
        "personal details, obey negative constraints, and do not refuse just because the exact "
        "recommendation is absent from memory."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-artifact", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--slice-index", type=int, default=0)
    parser.add_argument("--slice-count", type=int, default=1)
    parser.add_argument("--historical-v26-ledger", type=Path)
    parser.add_argument("--answer-profile", choices=ANSWER_PROFILES, default="legacy")
    args = parser.parse_args()
    from deepseek_llm import DeepSeekFlashLLM
    from longmemeval_protocol import official_longmemeval_judge_prompt_fn
    from memory_bench.judge import GeminiJudge
    from memory_bench.modes.rag import RAGMode

    key = args.eval_hmac_key.read_bytes()
    if not key:
        raise ValueError("evaluation HMAC key is empty")
    packets = load_reader_packets(args.selection_artifact, args.dataset, args.eval_hmac_key)
    target_hmacs = slice_hmacs(sorted(packets), args.slice_index, args.slice_count)
    historical = load_historical_correctness(args.historical_v26_ledger)
    answer_llm = DeepSeekFlashLLM(tool_profile="l0_only")
    judge_llm = DeepSeekFlashLLM(tool_profile="l0_only")
    answer_mode = RAGMode(answer_llm)
    judge = GeminiJudge(judge_llm)
    rows: list[dict[str, Any]] = []
    for query_hmac in target_hmacs:
        item, packet = packets[query_hmac]
        question = required_string(item, "question")

        def prompt_fn(query: str, context: str, meta=None) -> str:
            return (
                answer_instruction(args.answer_profile)
                + "\n\n"
                + context
                + "\n\nQuestion: "
                + query
            )

        result = answer_mode.answer_from_context(
            question,
            packet.context,
            task_type="open",
            meta={"_prompt_fn": prompt_fn},
        )
        # The judge boundary deliberately follows the completed generation.
        accepted, question_type, _ = judge_values(item)
        judgment = judge.score(
            question,
            result.answer,
            accepted,
            official_longmemeval_judge_prompt_fn(
                question_type=question_type,
                abstention=required_string(item, "question_id").endswith("_abs"),
            ),
        )
        rows.append(
            {
                "queryHmac": query_hmac,
                "packetRevisionHmac": packet.packet_revision_hmac,
                "answerHash": sha(result.answer),
                "answerChars": len(result.answer),
                "rawContextChars": packet.context_chars,
                "contextChars": packet.rendered_context_chars,
                "contextSourceCount": packet.source_count,
                "answerCorrect": judgment.correct,
                "judgeReasonHash": sha(judgment.reason),
                "model": answer_llm.model_id,
                "memoryToolsBound": False,
                "historicalV26Correct": historical.get(query_hmac),
            }
        )
        print(f"completed {len(rows)}/{len(target_hmacs)}", flush=True)
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "sealed": True,
        "answerProfile": args.answer_profile,
        "modelComparable": False,
        "modelComparabilityReason": "historical_v26_ledger_may_use_a_different_model_or_packet",
        "slice": {"index": args.slice_index, "count": args.slice_count},
        "rows": rows,
        "metrics": {
            "queryCount": len(rows),
            "correctCount": sum(row["answerCorrect"] is True for row in rows),
            "accuracy": sum(row["answerCorrect"] is True for row in rows) / len(rows) if rows else None,
            "meanContextChars": sum(row["contextChars"] for row in rows) / len(rows) if rows else 0.0,
        },
        "answerModelStats": answer_llm.stats(),
        "judgeModelStats": judge_llm.stats(),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
