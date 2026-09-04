"""Deterministic, label-blind temporal event-facet set selector shadow.

This is an evidence-selection experiment only.  It compiles the question with
the existing deterministic temporal compiler, freezes the existing source
locks, and chooses a small set of turn addresses using shallow lexical and
timeline facets.  It never calls an LLM and never changes an answer path.

The selector deliberately does not inspect ``TurnCandidate.has_answer`` or
any baseline answer outcome.  Gold endpoint labels are read only after the
complete content-free selection has been frozen, to report reachability.
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
        answer_user_evidence_refs,
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
        answer_user_evidence_refs,
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


SCHEMA_VERSION = "paw.temporal-event-facet-set-shadow.v1"
SELECTOR_VERSION = "paw.temporal-event-facet-set-selector.v1"
MAX_SLOT_TURNS = 4
MAX_EVENT_SET_TURNS = 8
MAX_PACKET_TURNS = 12
TOKEN_STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "at", "by", "did", "do", "for", "from",
        "had", "have", "how", "i", "in", "is", "it", "many", "me", "my",
        "of", "on", "or", "the", "to", "was", "were", "what", "when", "which",
        "who", "with", "you", "your",
    }
)
TEMPORAL_CUE = re.compile(
    r"\b(?:today|yesterday|tomorrow|last|next|ago|recent(?:ly)?|first|latest|"
    r"earliest|before|after|between|since|until|when|monday|tuesday|wednesday|"
    r"thursday|friday|saturday|sunday|january|february|march|april|may|june|july|"
    r"august|september|october|november|december|\d{4}|\d+(?:st|nd|rd|th))\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class EventFacetRecord:
    """Query-independent shallow record derived from one locked user turn."""

    candidate: TurnCandidate
    initial_rank: int
    lexical_facets: tuple[str, ...]
    temporal_cues: tuple[str, ...]
    adjacent_refs: tuple[str, ...]


@dataclass(frozen=True)
class FacetSelection:
    slot: SlotSpec
    selected: tuple[EventFacetRecord, ...]
    required_facets: tuple[str, ...]
    covered_facets: tuple[str, ...]


def keyed_revision(value: str, key: bytes, domain: str) -> str:
    return eval_hmac(f"{domain}:{value}", key)


def _ordered_unique(values: list[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(value for value in values if value))


def lexical_facets(text: str) -> tuple[str, ...]:
    """Stable, shallow terms; no entity model and no benchmark labels."""

    return _ordered_unique(
        [token for token in tokenize(text) if len(token) > 1 and token not in TOKEN_STOPWORDS]
    )


def temporal_cues(text: str) -> tuple[str, ...]:
    return _ordered_unique([match.group(0).casefold() for match in TEMPORAL_CUE.finditer(text)])


def build_event_facet_records(candidates: list[TurnCandidate]) -> list[EventFacetRecord]:
    """Build records using only candidate text and source/session provenance."""

    by_source: dict[str, list[TurnCandidate]] = {}
    for initial_rank, candidate in enumerate(candidates, start=1):
        by_source.setdefault(candidate.source_id, []).append(candidate)
    output: list[EventFacetRecord] = []
    for candidate in candidates:
        source_turns = sorted(
            by_source[candidate.source_id],
            key=lambda item: (item.turn_order, item.evidence_ref),
        )
        position = source_turns.index(candidate)
        adjacent: list[str] = []
        if position:
            adjacent.append(source_turns[position - 1].evidence_ref)
        if position + 1 < len(source_turns):
            adjacent.append(source_turns[position + 1].evidence_ref)
        output.append(
            EventFacetRecord(
                candidate=candidate,
                initial_rank=initial_rank,
                lexical_facets=lexical_facets(candidate.content),
                temporal_cues=temporal_cues(candidate.content),
                adjacent_refs=tuple(adjacent),
            )
        )
    return output


def slot_required_facets(slot: SlotSpec) -> tuple[str, ...]:
    """Facet universe for bounded coverage, scoped to the typed slot mention."""

    words = lexical_facets(slot.query_mention)
    cues = tuple(f"time:{cue}" for cue in temporal_cues(slot.query_mention))
    # A complete question is common for event-set plans.  Cap the universe so
    # generic wording cannot make every turn look equally valuable.
    return _ordered_unique(list(words[:12]) + list(cues[:6]))


def _record_features(record: EventFacetRecord) -> set[str]:
    return set(record.lexical_facets) | {f"time:{cue}" for cue in record.temporal_cues}


def facet_score(
    record: EventFacetRecord,
    required: tuple[str, ...],
    selected_refs: set[str],
) -> tuple[int, int, int]:
    """Return direct relevance, marginal coverage, and adjacency support."""

    features = _record_features(record)
    required_set = set(required)
    lexical_hits = len(set(record.lexical_facets) & required_set)
    cue_hits = len({f"time:{cue}" for cue in record.temporal_cues} & required_set)
    direct = lexical_hits * 8 + cue_hits * 5
    marginal = len(features & required_set)
    adjacent = len(set(record.adjacent_refs) & selected_refs)
    return direct, marginal, adjacent


def _record_order(record: EventFacetRecord) -> tuple[int, int, str]:
    candidate = record.candidate
    return candidate.session_order, candidate.turn_order, candidate.evidence_ref


def select_slot_facets(
    slot: SlotSpec,
    records: list[EventFacetRecord],
    *,
    preselected_refs: set[str] | None = None,
) -> FacetSelection:
    """Greedy bounded set cover with deterministic relevance tie breaking."""

    required = slot_required_facets(slot)
    budget = MAX_EVENT_SET_TURNS if slot.role == "event_set" else MAX_SLOT_TURNS
    selected: list[EventFacetRecord] = []
    selected_refs = set(preselected_refs or set())
    selected_sources: set[str] = set()
    covered: set[str] = set()
    available = list(records)
    while available and len(selected) < budget:
        scored = []
        for record in available:
            direct, _, adjacency = facet_score(record, required, selected_refs)
            marginal = len((_record_features(record) & set(required)) - covered)
            scored.append((direct, marginal, adjacency, record))
        direct, marginal, adjacency, chosen = min(
            scored,
            key=lambda value: (
                -value[0],
                # Collection operators compare distinct events.  On the
                # fixed source-lane frontier, cover source sessions before
                # selecting a second turn from one session.
                int(
                    slot.role == "event_set"
                    and value[3].candidate.source_id in selected_sources
                ),
                -value[1],
                -value[2],
                value[3].initial_rank,
                *_record_order(value[3]),
            ),
        )
        # No query facet means the candidate cannot be justified by this slot.
        # For a typed event-set, the fixed top-48 rank is itself the bounded
        # relevance frontier.  Keep a competitive collection even where an
        # event is paraphrased and therefore has no literal query token.
        if slot.role != "event_set" and direct == 0 and marginal == 0:
            break
        selected.append(chosen)
        selected_refs.add(chosen.candidate.evidence_ref)
        selected_sources.add(chosen.candidate.source_id)
        covered.update(_record_features(chosen) & set(required))
        available.remove(chosen)
        # For ordinary named endpoints, stop once all observable slot facets
        # are covered.  Event sets keep adding directly relevant events.
        if slot.role != "event_set" and set(required).issubset(covered):
            break
    return FacetSelection(
        slot=slot,
        selected=tuple(selected),
        required_facets=required,
        covered_facets=tuple(sorted(covered)),
    )


def select_event_facet_packet(
    plan: TemporalPlan | None, records: list[EventFacetRecord]
) -> tuple[FacetSelection, ...]:
    """Select per slot, then enforce the immutable packet-wide 12-turn cap."""

    if plan is None:
        return ()
    selected_refs: set[str] = set()
    selections: list[FacetSelection] = []
    for slot in plan.slots:
        selection = select_slot_facets(slot, records, preselected_refs=selected_refs)
        selections.append(selection)
        selected_refs.update(record.candidate.evidence_ref for record in selection.selected)

    # Preserve slot assignment while applying a global cap.  The canonical
    # pass keeps the strongest role-local occurrence per evidence address.
    best: dict[str, tuple[int, int, int, EventFacetRecord]] = {}
    for selection in selections:
        required = selection.required_facets
        for record in selection.selected:
            value = facet_score(record, required, set()) + (record,)
            current = best.get(record.candidate.evidence_ref)
            if current is None or value[:3] > current[:3]:
                best[record.candidate.evidence_ref] = value
    allowed = {
        record.candidate.evidence_ref
        for _, _, _, record in sorted(
            best.values(),
            key=lambda value: (
                -value[0], -value[1], -value[2], *_record_order(value[3])
            ),
        )[:MAX_PACKET_TURNS]
    }
    trimmed: list[FacetSelection] = []
    for selection in selections:
        chosen = tuple(
            record
            for record in selection.selected
            if record.candidate.evidence_ref in allowed
        )
        covered = set()
        for record in chosen:
            covered.update(_record_features(record) & set(selection.required_facets))
        trimmed.append(
            FacetSelection(
                slot=selection.slot,
                selected=chosen,
                required_facets=selection.required_facets,
                covered_facets=tuple(sorted(covered)),
            )
        )
    return tuple(trimmed)


def content_free_facet_certificate(
    selection: FacetSelection, key: bytes
) -> dict[str, Any]:
    """Expose only HMAC addresses and HMACed shallow facets, never turn text."""

    return {
        "slotId": selection.slot.slot_id,
        "role": selection.slot.role,
        "queryMentionHmac": keyed_revision(
            selection.slot.query_mention, key, "query-mention"
        ),
        "requiredFacetHmacs": [
            keyed_revision(facet, key, "facet") for facet in selection.required_facets
        ],
        "coveredFacetHmacs": [
            keyed_revision(facet, key, "facet") for facet in selection.covered_facets
        ],
        "selected": [
            {
                "evidenceRefHmac": hmac_ref(record.candidate.evidence_ref, key),
                "sourceIdHmac": keyed_revision(
                    record.candidate.source_id, key, "source-id"
                ),
                "sessionTimestampHmac": keyed_revision(
                    record.candidate.session_timestamp, key, "session-timestamp"
                ),
                "sessionOrder": record.candidate.session_order,
                "turnOrder": record.candidate.turn_order,
                "adjacentEvidenceRefHmacs": sorted(
                    hmac_ref(reference, key) for reference in record.adjacent_refs
                ),
                "lexicalFacetHmacs": [
                    keyed_revision(facet, key, "facet")
                    for facet in record.lexical_facets
                ],
                "temporalCueHmacs": [
                    keyed_revision(cue, key, "temporal-cue")
                    for cue in record.temporal_cues
                ],
            }
            for record in selection.selected
        ],
    }


def _assert_content_free(value: Any) -> None:
    forbidden = {"answer", "answercorrect", "residual", "category", "content", "gold"}
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).casefold() in forbidden:
                raise ValueError("facet certificate is not content-free")
            _assert_content_free(child)
    elif isinstance(value, list):
        for child in value:
            _assert_content_free(child)


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError as error:
        raise ValueError(f"required package version is unavailable: {name}") from error


def _load_reranker(args: argparse.Namespace) -> tuple[Any | None, dict[str, Any]]:
    if not args.cross_encoder_id:
        if args.cross_encoder_revision or args.cross_encoder_path:
            raise ValueError("cross-encoder id and revision must be pinned together")
        return None, {"ranker": "label_blind_exact_turn_bm25_v1"}
    if not args.cross_encoder_revision:
        raise ValueError("cross-encoder revision is required")
    from sentence_transformers import CrossEncoder

    options: dict[str, Any] = {
        "device": args.cross_encoder_device,
        "max_length": args.cross_encoder_max_length,
    }
    if not args.cross_encoder_path:
        options["revision"] = args.cross_encoder_revision
    reranker = CrossEncoder(args.cross_encoder_path or args.cross_encoder_id, **options)
    return reranker, {
        "ranker": "label_blind_exact_turn_bm25_cross_encoder_rrf_v1",
        "crossEncoderModel": args.cross_encoder_id,
        "crossEncoderRevision": args.cross_encoder_revision,
        "crossEncoderMaxLength": args.cross_encoder_max_length,
        "crossEncoderBatchSize": args.cross_encoder_batch_size,
        "crossEncoderArtifactSha256": (
            sha256_tree(args.cross_encoder_path) if args.cross_encoder_path else None
        ),
        "crossEncoderRuntimeVersions": {
            name: _package_version(name)
            for name in ("sentence-transformers", "transformers", "torch")
        },
    }


def _checkpoint_payload(policy: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schemaVersion": f"{SCHEMA_VERSION}:checkpoint",
        "contentFree": True,
        "policy": policy,
        "rows": sorted(rows, key=lambda row: str(row["queryHmac"])),
    }


def save_checkpoint(path: Path, policy: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(_checkpoint_payload(policy, rows), indent=2) + "\n", encoding="utf-8")
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
        raise ValueError("checkpoint does not match this facet-set run")
    rows = [row for row in payload["rows"] if isinstance(row, dict)]
    hmacs = [row.get("queryHmac") for row in rows]
    if any(not isinstance(value, str) or value not in targets for value in hmacs) or len(hmacs) != len(set(hmacs)):
        raise ValueError("checkpoint rows are invalid")
    return rows


def _target_hmacs(baseline_rows: list[dict[str, Any]]) -> set[str]:
    """All frozen ledger addresses; intentionally no answer outcome inspection."""

    targets = {
        row["queryHmac"]
        for row in baseline_rows
        if isinstance(row.get("queryHmac"), str) and row["queryHmac"]
    }
    if not targets:
        raise ValueError("baseline ledger contains no query HMACs")
    return targets


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--baseline-ledger", type=Path, nargs="+", required=True)
    parser.add_argument("--temporal-source-lane-log", type=Path, nargs="+", required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--top-k", type=int, default=48)
    parser.add_argument("--expected-source-session-count", type=int, default=16)
    parser.add_argument("--cross-encoder-id", default="")
    parser.add_argument("--cross-encoder-revision", default="")
    parser.add_argument("--cross-encoder-path", type=Path)
    parser.add_argument("--cross-encoder-device", default="cuda")
    parser.add_argument("--cross-encoder-batch-size", type=int, default=64)
    parser.add_argument("--cross-encoder-max-length", type=int, default=512)
    args = parser.parse_args()
    if not 1 <= args.top_k <= 48:
        raise ValueError("--top-k must be between 1 and 48")
    if args.expected_source_session_count < 1:
        raise ValueError("expected source session count is invalid")
    if not 1 <= args.cross_encoder_batch_size <= 256:
        raise ValueError("cross-encoder batch size is invalid")
    if not 64 <= args.cross_encoder_max_length <= 1024:
        raise ValueError("cross-encoder max length is invalid")

    key = args.eval_hmac_key.read_bytes().strip()
    if not key:
        raise ValueError("evaluation HMAC key is empty")
    dataset = load_json(args.dataset)
    if not isinstance(dataset, list):
        raise ValueError("dataset is invalid")
    baseline_rows = list(iter_sealed_rows(args.baseline_ledger))
    targets = _target_hmacs(baseline_rows)
    dataset_by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset
        if isinstance(item, dict)
    }
    if not targets.issubset(dataset_by_hmac):
        raise ValueError("target ledger rows cannot bind to the pinned dataset")
    source_by_query = load_temporal_source_lane_sources(args.temporal_source_lane_log)
    reranker, ranking_policy = _load_reranker(args)
    policy = {
        "candidatePolicy": {
            "sourceBoundary": "read_only_temporal_source_lane_lock",
            "role": "user_only",
            "topK": args.top_k,
            "usesBenchmarkHasAnswerBeforeSelection": False,
            **ranking_policy,
        },
        "selectorPolicy": {
            "version": SELECTOR_VERSION,
            "compiler": "paw.temporal-question-compiler.v1",
            "selection": "deterministic_facet_weighted_bounded_set_cover_v1",
            "ordinarySlotMaxTurns": MAX_SLOT_TURNS,
            "eventSetMaxTurns": MAX_EVENT_SET_TURNS,
            "packetMaxTurns": MAX_PACKET_TURNS,
            "eventSetSessionDiversity": "one_per_source_before_duplicates",
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
        ranked = (
            rank_semantic_rrf(question, locked, args.top_k, reranker, args.cross_encoder_batch_size)
            if reranker is not None
            else rank_bm25(question, locked, args.top_k)
        )
        plan = compile_question_plan(question)
        records = build_event_facet_records(ranked)
        selections = select_event_facet_packet(plan, records)
        certificates = [content_free_facet_certificate(selection, key) for selection in selections]
        _assert_content_free(certificates)
        selected_refs = {
            record.candidate.evidence_ref
            for selection in selections
            for record in selection.selected
        }
        # Evaluation begins only after the entire selection/certificate is frozen.
        gold_refs = answer_user_evidence_refs(item)
        rows.append(
            {
                "queryHmac": query_hmac,
                "queryCutoffHmac": keyed_revision(cutoff, key, "query-cutoff"),
                "lockedSourceSessionCount": len(source_hashes),
                "sourceLockRevisionHmac": keyed_revision(json.dumps(sorted(source_hashes)), key, "source-lock"),
                "rankedCandidateSetRevisionHmac": keyed_revision(
                    json.dumps([candidate.evidence_ref for candidate in ranked]), key, "ranked-candidate-set"
                ),
                "planStatus": "compiled" if plan is not None else "unsupported",
                "planOperator": plan.operator if plan is not None else None,
                "planUnit": plan.unit if plan is not None else None,
                "facetCertificate": certificates,
                "selectedEvidenceRefHmacs": sorted(hmac_ref(reference, key) for reference in selected_refs),
                "selectedCandidateCount": len(selected_refs),
                "goldUserEndpointCount": len(gold_refs),
                "selectedEndpointCoverageComplete": bool(gold_refs) and gold_refs.issubset(selected_refs),
                "selectedGoldEndpointCount": len(gold_refs & selected_refs),
            }
        )
        save_checkpoint(checkpoint, policy, rows)
        print(f"completed {index}/{len(targets)}", flush=True)

    rows.sort(key=lambda row: str(row["queryHmac"]))
    packet_sizes = [int(row["selectedCandidateCount"]) for row in rows]
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
            "selectedEndpointCoverageCompleteCount": sum(row["selectedEndpointCoverageComplete"] for row in rows),
            "meanSelectedCandidateCount": sum(packet_sizes) / len(packet_sizes) if packet_sizes else 0.0,
            "maxSelectedCandidateCount": max(packet_sizes, default=0),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
