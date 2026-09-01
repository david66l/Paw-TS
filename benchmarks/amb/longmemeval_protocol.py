"""Canonical LongMemEval-S protocol metadata and judge prompts.

The AMB dataset adapter is useful for loading documents, but LongMemEval's
official session-level labels and abstention rule must remain authoritative:

* ``answer_session_ids`` defines the gold sessions for answerable questions;
* a ``question_id`` ending in ``_abs`` defines an abstention question;
* ``has_answer`` is a turn-level annotation, not a replacement for the
  session-level labels.

This module deliberately contains no retrieval or answer-generation logic.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import json
from pathlib import Path
from typing import Callable, Iterable


OFFICIAL_LONGMEMEVAL_QUESTION_TYPES = frozenset(
    {
        "single-session-user",
        "single-session-assistant",
        "multi-session",
        "temporal-reasoning",
        "knowledge-update",
        "single-session-preference",
    }
)


@dataclass(frozen=True)
class LongMemEvalQuestionProtocol:
    question_id: str
    question_type: str
    abstention: bool
    gold_document_ids: tuple[str, ...]


@dataclass(frozen=True)
class LongMemEvalProtocolAudit:
    query_count: int
    abstention_count: int
    answerable_count: int
    declared_gold_session_count: int
    turn_label_session_count: int
    turn_label_mismatch_count: int
    turn_label_mismatch_answerable_count: int
    turn_label_empty_answerable_count: int
    duplicate_session_id_query_count: int
    duplicate_session_id_occurrence_count: int

    def public_dict(self) -> dict[str, int | str | bool]:
        return {
            "schemaVersion": "paw.longmemeval-protocol-audit.v1",
            "queryCount": self.query_count,
            "abstentionCount": self.abstention_count,
            "answerableCount": self.answerable_count,
            "declaredGoldSessionCount": self.declared_gold_session_count,
            "turnLabelSessionCount": self.turn_label_session_count,
            "turnLabelMismatchCount": self.turn_label_mismatch_count,
            "turnLabelMismatchAnswerableCount": self.turn_label_mismatch_answerable_count,
            "turnLabelEmptyAnswerableCount": self.turn_label_empty_answerable_count,
            "duplicateSessionIdQueryCount": self.duplicate_session_id_query_count,
            "duplicateSessionIdOccurrenceCount": self.duplicate_session_id_occurrence_count,
            "goldSessionAuthority": "answer_session_ids",
            "turnLabelAuthority": "has_answer",
            "abstentionAuthority": "question_id_suffix_abs",
            "contentFree": True,
        }


def load_longmemeval_protocol(
    path: Path,
) -> tuple[dict[str, LongMemEvalQuestionProtocol], LongMemEvalProtocolAudit]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("LongMemEval data must be a JSON array")

    records: dict[str, LongMemEvalQuestionProtocol] = {}
    abstention_count = 0
    declared_gold_session_count = 0
    turn_label_session_count = 0
    turn_label_mismatch_count = 0
    turn_label_mismatch_answerable_count = 0
    turn_label_empty_answerable_count = 0
    duplicate_session_id_query_count = 0
    duplicate_session_id_occurrence_count = 0

    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("LongMemEval query must be an object")
        question_id = _required_string(item, "question_id")
        question_type = _required_string(item, "question_type")
        if question_type not in OFFICIAL_LONGMEMEVAL_QUESTION_TYPES:
            raise ValueError("LongMemEval question type is incompatible")
        if question_id in records:
            raise ValueError("LongMemEval question IDs must be unique")

        session_ids = _string_list(item.get("haystack_session_ids"))
        sessions = item.get("haystack_sessions")
        dates = item.get("haystack_dates")
        if (
            not isinstance(sessions, list)
            or not isinstance(dates, list)
            or len(session_ids) != len(sessions)
            or len(session_ids) != len(dates)
        ):
            raise ValueError("LongMemEval session arrays are not aligned")
        duplicate_count = len(session_ids) - len(set(session_ids))
        if duplicate_count:
            duplicate_session_id_query_count += 1
            duplicate_session_id_occurrence_count += duplicate_count

        declared_session_ids = _string_list(item.get("answer_session_ids"))
        if not declared_session_ids or not set(declared_session_ids).issubset(
            session_ids
        ):
            raise ValueError("LongMemEval declared gold sessions are invalid")

        turn_label_session_ids = tuple(
            session_id
            for session_id, turns in zip(session_ids, sessions)
            if _session_has_answer_turn(turns)
        )
        abstention = question_id.endswith("_abs")
        if abstention:
            abstention_count += 1
            gold_document_ids: tuple[str, ...] = ()
        else:
            gold_document_ids = tuple(
                f"{question_id}_{session_id}" for session_id in declared_session_ids
            )
            if not turn_label_session_ids:
                turn_label_empty_answerable_count += 1

        if set(turn_label_session_ids) != set(declared_session_ids):
            turn_label_mismatch_count += 1
            if not abstention:
                turn_label_mismatch_answerable_count += 1
        declared_gold_session_count += len(declared_session_ids)
        turn_label_session_count += len(turn_label_session_ids)
        records[question_id] = LongMemEvalQuestionProtocol(
            question_id=question_id,
            question_type=question_type,
            abstention=abstention,
            gold_document_ids=gold_document_ids,
        )

    audit = LongMemEvalProtocolAudit(
        query_count=len(records),
        abstention_count=abstention_count,
        answerable_count=len(records) - abstention_count,
        declared_gold_session_count=declared_gold_session_count,
        turn_label_session_count=turn_label_session_count,
        turn_label_mismatch_count=turn_label_mismatch_count,
        turn_label_mismatch_answerable_count=turn_label_mismatch_answerable_count,
        turn_label_empty_answerable_count=turn_label_empty_answerable_count,
        duplicate_session_id_query_count=duplicate_session_id_query_count,
        duplicate_session_id_occurrence_count=duplicate_session_id_occurrence_count,
    )
    return records, audit


def canonicalize_longmemeval_documents(
    documents: Iterable[object],
) -> tuple[list[object], dict[str, str], int]:
    """Give repeated official session IDs collision-free physical IDs.

    The returned mapping converts physical IDs back to the official logical ID
    for session-level metrics. Non-colliding IDs are left unchanged.
    """

    materialized = list(documents)
    totals: dict[tuple[str | None, str], int] = {}
    for document in materialized:
        key = (getattr(document, "user_id", None), getattr(document, "id"))
        totals[key] = totals.get(key, 0) + 1

    occurrences: dict[tuple[str | None, str], int] = {}
    physical_to_logical: dict[str, str] = {}
    canonical: list[object] = []
    collision_count = 0
    for document in materialized:
        logical_id = getattr(document, "id")
        key = (getattr(document, "user_id", None), logical_id)
        occurrence = occurrences.get(key, 0) + 1
        occurrences[key] = occurrence
        if totals[key] > 1:
            collision_count += int(occurrence > 1)
            physical_id = f"{logical_id}~occurrence-{occurrence}"
            canonical_document = replace(document, id=physical_id)
        else:
            physical_id = logical_id
            canonical_document = document
        if physical_id in physical_to_logical:
            raise ValueError("LongMemEval physical document IDs are not unique")
        physical_to_logical[physical_id] = logical_id
        canonical.append(canonical_document)

    if len(physical_to_logical) != len(canonical):
        raise ValueError("LongMemEval document canonicalization lost a session")
    return canonical, physical_to_logical, collision_count


def official_longmemeval_judge_prompt_fn(
    *, question_type: str, abstention: bool
) -> Callable[[str, list[str], str], str]:
    if question_type not in OFFICIAL_LONGMEMEVAL_QUESTION_TYPES:
        raise ValueError("LongMemEval question type is incompatible")

    def prompt(query: str, gold_answers: list[str], answer: str) -> str:
        gold = gold_answers[0] if gold_answers else ""
        if abstention:
            body = f"""I will give you an unanswerable question, an explanation, and a response from a model.
