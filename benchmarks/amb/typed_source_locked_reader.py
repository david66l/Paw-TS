"""Query-only reader routing over immutable retrieved LongMemEval sources.

The retrieval layer owns the source aperture.  This module may re-render only
documents already returned by that aperture; it never searches, expands, or
consults evaluation annotations.  Invalid source locks and malformed authority
certificates fail hard; only an explicitly unowned, uncertified dialogue stays
on the original reader packet.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any, Iterable, Mapping

try:
    from .multi_session_set_plan import Operator, SetPlan, compile_set_plan
    from .multi_session_evidence_set_protocol import (
        complete_evidence_set_protocol,
    )
    from .temporal_event_ledger_shadow import timestamp
except ImportError:
    from multi_session_set_plan import Operator, SetPlan, compile_set_plan  # type: ignore[no-redef]
    from multi_session_evidence_set_protocol import (  # type: ignore[no-redef]
        complete_evidence_set_protocol,
    )
    from temporal_event_ledger_shadow import timestamp  # type: ignore[no-redef]


ROUTER_POLICY = "paw.typed-source-locked-reader.v7:canonical-pair-proof-lineage"

MAX_DIALOGUE_PAIR_LINEAGE_REVISIONS = 16


class SourceLockInvariantError(RuntimeError):
    """The frozen retrieval aperture cannot be proven safe to materialize."""


class CertificateInvariantError(RuntimeError):
    """Core-issued dialogue authority does not bind this exact reader packet."""

ASSISTANT_DIALOGUE_PROTOCOL = """Paw prior-dialogue artifact protocol:
- The supplied blocks are exact turns from already-retrieved prior sessions.
- Preserve authorship: USER is the earlier request or statement; ASSISTANT is the earlier response. Never answer an assistant-artifact question with only the user's prompt.
- Bind the requested artifact to the exact adjacent dialogue pair. Topic similarity alone does not transfer authorship between turns or sessions.
- Scan every supplied session, then return the requested prior answer, wording, recommendation, list, or other dialogue artifact directly.
- If no supplied ASSISTANT turn answers the request, say only that the locked memory is insufficient. Never invent a missing prior response.

"""

SHARED_DIALOGUE_PROTOCOL = """Paw shared-dialogue artifact protocol:
- The supplied role-labelled turns are authorized shared dialogue artifacts from the frozen packet only.
- Preserve both authors and resolve the requested shared artifact only from an explicitly supported dialogue pair.
- Do not promote a USER statement into an ASSISTANT action, or an ASSISTANT response into a user preference.

"""

UNOWNED_DIALOGUE_PROTOCOL = """Paw certified-dialogue artifact protocol:
- The supplied role-labelled turns are limited to the certificate's exact authorized source scope.
- Preserve authorship and answer only an explicitly supported shared dialogue artifact; never infer that either participant owns an unstated claim.

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
    authority: str = ""
    locked_source_count: int = 0
    source_lock_digest: str | None = None
    packet_hash: str | None = None
    protocol_hash: str | None = None
    certificate_revision: str | None = None
    rendered_chars: int = 0


@dataclass(frozen=True)
class CertificateScope:
    source_ids: tuple[str, ...]
    authorized_items: tuple["AuthorizedItem", ...]
    authorized_pairs: tuple["AuthorizedPair", ...]
    revision: str


@dataclass(frozen=True)
class AuthorizedItem:
    source_id: str
    evidence_ref: str
    turn_order: int
    evidence_use: str


@dataclass(frozen=True)
class AuthorizedPair:
    source_id: str
    assistant_ref: str
    assistant_hash: str
    assistant_order: int
    predecessor_ref: str
    predecessor_hash: str
    predecessor_order: int
    cutoff: str
    lineage_revisions: tuple[str, ...]


