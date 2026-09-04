"""Fail-closed reader for frozen multi-session user evidence sets.

This module reconstructs a certified, user-only evidence packet.  It is not an
answer runner and does not inspect evaluation annotations.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .multi_session_evidence_set_shadow import (
        KEY_DOMAIN,
        SCHEMA_VERSION,
        content_free_certificate,
        render_user_session_blocks,
    )
    from .preference_user_authority_shadow import (
        assert_label_free,
        keyed_revision,
        load_first_retrieve_sources,
        sha256_file,
        user_only_sessions,
    )
    from .temporal_event_ledger_shadow import eval_hmac, load_json, required_string, sha256_text, timestamp
except ImportError:
    from multi_session_evidence_set_shadow import (  # type: ignore[no-redef]
        KEY_DOMAIN,
        SCHEMA_VERSION,
        content_free_certificate,
        render_user_session_blocks,
    )
    from preference_user_authority_shadow import (  # type: ignore[no-redef]
        assert_label_free,
        keyed_revision,
        load_first_retrieve_sources,
        sha256_file,
        user_only_sessions,
    )
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        eval_hmac,
        load_json,
        required_string,
        sha256_text,
        timestamp,
    )


READER_POLICY = "paw.multi-session-evidence-set-reader.v1"
EXECUTION_PROTOCOL = """MULTI_SESSION_EVIDENCE_SET_PROTOCOL
Every SxxTxx address below is immutable user-authored evidence. Scan every
session before concluding. Build the complete set of facts matching the query's
entity, relation, time window, and status. Merge only repeated mentions of the
same real event and action; do not merge distinct events merely because their
entity or type is the same. Member identity includes entity, action/state, and
time, so returning an old item and picking up its replacement are distinct
obligations. A newer statement supersedes an older one only for the same entity
and attribute. Keep planned, completed, cancelled, returned, and active states
distinct.