Please set correct=true if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: {query}

Explanation: {gold}

Model Response: {answer}"""
        elif question_type in {
            "single-session-user",
            "single-session-assistant",
            "multi-session",
        }:
            body = f"""I will give you a question, a correct answer, and a response from a model.
Please set correct=true if the response contains the correct answer. Otherwise, set correct=false. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, set correct=true. If the response only contains a subset of the information required by the answer, set correct=false.

Question: {query}

Correct Answer: {gold}

Model Response: {answer}"""
        elif question_type == "temporal-reasoning":
            body = f"""I will give you a question, a correct answer, and a response from a model.
Please set correct=true if the response contains the correct answer. Otherwise, set correct=false. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, set correct=true. If the response only contains a subset of the information required by the answer, set correct=false. Do not penalize off-by-one errors for the number of days. If the question asks for the number of days, weeks, months, or years and the model makes an off-by-one error, the response is still correct.

Question: {query}

Correct Answer: {gold}

Model Response: {answer}"""
        elif question_type == "knowledge-update":
            body = f"""I will give you a question, a correct answer, and a response from a model.
Please set correct=true if the response contains the correct answer. Otherwise, set correct=false. If the response contains previous information along with an updated answer, consider it correct as long as the updated answer is the required answer.

Question: {query}

Correct Answer: {gold}

Model Response: {answer}"""
        else:
            body = f"""I will give you a question, a rubric for a desired personalized response, and a response from a model.
Please set correct=true if the response satisfies the desired response. Otherwise, set correct=false. The model does not need to reflect all points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Question: {query}

Rubric: {gold}

Model Response: {answer}"""

        return (
            body
            + "\n\nReturn JSON with exactly two fields: "
            + '"correct" (boolean) and "reason" (one short sentence).'
        )

    return prompt


def require_protocol_records(
    records: dict[str, LongMemEvalQuestionProtocol], query_ids: Iterable[str]
) -> None:
    missing = sum(1 for query_id in query_ids if query_id not in records)
    if missing:
        raise ValueError("LongMemEval protocol metadata is incomplete")


def _required_string(item: dict, key: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"LongMemEval {key} is invalid")
    return value


def _string_list(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item for item in value
    ):
        raise ValueError("LongMemEval session ID list is invalid")
    return tuple(value)


def _session_has_answer_turn(turns: object) -> bool:
    if not isinstance(turns, list):
        raise ValueError("LongMemEval session turns are invalid")
    for turn in turns:
        if not isinstance(turn, dict):
            raise ValueError("LongMemEval turn is invalid")
        if turn.get("role") not in {"user", "assistant"}:
            raise ValueError("LongMemEval turn role is invalid")
        if turn.get("has_answer") is True:
            return True
    return False
