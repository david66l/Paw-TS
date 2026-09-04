"""Direct one-call answer arm for frozen multi-session evidence-set packets.

This arm evaluates the packet architecture independently from the stricter
member-table/host-arithmetic arm.  It still uses the query-only deterministic
set plan and never exposes labels before generation.
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
    from .multi_session_evidence_set_reader import load_reader_packets
    from .multi_session_set_plan import compile_set_plan
    from .run_multi_session_evidence_set_answer import public_plan, slice_hmacs
    from .temporal_event_ledger_shadow import required_string
except ImportError:
    from multi_session_evidence_set_reader import load_reader_packets  # type: ignore[no-redef]
    from multi_session_set_plan import compile_set_plan  # type: ignore[no-redef]
    from run_multi_session_evidence_set_answer import public_plan, slice_hmacs  # type: ignore[no-redef]
    from temporal_event_ledger_shadow import required_string  # type: ignore[no-redef]


SCHEMA_VERSION = "paw.multi-session-evidence-set-direct-answer.v1"
RUNNER_POLICY = "paw.multi-session-evidence-set-direct.v1:complete-scan-one-call"


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def judge_values(item: dict[str, Any]) -> tuple[list[str], str, bool]:
    accepted = item.get("answer")
    question_type = item.get("question_type")
    question_id = required_string(item, "question_id")
    if isinstance(accepted, (str, int, float)) and not isinstance(accepted, bool):
        answers = [str(accepted)]
    elif isinstance(accepted, list) and all(
        isinstance(value, (str, int, float)) and not isinstance(value, bool)
        for value in accepted
    ):
        answers = [str(value) for value in accepted]
    else:
        raise ValueError("judge answers are invalid")
    if not isinstance(question_type, str):
        raise ValueError("judge question type is invalid")
    return answers, question_type, question_id.endswith("_abs")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-artifact", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--v26b-retrieval-log", type=Path, nargs="+", required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--slice-index", type=int, default=0)
    parser.add_argument("--slice-count", type=int, default=1)
    args = parser.parse_args()

    from deepseek_llm import DeepSeekFlashLLM
    from longmemeval_protocol import official_longmemeval_judge_prompt_fn
    from memory_bench.judge import GeminiJudge
    from memory_bench.modes.rag import RAGMode

    packets = load_reader_packets(
        args.selection_artifact,
        args.dataset,
        args.v26b_retrieval_log,
        args.eval_hmac_key,
    )
    targets = slice_hmacs(sorted(packets), args.slice_index, args.slice_count)
    answer_llm = DeepSeekFlashLLM(tool_profile="l0_only")
    judge_llm = DeepSeekFlashLLM(tool_profile="l0_only")
    answer_llm.bind_memory_tools(None, None)
    judge_llm.bind_memory_tools(None, None)
    answer_mode = RAGMode(answer_llm)
    judge = GeminiJudge(judge_llm)
    rows: list[dict[str, Any]] = []
    for query_hmac in targets:
        item, packet = packets[query_hmac]
        question = required_string(item, "question")
        plan = compile_set_plan(question)
        plan_payload = public_plan(plan) if plan is not None else None

        def prompt_fn(query: str, context: str, meta=None) -> str:
            return f"""You are the final executor for a complete, locked multi-session evidence set.
The query-only host plan is: {json.dumps(plan_payload, sort_keys=True, separators=(',', ':'))}

Derive the exact inclusion rule from the question, then scan EVERY supplied session. Form the complete set of matching user facts before calculating. Preserve entity, action/state, value, unit, and event time. Merge only repeated mentions of the same real event and action; the same entity can have distinct obligations or events, such as returning an old item and picking up its replacement. Apply time/range/latest and active/completed/planned/cancelled filters before arithmetic. For relative windows, anchor at the query cutoff and use the session timestamp when no more specific event date is stated.

Treat the question as the cross-session join contract. If separate sessions provide unique compatible facts for the named entity, operands, or requested relationship, join them; do not reject the calculation merely because no one sentence restates the relationship. Evidence that the user acquired or possesses an item may support an acquisition count unless another statement contradicts it. Normalize compatible units. For a count, enumerate the unique event/action members; for a sum, difference, average, ratio, or maximum, show a short checkable calculation. Make a second pass over all sessions. If a required operand is genuinely absent or conflicting, state that the available memory is insufficient rather than guessing. The final answer must directly match the requested value, date, entity, list, or comparison.

Boundary and abstention rules:
- Absence of a matching memory is not proof that the count is zero. Say the information is insufficient unless the packet positively establishes an exhaustive zero.
- In "items/events before X" questions, X is the boundary/reference event and is not itself a counted member unless the wording explicitly includes it.
- Keep exact qualifiers such as entity, research stage, location, and event type. Never substitute an adjacent but different fact merely because it has similar words.
- Interpret "last week" as the rolling seven-day interval immediately preceding the query cutoff; never include days after the cutoff. Other relative windows also end at the cutoff unless the question states a calendar boundary.
- A uniquely matching scheduled appointment time may supply the time of the named visit or arrival when the question joins those facts and nothing conflicts; likewise join a uniquely matching deadline/date with the named submission. Do not demand a redundant sentence restating the link.

{context}

Question: {query}"""

        result = answer_mode.answer_from_context(
            question,
            packet.context,
            task_type="open",
            meta={"_prompt_fn": prompt_fn},
        )

        # This is the first evaluation-label boundary.
        accepted, question_type, abstention = judge_values(item)
        judgment = judge.score(
            question,
            result.answer,
            accepted,
            official_longmemeval_judge_prompt_fn(
                question_type=question_type,
                abstention=abstention,
            ),
        )
        rows.append(
            {
                "queryHmac": query_hmac,
                "packetRevisionHmac": packet.packet_revision_hmac,
                "plan": plan_payload,
                "answerHash": sha(result.answer),
                "answerChars": len(result.answer),
                "answerCorrect": judgment.correct,
                "judgeReasonHash": sha(judgment.reason),
                "sourceCount": packet.source_count,
                "userTurnCount": packet.user_turn_count,
                "rawContextChars": packet.raw_context_chars,
                "renderedContextChars": packet.rendered_context_chars,
                "model": answer_llm.model_id,
                "memoryToolsBound": False,
            }
        )
        output = {
            "schemaVersion": f"{SCHEMA_VERSION}:checkpoint",
            "sealed": True,
            "runnerPolicy": RUNNER_POLICY,
            "slice": {"index": args.slice_index, "count": args.slice_count},
            "rows": rows,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
        print(
            f"completed {len(rows)}/{len(targets)} correct={int(judgment.correct)}",
            flush=True,
        )

    correct = sum(row["answerCorrect"] is True for row in rows)
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "sealed": True,
        "runnerPolicy": RUNNER_POLICY,
        "slice": {"index": args.slice_index, "count": args.slice_count},
        "rows": rows,
        "metrics": {
            "queryCount": len(rows),
            "correctCount": correct,
            "accuracy": correct / len(rows) if rows else None,
            "meanRenderedContextChars": (
                sum(row["renderedContextChars"] for row in rows) / len(rows)
                if rows
                else 0.0
            ),
        },
        "answerModelStats": answer_llm.stats(),
        "judgeModelStats": judge_llm.stats(),
    }
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