def _public_plan(plan: SetPlan) -> dict[str, Any]:
    payload = asdict(plan)
    return {
        key: value.value if hasattr(value, "value") else value
        for key, value in payload.items()
    }


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_json(value: object) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def _instant(value: str) -> datetime | None:
    normalized = timestamp(value)
    if normalized is None:
        return None
    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:  # pragma: no cover - timestamp already parsed it
        return None


def _authority(raw: Mapping[str, Any] | None) -> str:
    return str(raw.get("evidenceFirstQueryAnswerOriginKind", "")) if raw else ""


def _set_route(question: str) -> SetPlan | None:
    plan = compile_set_plan(question)
    if plan is None:
        return None
    if plan.operator is Operator.LOOKUP:
        return None
    if not plan.exhaustive_set_required and plan.arity < 2:
        return None
    return plan


def _turns(document: object) -> tuple[tuple[str, str], ...]:
    return tuple((role, text.strip()) for role, text in _raw_turns(document))


def _raw_turns(document: object) -> tuple[tuple[str, str], ...]:
    content = getattr(document, "content", None)
    if not isinstance(content, str):
        raise SourceLockInvariantError("source content is not text")
    try:
        value = json.loads(content)
    except json.JSONDecodeError as error:
        raise SourceLockInvariantError("source content is malformed JSON") from error
    if not isinstance(value, list) or not value:
        raise SourceLockInvariantError("source content is not a dialogue session")
    output: list[tuple[str, str]] = []
    for turn in value:
        if not isinstance(turn, dict) or turn.get("role") not in {"user", "assistant"}:
            raise SourceLockInvariantError("source dialogue role is invalid")
        text = turn.get("content")
        if not isinstance(text, str) or not text.strip():
            raise SourceLockInvariantError("source dialogue content is invalid")
        output.append((turn["role"], text))
    return tuple(output)


def _locked_documents(
    recalled: Iterable[object],
    documents_by_id: Mapping[str, object],
    query_timestamp: str | None,
) -> tuple[tuple[object, int], ...]:
    cutoff = _instant(query_timestamp) if isinstance(query_timestamp, str) else None
    if cutoff is None:
        raise ValueError("query cutoff is unavailable")
    selected: list[tuple[object, int]] = []
    seen: set[str] = set()
    for rank, recalled_document in enumerate(recalled, start=1):
        source_id = getattr(recalled_document, "id", None)
        if not isinstance(source_id, str):
            raise SourceLockInvariantError("source lock has an invalid source identifier")
        if source_id in seen:
            raise SourceLockInvariantError("source lock has a duplicate source identifier")
        source = documents_by_id.get(source_id)
        if source is None:
            raise SourceLockInvariantError("source lock source is missing from canonical documents")
        observed = getattr(source, "timestamp", None)
        observed_at = _instant(observed) if isinstance(observed, str) else None
        if observed_at is None or observed_at > cutoff:
            raise SourceLockInvariantError("source lock contains an invalid or post-cutoff source")
        # Validate every canonical dialogue before any route, including legacy.
        # Otherwise an ordinary lookup could bypass malformed-role/session gates.
        _turns(source)
        seen.add(source_id)
        selected.append((source, rank))
    if not selected:
        raise SourceLockInvariantError("source lock has no immutable source documents")
    return tuple(selected)


