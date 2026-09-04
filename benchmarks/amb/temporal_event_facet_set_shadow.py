"""Label-free deterministic temporal EventBundle/EventRecord selector.

The selector is deliberately *not* an answer system.  It first builds stable,
query-independent event records over every locked user turn, then uses BM25 or
a pinned cross-encoder only to form a top-48 retrieval frontier.  Typed
obligations, not retrieval scores, decide whether a bounded event packet is
complete.  Gold endpoints are intentionally unavailable in this module.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .temporal_event_ledger_shadow import (
        TurnCandidate,
        enumerate_locked_user_turns,
        eval_hmac,
        hmac_ref,
        iter_sealed_rows,
        load_json,
        load_temporal_source_lane_sources,
        rank_bm25,
        rank_semantic_rrf,
        required_string,
        sha256_text,
        timestamp,
        tokenize,
    )
    from .temporal_event_slot_shadow import (
        SlotSpec,
        TemporalPlan,
        compile_question_plan,
        sha256_file,
        sha256_tree,
    )
except ImportError:
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        TurnCandidate,
        enumerate_locked_user_turns,
        eval_hmac,
        hmac_ref,
        iter_sealed_rows,
        load_json,
        load_temporal_source_lane_sources,
        rank_bm25,
        rank_semantic_rrf,
        required_string,
        sha256_text,
        timestamp,
        tokenize,
    )
    from temporal_event_slot_shadow import (  # type: ignore[no-redef]
        SlotSpec,
        TemporalPlan,
        compile_question_plan,
        sha256_file,
        sha256_tree,
    )


SCHEMA_VERSION = "paw.temporal-event-facet-set-shadow.v2"
SELECTOR_VERSION = "paw.temporal-event-bundle-obligations.v2"
MAX_SLOT_TURNS = 4
MAX_EVENT_SET_TURNS = 8
MAX_PACKET_TURNS = 12
DEFAULT_TARGET_COUNT = 133
STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "at", "by", "did", "do", "for", "from",
        "had", "have", "how", "i", "in", "is", "it", "many", "me", "my",
        "of", "on", "or", "the", "to", "was", "were", "what", "when", "which",
        "who", "with", "you", "your",
    }
)
RELATIVE_WORDS = frozenset(
    {
        "today", "yesterday", "tomorrow", "last", "next", "ago", "recently",
        "first", "latest", "earliest", "before", "after", "between", "since", "until",
    }
)
MONTHS = frozenset(
    {
        "january", "february", "march", "april", "may", "june", "july", "august",
        "september", "october", "november", "december",
    }
)
WEEKDAYS = frozenset(
    {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
)
EVENT_VERBS = re.compile(
    r"\b(?:adopt(?:ed)?|attend(?:ed)?|bought|booked|celebrat(?:ed|e)|"
    r"completed|drove|flew|got|graduat(?:ed|e)|had|hiked|joined|moved|ordered|"
    r"received|recover(?:ed)?|rent(?:ed)?|started|stopped|took|traveled|visited|"
    r"walked|watched|went|worked)\b",
    re.IGNORECASE,
)
EXPLICIT_DATE = re.compile(r"\b\d{4}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?\b")
ORDINAL = re.compile(r"\b\d+(?:st|nd|rd|th)\b", re.IGNORECASE)
NUMBER = re.compile(r"\b\d+\b")


@dataclass(frozen=True)
class TimeAnchor:
    kind: str  # session, explicit, relative
    normalized: str
    provenance: str  # session_timestamp, turn_text


@dataclass(frozen=True)
class EventRecord:
    """Query-independent atomic event candidate from a full locked source."""

    event_id: str
    candidate: TurnCandidate
    lexical_facets: tuple[str, ...]
    anchors: tuple[TimeAnchor, ...]
    membership_eligible: bool
    count_support: bool
    adjacent_refs: tuple[str, ...]


@dataclass(frozen=True)
class EventBundle:
    """Source-session bounded ordered record bundle, built before retrieval."""

    source_id: str
    session_timestamp: str
    records: tuple[EventRecord, ...]


@dataclass(frozen=True)
class Obligation:
    obligation_id: str
    slot_id: str
    kind: str
    terms: tuple[str, ...]


@dataclass(frozen=True)
class SlotSelection:
    slot: SlotSpec
    records: tuple[EventRecord, ...]
    origins: tuple[str, ...]


def keyed_revision(value: str, key: bytes, domain: str) -> str:
    return eval_hmac(f"{domain}:{value}", key)


def ordered_unique(values: list[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(value for value in values if value))


def identity_facets(text: str) -> tuple[str, ...]:
    """Non-temporal lexical terms; terms never stand in for obligations."""

    output: list[str] = []
    for value in tokenize(text):
        if (
            len(value) > 1
            and value not in STOPWORDS
            and value not in RELATIVE_WORDS
            and value not in MONTHS
            and value not in WEEKDAYS
        ):
            output.append(value)
    return ordered_unique(output)


def normalized_time_anchors(content: str, session_timestamp: str) -> tuple[TimeAnchor, ...]:
    """Retain normalized session, explicit, and relative anchors with provenance."""

    anchors = [TimeAnchor("session", session_timestamp, "session_timestamp")]
    lowered = content.casefold()
    for match in EXPLICIT_DATE.finditer(lowered):
        anchors.append(TimeAnchor("explicit", match.group(0), "turn_text"))
    for value in tokenize(lowered):
        if value in MONTHS or value in WEEKDAYS or ORDINAL.fullmatch(value):
            anchors.append(TimeAnchor("explicit", value, "turn_text"))
        elif value in RELATIVE_WORDS:
            anchors.append(TimeAnchor("relative", value, "turn_text"))
    unique = {(anchor.kind, anchor.normalized, anchor.provenance): anchor for anchor in anchors}
    return tuple(sorted(unique.values(), key=lambda item: (item.kind, item.normalized, item.provenance)))


def build_event_bundles(locked: list[TurnCandidate]) -> tuple[EventBundle, ...]:
    """Build full-source event records *before* any query or retrieval ranking."""

    by_source: dict[str, list[TurnCandidate]] = {}
    for candidate in locked:
        by_source.setdefault(candidate.source_id, []).append(candidate)
    bundles: list[EventBundle] = []
    for source_id, candidates in sorted(by_source.items()):
        ordered = sorted(candidates, key=lambda item: (item.turn_order, item.evidence_ref))
        records: list[EventRecord] = []
        for index, candidate in enumerate(ordered):
            facets = identity_facets(candidate.content)
            anchors = normalized_time_anchors(candidate.content, candidate.session_timestamp)
            adjacent: list[str] = []
            if index:
                adjacent.append(ordered[index - 1].evidence_ref)
            if index + 1 < len(ordered):
                adjacent.append(ordered[index + 1].evidence_ref)
            event_like = bool(EVENT_VERBS.search(candidate.content))
            has_non_session_anchor = any(anchor.kind != "session" for anchor in anchors)
            records.append(
                EventRecord(
                    event_id=sha256_text(
                        "event-record-v2:"
                        f"{candidate.source_id}:{candidate.session_timestamp}:{candidate.turn_order}"
                    ),
                    candidate=candidate,
                    lexical_facets=facets,
                    anchors=anchors,
                    membership_eligible=event_like or has_non_session_anchor,
                    count_support=bool(NUMBER.search(candidate.content)) or any(
                        value in {"most", "least", "twice", "double", "third", "fourth"}
                        for value in tokenize(candidate.content)
                    ),
                    adjacent_refs=tuple(adjacent),
                )
            )
        if records:
            bundles.append(EventBundle(source_id, records[0].candidate.session_timestamp, tuple(records)))
    return tuple(bundles)


def records_from_bundles(bundles: tuple[EventBundle, ...]) -> list[EventRecord]:
    return [record for bundle in bundles for record in bundle.records]


def explicit_collection_members(question: str) -> tuple[tuple[str, ...], ...]:
    """Extract an explicitly enumerated event collection, when grammar is safe.

    The fallback is deliberately empty: a generic collection still needs
    positive membership evidence, but we do not invent member descriptions.
    """

    candidate = ""
    if ":" in question:
        candidate = question.rsplit(":", 1)[1]
    else:
        match = re.search(
            r"\b(?:between|among)\s+(.+?)(?:\?|$)", question, re.IGNORECASE
        )
        if match is None:
            match = re.search(
                r"\b(?:order|first|latest)\b.{0,80}?\bof\s+(.+?)(?:\?|$)",
                question,
                re.IGNORECASE,
            )
        if match:
            candidate = match.group(1)
    if not candidate or not re.search(r"(?:,|;|\band\b)", candidate, re.IGNORECASE):
        return ()
    fragments = re.split(r"\s*(?:,|;|\band\b)\s*", candidate, flags=re.IGNORECASE)
    members = [identity_facets(fragment.strip(" .?")) for fragment in fragments]
    members = [member for member in members if member]
    return tuple(members) if len(members) >= 2 else ()


def obligations_for_plan(plan: TemporalPlan | None) -> tuple[Obligation, ...]:
    """Typed proof obligations; their kinds are independent of lexical terms."""

    if plan is None:
        return ()
    output: list[Obligation] = []
    for slot in plan.slots:
        terms = identity_facets(slot.query_mention)
        prefix = slot.slot_id
        output.append(Obligation(f"{prefix}:event_identity", prefix, "event_identity", terms))
        requires_anchor = plan.operator in {
            "duration_between", "elapsed_since", "order_events", "first_event",
            "latest_event", "count_before", "argmax_by_count",
        } or bool(normalized_time_anchors(slot.query_mention, "query") [1:])
        if requires_anchor:
            output.append(Obligation(f"{prefix}:temporal_anchor", prefix, "temporal_anchor", terms))
        if plan.operator == "duration_between":
            output.append(Obligation(f"{prefix}:relation_endpoint", prefix, "relation_endpoint", terms))
        if slot.role == "event_set":
            output.append(Obligation(f"{prefix}:collection_membership", prefix, "collection_membership", terms))
            for index, member_terms in enumerate(
                explicit_collection_members(slot.query_mention), start=1
            ):
                output.append(
                    Obligation(
                        f"{prefix}:collection_member:{index}",
                        prefix,
                        "collection_member",
                        member_terms,
                    )
                )
            if plan.operator in {"count_before", "argmax_by_count"}:
                output.append(Obligation(f"{prefix}:count_support", prefix, "count_support", terms))
        if plan.operator == "locate_event":
            output.append(Obligation(f"{prefix}:requested_attribute", prefix, "requested_attribute", terms))
    return tuple(output)


def record_supports(record: EventRecord, obligation: Obligation) -> bool:
    """A structural proof predicate; never consumes retrieval rank or labels."""

    identity = bool(set(record.lexical_facets) & set(obligation.terms))
    anchored = bool(record.anchors)
    if obligation.kind == "event_identity":
        return identity
    if obligation.kind == "temporal_anchor":
        return identity and anchored
    if obligation.kind == "relation_endpoint":
        return identity and anchored
    if obligation.kind == "collection_membership":
        return identity and anchored and record.membership_eligible
    if obligation.kind == "collection_member":
        return identity and anchored and record.membership_eligible
    if obligation.kind == "count_support":
        return identity and record.membership_eligible and record.count_support
    if obligation.kind == "requested_attribute":
        return identity
    raise ValueError("unknown temporal proof obligation")


def anchor_quality(record: EventRecord) -> int:
    kinds = {anchor.kind for anchor in record.anchors}
    return 3 if "explicit" in kinds else 2 if "relative" in kinds else 1 if "session" in kinds else 0


def ranked_event_records(
    question: str,
    records: list[EventRecord],
    top_k: int,
    reranker: Any | None,
    batch_size: int,
) -> tuple[list[EventRecord], dict[str, int]]:
    """Retrieval only: RRF rank never claims slot entailment or completeness."""

    candidates = [record.candidate for record in records]
    ranked_candidates = (
        rank_semantic_rrf(question, candidates, top_k, reranker, batch_size)
        if reranker is not None
        else rank_bm25(question, candidates, top_k)
    )
    by_ref = {record.candidate.evidence_ref: record for record in records}
    ranked = [by_ref[candidate.evidence_ref] for candidate in ranked_candidates]
    return ranked, {record.event_id: index for index, record in enumerate(ranked, start=1)}


def _slot_cap(slot: SlotSpec) -> int:
    return MAX_EVENT_SET_TURNS if slot.role == "event_set" else MAX_SLOT_TURNS


def _current_event_ids(selected: dict[str, list[EventRecord]], slot_id: str) -> set[str]:
    return {record.event_id for record in selected.get(slot_id, [])}


def _duration_other_slot(plan: TemporalPlan, slot_id: str) -> str | None:
    if plan.operator != "duration_between" or len(plan.slots) != 2:
        return None
    return next(slot.slot_id for slot in plan.slots if slot.slot_id != slot_id)


def _eligible_assignment(
    plan: TemporalPlan,
    slot: SlotSpec,
    record: EventRecord,
    selected: dict[str, list[EventRecord]],
) -> bool:
    if len(selected[slot.slot_id]) >= _slot_cap(slot):
        return False
    if record.event_id in _current_event_ids(selected, slot.slot_id):
        return False
    other = _duration_other_slot(plan, slot.slot_id)
    return other is None or record.event_id not in _current_event_ids(selected, other)


def _selection_key(
    newly_covered: set[str],
    slot: SlotSpec,
    record: EventRecord,
    selected: dict[str, list[EventRecord]],
    ranks: dict[str, int],
) -> tuple[int, int, int, int, int, int, str]:
    # Set-cover marginal comes first.  Event-set only then asks for source
    # diversity; retrieval rank is a deterministic tie break, not a proof.
    same_source = any(
        chosen.candidate.source_id == record.candidate.source_id
        for chosen in selected[slot.slot_id]
    )
    return (
        -len(newly_covered),
        int(slot.role == "event_set" and same_source),
        -anchor_quality(record),
        ranks[record.event_id],
        record.candidate.session_order,
        record.candidate.turn_order,
        record.candidate.evidence_ref,
    )


def _candidate_coverage(record: EventRecord, obligations: tuple[Obligation, ...]) -> set[str]:
    return {item.obligation_id for item in obligations if record_supports(record, item)}


def _add_event_set_competitors(
    plan: TemporalPlan,
    obligations: tuple[Obligation, ...],
    ranked: list[EventRecord],
    ranks: dict[str, int],
    selected: dict[str, list[EventRecord]],
) -> None:
    """First/order/latest require two distinct, anchor-comparable event IDs."""

    for slot in plan.slots:
        if slot.role != "event_set":
            continue
        slot_obligations = tuple(item for item in obligations if item.slot_id == slot.slot_id)
        while len(selected[slot.slot_id]) < 2:
            options = [
                record
                for record in ranked
                if _eligible_assignment(plan, slot, record, selected)
                and record_supports(
                    record,
                    next(item for item in slot_obligations if item.kind == "collection_membership"),
                )
            ]
            if not options:
                return
            chosen = min(
                options,
                key=lambda record: _selection_key(
                    {"collection_competitor"}, slot, record, selected, ranks
                ),
            )
            selected[slot.slot_id].append(chosen)


def _closure_records(
    plan: TemporalPlan,
    obligations: tuple[Obligation, ...],
    selected: dict[str, list[EventRecord]],
    all_records: list[EventRecord],
) -> None:
    """Only ordinary slots may close over immediate neighbours in their source."""

    by_ref = {record.candidate.evidence_ref: record for record in all_records}
    by_slot = {
        slot.slot_id: tuple(item for item in obligations if item.slot_id == slot.slot_id)
        for slot in plan.slots
    }
    for slot in plan.slots:
        if slot.role == "event_set":
            continue
        for primary in tuple(selected[slot.slot_id]):
            if len(selected[slot.slot_id]) >= _slot_cap(slot):
                break
            for reference in primary.adjacent_refs:
                adjacent = by_ref[reference]
                if not _eligible_assignment(plan, slot, adjacent, selected):
                    continue
                if adjacent.candidate.source_id != primary.candidate.source_id:
                    raise AssertionError("event closure crossed source boundary")
                if any(record_supports(adjacent, item) for item in by_slot[slot.slot_id]):
                    selected[slot.slot_id].append(adjacent)
                    if len(selected[slot.slot_id]) >= _slot_cap(slot):
                        break


def validate_packet(
    plan: TemporalPlan | None,
    obligations: tuple[Obligation, ...],
    selected: dict[str, list[EventRecord]],
) -> tuple[bool, list[str]]:
    """Revalidate all constraints after any global dedupe or trim."""

    if plan is None:
        return False, ["unsupported_plan"]
    unmet: list[str] = []
    for obligation in obligations:
        if not any(record_supports(record, obligation) for record in selected[obligation.slot_id]):
            unmet.append(obligation.kind)
    all_records = [record for slot in plan.slots for record in selected[slot.slot_id]]
    unique = {record.event_id for record in all_records}
    if len(unique) > MAX_PACKET_TURNS:
        unmet.append("packet_budget")
    for slot in plan.slots:
        records = selected[slot.slot_id]
        if len(records) > _slot_cap(slot):
            unmet.append("slot_budget")
        if slot.role == "event_set":
            members = [
                record
                for record in records
                if record.membership_eligible and any(record.anchors)
            ]
            if len({record.event_id for record in members}) < 2:
                unmet.append("collection_competitors")
            if len({record.candidate.source_id for record in members}) < 2:
                unmet.append("collection_sources")
            session_anchors = [
                anchor for record in members for anchor in record.anchors if anchor.kind == "session"
            ]
            if len(session_anchors) < 2:
                unmet.append("comparable_anchor")
    if plan.operator == "duration_between" and len(plan.slots) == 2:
        left = _current_event_ids(selected, plan.slots[0].slot_id)
        right = _current_event_ids(selected, plan.slots[1].slot_id)
        if not left or not right or left & right:
            unmet.append("distinct_duration_endpoints")
    return not unmet, sorted(set(unmet))


def global_trim_and_validate(
    plan: TemporalPlan | None,
    obligations: tuple[Obligation, ...],
    selected: dict[str, list[EventRecord]],
    ranks: dict[str, int],
) -> tuple[dict[str, list[EventRecord]], bool, list[str]]:
    """Globally cap records, then fail closed if the cap damaged a proof."""

    if plan is None:
        return selected, False, ["unsupported_plan"]
    occurrences: dict[str, tuple[EventRecord, set[str]]] = {}
    for slot in plan.slots:
        for record in selected[slot.slot_id]:
            covered = _candidate_coverage(
                record, tuple(item for item in obligations if item.slot_id == slot.slot_id)
            )
            current = occurrences.get(record.event_id)
            if current is None:
                occurrences[record.event_id] = (record, covered)
            else:
                occurrences[record.event_id] = (record, current[1] | covered)
    allowed = {
        event_id
        for event_id, (record, covered) in sorted(
            occurrences.items(),
            key=lambda item: (
                -len(item[1][1]), -anchor_quality(item[1][0]), ranks.get(item[0], 2**31),
                item[1][0].candidate.session_order, item[1][0].candidate.turn_order,
                item[1][0].candidate.evidence_ref,
            ),
        )[:MAX_PACKET_TURNS]
    }
    trimmed = {
        slot.slot_id: [record for record in selected[slot.slot_id] if record.event_id in allowed]
        for slot in plan.slots
    }
    complete, unmet = validate_packet(plan, obligations, trimmed)
    return trimmed, complete, unmet


def select_event_packet(
    plan: TemporalPlan | None,
    ranked: list[EventRecord],
    all_records: list[EventRecord],
    ranks: dict[str, int],
) -> tuple[dict[str, list[EventRecord]], bool, list[str], dict[tuple[str, str], str]]:
    """Marginal-uncovered-obligation set cover followed by structural checks."""

    if plan is None:
        return {}, False, ["unsupported_plan"], {}
    obligations = obligations_for_plan(plan)
    selected = {slot.slot_id: [] for slot in plan.slots}
    origins: dict[tuple[str, str], str] = {}
    pending = {item.obligation_id for item in obligations}
    while pending:
        choices: list[tuple[set[str], SlotSpec, EventRecord]] = []
        for slot in plan.slots:
            slot_obligations = tuple(item for item in obligations if item.slot_id == slot.slot_id)
            for record in ranked:
                if not _eligible_assignment(plan, slot, record, selected):
                    continue
                marginal = _candidate_coverage(record, slot_obligations) & pending
                if marginal:
                    choices.append((marginal, slot, record))
        if not choices:
            return selected, False, sorted(
                obligation.kind for obligation in obligations if obligation.obligation_id in pending
            ), origins
        marginal, slot, chosen = min(
            choices,
            key=lambda value: _selection_key(value[0], value[1], value[2], selected, ranks),
        )
        selected[slot.slot_id].append(chosen)
        origins[(slot.slot_id, chosen.event_id)] = "retrieval_frontier"
        pending -= marginal
    _add_event_set_competitors(plan, obligations, ranked, ranks, selected)
    _closure_records(plan, obligations, selected, all_records)
    for slot in plan.slots:
        for record in selected[slot.slot_id]:
            origins.setdefault((slot.slot_id, record.event_id), "source_bounded_closure")
    trimmed, complete, unmet = global_trim_and_validate(plan, obligations, selected, ranks)
    return trimmed, complete, unmet, origins


def content_free_certificate(
    plan: TemporalPlan,
    obligations: tuple[Obligation, ...],
    selected: dict[str, list[EventRecord]],
    ranks: dict[str, int],
    origins: dict[tuple[str, str], str],
    key: bytes,
) -> list[dict[str, Any]]:
    by_slot = {slot.slot_id: slot for slot in plan.slots}
    output: list[dict[str, Any]] = []
    for slot_id in sorted(by_slot):
        slot = by_slot[slot_id]
        slot_obligations = [item for item in obligations if item.slot_id == slot_id]
        output.append(
            {
                "slotId": slot_id,
                "role": slot.role,
                "queryMentionHmac": keyed_revision(slot.query_mention, key, "query-mention"),
                "obligationKinds": sorted(item.kind for item in slot_obligations),
                "obligationTermHmacs": {
                    item.kind: [keyed_revision(term, key, "obligation-term") for term in item.terms]
                    for item in slot_obligations
                },
                "events": [
                    {
                        "eventIdHmac": keyed_revision(record.event_id, key, "event-id"),
                        "evidenceRefHmac": hmac_ref(record.candidate.evidence_ref, key),
                        "sourceIdHmac": keyed_revision(record.candidate.source_id, key, "source-id"),
                        "sessionTimestampHmac": keyed_revision(record.candidate.session_timestamp, key, "session-timestamp"),
                        "sessionOrder": record.candidate.session_order,
                        "turnOrder": record.candidate.turn_order,
                        "retrievalRank": ranks.get(record.event_id),
                        "selectionOrigin": origins[(slot_id, record.event_id)],
                        "adjacentEvidenceRefHmacs": sorted(hmac_ref(value, key) for value in record.adjacent_refs),
                        "timeAnchors": [
                            {
                                "kind": anchor.kind,
                                "valueHmac": keyed_revision(anchor.normalized, key, "time-anchor"),
                                "provenance": anchor.provenance,
                            }
                            for anchor in record.anchors
                        ],
                    }
                    for record in selected[slot_id]
                ],
            }
        )
    return output


def assert_label_free(value: Any) -> None:
    """Checkpoint/selection artifacts must not carry evaluation fields."""

    forbidden = ("gold", "endpoint", "answercorrect", "residual", "category")
    if isinstance(value, dict):
        for name, child in value.items():
            if any(token in str(name).casefold() for token in forbidden):
                raise ValueError("label-free artifact contains an evaluation field")
            assert_label_free(child)
    elif isinstance(value, list):
        for child in value:
            assert_label_free(child)


def save_checkpoint(path: Path, policy: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    assert_label_free(rows)
    payload = {
        "schemaVersion": f"{SCHEMA_VERSION}:checkpoint",
        "contentFree": True,
        "policy": policy,
        "rows": sorted(rows, key=lambda row: str(row["queryHmac"])),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def load_checkpoint(path: Path, policy: dict[str, Any], targets: set[str]) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    payload = load_json(path)
    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion") != f"{SCHEMA_VERSION}:checkpoint"
        or payload.get("contentFree") is not True
        or payload.get("policy") != policy
        or not isinstance(payload.get("rows"), list)
    ):
        raise ValueError("checkpoint does not match this event-bundle run")
    assert_label_free(payload["rows"])
    rows = [row for row in payload["rows"] if isinstance(row, dict)]
    hmacs = [row.get("queryHmac") for row in rows]
    if any(not isinstance(value, str) or value not in targets for value in hmacs) or len(hmacs) != len(set(hmacs)):
        raise ValueError("checkpoint rows are invalid")
    return rows


def target_hmacs(baseline_rows: list[dict[str, Any]]) -> set[str]:
    """Only address fields are read from the baseline ledger."""

    values = {
        row["queryHmac"]
        for row in baseline_rows
        if isinstance(row.get("queryHmac"), str) and row["queryHmac"]
    }
    if not values:
        raise ValueError("baseline ledger contains no query HMACs")
    return values


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError as error:
        raise ValueError(f"required package version is unavailable: {name}") from error


def load_reranker(args: argparse.Namespace) -> tuple[Any | None, dict[str, Any]]:
    if not args.cross_encoder_id:
        if args.cross_encoder_revision or args.cross_encoder_path:
            raise ValueError("cross-encoder id and revision must be pinned together")
        return None, {"ranker": "label_blind_exact_turn_bm25_v1"}
    if not args.cross_encoder_revision:
        raise ValueError("cross-encoder revision is required")
    from sentence_transformers import CrossEncoder

    options: dict[str, Any] = {"device": args.cross_encoder_device, "max_length": args.cross_encoder_max_length}
    if not args.cross_encoder_path:
        options["revision"] = args.cross_encoder_revision
    reranker = CrossEncoder(args.cross_encoder_path or args.cross_encoder_id, **options)
    return reranker, {
        "ranker": "label_blind_exact_turn_bm25_cross_encoder_rrf_v1",
        "crossEncoderModel": args.cross_encoder_id,
        "crossEncoderRevision": args.cross_encoder_revision,
        "crossEncoderMaxLength": args.cross_encoder_max_length,
        "crossEncoderBatchSize": args.cross_encoder_batch_size,
        "crossEncoderArtifactSha256": sha256_tree(args.cross_encoder_path) if args.cross_encoder_path else None,
        "crossEncoderRuntimeVersions": {
            name: package_version(name) for name in ("sentence-transformers", "transformers", "torch")
        },
        "crossEncoderUse": "retrieval_rrf_only_not_slot_entailment",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--baseline-ledger", type=Path, nargs="+", required=True)
    parser.add_argument("--temporal-source-lane-log", type=Path, nargs="+", required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--top-k", type=int, default=48)
    parser.add_argument("--expected-target-count", type=int, default=DEFAULT_TARGET_COUNT)
    parser.add_argument("--expected-source-session-count", type=int, default=16)
    parser.add_argument("--cross-encoder-id", default="")
    parser.add_argument("--cross-encoder-revision", default="")
    parser.add_argument("--cross-encoder-path", type=Path)
    parser.add_argument("--cross-encoder-device", default="cuda")
    parser.add_argument("--cross-encoder-batch-size", type=int, default=64)
    parser.add_argument("--cross-encoder-max-length", type=int, default=512)
    args = parser.parse_args()
    if args.top_k != 48:
        raise ValueError("event-bundle selector requires the frozen top-48 frontier")
    if args.expected_target_count < 1 or args.expected_source_session_count < 1:
        raise ValueError("expected cardinality is invalid")
    if not 1 <= args.cross_encoder_batch_size <= 256 or not 64 <= args.cross_encoder_max_length <= 1024:
        raise ValueError("cross-encoder bounds are invalid")
    key = args.eval_hmac_key.read_bytes().strip()
    if not key:
        raise ValueError("evaluation HMAC key is empty")
    dataset = load_json(args.dataset)
    if not isinstance(dataset, list):
        raise ValueError("dataset is invalid")
    targets = target_hmacs(list(iter_sealed_rows(args.baseline_ledger)))
    if len(targets) != args.expected_target_count:
        raise ValueError("frozen ledger target count does not match policy")
    dataset_by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset if isinstance(item, dict)
    }
    if not targets.issubset(dataset_by_hmac):
        raise ValueError("target ledger rows cannot bind to pinned dataset")
    source_by_query = load_temporal_source_lane_sources(args.temporal_source_lane_log)
    reranker, ranker_policy = load_reranker(args)
    policy = {
        "candidatePolicy": {
            "sourceBoundary": "read_only_temporal_source_lane_lock",
            "role": "user_only",
            "topK": 48,
            "usesBenchmarkHasAnswerBeforeSelection": False,
            **ranker_policy,
        },
        "selectorPolicy": {
            "version": SELECTOR_VERSION,
            "buildBeforeRetrieval": "full_locked_user_turns_to_source_bounded_event_bundles",
            "compiler": "paw.temporal-question-compiler.v1",
            "selection": "marginal_uncovered_typed_obligation_set_cover_v2",
            "ordinarySlotMaxTurns": MAX_SLOT_TURNS,
            "eventSetMaxTurns": MAX_EVENT_SET_TURNS,
            "packetMaxTurns": MAX_PACKET_TURNS,
            "eventSetConstraints": "two_distinct_event_ids_and_comparable_session_anchors",
            "durationConstraint": "distinct_event_ids_for_E1_E2",
            "packetStatus": "facet_complete_or_insufficient",
            "answerPathChanged": False,
        },
        "artifactPolicy": {
            "datasetSha256": sha256_file(args.dataset),
            "baselineLedgerSha256s": sorted(sha256_file(path) for path in args.baseline_ledger),
            "sourceLockLogSha256s": sorted(sha256_file(path) for path in args.temporal_source_lane_log),
            "producerCodeSha256": sha256_file(Path(__file__)),
            "compilerCodeSha256": sha256_file(Path(__file__).with_name("temporal_event_slot_shadow.py")),
            "sourceLockCodeSha256": sha256_file(Path(__file__).with_name("temporal_event_ledger_shadow.py")),
            "hmacKeyId": keyed_revision("paw.temporal.v1", key, "key-id"),
        },
        "targetScope": "ledger",
        "targetQueryHmacs": sorted(targets),
    }
    checkpoint = args.checkpoint or args.output.with_suffix(args.output.suffix + ".checkpoint.json")
    rows = load_checkpoint(checkpoint, policy, targets)
    completed = {str(row["queryHmac"]) for row in rows}
    for index, query_hmac in enumerate(sorted(targets), start=1):
        if query_hmac in completed:
            print(f"resumed {index}/{len(targets)}", flush=True)
            continue
        item = dataset_by_hmac[query_hmac]
        question = required_string(item, "question")
        cutoff = timestamp(required_string(item, "question_date"))
        if cutoff is None:
            raise ValueError("query cutoff is invalid")
        source_hashes = source_by_query.get(sha256_text(question), set())
        if len(source_hashes) != args.expected_source_session_count:
            raise ValueError("frozen source session count does not match policy")
        locked = enumerate_locked_user_turns(item, source_hashes)
        bundles = build_event_bundles(locked)
        all_records = records_from_bundles(bundles)
        ranked, ranks = ranked_event_records(question, all_records, 48, reranker, args.cross_encoder_batch_size)
        plan = compile_question_plan(question)
        selected, complete, unmet, origins = select_event_packet(plan, ranked, all_records, ranks)
        obligations = obligations_for_plan(plan)
        certificate = content_free_certificate(plan, obligations, selected, ranks, origins, key) if complete and plan else []
        row = {
            "queryHmac": query_hmac,
            "queryCutoffHmac": keyed_revision(cutoff, key, "query-cutoff"),
            "sourceLockRevisionHmac": keyed_revision(json.dumps(sorted(source_hashes)), key, "source-lock"),
            "lockedSourceSessionCount": len(source_hashes),
            "lockedUserTurnCount": len(locked),
            "rankedCandidateCount": len(ranked),
            "rankedCandidateSetRevisionHmac": keyed_revision(json.dumps([record.candidate.evidence_ref for record in ranked]), key, "ranked-candidate-set"),
            "planStatus": "compiled" if plan is not None else "unsupported",
            "planOperator": plan.operator if plan is not None else None,
            "packetStatus": "facet_complete" if complete else "insufficient",
            "unmetObligationKinds": [] if complete else unmet,
            "facetCertificate": certificate,
            "selectedEvidenceRefHmacs": sorted(
                {
                    hmac_ref(record.candidate.evidence_ref, key)
                    for slot_records in selected.values()
                    for record in slot_records
                }
            ) if complete else [],
        }
        assert_label_free(row)
        rows.append(row)
        save_checkpoint(checkpoint, policy, rows)
        print(f"completed {index}/{len(targets)}", flush=True)
    rows.sort(key=lambda row: str(row["queryHmac"]))
    output = {
        "schemaVersion": SCHEMA_VERSION,
        "contentFree": True,
        "diagnosticOnly": True,
        "answerPathChanged": False,
        **policy,
        "rows": rows,
        "metrics": {
            "targetCount": len(rows),
            "compiledCount": sum(row["planStatus"] == "compiled" for row in rows),
            "facetCompleteCount": sum(row["packetStatus"] == "facet_complete" for row in rows),
            "insufficientCount": sum(row["packetStatus"] == "insufficient" for row in rows),
        },
    }
    assert_label_free(output["rows"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
