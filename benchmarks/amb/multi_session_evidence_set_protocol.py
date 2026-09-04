"""Query-only execution protocol for complete frozen evidence sets.

The functions here intentionally consume question text and an already-compiled
plan only.  They do not receive benchmark labels, retrieved content, or model
answers.  Both the standalone direct reader and the main runner import this
module so their set semantics cannot silently drift.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal


PROTOCOL_REVISION = "paw.complete-evidence-set-protocol.v4:item-scoped-dialogue"


def query_bound_boundary_protocol(question: str) -> str:
    """Return only narrowly-scoped semantics implied by the query wording."""

    lowered = question.casefold()
    clauses: list[str] = []
    if re.search(r"\bbefore\b", lowered):
        clauses.append(
            "In an items/events-before-X question, X is the boundary/reference "
            "event and is not itself counted unless the wording explicitly includes it."
        )
    if not clauses:
        return ""
    return "\n\nAdditional query-bound boundary rules:\n- " + "\n- ".join(clauses)


def complete_evidence_set_protocol(
    plan_payload: dict[str, Any] | None,
    question: str,
    *,
    role_authority: Literal["user", "dialogue"] = "user",
) -> str:
    """Stable direct-reader instructions shared by both execution paths."""

    plan = json.dumps(plan_payload, sort_keys=True, separators=(",", ":"))
    evidence_contract = (
        "The supplied blocks contain complete USER turns from every already-retrieved, cutoff-valid source in the frozen source lock."
        if role_authority == "user"
        else "The supplied blocks contain only item-certified role-labelled turns and each certified assistant turn's adjacent USER predecessor from the certificate's exact source scope."
    )
    return f"""Paw typed complete evidence-set execution protocol ({PROTOCOL_REVISION}):
- The query-only host plan is: {plan}
- {evidence_contract} Preserve authorship and scan every supplied session before calculating.
- Derive the exact inclusion rule from the question, then form a checkable member table: entity, action/state, value, unit, event time, supporting session/turn, and source rank. Apply inclusion, time-window, active/completed/planned/cancelled, and requested-attribute filters before arithmetic.
- Deduplicate only repeated mentions of the same real event and action. The same entity may have distinct events or obligations. A newer fact supersedes an older fact only for the same entity and attribute.
- Resolve relative time in the current question against the query cutoff. Resolve relative time inside a memory turn against that source's observation time. An explicit event date or timestamp outranks both anchors. Do not substitute a session time for an unrelated undated event.
- The question supplies the operator and requested relationship. Compatible operands may come from separate sessions, but every operand, entity, event, and requested attribute must be explicitly supported by the locked evidence. Normalize compatible units, then count, sum, compare, average, select, or list only after a second complete scan.
- Do not replace a missing operand with a related fact. If a required operand is absent or conflicting, report the exact insufficiency instead of guessing.
- For a count, enumerate the unique event/action members. For arithmetic, show one short checkable calculation. Make the final answer directly match the requested value, date, entity, list, or comparison.{query_bound_boundary_protocol(question)}

"""
