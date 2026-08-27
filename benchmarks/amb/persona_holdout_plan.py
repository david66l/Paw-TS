"""Build and validate content-free, persona-disjoint AMB evaluation plans."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Mapping, Sequence


SCHEMA_VERSION = "paw.amb-persona-disjoint-plan.v1"


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def parse_range(value: str) -> tuple[int, int]:
    """Parse a half-open query-index range such as ``0:189``."""
    pieces = value.split(":", 1)
    if len(pieces) != 2:
        raise argparse.ArgumentTypeError("range must use START:END")
    try:
        start, end = (int(piece) for piece in pieces)
    except ValueError as error:
        raise argparse.ArgumentTypeError("range bounds must be integers") from error
    if start < 0 or end <= start:
        raise argparse.ArgumentTypeError("range must satisfy 0 <= START < END")
    return start, end


def build_persona_disjoint_plan(
    queries: Sequence[object],
    *,
    excluded_ranges: Sequence[tuple[int, int]],
    partition_sizes: Mapping[str, int],
    seed: str,
) -> dict:
    """Select exactly one deterministic query for each previously unseen persona.

    Query text, answers, document IDs, and persona IDs are intentionally omitted
    from the returned plan. The runner later verifies the content-free hashes
    against the pinned dataset before making any model call.
    """
    if not seed:
        raise ValueError("seed must not be empty")
    if not partition_sizes or any(size < 0 for size in partition_sizes.values()):
        raise ValueError("partition sizes must be non-negative")
    requested = sum(partition_sizes.values())
    if requested < 1:
        raise ValueError("at least one persona must be requested")

    excluded_indexes: set[int] = set()
    normalized_ranges: list[tuple[int, int]] = []
    for start, end in excluded_ranges:
        if start < 0 or end <= start or end > len(queries):
            raise ValueError("excluded range is outside the query dataset")
        normalized_ranges.append((start, end))
        excluded_indexes.update(range(start, end))

    excluded_personas = {
        _query_user_id(queries[index]) for index in sorted(excluded_indexes)
    }
    candidates_by_persona: dict[str, list[tuple[int, object]]] = defaultdict(list)
    for index, query in enumerate(queries):
        user_id = _query_user_id(query)
        if index in excluded_indexes or user_id in excluded_personas:
            continue
        if not _query_gold_ids(query):
            continue
        candidates_by_persona[user_id].append((index, query))

    ranked_personas = sorted(
        candidates_by_persona,
        key=lambda user_id: sha(f"{seed}\0persona\0{user_id}"),
    )
    if len(ranked_personas) < requested:
        raise ValueError(
            f"requested {requested} personas but only {len(ranked_personas)} remain"
        )

    selected_rows: list[dict] = []
    for user_id in ranked_personas[:requested]:
        choices = candidates_by_persona[user_id]
        index, query = min(
            choices,
            key=lambda item: sha(f"{seed}\0query\0{_query_id(item[1])}"),
        )
        selected_rows.append(
            {
                "queryIndex": index,
                "queryFingerprint": sha(_query_id(query))[:20],
                "personaFingerprint": sha(user_id)[:20],
                "historyDocumentCount": len(_query_gold_ids(query)),
                "questionTypes": _question_types(query),
            }
        )

    partitions: dict[str, list[dict]] = {}
    cursor = 0
    for name, size in partition_sizes.items():
        if not name or not name.replace("_", "").isalnum():
            raise ValueError("partition names must be non-empty identifiers")
        partitions[name] = selected_rows[cursor : cursor + size]
        cursor += size

    plan = {
        "schemaVersion": SCHEMA_VERSION,
        "dataset": "personamem",
        "split": "32k",
        "policy": {
            "selection": "one-query-per-persona-hash-order-v1",
            "seedHash": sha(seed),
            "excludedRanges": [
                {"start": start, "end": end} for start, end in normalized_ranges
            ],
        },
        "population": {
            "queryCount": len(queries),
            "excludedPersonaCount": len(excluded_personas),
            "candidatePersonaCount": len(candidates_by_persona),
            "selectedPersonaCount": len(selected_rows),
        },
        "partitions": partitions,
        "note": (
            "Content-free plan. Each selected row belongs to a distinct persona; "
            "query text, answers, persona IDs, and document IDs are omitted."
        ),
    }
    validate_persona_disjoint_plan(plan, queries)
    return plan


def validate_persona_disjoint_plan(plan: Mapping, queries: Sequence[object]) -> None:
    """Fail closed if a plan drifted or reused a persona across partitions."""
    if plan.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported persona holdout plan schema")
    if plan.get("dataset") != "personamem" or plan.get("split") != "32k":
        raise ValueError("persona holdout plan targets a different dataset")
    partitions = plan.get("partitions")
    if not isinstance(partitions, Mapping) or not partitions:
        raise ValueError("persona holdout plan has no partitions")

    seen_personas: set[str] = set()
    seen_queries: set[int] = set()
    for name, raw_rows in partitions.items():
        if not isinstance(name, str) or not isinstance(raw_rows, list):
            raise ValueError("invalid persona holdout partition")
        for row in raw_rows:
            if not isinstance(row, Mapping):
                raise ValueError("invalid persona holdout row")
            index = row.get("queryIndex")
            if not isinstance(index, int) or index < 0 or index >= len(queries):
                raise ValueError("persona holdout query index is outside the dataset")
            query = queries[index]
            expected_query = sha(_query_id(query))[:20]
            expected_persona = sha(_query_user_id(query))[:20]
            if row.get("queryFingerprint") != expected_query:
                raise ValueError("persona holdout query fingerprint drifted")
            if row.get("personaFingerprint") != expected_persona:
                raise ValueError("persona holdout persona fingerprint drifted")
            if index in seen_queries:
                raise ValueError("persona holdout query was selected more than once")
            if expected_persona in seen_personas:
                raise ValueError("persona holdout reused a persona across partitions")
            seen_queries.add(index)
            seen_personas.add(expected_persona)


def queries_for_partition(
    plan: Mapping, queries: Sequence[object], partition: str
) -> list[object]:
    validate_persona_disjoint_plan(plan, queries)
    partitions = plan["partitions"]
    if partition not in partitions:
        raise ValueError(f"unknown persona holdout partition: {partition}")
    return [queries[row["queryIndex"]] for row in partitions[partition]]


def _query_id(query: object) -> str:
    value = getattr(query, "id", None)
    if not isinstance(value, str) or not value:
        raise ValueError("query is missing a stable ID")
    return value


def _query_user_id(query: object) -> str:
    value = getattr(query, "user_id", None)
    if not isinstance(value, str) or not value:
        raise ValueError("query is missing a persona/user ID")
    return value


def _query_gold_ids(query: object) -> list[str]:
    value = getattr(query, "gold_ids", None)
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("query has invalid history document IDs")
    return value


def _question_types(query: object) -> list[str]:
    meta = getattr(query, "meta", None)
    if not isinstance(meta, Mapping):
        return []
    value = meta.get("question_type")
    if isinstance(value, str) and value:
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return []


def _partition(value: str) -> tuple[str, int]:
    pieces = value.split("=", 1)
    if len(pieces) != 2 or not pieces[0]:
        raise argparse.ArgumentTypeError("partition must use NAME=COUNT")
    try:
        size = int(pieces[1])
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "partition count must be an integer"
        ) from error
    if size < 0:
        raise argparse.ArgumentTypeError("partition count must be non-negative")
    return pieces[0], size


def main() -> None:
    here = Path(__file__).resolve().parent
    upstream_src = here / "upstream" / "src"
    sys.path.insert(0, str(upstream_src))
    from memory_bench.dataset import get_dataset

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--exclude-range", action="append", type=parse_range, default=[]
    )
    parser.add_argument(
        "--partition",
        action="append",
        type=_partition,
        default=[],
        help="Repeat NAME=COUNT; personas never overlap between partitions.",
    )
    parser.add_argument("--seed", default="paw-amb-persona-split-v1")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    partition_sizes = dict(args.partition or [("dev", 6), ("test", 12)])
    if len(partition_sizes) != len(args.partition or partition_sizes):
        raise ValueError("partition names must be unique")
    queries = get_dataset("personamem").load_queries("32k")
    plan = build_persona_disjoint_plan(
        queries,
        excluded_ranges=args.exclude_range,
        partition_sizes=partition_sizes,
        seed=args.seed,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, indent=2), encoding="utf-8")
    print(json.dumps(plan, ensure_ascii=False))


if __name__ == "__main__":
    main()
