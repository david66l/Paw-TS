"""Label-blind plans and fail-closed execution for multi-session set queries.

This module is deliberately independent of the retrieval and benchmark runner.
It consumes only question text, a packet's evidence identifiers, and one model
extraction.  The model may identify supported members, but it never decides the
arithmetic result: the host validates and recomputes it deterministically.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from enum import Enum
import re
from typing import Any, Iterable, Mapping


class Operator(str, Enum):
    COUNT_MEMBERS = "count_members"
    SUM_VALUES = "sum_values"
    DIFFERENCE = "difference"
    AVERAGE = "average"
    RATIO_PERCENT = "ratio_percent"
    ARGMAX = "argmax"
    ARGMIN = "argmin"
    COLLECT_UNIQUE = "collect_unique"
    LOOKUP = "lookup"


class CountBasis(str, Enum):
    ENUMERATED_MEMBERS = "enumerated_members"
    STATED_CARDINALITY = "stated_cardinality"


class TemporalMode(str, Enum):
    ANY = "any"
    RANGE = "range"
    LATEST = "latest"


@dataclass(frozen=True)
class SetPlan:
    operator: Operator
    member_kind: str
    count_basis: CountBasis | None
    arity: int
    minimum_logical_members: int
    requested_unit: str | None
    temporal_mode: TemporalMode
    exhaustive_set_required: bool


@dataclass(frozen=True)
class Packet:
    """The small, implementation-neutral packet contract used by the validator."""

    evidence_ids: frozenset[str]


@dataclass(frozen=True)
class ExtractedMember:
    member_key: str
    evidence_ids: tuple[str, ...]
    entity: str
    value: Decimal | None
    unit: str | None
    event_time: str | None
    disposition: str


@dataclass(frozen=True)
class Extraction:
    status: str
    operator: Operator
    members: tuple[ExtractedMember, ...]
    calculation: str | None
    answer: str | int | float | None


@dataclass(frozen=True)
class ExecutionResult:
    status: str
    answer: str | None
    calculation: str | None
    members_used: tuple[str, ...]


_STATUS = frozenset(("complete", "unsupported", "insufficient"))
_MEMBER_KEYS = frozenset(("memberKey", "evidenceIds", "entity", "value", "unit", "eventTime", "disposition"))
_EXTRACTION_KEYS = frozenset(("status", "operator", "members", "calculation", "answer"))
_VALUE_OPERATORS = frozenset((Operator.SUM_VALUES, Operator.DIFFERENCE, Operator.AVERAGE, Operator.RATIO_PERCENT, Operator.ARGMAX, Operator.ARGMIN))
_BINARY_OPERATORS = frozenset((Operator.DIFFERENCE, Operator.RATIO_PERCENT))
_UNIT_ALIASES = {
    "$": "usd", "usd": "usd", "dollar": "usd", "dollars": "usd",
    "%": "percent", "percent": "percent", "percentage": "percent",
    "hour": "hour", "hours": "hour", "hr": "hour", "hrs": "hour",
    "minute": "minute", "minutes": "minute", "min": "minute", "mins": "minute",
    "day": "day", "days": "day", "week": "week", "weeks": "week",
    "month": "month", "months": "month", "year": "year", "years": "year",
    "km": "km", "kilometer": "km", "kilometers": "km",
    "mile": "mile", "miles": "mile",
    "page": "page", "pages": "page", "point": "point", "points": "point",
    "episode": "episode", "episodes": "episode", "view": "view", "views": "view",
    "comment": "comment", "comments": "comment", "pound": "pound", "pounds": "pound",
}


def _normalized(question: str) -> str | None:
    if not isinstance(question, str):
        return None
    value = " ".join(question.strip().split())
    return value.casefold() or None


def _requested_unit(question: str, operator: Operator) -> str | None:
    lowered = question.casefold()
    if re.search(r"\b(?:percent|percentage)\b", lowered) or "%" in question:
        return "percent"
    if operator in _VALUE_OPERATORS or operator is Operator.COUNT_MEMBERS:
        # Time-window words such as "in the past month" describe scope, not the
        # answer unit. Prefer the measure immediately governed by how-many,
        # total, difference, distance, time, or weight wording.
        governed = re.search(
            r"(?:how many|how much|total(?: number| amount| distance| time| weight)?(?: of)?|difference in)\s+"
            r"(minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|points?|episodes?|views?|comments?|pounds?)\b",
            lowered,
        )
        if governed:
            return _UNIT_ALIASES.get(governed.group(1), governed.group(1))
    if "$" in question or re.search(
        r"\b(?:usd|dollars?|money|cost|price|spent|spend|paid|pay|earned|earn|raise[ds]?|cashback|save[ds]?)\b",
        lowered,
    ):
        return "usd"
    return None


def _temporal_mode(question: str) -> TemporalMode:
    if re.search(r"\b(?:latest|newest|most recently|most recent)\b", question):
        return TemporalMode.LATEST
    temporal_words = r"(?:\d{4}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|date|week|month|year)"
    if re.search(
        r"\b(?:during|since|recently|today|yesterday|this (?:week|month|year)|last (?:week|month|year)|past (?:few |two |three |four )?(?:days?|weeks?|months?|years?))\b|\bin\s+(?:the\s+)?\d{4}\b",
        question,
    ) or (
        re.search(r"\b(?:between|from)\b.+\b(?:and|to)\b", question)
        and re.search(temporal_words, question)
    ):
        return TemporalMode.RANGE
    return TemporalMode.ANY


def _member_kind(question: str, operator: Operator) -> str:
    if operator in _VALUE_OPERATORS:
        return "value"
    if re.search(r"\b(?:who|person|people|member|members)\b", question):
        return "person"
    if re.search(r"\b(?:event|meeting|trip|visit|appointment|session)\b", question):
        return "event"
    return "entity"


def compile_set_plan(question: str) -> SetPlan | None:
    """Conservatively classify a set operation from text alone.

    Ambiguous prose is unsupported.  In particular, average/min/max are tested
    before collection wording, preventing them from silently becoming a list.
    """

    text = _normalized(question)
    if text is None:
        return None
    temporal_mode = _temporal_mode(text)
    operator: Operator
    count_basis: CountBasis | None = None
    arity = 1
    minimum = 1
    exhaustive = False
    if re.search(r"\b(?:percentage|percent|ratio)\b|%|\bwhat portion\b", text):
        operator, arity, minimum = Operator.RATIO_PERCENT, 2, 2
    elif re.search(
        r"\b(?:difference between|how much (?:more|less)|how many (?:more|fewer)|increase|decrease|older|younger|earlier|later|faster|slower|left to|need to earn|did it take|have i been|exceed(?:ed)?|save by|saved on|subtract)\b",
        text,
    ):
        operator, arity, minimum = Operator.DIFFERENCE, 2, 2
    elif re.search(r"\b(?:average|mean)\b", text):
        operator, minimum, exhaustive = Operator.AVERAGE, 1, True
    elif re.search(r"\b(?:highest|largest|most)\b", text) and not re.search(r"\bhow many\b", text):
        operator, minimum, exhaustive = Operator.ARGMAX, 2, True
    elif re.search(r"\b(?:lowest|smallest|least|fewest)\b", text) and not re.search(
        r"\b(?:amount|total).+\b(?:and|combined)\b", text
    ):
        operator, minimum, exhaustive = Operator.ARGMIN, 2, True
    elif re.search(r"\b(?:how many|number of|count)\b", text) and not re.search(
        r"\bhow many\s+(?:minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|points?|episodes?|views?|comments?|pounds?)\b",
        text,
    ):
        operator, exhaustive = Operator.COUNT_MEMBERS, True
        count_basis = (
            CountBasis.STATED_CARDINALITY
            if re.search(r"\b(?:fish|attendees?|people|followers?|siblings?)\b", text)
            else CountBasis.ENUMERATED_MEMBERS
        )
    elif re.search(r"\b(?:total|sum)\b", text) or re.search(
        r"\bhow (?:many|much)\b.+\b(?:minutes?|hours?|days?|weeks?|months?|years?|miles?|kilometers?|km|pages?|points?|episodes?|views?|comments?|weight|money|cost|spent|spend|earned|earn|made|raise[ds]?)\b",
        text,
    ):
        operator, exhaustive = Operator.SUM_VALUES, True
    elif re.search(r"\b(?:list|all|unique|distinct|which ones|what are)\b", text):
        operator, exhaustive = Operator.COLLECT_UNIQUE, True
    elif re.match(r"^(?:who|what|which|when|where|did|do|does|is|was|were|how)\b", text):
        operator = Operator.LOOKUP
    else:
        return None
    unit = _requested_unit(question, operator)
    return SetPlan(operator, _member_kind(text, operator), count_basis, arity, minimum, unit, temporal_mode, exhaustive)


def packet_from(value: Packet | Mapping[str, Any] | Iterable[str]) -> Packet:
    """Construct a packet only when its evidence identifiers are unambiguous."""

    if isinstance(value, Packet):
        return value
    raw: Any
    if isinstance(value, Mapping):
        raw = value.get("evidenceIds", value.get("evidence_ids"))
    else:
        raw = value
    if not isinstance(raw, Iterable) or isinstance(raw, (str, bytes)):
        raise ValueError("packet must provide evidence identifiers")
    ids = list(raw)
    if not ids or any(not isinstance(item, str) or not item.strip() for item in ids):
        raise ValueError("packet evidence identifiers are invalid")
    cleaned = frozenset(item.strip() for item in ids)
    if len(cleaned) != len(ids):
        raise ValueError("packet evidence identifiers must be unique")
    return Packet(cleaned)


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError("member value must be numeric or null")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError("member value must be finite") from error
    if not result.is_finite():
        raise ValueError("member value must be finite")
    return result


def _unit(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("member unit must be a string or null")
    normalized = _UNIT_ALIASES.get(value.strip().casefold(), value.strip().casefold())
    return normalized


def _event_time(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("member eventTime must be a string or null")
    candidate = value.strip().replace("Z", "+00:00")
    try:
        datetime.fromisoformat(candidate)
    except ValueError as error:
        raise ValueError("member eventTime is not ISO-8601") from error
    return value.strip()


def _logical_key(member: ExtractedMember) -> str:
    return " ".join(member.entity.casefold().split())


def _validate_units(plan: SetPlan, members: tuple[ExtractedMember, ...]) -> None:
    values = [member for member in members if member.value is not None]
    if plan.operator in _VALUE_OPERATORS or plan.count_basis is CountBasis.STATED_CARDINALITY:
        if len(values) != len(members):
            raise ValueError("all planned members require numeric values")
        units = {member.unit for member in members}
        if len(units) != 1:
            raise ValueError("member units are incompatible")
        only_unit = next(iter(units))
        # A ratio's requested percent is its output unit; its operands are
        # commonly unitless counts (or a shared non-percent unit).
        if (
            plan.requested_unit is not None
            and plan.operator is not Operator.RATIO_PERCENT
            and only_unit != plan.requested_unit
        ):
            raise ValueError("member unit differs from requested unit")
    elif any(member.value is not None or member.unit is not None for member in members):
        raise ValueError("non-value operation cannot contain numeric values")


def validate_extraction(plan: SetPlan | None, packet: Packet | Mapping[str, Any] | Iterable[str], proposal: Any) -> Extraction:
    """Validate one model extraction against the frozen plan and packet.

    No proposal field is used as an arithmetic result.  Malformed, incomplete,
    or role-incompatible proposals raise rather than being repaired.
    """

    if plan is None:
        raise ValueError("unsupported plan cannot be executed")
    evidence_packet = packet_from(packet)
    if not isinstance(proposal, Mapping) or set(proposal) != _EXTRACTION_KEYS:
        raise ValueError("extraction must have exactly the required fields")
    status, raw_operator = proposal.get("status"), proposal.get("operator")
    if status not in _STATUS:
        raise ValueError("extraction status is invalid")
    if raw_operator != plan.operator.value:
        raise ValueError("extraction operator differs from plan")
    raw_members = proposal.get("members")
    calculation, answer = proposal.get("calculation"), proposal.get("answer")
    if not isinstance(raw_members, list):
        raise ValueError("extraction members must be a list")
    if status != "complete":
        if raw_members or calculation is not None or answer is not None:
            raise ValueError("non-complete extraction must not contain a partial answer")
        return Extraction(status, plan.operator, (), None, None)
    if not isinstance(calculation, str) or not calculation.strip():
        raise ValueError("complete extraction requires a calculation string")
    if isinstance(answer, bool) or not isinstance(answer, (str, int, float)):
        raise ValueError("complete extraction requires a scalar answer")
    members: list[ExtractedMember] = []
    for raw in raw_members:
        if not isinstance(raw, Mapping) or set(raw) != _MEMBER_KEYS:
            raise ValueError("member must have exactly the required fields")
        key, ids, entity = raw["memberKey"], raw["evidenceIds"], raw["entity"]
        if not isinstance(key, str) or not key.strip() or not isinstance(entity, str) or not entity.strip():
            raise ValueError("member key and entity are required")
        if not isinstance(ids, list) or not ids or any(not isinstance(item, str) or not item.strip() for item in ids):
            raise ValueError("member evidenceIds are invalid")
        cleaned_ids = tuple(item.strip() for item in ids)
        if len(set(cleaned_ids)) != len(cleaned_ids) or not set(cleaned_ids).issubset(evidence_packet.evidence_ids):
            raise ValueError("member evidenceIds are not in packet")
        disposition = raw["disposition"]
        if not isinstance(disposition, str):
            raise ValueError("member disposition is invalid")
        members.append(ExtractedMember(key.strip(), cleaned_ids, entity.strip(), _decimal(raw["value"]), _unit(raw["unit"]), _event_time(raw["eventTime"]), disposition))
    if len({member.member_key for member in members}) != len(members):
        raise ValueError("member keys must be unique")
    if len({_logical_key(member) for member in members}) < plan.minimum_logical_members:
        raise ValueError("too few logical members")
    if plan.operator in _BINARY_OPERATORS:
        if len(members) != plan.arity or {member.disposition for member in members} != {"left", "right"}:
            raise ValueError("binary extraction requires exactly left and right members")
    elif len(members) < plan.arity or any(member.disposition != "include" for member in members):
        raise ValueError("unary extraction requires included members")
    # A bounded range can be stated relative to the query cutoff ("last
    # week") without a safely resolvable instant for every event.  The model
    # still has to filter before inclusion; only a latest-state operation
    # requires comparable explicit instants for deterministic host selection.
    if plan.temporal_mode is TemporalMode.LATEST and any(
        member.event_time is None for member in members
    ):
        raise ValueError("latest extraction requires eventTime")
    frozen_members = tuple(members)
    _validate_units(plan, frozen_members)
    return Extraction(status, plan.operator, frozen_members, calculation.strip(), answer)


def _format_decimal(value: Decimal) -> str:
    if value == value.to_integral():
        return str(value.quantize(Decimal("1")))
    rendered = format(value.normalize(), "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def _with_unit(value: Decimal, unit: str | None) -> str:
    text = _format_decimal(value)
    if unit == "percent":
        return f"{text}%"
    if unit == "usd":
        return f"${text}"
    return f"{text} {unit}" if unit else text


def _latest(members: tuple[ExtractedMember, ...]) -> tuple[ExtractedMember, ...]:
    if not members or any(member.event_time is None for member in members):
        raise ValueError("latest execution requires eventTime")
    latest = max(member.event_time for member in members)
    return tuple(member for member in members if member.event_time == latest)


def execute_set_plan(plan: SetPlan | None, extraction: Extraction) -> ExecutionResult:
    """Recompute the direct answer without trusting the model-provided answer."""

    if plan is None or extraction.operator is not plan.operator:
        raise ValueError("extraction does not bind to an executable plan")
    if extraction.status != "complete":
        return ExecutionResult(extraction.status, None, None, ())
    members = _latest(extraction.members) if plan.temporal_mode is TemporalMode.LATEST else extraction.members
    if plan.operator is Operator.COUNT_MEMBERS:
        if plan.count_basis is CountBasis.STATED_CARDINALITY:
            total = sum((member.value for member in members if member.value is not None), Decimal("0"))
            answer = _with_unit(total, members[0].unit if members else None)
            calculation = f"sum of stated cardinalities = {answer}"
        else:
            total = len({_logical_key(member) for member in members})
            answer, calculation = str(total), f"{total} unique enumerated members"
    elif plan.operator is Operator.SUM_VALUES:
        total = sum((member.value for member in members if member.value is not None), Decimal("0"))
        answer, calculation = _with_unit(total, members[0].unit), f"sum of {len(members)} values = {_with_unit(total, members[0].unit)}"
    elif plan.operator is Operator.AVERAGE:
        total = sum((member.value for member in members if member.value is not None), Decimal("0"))
        average = total / Decimal(len(members))
        answer, calculation = _with_unit(average, members[0].unit), f"{_with_unit(total, members[0].unit)} / {len(members)} = {_with_unit(average, members[0].unit)}"
    elif plan.operator in _BINARY_OPERATORS:
        left = next(member for member in members if member.disposition == "left")
        right = next(member for member in members if member.disposition == "right")
        if plan.operator is Operator.DIFFERENCE:
            result = left.value - right.value  # type: ignore[operator]
            answer, calculation = _with_unit(result, left.unit), f"{_with_unit(left.value, left.unit)} - {_with_unit(right.value, right.unit)} = {_with_unit(result, left.unit)}"
        else:
            if right.value == 0:  # type: ignore[comparison-overlap]
                return ExecutionResult("unsupported", None, None, ())
            result = (left.value / right.value) * Decimal("100")  # type: ignore[operator]
            answer, calculation = _with_unit(result, "percent"), f"({_format_decimal(left.value)} / {_format_decimal(right.value)}) x 100 = {_with_unit(result, 'percent')}"
    elif plan.operator in {Operator.ARGMAX, Operator.ARGMIN}:
        chooser = max if plan.operator is Operator.ARGMAX else min
        selected = chooser(members, key=lambda member: (member.value, _logical_key(member)))
        answer, calculation = selected.entity, f"{selected.entity} ({_with_unit(selected.value, selected.unit)})"
    elif plan.operator is Operator.COLLECT_UNIQUE:
        canonical: dict[str, str] = {}
        for member in members:
            key = _logical_key(member)
            current = canonical.get(key)
            if current is None or (member.entity.casefold(), member.entity) < (current.casefold(), current):
                canonical[key] = member.entity
        names = sorted(canonical.values(), key=lambda item: (item.casefold(), item))
        answer, calculation = ", ".join(names), f"{len(names)} unique members"
    elif plan.operator is Operator.LOOKUP:
        selected = sorted(members, key=lambda member: (_logical_key(member), member.member_key))[0]
        answer, calculation = selected.entity, "supported by supplied evidence"
    else:  # pragma: no cover - Enum exhaustiveness guard
        raise ValueError("operator is unsupported")
    return ExecutionResult("complete", answer, calculation, tuple(member.member_key for member in members))
