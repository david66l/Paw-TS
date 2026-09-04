"""Run one-call Evidence-Set Reader answers over sealed multi-session packets.

The reader and set-plan compiler remain label-blind through generation.  The
official LongMemEval answer and question metadata are read only after the model
has returned its structured member extraction.  Arithmetic answers are then
validated and recomputed by the host before judging.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
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
    from .multi_session_set_plan import (
        Operator,
        compile_set_plan,
        execute_set_plan,
        validate_extraction,
    )
    from .temporal_event_ledger_shadow import required_string
except ImportError:
    from multi_session_evidence_set_reader import load_reader_packets  # type: ignore[no-redef]
    from multi_session_set_plan import (  # type: ignore[no-redef]
        Operator,
        compile_set_plan,
        execute_set_plan,
        validate_extraction,
    )
    from temporal_event_ledger_shadow import required_string  # type: ignore[no-redef]


SCHEMA_VERSION = "paw.multi-session-evidence-set-answer.v1"
READER_RUN_POLICY = "paw.multi-session-evidence-set-runner.v1:one-extraction-host-math"
INSUFFICIENT_ANSWER = (
    "The available memory does not contain enough information to answer this question."
)


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def slice_hmacs(values: list[str], index: int, count: int) -> list[str]:
    if count < 1 or not 0 <= index < count:
        raise ValueError("query slice is invalid")
    return [value for position, value in enumerate(values) if position % count == index]


def public_plan(plan: Any) -> dict[str, Any]:
    payload = asdict(plan)
    for key, value in tuple(payload.items()):
        if hasattr(value, "value"):
            payload[key] = value.value
    return payload


def extraction_schema():
    from memory_bench.llm.base import Schema

    nullable_string = {"type": ["string", "null"]}
    nullable_number = {"type": ["number", "string", "null"]}
    return Schema(
        properties={
            "status": {
                "type": "string",
                "enum": ["complete", "insufficient", "unsupported"],
            },
            "operator": {
                "type": "string",
                "enum": [operator.value for operator in Operator],
            },
            "members": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "memberKey": {"type": "string"},
                        "evidenceIds": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "entity": {"type": "string"},
                        "value": nullable_number,
                        "unit": nullable_string,
                        "eventTime": nullable_string,
                        "disposition": {
                            "type": "string",
                            "enum": ["include", "left", "right"],
                        },
                    },
                    "required": [
                        "memberKey",
                        "evidenceIds",
                        "entity",
                        "value",
                        "unit",
                        "eventTime",
                        "disposition",
                    ],
                },
            },
            "calculation": nullable_string,
            "answer": {"type": ["string", "number", "null"]},
        },
        required=["status", "operator", "members", "calculation", "answer"],
    )


def extraction_prompt(question: str, plan: Any, context: str) -> str:
    plan_json = json.dumps(public_plan(plan), sort_keys=True, separators=(",", ":"))
    return f"""Execute the deterministic set plan below over the complete locked evidence packet.

SET_PLAN: {plan_json}

Return one structured extraction. The operator must exactly match SET_PLAN. Use only SxxTxx evidence IDs present in the packet. Scan every session before returning complete.

Member rules:
- One member is one real entity, event, or numeric observation, not one mention. Merge repeated mentions of the same event into one member and cite every supporting evidence ID.
- Keep distinct real events as distinct members even if their names or types match.
- Apply the query's entity, time window, state, and completion constraints before including members. Do not count planned or cancelled events when the question requires completed events.
- For count_members with enumerated_members, value and unit are null. For stated_cardinality, give each supported numeric subtotal and one common normalized unit.
- For sum_values, average, argmax, and argmin, give every included member a numeric value and one common normalized unit. Convert minutes/hours and other compatible units to the requested unit first.
- For difference and ratio_percent, return exactly two members: disposition left is the requested minuend/numerator and disposition right is the subtrahend/denominator.
- For lookup, put the direct supported result in entity. A single logical member may cite multiple evidence IDs when the answer requires linking facts across sessions.
- disposition is include for every non-binary operation.
- eventTime is ISO-8601 when an explicit event time can be resolved; otherwise null. Session time is only a fallback when the statement clearly locates the event in that session.
- If one or more required facts are absent or conflict cannot be resolved, return status insufficient with empty members and null calculation/answer. Never guess.
- The answer and calculation fields are untrusted audit fields; arithmetic will be recomputed by the host.

EVIDENCE PACKET:
{context}

QUESTION: {question}
"""


def judge_values(item: dict[str, Any]) -> tuple[list[str], str, bool]:
    """This is the first evaluation-label read and must follow generation."""

    accepted = item.get("answer")
    question_type = item.get("question_type")
    question_id = required_string(item, "question_id")
    if isinstance(accepted, str):
        answers = [accepted]
    elif isinstance(accepted, list) and all(isinstance(value, str) for value in accepted):
        answers = accepted
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
    judge = GeminiJudge(judge_llm)
    schema = extraction_schema()
    rows: list[dict[str, Any]] = []
    for query_hmac in targets:
        item, packet = packets[query_hmac]
        question = required_string(item, "question")
        plan = compile_set_plan(question)
        proposal: dict[str, Any] | None = None
        execution_status = "unsupported_plan"
        execution_answer = INSUFFICIENT_ANSWER
        execution_calculation: str | None = None
        validation_error: str | None = None
        if plan is not None:
            proposal = answer_llm.generate(
                extraction_prompt(question, plan, packet.context),
                schema,
            )
            try:
                extraction = validate_extraction(
                    plan,
                    {"evidenceIds": packet.evidence_ids},
                    proposal,
                )
                execution = execute_set_plan(plan, extraction)
                execution_status = execution.status
                execution_calculation = execution.calculation
                if execution.answer is not None:
                    execution_answer = (
                        f"{execution.answer}. {execution.calculation}"
                        if execution.calculation
                        else execution.answer
                    )
            except (KeyError, TypeError, ValueError) as error:
                execution_status = "invalid_extraction"
                validation_error = error.__class__.__name__ + ":" + str(error)

        # Evaluation labels enter only after the answer has been finalized.
        accepted, question_type, abstention = judge_values(item)
        judgment = judge.score(
            question,
            execution_answer,
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
                "plan": public_plan(plan) if plan is not None else None,
                "proposalHash": sha(json.dumps(proposal, sort_keys=True)) if proposal is not None else None,
                "executionStatus": execution_status,
                "executionAnswerHash": sha(execution_answer),
                "executionCalculationHash": sha(execution_calculation) if execution_calculation else None,
                "validationError": validation_error,
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
        checkpoint = {
            "schemaVersion": f"{SCHEMA_VERSION}:checkpoint",
            "runnerPolicy": READER_RUN_POLICY,
            "slice": {"index": args.slice_index, "count": args.slice_count},
            "rows": rows,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(checkpoint, indent=2) + "\n", encoding="utf-8")
        print(
            f"completed {len(rows)}/{len(targets)} correct={int(judgment.correct)} "
            f"status={execution_status}",
            flush=True,
        )

    correct = sum(row["answerCorrect"] is True for row in rows)
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "sealed": True,
        "runnerPolicy": READER_RUN_POLICY,
        "slice": {"index": args.slice_index, "count": args.slice_count},
        "rows": rows,
        "metrics": {
            "queryCount": len(rows),
            "correctCount": correct,
            "accuracy": correct / len(rows) if rows else None,
            "invalidExtractionCount": sum(
                row["executionStatus"] == "invalid_extraction" for row in rows
            ),
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
