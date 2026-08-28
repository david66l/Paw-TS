from __future__ import annotations

from dataclasses import dataclass

from memory_bench.llm.base import Schema


PRIMARY_CAUSES = {
    "missing_relevant_evidence",
    "distractor_or_conflict",
    "role_attribution",
    "temporal_ordering",
    "latest_state_resolution",
    "multi_evidence_synthesis",
    "preference_inference",
    "answer_format_or_scope",
    "judge_mismatch",
    "other",
}
REPAIR_STAGES = {
    "retrieval",
    "evidence_selection",
    "state_resolution",
    "answer_synthesis",
    "evaluation",
}
EVIDENCE_STATUSES = {"sufficient", "partial", "insufficient"}
CONFIDENCES = {"high", "medium", "low"}

_AUDIT_SCHEMA = Schema(
    properties={
        "primary_cause": {
            "type": "string",
            "description": "One allowed failure category from the audit protocol.",
        },
        "repair_stage": {
            "type": "string",
            "description": "One allowed pipeline stage where the smallest architectural repair belongs.",
        },
        "evidence_status": {
            "type": "string",
            "description": "Exactly sufficient, partial, or insufficient.",
        },
        "confidence": {
            "type": "string",
            "description": "Exactly high, medium, or low.",
        },
    },
    required=["primary_cause", "repair_stage", "evidence_status", "confidence"],
)

_AUDIT_PROTOCOL = """Classify why the candidate answer was judged incorrect.
Use the question, accepted answers, candidate answer, and supplied memory packet only.
Return labels, never quotes, copied facts, names, dates, or a rationale.
primary_cause must be exactly one of: missing_relevant_evidence, distractor_or_conflict,
role_attribution, temporal_ordering, latest_state_resolution, multi_evidence_synthesis,
preference_inference, answer_format_or_scope, judge_mismatch, other.
repair_stage must be exactly one of: retrieval, evidence_selection, state_resolution,
answer_synthesis, evaluation.
evidence_status must be exactly one of: sufficient, partial, insufficient.
confidence must be exactly one of: high, medium, low.
Prefer the earliest causal failure, not a downstream symptom.
"""


@dataclass(frozen=True)
class EvidenceErrorAudit:
    primary_cause: str
    repair_stage: str
    evidence_status: str
    confidence: str


def audit_evidence_error(
    llm,
    *,
    question: str,
    question_type: str,
    context: str,
    candidate_answer: str,
    accepted_answers: list[str],
    judge_reason: str,
) -> EvidenceErrorAudit:
    prompt = (
        _AUDIT_PROTOCOL
        + f"\nQuestion type: {question_type}"
        + f"\nQuestion:\n{question}"
        + f"\n\nAccepted answers:\n{accepted_answers}"
        + f"\n\nCandidate answer:\n{candidate_answer}"
        + f"\n\nJudge signal:\n{judge_reason}"
        + f"\n\nMemory packet:\n{context}"
    )
    result = llm.generate(prompt, _AUDIT_SCHEMA)
    cause = str(result.get("primary_cause", "")).strip().lower()
    stage = str(result.get("repair_stage", "")).strip().lower()
    evidence = str(result.get("evidence_status", "")).strip().lower()
    confidence = str(result.get("confidence", "")).strip().lower()
    return EvidenceErrorAudit(
        cause if cause in PRIMARY_CAUSES else "invalid",
        stage if stage in REPAIR_STAGES else "invalid",
        evidence if evidence in EVIDENCE_STATUSES else "invalid",
        confidence if confidence in CONFIDENCES else "invalid",
    )
