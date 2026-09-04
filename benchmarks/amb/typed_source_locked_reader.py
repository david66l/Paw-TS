"""Query-only reader routing over immutable retrieved LongMemEval sources.

The retrieval layer owns the source aperture.  This module may re-render only
documents already returned by that aperture; it never searches, expands, or
consults evaluation annotations.  A failed hydration is an atomic fallback to
the original reader packet.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from typing import Any, Iterable, Mapping

try:
    from .multi_session_set_plan import Operator, SetPlan, compile_set_plan
    from .temporal_event_ledger_shadow import timestamp
except ImportError:
    from multi_session_set_plan import Operator, SetPlan, compile_set_plan  # type: ignore[no-redef]
    from temporal_event_ledger_shadow import timestamp  # type: ignore[no-redef]


ROUTER_POLICY = "paw.typed-source-locked-reader.v1:query-origin-and-set-plan"

ASSISTANT_DIALOGUE_PROTOCOL = """Paw prior-dialogue artifact protocol:
- The supplied blocks are exact turns from already-retrieved prior sessions.
- Preserve authorship: USER is the earlier request or statement; ASSISTANT is the earlier response. Never answer an assistant-artifact question with only the user's prompt.
- Bind the requested artifact to the exact adjacent dialogue pair. Topic similarity alone does not transfer authorship between turns or sessions.
- Scan every supplied session, then return the requested prior answer, wording, recommendation, list, or other dialogue artifact directly.
- If no supplied ASSISTANT turn answers the request, say only that the locked memory is insufficient. Never invent a missing prior response.

"""

EVIDENCE_SET_PROTOCOL = """Paw typed evidence-set execution protocol:
- The query-only host plan is: {plan}
- The supplied blocks are complete USER turns from every already-retrieved, cutoff-valid source in the frozen source lock. Scan every session before calculating.
- First form a checkable member table: entity, action/state, value, unit, event time, and supporting session/turn. Apply inclusion, time-window, active/completed/planned/cancelled, and requested-attribute filters before arithmetic.
- Deduplicate only repeated mentions of the same real event and action. The same entity may have distinct events or obligations. A newer fact supersedes an older fact only for the same entity and attribute.
- Treat the question as the join contract: compatible operands may come from separate sessions. Normalize compatible units, then count, sum, compare, average, select, or list only after a second complete scan.
- Do not replace a missing operand with a related fact. If a required operand is absent or conflicting, report the exact insufficiency instead of guessing.
- Make the final answer directly match the requested value, date, entity, list, or comparison; keep the audit calculation short.

