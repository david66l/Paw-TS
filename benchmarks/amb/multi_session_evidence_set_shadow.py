"""Label-blind frozen top-8 user-session evidence-set selector.

The sealed target manifest is created outside this module.  Once invoked, this
selector sees only a query address, its text/date, pinned raw history, and the
first v26 retrieve lock.  It neither re-ranks nor expands that lock, and it
never reads evaluation annotations.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

try:
    from .preference_user_authority_shadow import (
        BASELINE_SOURCE_COUNT,
        assert_label_free,
        keyed_revision,
        load_first_retrieve_sources,
        load_target_manifest,
        sha256_file,
        user_only_sessions,
    )
    from .temporal_event_ledger_shadow import (
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        sha256_text,
        timestamp,
    )
except ImportError:
    from preference_user_authority_shadow import (  # type: ignore[no-redef]
        BASELINE_SOURCE_COUNT,
        assert_label_free,
        keyed_revision,
        load_first_retrieve_sources,
        load_target_manifest,
        sha256_file,
        user_only_sessions,
    )
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        sha256_text,
        timestamp,
    )


SCHEMA_VERSION = "paw.multi-session-evidence-set-shadow.v1"
TARGET_COUNT = 133
KEY_DOMAIN = "paw.multi-session-evidence-set"


def _source_ranked_sessions(sessions: tuple[Any, ...], source_lock: tuple[str, ...]) -> list[tuple[int, Any]]:
    """Resolve the frozen lock and order its complete sessions by time."""

    if len(source_lock) != BASELINE_SOURCE_COUNT or len(set(source_lock)) != BASELINE_SOURCE_COUNT:
        raise ValueError("multi-session source lock must contain exactly eight unique sources")
    by_hash = {session.source_hash: session for session in sessions}
    try:
        selected = [(rank, by_hash[source_hash]) for rank, source_hash in enumerate(source_lock, start=1)]
    except KeyError as error:
        raise ValueError("frozen source lock cannot hydrate a complete user session") from error
    return sorted(selected, key=lambda value: (value[1].session_timestamp, value[1].session_order, value[0]))


def render_user_session_blocks(sessions: tuple[Any, ...], source_lock: tuple[str, ...]) -> str:
    """Render complete user sessions chronologically, retaining frozen rank."""

    blocks: list[str] = []
    for session_index, (rank, session) in enumerate(
        _source_ranked_sessions(sessions, source_lock), start=1
    ):
        blocks.append(
            f"[Session S{session_index:02d}; source rank {rank}; "
            f"session {session.session_timestamp}]"
        )
        for turn in sorted(session.turns, key=lambda value: (value.turn_order, value.evidence_ref)):
            blocks.append(
                f"[S{session_index:02d}T{turn.turn_order:02d}] USER: {turn.content}"
            )
    return "\n".join(blocks)


def content_free_certificate(sessions: tuple[Any, ...], source_lock: tuple[str, ...], key: bytes) -> dict[str, Any]:
    """Certify exact, full, user-only source-session closure without content."""

    selected = _source_ranked_sessions(sessions, source_lock)
    refs: list[str] = []
    session_rows: list[dict[str, Any]] = []
    raw_chars = 0
    short_ids: list[str] = []
    for session_index, (rank, session) in enumerate(selected, start=1):
        turns = sorted(session.turns, key=lambda value: (value.turn_order, value.evidence_ref))
        if not turns:
            raise ValueError("frozen source lacks a complete user session")
        turn_refs = [hmac_ref(turn.evidence_ref, key) for turn in turns]
        if len(set(turn_refs)) != len(turn_refs):
            raise ValueError("user session has duplicate turn references")
        refs.extend(turn_refs)
        short_ids.extend(
            f"S{session_index:02d}T{turn.turn_order:02d}" for turn in turns
        )
        chars = sum(len(turn.content) for turn in turns)
        raw_chars += chars
        session_rows.append(
            {
                "sourceRank": rank,
                "sourceHmac": keyed_revision(session.source_hash, key, "source-hash"),
                "sessionTimestampHmac": keyed_revision(session.session_timestamp, key, "session-timestamp"),
                "sessionOrder": session.session_order,
                "userTurnCount": len(turns),
                "rawCharCount": chars,
                "turnEvidenceRefHmacs": turn_refs,
            }
        )
    if len(set(refs)) != len(refs):
        raise ValueError("source lock has duplicate user evidence references")
    rendered = render_user_session_blocks(sessions, source_lock)
    return {
        "sourceDocumentHashes": list(source_lock),
        "sourceHmacs": [keyed_revision(source_hash, key, "source-hash") for source_hash in source_lock],
        "completeUserSessions": session_rows,
        "userEvidenceRefHmacs": refs,
        "shortEvidenceIds": short_ids,
        "completeSessionClosure": True,
        "userTurnCount": len(refs),
        "rawContextCharCount": raw_chars,
        "renderedContextCharCount": len(rendered),
        "assistantTurnCount": 0,
        "outOfLockUserTurnCount": 0,
        "postCutoffUserTurnCount": 0,
        "duplicateEvidenceRefCount": 0,
    }


def save_checkpoint(path: Path, policy: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    assert_label_free(rows)
    payload = {
        "schemaVersion": f"{SCHEMA_VERSION}:checkpoint",
        "contentFree": True,
        "policy": policy,
        "rows": sorted(rows, key=lambda value: str(value["queryHmac"])),
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
        raise ValueError("checkpoint does not bind this selection run")
    assert_label_free(payload["rows"])
    rows = [row for row in payload["rows"] if isinstance(row, dict)]
    hmacs = [row.get("queryHmac") for row in rows]
    if (
        any(not isinstance(value, str) or value not in targets for value in hmacs)
        or len(hmacs) != len(set(hmacs))
    ):
        raise ValueError("checkpoint rows are invalid")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--target-manifest", type=Path, required=True)
    parser.add_argument("--v26b-retrieval-log", type=Path, nargs="+", required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--expected-target-count", type=int, default=TARGET_COUNT)
    args = parser.parse_args()
    if args.expected_target_count != TARGET_COUNT:
        raise ValueError("multi-session evidence-set requires exactly 133 targets")
    key = args.eval_hmac_key.read_bytes()
    dataset = load_json(args.dataset)
    if not key or not isinstance(dataset, list):
        raise ValueError("selector input is invalid")
    targets = load_target_manifest(args.target_manifest, args.expected_target_count)
    dataset_by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset
        if isinstance(item, dict)
    }
    if not targets.issubset(dataset_by_hmac):
        raise ValueError("target manifest cannot bind to pinned dataset")
    locks = load_first_retrieve_sources(args.v26b_retrieval_log)
    policy = {
        "sourcePolicy": {
            "baseline": "v26b_first_retrieve_returned_source_hashes_exact_top_8",
            "hydration": "complete_user_turns_only_per_locked_source_chronological",
            "queryCutoffRequired": True,
            "noRetrievalExpansion": True,
            "noSessionTruncation": True,
        },
        "artifactPolicy": {
            "datasetSha256": sha256_file(args.dataset),
            "targetManifestSha256": sha256_file(args.target_manifest),
            "v26bRetrievalLogSha256s": sorted(sha256_file(path) for path in args.v26b_retrieval_log),
            "producerCodeSha256": sha256_file(Path(__file__)),
            "hmacKeyId": keyed_revision(KEY_DOMAIN, key, "key-id"),
        },
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
        cutoff = timestamp(required_string(item, "question_date"))
        if cutoff is None:
            raise ValueError("query cutoff is invalid")
        question = required_string(item, "question")
        source_lock = locks.get(sha256_text(question))
        if source_lock is None:
            raise ValueError("target has no frozen v26 first retrieve source lock")
        certificate = content_free_certificate(user_only_sessions(item, cutoff), source_lock, key)
        packet_revision = keyed_revision(
            json.dumps(certificate, sort_keys=True, separators=(",", ":")),
            key,
            "multi-session-evidence-set-packet",
        )
        rows.append(
            {
                "queryHmac": query_hmac,
                "queryCutoffHmac": keyed_revision(cutoff, key, "query-cutoff"),
                "sourceLockRevisionHmac": keyed_revision(json.dumps(list(source_lock)), key, "source-lock"),
                "packetRevisionHmac": packet_revision,
                "certificate": certificate,
            }
        )
        save_checkpoint(checkpoint, policy, rows)
        print(f"selected {index}/{len(targets)}", flush=True)
    assert_label_free(rows)
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "contentFree": True,
        "policy": policy,
        "rows": sorted(rows, key=lambda value: str(value["queryHmac"])),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