def _certificate_sources(
    *,
    raw: Mapping[str, Any] | None,
    question: str,
    cutoff: str,
    recalled: tuple[object, ...],
) -> CertificateScope | None:
    """Validate the core source lock and its final presentation envelope.

    The bridge can legitimately replace core source documents with a certified
    presentation document.  The certificate therefore binds both layers:
    ``sourceLockIds`` select immutable canonical sessions, while
    ``readerDocumentIds`` must exactly match the documents returned to the
    benchmark runner.  Canonical sessions are hydrated only after the router
    decides that a specialized reader actually needs them.
    """
    authority = _authority(raw)
    certificate = raw.get("evidenceFirstDialogueMaterializationCertificate") if raw else None
    named_authority = authority in {"explicit_assistant", "explicit_shared"}
    if certificate is None and not named_authority:
        return None
    if not isinstance(certificate, Mapping):
        raise CertificateInvariantError("dialogue authority certificate is missing")
    identity = {key: certificate.get(key) for key in (
        "schema", "policy", "queryHash", "originKind", "originRevision", "queryCutoff",
        "sourceLockIds", "sourceLockDigest", "authorizedItems", "authorizedPairContext", "resolutionRevision",
        "readerDocumentIds", "readerDocumentDigest", "readerPacketDigest",
    )}
    if set(certificate) != {*identity, "certificateRevision"}:
        raise CertificateInvariantError("certificate fields are invalid")
    if (identity["schema"] != "paw.dialogue-materialization-certificate.v5"
            or identity["policy"] != "paw.core-final-packet-authority.v5:canonical-pair-proof-lineage"):
        raise CertificateInvariantError("certificate schema or policy is invalid")
    if identity["queryHash"] != _sha(question) or identity["originKind"] != authority:
        raise CertificateInvariantError("certificate query or authority binding is invalid")
    hexadecimal = re.compile(r"^[0-9a-f]{64}$")
    if (not isinstance(identity["originRevision"], str)
            or not hexadecimal.fullmatch(identity["originRevision"])
            or identity["originRevision"] != (raw.get("evidenceFirstQueryAnswerOriginRevision") if raw else None)
            or not isinstance(identity["resolutionRevision"], str)
            or not hexadecimal.fullmatch(identity["resolutionRevision"])
            or not isinstance(certificate.get("certificateRevision"), str)
            or not hexadecimal.fullmatch(certificate["certificateRevision"])):
        raise CertificateInvariantError("certificate origin revision is invalid")
    certificate_cutoff = identity["queryCutoff"]
    if not isinstance(certificate_cutoff, str) or timestamp(certificate_cutoff) != cutoff:
        raise CertificateInvariantError("certificate cutoff is invalid")
    ids = identity["sourceLockIds"]
    if (not isinstance(ids, list)
            or any(not isinstance(source_id, str) or not source_id for source_id in ids)
            or len(set(ids)) != len(ids)):
        raise CertificateInvariantError("certificate source lock is invalid")
    if identity["sourceLockDigest"] != _sha(_canonical_json(ids)):
        raise CertificateInvariantError("certificate source lock digest is invalid")
    reader_ids = identity["readerDocumentIds"]
    actual_reader_ids = [getattr(source, "id", None) for source in recalled]
    actual_reader_packet = [
        {
            "id": getattr(source, "id", None),
            "contentHash": _sha(getattr(source, "content", "")),
        }
        for source in recalled
        if isinstance(getattr(source, "content", None), str)
    ]
    if (not isinstance(reader_ids, list)
            or any(not isinstance(source_id, str) or not source_id for source_id in reader_ids)
            or len(set(reader_ids)) != len(reader_ids)
            or reader_ids != actual_reader_ids
            or len(actual_reader_packet) != len(recalled)
            or identity["readerDocumentDigest"] != _sha(_canonical_json(reader_ids))
            or identity["readerPacketDigest"] != _sha(_canonical_json(actual_reader_packet))):
        raise CertificateInvariantError("certificate reader document lock is invalid")
    if certificate.get("certificateRevision") != _sha(_canonical_json(identity)):
        raise CertificateInvariantError("certificate revision is invalid")
    authorized = identity["authorizedItems"]
    if not isinstance(authorized, list):
        raise CertificateInvariantError("certificate authorized items are invalid")
    authorized_items: list[AuthorizedItem] = []
    seen_refs: set[str] = set()
    for item in authorized:
        if not isinstance(item, Mapping) or set(item) != {
            "sourceId",
            "evidenceRef",
            "turnOrder",
            "evidenceUse",
            "allowedModes",
        }:
            raise CertificateInvariantError("certificate authorization entry is invalid")
        source_id = item["sourceId"]
        evidence_ref = item["evidenceRef"]
        turn_order = item["turnOrder"]
        evidence_use = item["evidenceUse"]
        modes = item["allowedModes"]
        match = (
            re.fullmatch(r"(.+)#source-(\d+)", evidence_ref)
            if isinstance(evidence_ref, str)
            else None
        )
        if (not isinstance(source_id, str) or source_id not in ids
                or match is None or match.group(1) != source_id
                or not isinstance(turn_order, int) or isinstance(turn_order, bool)
                or turn_order < 1 or int(match.group(2)) != turn_order
                or evidence_ref in seen_refs
                or evidence_use not in {"assistant_report", "shared_dialogue_artifact"}
                or (authority == "explicit_assistant" and evidence_use != "assistant_report")
                or modes != ["dialogue_materialization"]):
            raise CertificateInvariantError("certificate authorization scope is invalid")
        seen_refs.add(evidence_ref)
        authorized_items.append(
            AuthorizedItem(source_id, evidence_ref, turn_order, evidence_use)
        )
    pairs = identity["authorizedPairContext"]
    if not isinstance(pairs, list):
        raise CertificateInvariantError("certificate pair context is invalid")
    authorized_pairs: list[AuthorizedPair] = []
    seen_pair_assistants: set[str] = set()
    seen_lineage_revisions: set[str] = set()
    for pair in pairs:
        if not isinstance(pair, Mapping) or set(pair) != {
            "sourceId", "assistantEvidenceRef", "assistantContentHash", "assistantTurnOrder",
            "assistantRole", "predecessorEvidenceRef", "predecessorContentHash", "predecessorTurnOrder",
            "predecessorRole", "relation", "allowedModes", "evidenceTimeUpperBound", "verifierVersion", "verificationRevision",
            "dialogueCertificateRevisions",
        }:
            raise CertificateInvariantError("certificate pair context fields are invalid")
        source_id = pair["sourceId"]
        assistant_ref = pair["assistantEvidenceRef"]
        predecessor_ref = pair["predecessorEvidenceRef"]
        assistant_order = pair["assistantTurnOrder"]
        predecessor_order = pair["predecessorTurnOrder"]
        assistant_match = re.fullmatch(r"(.+)#source-(\d+)", assistant_ref) if isinstance(assistant_ref, str) else None
        predecessor_match = re.fullmatch(r"(.+)#source-(\d+)", predecessor_ref) if isinstance(predecessor_ref, str) else None
        hashes = (pair["assistantContentHash"], pair["predecessorContentHash"], pair["verificationRevision"])
        lineage_revisions = pair["dialogueCertificateRevisions"]
        if (not isinstance(source_id, str) or source_id not in ids
                or assistant_match is None or predecessor_match is None
                or assistant_match.group(1) != source_id or predecessor_match.group(1) != source_id
                or not isinstance(assistant_order, int) or isinstance(assistant_order, bool)
                or not isinstance(predecessor_order, int) or isinstance(predecessor_order, bool)
                or assistant_order < 2 or predecessor_order < 1
                or int(assistant_match.group(2)) != assistant_order
                or int(predecessor_match.group(2)) != predecessor_order
                or assistant_order != predecessor_order + 1
                or pair["assistantRole"] != "assistant_output" or pair["predecessorRole"] != "user_input"
                or pair["relation"] != "immediate_predecessor" or pair["allowedModes"] != ["dialogue_pair_context"]
                or not isinstance(pair["evidenceTimeUpperBound"], str)
                or timestamp(pair["evidenceTimeUpperBound"]) != cutoff
                or not isinstance(pair["verifierVersion"], str) or not pair["verifierVersion"]
                or any(not isinstance(value, str) or not hexadecimal.fullmatch(value) for value in hashes)
                or not isinstance(lineage_revisions, list)
                or not 1 <= len(lineage_revisions) <= MAX_DIALOGUE_PAIR_LINEAGE_REVISIONS
                or any(not isinstance(value, str) or not hexadecimal.fullmatch(value) for value in lineage_revisions)
                or lineage_revisions != sorted(lineage_revisions)
                or len(set(lineage_revisions)) != len(lineage_revisions)
                or any(value in seen_lineage_revisions for value in lineage_revisions)
                or assistant_ref in seen_pair_assistants):
            raise CertificateInvariantError("certificate pair context is invalid")
        seen_pair_assistants.add(assistant_ref)
        seen_lineage_revisions.update(lineage_revisions)
        authorized_pairs.append(AuthorizedPair(source_id, assistant_ref, pair["assistantContentHash"], assistant_order, predecessor_ref, pair["predecessorContentHash"], predecessor_order, cutoff, tuple(lineage_revisions)))
    if (len(authorized_pairs) > len(authorized_items)
            or not seen_pair_assistants.issubset(seen_refs)):
        raise CertificateInvariantError("certificate pair context is orphaned")
    return CertificateScope(
        tuple(ids), tuple(authorized_items), tuple(authorized_pairs), certificate["certificateRevision"]
    )


