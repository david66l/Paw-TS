"""Fail-closed reader for frozen preference user-authority projections.

This reader is deliberately label-free.  It reconstructs only the certified
user-authored session projection from the pinned dataset and renders it as a
compact raw-memory block for a standalone evaluation harness.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .preference_user_authority_shadow import (
        SCHEMA_VERSION,
        assert_label_free,
        hydrate_user_turns,
        keyed_revision,
        sha256_file,
        user_only_sessions,
    )
    from .temporal_event_ledger_shadow import eval_hmac, hmac_ref, load_json, required_string, timestamp
except ImportError:
    from preference_user_authority_shadow import (  # type: ignore[no-redef]
        SCHEMA_VERSION,
        assert_label_free,
        hydrate_user_turns,
        keyed_revision,
        sha256_file,
        user_only_sessions,
    )
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        timestamp,
    )


READER_POLICY = "paw.preference-user-authority-reader.v1"
RULE = (
    "Use relevant user statements jointly to identify explicit likes or dislikes, comparisons, "
    "goals, constraints, prior attempts and effects, and novelty; preserve entity-attribute "
    "relations, treat requests to branch out or avoid something as negative constraints, ignore "
    "unrelated sessions, and never turn one experience into a permanent preference."
)


@dataclass(frozen=True)
class ReaderPacket:
    query_hmac: str
    packet_revision_hmac: str
    context: str
    evidence_ref_hmacs: tuple[str, ...]
    rendered_context_chars: int
    context_chars: int
    source_count: int


def _required_dict(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(message)
    return value


def validate_selection_artifact(selection: dict[str, Any], dataset_path: Path, key: bytes) -> dict[str, dict[str, Any]]:
    """Verify immutable selection bindings before looking at raw history."""

    if selection.get("schemaVersion") != SCHEMA_VERSION or selection.get("contentFree") is not True:
        raise ValueError("selection schema is invalid")
    policy = _required_dict(selection.get("policy"), "selection policy is invalid")
    artifacts = _required_dict(policy.get("artifactPolicy"), "selection artifact policy is invalid")
    if artifacts.get("datasetSha256") != sha256_file(dataset_path):
        raise ValueError("selection dataset binding is invalid")
    if artifacts.get("hmacKeyId") != keyed_revision("paw.preference.authority.v1", key, "key-id"):
        raise ValueError("selection HMAC key binding is invalid")
    source_policy = _required_dict(policy.get("sourcePolicy"), "selection source policy is invalid")
    if (
        source_policy.get("baseline") != "v26b_first_retrieve_returned_source_hashes_first_8"
        or source_policy.get("hydration") != "full_user_turns_only_chronological"
        or source_policy.get("readerMode") != "replace_legacy_packet_when_projection_is_complete"
        or source_policy.get("projection")
        != "stable_baseline_first_4_then_locked_user_bm25_top_2_max_6"
        or source_policy.get("queryCutoffRequired") is not True
    ):
        raise ValueError("selection does not require a query cutoff")
    rows = selection.get("rows")
    if not isinstance(rows, list):
        raise ValueError("selection rows are invalid")
    assert_label_free(rows)
    by_hmac: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("queryHmac"), str):
            raise ValueError("selection row is invalid")
        query_hmac = row["queryHmac"]
        if query_hmac in by_hmac:
            raise ValueError("selection query addresses are duplicated")
        certificate = _required_dict(row.get("certificate"), "selection certificate is invalid")
        revision = keyed_revision(
            json.dumps(certificate, sort_keys=True, separators=(",", ":")),
            key,
            "preference-user-projection-packet",
        )
        if row.get("packetRevisionHmac") != revision:
            raise ValueError("selection packet identity is invalid")
        baseline = certificate.get("baselineSourceDocumentHashes")
        union = certificate.get("stableUnionSourceDocumentHashes")
        projection = certificate.get("projectionSourceDocumentHashes")
        projection_candidates = certificate.get("projectionCandidateSourceDocumentHashes")
        references = certificate.get("hydratedUserEvidenceRefHmacs")
        if (
            not isinstance(baseline, list)
            or not isinstance(union, list)
            or not isinstance(projection, list)
            or not isinstance(projection_candidates, list)
            or not isinstance(references, list)
            or any(
                not isinstance(value, str)
                for value in baseline + union + projection_candidates + projection + references
            )
            or not 1 <= len(baseline) <= 8
            or union[: len(baseline)] != baseline
            or len(union) > 12
            or len(projection) > 6
            or projection_candidates[: len(projection)] != projection
            or not set(projection_candidates).issubset(set(union))
            or not set(projection).issubset(set(union))
            or len(references) != len(set(references))
            or certificate.get("completeSessionProjection") is not True
            or certificate.get("outOfLockUserTurnCount") != 0
            or certificate.get("postCutoffUserTurnCount") != 0
            or certificate.get("duplicateEvidenceRefCount") != 0
            or not isinstance(certificate.get("projectionBudgetChars"), int)
            or certificate.get("rawContextCharCount", -1) > certificate.get("projectionBudgetChars")
            or row.get("sourceLockIdentityPreserved") is not True
        ):
            raise ValueError("selection packet policy is invalid")
        by_hmac[query_hmac] = row
    return by_hmac


def _reader_turns(item: dict[str, Any], row: dict[str, Any], key: bytes):
    cutoff = timestamp(required_string(item, "question_date"))
    if cutoff is None:
        raise ValueError("query cutoff is invalid")
    if row.get("queryCutoffHmac") != keyed_revision(cutoff, key, "query-cutoff"):
        raise ValueError("query cutoff binding is invalid")
    certificate = _required_dict(row.get("certificate"), "selection certificate is invalid")
    union = tuple(certificate["stableUnionSourceDocumentHashes"])
    if row.get("sourceLockRevisionHmac") != keyed_revision(json.dumps(list(union)), key, "source-lock"):
        raise ValueError("source lock binding is invalid")
    projection = tuple(certificate["projectionSourceDocumentHashes"])
    sessions = user_only_sessions(item, cutoff)
    by_hash = {session.source_hash: session for session in sessions}
    if any(source_hash not in by_hash for source_hash in projection):
        raise ValueError("projection source cannot hydrate from pinned data")
    actual = hydrate_user_turns(sessions, projection)
    actual_hmacs = tuple(hmac_ref(turn.evidence_ref, key) for turn in actual)
    certified = tuple(certificate["hydratedUserEvidenceRefHmacs"])
    if set(actual_hmacs) != set(certified) or len(actual_hmacs) != len(certified):
        raise ValueError("projection evidence HMAC set is invalid")
    if sum(len(turn.content) for turn in actual) != certificate.get("rawContextCharCount"):
        raise ValueError("projection context character binding is invalid")
    return by_hash, projection, actual_hmacs


def render_user_authored_memory(item: dict[str, Any], row: dict[str, Any], key: bytes) -> ReaderPacket:
    """Render source-rank ordered, user-only turns without a typed profile."""

    by_hash, projection, actual_hmacs = _reader_turns(item, row, key)
    sections = ["USER_AUTHORED_MEMORY", RULE]
    context_chars = 0
    for rank, source_hash in enumerate(projection, start=1):
        session = by_hash[source_hash]
        sections.append(f"[Memory source {rank}; session {session.session_timestamp}]")
        for turn in sorted(session.turns, key=lambda value: (value.turn_order, value.evidence_ref)):
            sections.append(turn.content)
            context_chars += len(turn.content)
    context = "\n".join(sections)
    return ReaderPacket(
        query_hmac=str(row["queryHmac"]),
        packet_revision_hmac=str(row["packetRevisionHmac"]),
        context=context,
        evidence_ref_hmacs=actual_hmacs,
        rendered_context_chars=len(context),
        context_chars=context_chars,
        source_count=len(projection),
    )


def load_reader_packets(selection_path: Path, dataset_path: Path, key_path: Path) -> dict[str, tuple[dict[str, Any], ReaderPacket]]:
    key = key_path.read_bytes()
    selection = load_json(selection_path)
    dataset = load_json(dataset_path)
    if not key or not isinstance(selection, dict) or not isinstance(dataset, list):
        raise ValueError("reader input is invalid")
    rows = validate_selection_artifact(selection, dataset_path, key)
    packets: dict[str, tuple[dict[str, Any], ReaderPacket]] = {}
    for item in dataset:
        if not isinstance(item, dict):
            continue
        query_hmac = eval_hmac(required_string(item, "question_id"), key)
        row = rows.get(query_hmac)
        if row is not None:
            packets[query_hmac] = (item, render_user_authored_memory(item, row, key))
    if set(packets) != set(rows):
        raise ValueError("selection target cannot bind to pinned dataset")
    return packets
