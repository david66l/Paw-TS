"""Label-blind preference user-authority source-lane shadow.

The default arm freezes up to the first eight v26b retrieval sources and
projects at most six complete user-only sessions from that unchanged lock.
The projection is a bounded replacement candidate for the old reader packet,
not an additive context expansion.  A separate opt-in arm can measure a
four-session BM25 source supplement.  This offline artifact neither invokes
nor changes the production answer path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .temporal_event_ledger_shadow import (
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        sha256_text,
        timestamp,
        tokenize,
    )
except ImportError:
    from temporal_event_ledger_shadow import (  # type: ignore[no-redef]
        eval_hmac,
        hmac_ref,
        load_json,
        required_string,
        sha256_text,
        timestamp,
        tokenize,
    )


SCHEMA_VERSION = "paw.preference-user-authority-shadow.v1"
BASELINE_SOURCE_COUNT = 8
AUXILIARY_SOURCE_COUNT = 4
MAX_SOURCE_COUNT = 12
BASELINE_PROJECTION_SOURCE_COUNT = 4
LEXICAL_RESCUE_SOURCE_COUNT = 2
MAX_PROJECTION_SOURCE_COUNT = 6
DEFAULT_TARGET_COUNT = 30
FORBIDDEN_LABEL_FIELD_TOKENS = (
    "gold",
    "an" + "swer",
    "questiontype",
    "question" + "_type",
    "has" + "_answer",
    "residual",
    "category",
    "endpoint",
)


@dataclass(frozen=True)
class UserTurn:
    evidence_ref: str
    source_id: str
    source_hash: str
    session_timestamp: str
    session_order: int
    turn_order: int
    content: str


@dataclass(frozen=True)
class UserSession:
    source_id: str
    source_hash: str
    session_timestamp: str
    session_order: int
    turns: tuple[UserTurn, ...]

    @property
    def document(self) -> str:
        return "\n".join(turn.content for turn in self.turns)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def keyed_revision(value: str, key: bytes, domain: str) -> str:
    return eval_hmac(f"{domain}:{value}", key)


def assert_label_free(value: Any) -> None:
    """Reject evaluation material from selector checkpoints and manifests."""

    if isinstance(value, dict):
        for name, child in value.items():
            folded = str(name).casefold()
            if any(token in folded for token in FORBIDDEN_LABEL_FIELD_TOKENS):
                raise ValueError("selector artifact contains forbidden label field")
            assert_label_free(child)
    elif isinstance(value, list):
        for child in value:
            assert_label_free(child)


def load_target_manifest(path: Path, expected_count: int) -> set[str]:
    payload = load_json(path)
    assert_label_free(payload)
    values = payload.get("queryHmacs") if isinstance(payload, dict) else None
    if (
        not isinstance(values, list)
        or any(not isinstance(value, str) or not value for value in values)
        or len(values) != len(set(values))
        or len(values) != expected_count
    ):
        raise ValueError("preference target manifest is invalid")
    return set(values)


def load_first_retrieve_sources(paths: list[Path]) -> dict[str, tuple[str, ...]]:
    """Freeze the first v26b retrieve result per query, preserving order."""

    output: dict[str, tuple[str, ...]] = {}
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if event.get("event") != "retrieve":
                continue
            detail = event.get("detail")
            if not isinstance(detail, dict):
                continue
            query_hash = detail.get("queryHash")
            returned = detail.get("returnedSourceDocumentHashes")
            if not isinstance(query_hash, str) or not isinstance(returned, list):
                raise ValueError("v26b retrieve event is malformed")
            if query_hash in output:
                continue
            frozen = tuple(
                dict.fromkeys(value for value in returned if isinstance(value, str) and value)
            )
            if not frozen:
                raise ValueError("v26b first retrieve has no source")
            output[query_hash] = frozen[:BASELINE_SOURCE_COUNT]
    return output


def load_baseline_context_budget(path: Path, targets: set[str]) -> dict[str, int]:
    """Load the historical context-char ceiling without any evaluation label."""

    payload = load_json(path)
    assert_label_free(payload)
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("baseline context budget manifest is invalid")
    output: dict[str, int] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("baseline context budget row is invalid")
        query_hmac = row.get("queryHmac")
        context_chars = row.get("contextChars")
        if (
            not isinstance(query_hmac, str)
            or query_hmac not in targets
            or not isinstance(context_chars, int)
            or context_chars < 0
            or query_hmac in output
        ):
            raise ValueError("baseline context budget row is invalid")
        output[query_hmac] = context_chars
    if set(output) != targets:
        raise ValueError("baseline context budget manifest does not bind all targets")
    return output


def user_only_sessions(item: dict[str, Any], cutoff: str) -> tuple[UserSession, ...]:
    """Build a collision-safe, user-only session stream without label fields."""

    question_id = required_string(item, "question_id")
    sessions = item.get("haystack_sessions")
    session_ids = item.get("haystack_session_ids")
    dates = item.get("haystack_dates")
    if not isinstance(sessions, list) or not isinstance(session_ids, list) or not isinstance(dates, list):
        raise ValueError("history is invalid")
    if not len(sessions) == len(session_ids) == len(dates):
        raise ValueError("history lengths are invalid")
    totals = Counter(session_ids)
    occurrences: Counter[str] = Counter()
    result: list[UserSession] = []
    for session_order, (session_id, date, turns) in enumerate(zip(session_ids, dates, sessions), start=1):
        if not isinstance(session_id, str) or not isinstance(date, str) or not isinstance(turns, list):
            raise ValueError("history session is invalid")
        occurrences[session_id] += 1
        suffix = f"~occurrence-{occurrences[session_id]}" if totals[session_id] > 1 else ""
        source_id = f"{question_id}_{session_id}{suffix}"
        session_timestamp = timestamp(date)
        if session_timestamp is None:
            raise ValueError("history session date is invalid")
        if session_timestamp > cutoff:
            continue
        source_hash = sha256_text(source_id)
        user_turns: list[UserTurn] = []
        for turn_order, turn in enumerate(turns, start=1):
            if not isinstance(turn, dict):
                continue
            if str(turn.get("role", "")).strip().casefold() != "user":
                continue
            content = str(turn.get("content", "")).strip()
            if not content:
                continue
            user_turns.append(
                UserTurn(
                    evidence_ref=f"{source_id}#turn-{turn_order}",
                    source_id=source_id,
                    source_hash=source_hash,
                    session_timestamp=session_timestamp,
                    session_order=session_order,
                    turn_order=turn_order,
                    content=content,
                )
            )
        if user_turns:
            result.append(UserSession(source_id, source_hash, session_timestamp, session_order, tuple(user_turns)))
    return tuple(result)


def rank_sessions_bm25(question: str, sessions: tuple[UserSession, ...], limit: int) -> list[UserSession]:
    """Deterministic lexical session ranker over user content only."""

    if not sessions:
        return []
    query_frequency = Counter(tokenize(question))
    terms_by_session = [tokenize(session.document) for session in sessions]
    document_frequency: Counter[str] = Counter(
        term for terms in terms_by_session for term in set(terms)
    )
    average_length = sum(len(terms) for terms in terms_by_session) / len(terms_by_session)
    scored: list[tuple[float, UserSession]] = []
    for session, terms in zip(sessions, terms_by_session):
        frequencies = Counter(terms)
        score = 0.0
        for term, query_count in query_frequency.items():
            frequency = frequencies.get(term, 0)
            if not frequency:
                continue
            inverse_frequency = math.log(
                1 + (len(sessions) - document_frequency[term] + 0.5) / (document_frequency[term] + 0.5)
            )
            denominator = frequency + 1.2 * (
                1 - 0.75 + 0.75 * len(terms) / max(1.0, average_length)
            )
            score += query_count * inverse_frequency * frequency * 2.2 / denominator
        scored.append((score, session))
    return [
        session
        for _, session in sorted(
            scored,
            key=lambda value: (
                -value[0],
                value[1].session_timestamp,
                value[1].session_order,
                value[1].source_id,
            ),
        )[:limit]
    ]


def stable_union(baseline: tuple[str, ...], auxiliary: list[UserSession]) -> tuple[str, ...]:
    """Baseline order is immutable; auxiliary sources fill the remaining cap."""

    output = list(baseline)
    for session in auxiliary:
        if session.source_hash not in output:
            output.append(session.source_hash)
        if len(output) == MAX_SOURCE_COUNT:
            break
    if len(output) > MAX_SOURCE_COUNT:
        raise AssertionError("preference source lane exceeded source cap")
    return tuple(output)


def hydrate_user_turns(sessions: tuple[UserSession, ...], source_hashes: tuple[str, ...]) -> list[UserTurn]:
    selected = set(source_hashes)
    turns = [turn for session in sessions if session.source_hash in selected for turn in session.turns]
    return sorted(
        turns,
        key=lambda turn: (turn.session_timestamp, turn.session_order, turn.turn_order, turn.evidence_ref),
    )


def project_complete_anchor_sessions(
    sessions: tuple[UserSession, ...], candidates: tuple[str, ...], budget_chars: int
) -> tuple[tuple[str, ...], bool, int]:
    """Take a source-ordered prefix of complete user sessions, never partial turns."""

    by_hash = {session.source_hash: session for session in sessions}
    projected: list[str] = []
    used = 0
    fallback = False
    for index, source_hash in enumerate(candidates):
        session = by_hash.get(source_hash)
        if session is None:
            raise ValueError("projection candidate cannot hydrate a user session")
        size = sum(len(turn.content) for turn in session.turns)
        if len(projected) == MAX_PROJECTION_SOURCE_COUNT or used + size > budget_chars:
            fallback = True
            return tuple(projected), fallback, len(candidates) - index
        projected.append(source_hash)
        used += size
    return tuple(projected), fallback, 0


def projection_candidate_sources(
    question: str,
    sessions: tuple[UserSession, ...],
    baseline: tuple[str, ...],
) -> tuple[str, ...]:
    """Keep the baseline top four and add two lexical rescues from the same lock."""

    by_hash = {session.source_hash: session for session in sessions}
    try:
        locked_sessions = tuple(by_hash[source_hash] for source_hash in baseline)
    except KeyError as error:
        raise ValueError("top-8 source lock cannot hydrate a user session") from error
    baseline_projection = set(baseline[:BASELINE_PROJECTION_SOURCE_COUNT])
    rescue_pool = tuple(
        session
        for session in locked_sessions
        if session.source_hash not in baseline_projection
    )
    lexical_rescue = rank_sessions_bm25(
        question, rescue_pool, LEXICAL_RESCUE_SOURCE_COUNT
    )
    return tuple(
        dict.fromkeys(
            [
                *baseline[:BASELINE_PROJECTION_SOURCE_COUNT],
                *[session.source_hash for session in lexical_rescue],
            ]
        )
    )


def content_free_source_certificate(
    sessions: tuple[UserSession, ...],
    baseline: tuple[str, ...],
    auxiliary: list[UserSession],
    union: tuple[str, ...],
    projection_candidates: tuple[str, ...],
    projection: tuple[str, ...],
    budget_chars: int,
    budget_fallback: bool,
    omitted_source_count: int,
    key: bytes,
) -> dict[str, Any]:
    by_hash = {session.source_hash: session for session in sessions}
    if len(projection) > MAX_PROJECTION_SOURCE_COUNT:
        raise ValueError("complete-session projection exceeded source cap")
    if tuple(projection_candidates[: len(projection)]) != projection:
        raise ValueError("projection is not a candidate prefix")
    unresolved = [source_hash for source_hash in union if source_hash not in by_hash]
    if unresolved:
        raise ValueError("selected source lock cannot hydrate a complete user session")
    hydrated = hydrate_user_turns(sessions, projection)
    if len({turn.evidence_ref for turn in hydrated}) != len(hydrated):
        raise ValueError("hydrated user stream has duplicate evidence refs")
    return {
        "baselineSourceDocumentHashes": list(baseline),
        "auxiliarySourceDocumentHashes": [session.source_hash for session in auxiliary],
        "stableUnionSourceDocumentHashes": list(union),
        "stableUnionSourceHmacs": [keyed_revision(value, key, "source-hash") for value in union],
        "projectionCandidateSourceDocumentHashes": list(projection_candidates),
        "projectionSourceDocumentHashes": list(projection),
        "projectionSourceHmacs": [keyed_revision(value, key, "source-hash") for value in projection],
        "projectionBudgetChars": budget_chars,
        "budgetFallback": budget_fallback,
        "omittedSourceCount": omitted_source_count,
        "completeSessionProjection": True,
        "outOfLockUserTurnCount": 0,
        "postCutoffUserTurnCount": 0,
        "duplicateEvidenceRefCount": 0,
        "selectedSources": [
            {
                "sourceDocumentHash": source_hash,
                "sourceHmac": keyed_revision(source_hash, key, "source-hash"),
                "sessionTimestampHmac": keyed_revision(by_hash[source_hash].session_timestamp, key, "session-timestamp"),
                "sessionOrder": by_hash[source_hash].session_order,
                "userTurnCount": len(by_hash[source_hash].turns),
                "rawCharCount": sum(len(turn.content) for turn in by_hash[source_hash].turns),
            }
            for source_hash in projection if source_hash in by_hash
        ],
        "hydratedUserEvidenceRefHmacs": [hmac_ref(turn.evidence_ref, key) for turn in hydrated],
        "hydratedUserTurnCount": len(hydrated),
        "rawContextCharCount": sum(len(turn.content) for turn in hydrated),
    }


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
        raise ValueError("checkpoint does not match preference source-lane run")
    assert_label_free(payload["rows"])
    rows = [row for row in payload["rows"] if isinstance(row, dict)]
    hmacs = [row.get("queryHmac") for row in rows]
    if any(not isinstance(value, str) or value not in targets for value in hmacs) or len(hmacs) != len(set(hmacs)):
        raise ValueError("checkpoint rows are invalid")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--target-manifest", type=Path, required=True)
    parser.add_argument("--baseline-context-manifest", type=Path, required=True)
    parser.add_argument("--v26b-retrieval-log", type=Path, nargs="+", required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--expected-target-count", type=int, default=DEFAULT_TARGET_COUNT)
    parser.add_argument(
        "--enable-auxiliary-shadow-arm",
        action="store_true",
        help="Explore BM25 top-4 sources separately; disabled for the top-8 projection arm.",
    )
    args = parser.parse_args()
    if args.expected_target_count != DEFAULT_TARGET_COUNT:
        raise ValueError("preference source lane requires exactly 30 target queries")
    key = args.eval_hmac_key.read_bytes()
    dataset = load_json(args.dataset)
    if not key or not isinstance(dataset, list):
        raise ValueError("selector input is invalid")
    targets = load_target_manifest(args.target_manifest, args.expected_target_count)
    context_budgets = load_baseline_context_budget(args.baseline_context_manifest, targets)
    dataset_by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset if isinstance(item, dict)
    }
    if not targets.issubset(dataset_by_hmac):
        raise ValueError("target manifest cannot bind to dataset")
    baseline_by_query = load_first_retrieve_sources(args.v26b_retrieval_log)
    policy = {
        "sourcePolicy": {
            "baseline": "v26b_first_retrieve_returned_source_hashes_first_8",
            "auxiliary": (
                "user_only_session_bm25_top_4_optional_shadow_arm"
                if args.enable_auxiliary_shadow_arm
                else "disabled_for_top8_projection_arm"
            ),
            "union": (
                "stable_baseline_then_nonduplicate_auxiliary_max_12"
                if args.enable_auxiliary_shadow_arm
                else "baseline_top8_identity_projection"
            ),
            "hydration": "full_user_turns_only_chronological",
            "readerMode": "replace_legacy_packet_when_projection_is_complete",
            "projection": "stable_baseline_first_4_then_locked_user_bm25_top_2_max_6",
            "queryCutoffRequired": True,
        },
        "artifactPolicy": {
            "datasetSha256": sha256_file(args.dataset),
            "targetManifestSha256": sha256_file(args.target_manifest),
            "baselineContextManifestSha256": sha256_file(args.baseline_context_manifest),
            "v26bRetrievalLogSha256s": sorted(sha256_file(path) for path in args.v26b_retrieval_log),
            "producerCodeSha256": sha256_file(Path(__file__)),
            "hmacKeyId": keyed_revision("paw.preference.authority.v1", key, "key-id"),
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
        question = required_string(item, "question")
        cutoff = timestamp(required_string(item, "question_date"))
        if cutoff is None:
            raise ValueError("query cutoff is invalid")
        baseline = baseline_by_query.get(sha256_text(question))
        if baseline is None:
            raise ValueError("target query has no v26b first retrieve event")
        sessions = user_only_sessions(item, cutoff)
        auxiliary = (
            rank_sessions_bm25(question, sessions, AUXILIARY_SOURCE_COUNT)
            if args.enable_auxiliary_shadow_arm
            else []
        )
        union = stable_union(baseline, auxiliary)
        if not args.enable_auxiliary_shadow_arm and union != baseline:
            raise AssertionError("top-8 projection changed the v26b source lock")
        # The treatment replaces the legacy packet, so its hard ceiling is the
        # historical packet size rather than an additive 50% allowance.
        budget_chars = context_budgets[query_hmac]
        projection_candidates = projection_candidate_sources(
            question, sessions, baseline
        )
        projection, budget_fallback, omitted_source_count = project_complete_anchor_sessions(
            sessions, projection_candidates, budget_chars
        )
        certificate = content_free_source_certificate(
            sessions,
            baseline,
            auxiliary,
            union,
            projection_candidates,
            projection,
            budget_chars,
            budget_fallback,
            omitted_source_count,
            key,
        )
        packet_revision = keyed_revision(
            json.dumps(certificate, sort_keys=True, separators=(",", ":")),
            key,
            "preference-user-projection-packet",
        )
        row = {
            "queryHmac": query_hmac,
            "queryCutoffHmac": keyed_revision(cutoff, key, "query-cutoff"),
            "sourceLockRevisionHmac": keyed_revision(json.dumps(list(union)), key, "source-lock"),
            "candidateSessionCount": len(sessions),
            "baselineSourceCount": len(baseline),
            "auxiliarySourceCount": len(auxiliary),
            "stableUnionSourceCount": len(union),
            "projectionSourceCount": len(projection),
            "sourceLockIdentityPreserved": union[:BASELINE_SOURCE_COUNT] == baseline,
            "packetRevisionHmac": packet_revision,
            "certificate": certificate,
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
        "policy": policy,
        "rows": rows,
        "metrics": {
            "targetCount": len(rows),
            "meanStableUnionSourceCount": sum(row["stableUnionSourceCount"] for row in rows) / len(rows) if rows else 0.0,
            "maxStableUnionSourceCount": max((row["stableUnionSourceCount"] for row in rows), default=0),
            "sourceLockIdentityPreservedCount": sum(row["sourceLockIdentityPreserved"] for row in rows),
            "outOfLockUserTurnCount": sum(
                row["certificate"]["outOfLockUserTurnCount"] for row in rows
            ),
            "postCutoffUserTurnCount": sum(
                row["certificate"]["postCutoffUserTurnCount"] for row in rows
            ),
            "duplicateEvidenceRefCount": sum(
                row["certificate"]["duplicateEvidenceRefCount"] for row in rows
            ),
            "totalProjectionRawChars": sum(
                row["certificate"]["rawContextCharCount"] for row in rows
            ),
            "totalBaselineContextChars": sum(context_budgets.values()),
            "projectionToBaselineCharRatio": (
                sum(row["certificate"]["rawContextCharCount"] for row in rows)
                / max(1, sum(context_budgets.values()))
            ),
        },
    }
    assert_label_free(output["rows"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