"""


@dataclass(frozen=True)
class ReaderExecution:
    route: str
    context: str
    protocol: str
    source_count: int
    turn_count: int
    plan: dict[str, Any] | None
    fallback_reason: str | None


def _public_plan(plan: SetPlan) -> dict[str, Any]:
    payload = asdict(plan)
    return {
        key: value.value if hasattr(value, "value") else value
        for key, value in payload.items()
    }


def _assistant_route(raw: Mapping[str, Any] | None) -> bool:
    if raw is None:
        return False
    return raw.get("evidenceFirstQueryAnswerOriginKind") in {
        "explicit_assistant",
        "explicit_shared",
        "dialogue_artifact_unowned",
    }


def _set_route(question: str) -> SetPlan | None:
    plan = compile_set_plan(question)
    if plan is None or plan.operator is Operator.LOOKUP:
        return None
    if not plan.exhaustive_set_required and plan.arity < 2:
        return None
    return plan


def _turns(document: object) -> tuple[tuple[str, str], ...]:
    content = getattr(document, "content", None)
    if not isinstance(content, str):
        raise ValueError("source content is not text")
    value = json.loads(content)
    if not isinstance(value, list) or not value:
        raise ValueError("source content is not a dialogue session")
    output: list[tuple[str, str]] = []
    for turn in value:
        if not isinstance(turn, dict) or turn.get("role") not in {"user", "assistant"}:
            raise ValueError("source dialogue role is invalid")
        text = turn.get("content")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("source dialogue content is invalid")
        output.append((turn["role"], text.strip()))
    return tuple(output)


def _locked_documents(
    recalled: Iterable[object],
    documents_by_id: Mapping[str, object],
    query_timestamp: str | None,
) -> tuple[object, ...]:
    cutoff = timestamp(query_timestamp) if isinstance(query_timestamp, str) else None
    if cutoff is None:
        raise ValueError("query cutoff is unavailable")
    selected: list[object] = []
    seen: set[str] = set()
    for recalled_document in recalled:
        source_id = getattr(recalled_document, "id", None)
        if not isinstance(source_id, str) or source_id in seen:
            continue
        source = documents_by_id.get(source_id)
        if source is None:
            continue
        observed = getattr(source, "timestamp", None)
        normalized = timestamp(observed) if isinstance(observed, str) else None
        if normalized is None or normalized > cutoff:
            raise ValueError("source lock contains an invalid or post-cutoff source")
        seen.add(source_id)
        selected.append(source)
        if len(selected) == 8:
            break
    if not selected:
        raise ValueError("source lock has no immutable source documents")
    return tuple(selected)


def _render(sources: tuple[object, ...], *, user_only: bool) -> tuple[str, int]:
    chronological = sorted(
        enumerate(sources),
        key=lambda item: (
            timestamp(getattr(item[1], "timestamp", "")) or "9999",
            item[0],
        ),
    )
    blocks: list[str] = []
    turn_count = 0
    for session_index, (_, source) in enumerate(chronological, start=1):
        source_turns = _turns(source)
        rendered: list[str] = []
        for turn_index, (role, text) in enumerate(source_turns, start=1):
            if user_only and role != "user":
                continue
            rendered.append(
                f"[S{session_index:02d}T{turn_index:02d}] {role.upper()}: {text}"
            )
            turn_count += 1
        if rendered:
            observed = timestamp(getattr(source, "timestamp", ""))
            blocks.append(
                f"[Session S{session_index:02d}; observed {observed}]\n"
                + "\n".join(rendered)
            )
    if not blocks or turn_count == 0:
        raise ValueError("source lock rendered no eligible dialogue turns")
    return "\n\n".join(blocks), turn_count


def route_typed_source_locked_reader(
    *,
    question: str,
    query_timestamp: str | None,
    recalled: Iterable[object],
    documents_by_id: Mapping[str, object],
    raw: Mapping[str, Any] | None,
    legacy_context: str,
) -> ReaderExecution:
    """Choose a reader packet without looking at category, gold, or correctness."""

    assistant = _assistant_route(raw)
    plan = _set_route(question)
    route = (
        "assistant_dialogue_set"
        if assistant and plan is not None
        else "assistant_dialogue"
        if assistant
        else "evidence_set"
        if plan is not None
        else "legacy"
    )
    if route == "legacy":
        return ReaderExecution(route, legacy_context, "", 0, 0, None, None)
    try:
        sources = _locked_documents(recalled, documents_by_id, query_timestamp)
        context, turn_count = _render(sources, user_only=route == "evidence_set")
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        return ReaderExecution(
            "legacy",
            legacy_context,
            "",
            0,
            0,
            _public_plan(plan) if plan is not None else None,
            type(error).__name__,
        )
    public_plan = _public_plan(plan) if plan is not None else None
    protocol = (
        ASSISTANT_DIALOGUE_PROTOCOL
        if assistant
        else ""
    ) + (
        EVIDENCE_SET_PROTOCOL.format(
            plan=json.dumps(public_plan, sort_keys=True, separators=(",", ":"))
        )
        if plan is not None
        else ""
    )
    return ReaderExecution(
        route,
        context,
        protocol,
        len(sources),
        turn_count,
        public_plan,
        None,
    )