def _render(
    sources: tuple[tuple[object, int], ...],
    *,
    user_only: bool,
    query_timestamp: str,
    set_mode: bool,
    allowed_turns: Mapping[str, frozenset[int]] | None = None,
) -> tuple[str, int]:
    chronological = sorted(
        sources,
        key=lambda item: (
            _instant(getattr(item[0], "timestamp", ""))
            or datetime.max.replace(tzinfo=timezone.utc),
            item[1],
        ),
    )
    blocks: list[str] = []
    turn_count = 0
    for session_index, (source, source_rank) in enumerate(chronological, start=1):
        source_turns = _turns(source)
        rendered: list[str] = []
        for turn_index, (role, text) in enumerate(source_turns, start=1):
            source_id = getattr(source, "id", "")
            if allowed_turns is not None and turn_index not in allowed_turns.get(
                source_id, frozenset()
            ):
                continue
            if user_only and role != "user":
                continue
            rendered.append(
                f"[S{session_index:02d}T{turn_index:02d}] {role.upper()}: {text}"
            )
            turn_count += 1
        if rendered:
            observed = timestamp(getattr(source, "timestamp", ""))
            header = (
                f"[Session S{session_index:02d}; source rank R{source_rank:02d}; "
                f"observed {observed}]"
                if set_mode
                else f"[Session S{session_index:02d}; observed {observed}]"
            )
            blocks.append(header + "\n" + "\n".join(rendered))
    if not blocks or turn_count == 0:
        raise SourceLockInvariantError("source lock rendered no eligible dialogue turns")
    context = "\n\n".join(blocks)
    if set_mode:
        context = f"[Query cutoff {timestamp(query_timestamp) or query_timestamp}]\n\n{context}"
    return context, turn_count


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

    cutoff = timestamp(query_timestamp) if isinstance(query_timestamp, str) else None
    if cutoff is None:
        raise SourceLockInvariantError("query cutoff is unavailable")
    authority = _authority(raw)
    plan = _set_route(question)
    recalled_documents = tuple(recalled)
    certificate_scope = _certificate_sources(
        raw=raw,
        question=question,
        cutoff=cutoff,
        recalled=recalled_documents,
    )
    assistant = authority == "explicit_assistant"
    shared = authority == "explicit_shared"
    unowned = authority == "dialogue_artifact_unowned"
    certificate_revision = (
        certificate_scope.revision if certificate_scope is not None else None
    )
    if certificate_scope is not None:
        locked_ids = certificate_scope.source_ids
        locked_source_count = len(locked_ids)
        source_lock_digest = _sha(_canonical_json(list(locked_ids)))
    else:
        locked_ids = ()
        locked_source_count = len(recalled_documents)
        source_lock_digest = None

    def legacy_execution() -> ReaderExecution:
        return ReaderExecution(
            "legacy",
            legacy_context,
            "",
            0,
            0,
            None,
            None,
            authority=authority,
            locked_source_count=locked_source_count,
            source_lock_digest=source_lock_digest,
            packet_hash=_sha(legacy_context),
            certificate_revision=certificate_revision,
            rendered_chars=len(legacy_context),
        )

    # An empty valid authorization is a safe negative result, not a corrupt
    # certificate and never permission to widen back to the full packet.
    if certificate_scope is not None and (assistant or shared):
        if not certificate_scope.authorized_items:
            protocol = (
                ASSISTANT_DIALOGUE_PROTOCOL if assistant else SHARED_DIALOGUE_PROTOCOL
            )
            context = "[No source in the frozen packet is authorized for this dialogue artifact.]"
            return ReaderExecution(
                "assistant_dialogue_insufficient"
                if assistant
                else "shared_dialogue_insufficient",
                context,
                protocol,
                0,
                0,
                None,
                "empty_authorized_source_scope",
                authority=authority,
                locked_source_count=locked_source_count,
                source_lock_digest=source_lock_digest,
                packet_hash=_sha(context),
                protocol_hash=_sha(protocol),
                certificate_revision=certificate_revision,
                rendered_chars=len(context),
            )
    if unowned and (
        certificate_scope is None or not certificate_scope.authorized_items
    ):
        if certificate_scope is None and recalled_documents:
            sources = _locked_documents(
                recalled_documents, documents_by_id, cutoff
            )
            locked_source_count = len(sources)
            source_lock_digest = _sha(
                _canonical_json(
                    [getattr(source, "id") for source, _ in sources]
                )
            )
        return legacy_execution()

    route = (
        "assistant_dialogue_set"
        if assistant and plan is not None
        else "assistant_dialogue"
        if assistant
        else "shared_dialogue_set"
        if shared and plan is not None
        else "shared_dialogue"
        if shared
        else "unowned_dialogue_set"
        if unowned and plan is not None
        else "unowned_dialogue"
        if unowned
        else "evidence_set"
        if plan is not None
        else "legacy"
    )
    if route == "legacy":
        # A valid v3 envelope already binds the exact presentation packet.  A
        # legacy reader consumes that presentation as-is; it must not try to
        # parse a synthetic projection as a canonical dialogue session.
        if certificate_scope is None and recalled_documents:
            sources = _locked_documents(
                recalled_documents, documents_by_id, cutoff
            )
            locked_source_count = len(sources)
            source_lock_digest = _sha(
                _canonical_json(
                    [getattr(source, "id") for source, _ in sources]
                )
            )
        return legacy_execution()

    if certificate_scope is not None:
        canonical_recalled = tuple(
            documents_by_id.get(source_id)
            for source_id in certificate_scope.source_ids
        )
        if any(source is None for source in canonical_recalled):
            raise SourceLockInvariantError(
                "certificate source is missing from canonical documents"
            )
        sources = (
            _locked_documents(canonical_recalled, documents_by_id, cutoff)
            if canonical_recalled
            else ()
        )
        if [getattr(source, "id", None) for source, _ in sources] != list(
            certificate_scope.source_ids
        ):
            raise SourceLockInvariantError(
                "certificate source lock order changed during hydration"
            )
    else:
        sources = (
            _locked_documents(recalled_documents, documents_by_id, cutoff)
            if recalled_documents
            else ()
        )
        locked_source_count = len(sources)
        source_lock_digest = _sha(
            _canonical_json([getattr(source, "id") for source, _ in sources])
        )
    allowed_turns: dict[str, frozenset[int]] | None = None
    if certificate_scope is not None and (assistant or shared or unowned):
        authorized = {
            item.source_id for item in certificate_scope.authorized_items
        }
        sources = tuple(
            item for item in sources if getattr(item[0], "id", None) in authorized
        )
        mutable_allowed_turns: dict[str, set[int]] = {}
        sources_by_id = {
            getattr(source, "id", ""): source for source, _ in sources
        }
        pairs_by_assistant = {
            pair.assistant_ref: pair for pair in certificate_scope.authorized_pairs
        }
        assistant_item_refs: set[str] = set()
        for item in certificate_scope.authorized_items:
            source = sources_by_id.get(item.source_id)
            if source is None:
                raise SourceLockInvariantError(
                    "authorized item source is missing from the core source lock"
                )
            turns = _turns(source)
            if item.turn_order > len(turns):
                raise CertificateInvariantError(
                    "authorized item turn is outside the canonical dialogue"
                )
            role = turns[item.turn_order - 1][0]
            if item.evidence_use == "assistant_report" and role != "assistant":
                raise CertificateInvariantError(
                    "assistant report does not bind an assistant turn"
                )
            selected = mutable_allowed_turns.setdefault(item.source_id, set())
            selected.add(item.turn_order)
            if role == "assistant":
                assistant_item_refs.add(item.evidence_ref)
                pair = pairs_by_assistant.get(item.evidence_ref)
                if pair is None:
                    raise CertificateInvariantError(
                        "authorized assistant turn has no core pair proof"
                    )
                raw_turns = _raw_turns(source)
                if (pair.source_id != item.source_id
                        or pair.assistant_order != item.turn_order
                        or pair.predecessor_order != item.turn_order - 1
                        or turns[pair.assistant_order - 1][0] != "assistant"
                        or turns[pair.predecessor_order - 1][0] != "user"
                        or _sha(raw_turns[pair.assistant_order - 1][1]) != pair.assistant_hash
                        or _sha(raw_turns[pair.predecessor_order - 1][1]) != pair.predecessor_hash):
                    raise CertificateInvariantError("authorized pair proof does not match canonical dialogue")
                selected.add(pair.predecessor_order)
        if set(pairs_by_assistant) != assistant_item_refs:
            raise CertificateInvariantError("certificate pair context is not exact")
        allowed_turns = {
            source_id: frozenset(turn_orders)
            for source_id, turn_orders in mutable_allowed_turns.items()
        }
    if not sources:
        protocol = (
            complete_evidence_set_protocol(
                _public_plan(plan),
                question,
                role_authority="dialogue"
                if (assistant or shared or unowned)
                else "user",
            )
            if plan is not None
            else ""
        )
        context = "[The frozen source lock contains no eligible evidence.]"
        return ReaderExecution(
            f"{route}_insufficient",
            context,
            protocol,
            0,
            0,
            _public_plan(plan) if plan is not None else None,
            "empty_source_lock",
            authority=authority,
            locked_source_count=locked_source_count,
            source_lock_digest=source_lock_digest,
            packet_hash=_sha(context),
            protocol_hash=_sha(protocol) if protocol else None,
            certificate_revision=certificate_revision,
            rendered_chars=len(context),
        )
    context, turn_count = _render(
        sources,
        user_only=route == "evidence_set",
        query_timestamp=cutoff,
        set_mode=plan is not None,
        allowed_turns=allowed_turns,
    )
    public_plan = _public_plan(plan) if plan is not None else None
    protocol = (
        ASSISTANT_DIALOGUE_PROTOCOL
        if assistant
        else SHARED_DIALOGUE_PROTOCOL
        if shared
        else UNOWNED_DIALOGUE_PROTOCOL
        if unowned
        else ""
    ) + (
        complete_evidence_set_protocol(
            public_plan,
            question,
            role_authority="dialogue" if (assistant or shared or unowned) else "user",
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
        authority=authority,
        locked_source_count=locked_source_count,
        source_lock_digest=source_lock_digest,
        packet_hash=_sha(context),
        protocol_hash=_sha(protocol) if protocol else None,
        certificate_revision=certificate_revision,
        rendered_chars=len(context),
    )