The question is the join and aggregation contract. When separate sessions give
unique, compatible facts for the entities or operands named by the question,
join them; do not demand that one sentence restate the cross-session relation.
For relative ranges, anchor the range at the query cutoff and use a session
timestamp as the event time when the statement gives no more specific date.
Filter before arithmetic and normalize compatible units. Evidence of acquiring
or possessing an item can support an acquisition count unless contradicted.
Count, sum, compare, or select latest only after a second scan of every session.
If a required operand is absent or conflicts, return insufficient, never a
guess."""


@dataclass(frozen=True)
class ReaderPacket:
    query_hmac: str
    packet_revision_hmac: str
    context: str
    evidence_ref_hmacs: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    source_count: int
    user_turn_count: int
    raw_context_chars: int
    rendered_context_chars: int


def _dict(value: Any, message: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(message)
    return value


def validate_selection_artifact(
    selection: dict[str, Any], dataset_path: Path, retrieval_logs: list[Path], key: bytes
) -> dict[str, dict[str, Any]]:
    """Validate code-independent artifact, raw-data and retrieval-log bindings."""

    if selection.get("schemaVersion") != SCHEMA_VERSION or selection.get("contentFree") is not True:
        raise ValueError("selection schema is invalid")
    policy = _dict(selection.get("policy"), "selection policy is invalid")
    artifacts = _dict(policy.get("artifactPolicy"), "artifact policy is invalid")
    if (
        artifacts.get("datasetSha256") != sha256_file(dataset_path)
        or artifacts.get("hmacKeyId") != keyed_revision(KEY_DOMAIN, key, "key-id")
        or artifacts.get("v26bRetrievalLogSha256s") != sorted(sha256_file(path) for path in retrieval_logs)
    ):
        raise ValueError("selection artifact binding is invalid")
    source_policy = _dict(policy.get("sourcePolicy"), "source policy is invalid")
    if source_policy != {
        "baseline": "v26b_first_retrieve_returned_source_hashes_exact_top_8",
        "hydration": "complete_user_turns_only_per_locked_source_chronological",
        "queryCutoffRequired": True,
        "noRetrievalExpansion": True,
        "noSessionTruncation": True,
    }:
        raise ValueError("selection source policy is invalid")
    rows = selection.get("rows")
    targets = policy.get("targetQueryHmacs")
    if not isinstance(rows, list) or not isinstance(targets, list):
        raise ValueError("selection rows are invalid")
    assert_label_free(rows)
    if any(not isinstance(value, str) for value in targets) or len(targets) != len(set(targets)):
        raise ValueError("selection target addresses are invalid")
    output: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("queryHmac"), str):
            raise ValueError("selection row is invalid")
        query_hmac = row["queryHmac"]
        if query_hmac in output or query_hmac not in targets:
            raise ValueError("selection query address is invalid")
        certificate = _dict(row.get("certificate"), "selection certificate is invalid")
        revision = keyed_revision(
            json.dumps(certificate, sort_keys=True, separators=(",", ":")),
            key,
            "multi-session-evidence-set-packet",
        )
        if row.get("packetRevisionHmac") != revision:
            raise ValueError("selection packet identity is invalid")
        source_lock = certificate.get("sourceDocumentHashes")
        source_hmacs = certificate.get("sourceHmacs")
        sessions = certificate.get("completeUserSessions")
        refs = certificate.get("userEvidenceRefHmacs")
        short_ids = certificate.get("shortEvidenceIds")
        if (
            not isinstance(source_lock, list)
            or not isinstance(source_hmacs, list)
            or not isinstance(sessions, list)
            or not isinstance(refs, list)
            or not isinstance(short_ids, list)
            or not 1 <= len(source_lock) <= 8
            or len(set(source_lock)) != len(source_lock)
            or any(not isinstance(value, str) for value in source_lock + source_hmacs + refs)
            or any(not isinstance(value, str) for value in short_ids)
            or source_hmacs != [keyed_revision(value, key, "source-hash") for value in source_lock]
            or len(sessions) != len(source_lock)
            or len(refs) != len(set(refs))
            or len(short_ids) != len(refs)
            or len(short_ids) != len(set(short_ids))
            or certificate.get("completeSessionClosure") is not True
            or certificate.get("assistantTurnCount") != 0
            or certificate.get("outOfLockUserTurnCount") != 0
            or certificate.get("postCutoffUserTurnCount") != 0
            or certificate.get("duplicateEvidenceRefCount") != 0
            or not isinstance(certificate.get("rawContextCharCount"), int)
            or not isinstance(certificate.get("renderedContextCharCount"), int)
        ):
            raise ValueError("selection certificate is invalid")
        if row.get("sourceLockRevisionHmac") != keyed_revision(json.dumps(source_lock), key, "source-lock"):
            raise ValueError("selection source lock identity is invalid")
        output[query_hmac] = row
    if set(output) != set(targets):
        raise ValueError("selection does not cover its sealed targets")
    return output


def render_multi_session_evidence(
    item: dict[str, Any],
    row: dict[str, Any],
    key: bytes,
    expected_source_lock: tuple[str, ...] | None = None,
) -> ReaderPacket:
    """Rehydrate and compare every locked user turn before rendering memory."""

    cutoff = timestamp(required_string(item, "question_date"))
    if cutoff is None:
        raise ValueError("query cutoff is invalid")
    if row.get("queryCutoffHmac") != keyed_revision(cutoff, key, "query-cutoff"):
        raise ValueError("query cutoff binding is invalid")
    certificate = _dict(row.get("certificate"), "selection certificate is invalid")
    source_lock = tuple(certificate.get("sourceDocumentHashes", []))
    if (
        not 1 <= len(source_lock) <= 8
        or len(set(source_lock)) != len(source_lock)
        or any(not isinstance(value, str) for value in source_lock)
    ):
        raise ValueError("selection source lock is invalid")
    if expected_source_lock is not None and source_lock != expected_source_lock:
        raise ValueError("selection source lock differs from pinned retrieval trace")
    sessions = user_only_sessions(item, cutoff)
    actual_certificate = content_free_certificate(sessions, source_lock, key)
    if actual_certificate != certificate:
        raise ValueError("hydrated evidence certificate does not match selection")
    rendered = render_user_session_blocks(sessions, source_lock)
    evidence_ids = tuple(actual_certificate["shortEvidenceIds"])
    context = "\n\n".join(
        (
            EXECUTION_PROTOCOL,
            f"[Query cutoff {required_string(item, 'question_date')}]",
            rendered,
        )
    )
    return ReaderPacket(
        query_hmac=str(row["queryHmac"]),
        packet_revision_hmac=str(row["packetRevisionHmac"]),
        context=context,
        evidence_ref_hmacs=tuple(actual_certificate["userEvidenceRefHmacs"]),
        evidence_ids=evidence_ids,
        source_count=len(source_lock),
        user_turn_count=int(actual_certificate["userTurnCount"]),
        raw_context_chars=int(actual_certificate["rawContextCharCount"]),
        rendered_context_chars=len(context),
    )


def load_reader_packets(
    selection_path: Path, dataset_path: Path, retrieval_logs: list[Path], key_path: Path
) -> dict[str, tuple[dict[str, Any], ReaderPacket]]:
    """Load only certified reader packets from exact pinned inputs."""

    key = key_path.read_bytes()
    selection = load_json(selection_path)
    dataset = load_json(dataset_path)
    if not key or not isinstance(selection, dict) or not isinstance(dataset, list):
        raise ValueError("reader input is invalid")
    rows = validate_selection_artifact(selection, dataset_path, retrieval_logs, key)
    locked_sources = load_first_retrieve_sources(retrieval_logs)
    packets: dict[str, tuple[dict[str, Any], ReaderPacket]] = {}
    for item in dataset:
        if not isinstance(item, dict):
            continue
        query_hmac = eval_hmac(required_string(item, "question_id"), key)
        row = rows.get(query_hmac)
        if row is not None:
            expected_source_lock = locked_sources.get(sha256_text(required_string(item, "question")))
            if expected_source_lock is None:
                raise ValueError("sealed target has no pinned retrieval lock")
            packets[query_hmac] = (
                item,
                render_multi_session_evidence(item, row, key, expected_source_lock),
            )
    if set(packets) != set(rows):
        raise ValueError("sealed target cannot bind to pinned dataset")
    return packets
