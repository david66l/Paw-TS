"""Verify and run the pinned LongMemEval-S benchmark from a local checkout."""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import runpy
import secrets
import socket
import sys
import urllib.request
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
UPSTREAM = HERE / "upstream"
DATASET_PATH = UPSTREAM / ".datasets" / "longmemeval" / "longmemeval_s_cleaned.json"
UPSTREAM_COMMIT_PATH = HERE / "UPSTREAM_COMMIT"
EXPECTED_DATASET_BYTES = 277_383_467
EXPECTED_DATASET_SHA256 = (
    "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"
)
EXPECTED_UPSTREAM_COMMIT = "62364d7ead2dc1a7225d6daf4ae23f303b925b40"
EXPECTED_QUERY_TYPES = {
    "knowledge-update": 78,
    "single-session-preference": 30,
    "multi-session": 133,
    "temporal-reasoning": 133,
    "single-session-user": 70,
    "single-session-assistant": 56,
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_local_dataset() -> dict[str, object]:
    if not DATASET_PATH.is_file():
        raise RuntimeError(f"LongMemEval-S dataset is missing: {DATASET_PATH}")
    if DATASET_PATH.stat().st_size != EXPECTED_DATASET_BYTES:
        raise RuntimeError("LongMemEval-S dataset byte size is incompatible")
    if file_sha256(DATASET_PATH) != EXPECTED_DATASET_SHA256:
        raise RuntimeError("LongMemEval-S dataset SHA-256 is incompatible")
    if not UPSTREAM_COMMIT_PATH.is_file():
        raise RuntimeError("AMB upstream commit pin is missing")
    if UPSTREAM_COMMIT_PATH.read_text(encoding="utf-8").strip() != EXPECTED_UPSTREAM_COMMIT:
        raise RuntimeError("AMB upstream commit pin is incompatible")

    sys.path.insert(0, str(UPSTREAM / "src"))
    from memory_bench.dataset import get_dataset

    dataset = get_dataset("longmemeval")
    queries = [
        query
        for question_type in EXPECTED_QUERY_TYPES
        for query in dataset.load_queries("s", category=question_type)
    ]
    query_ids = [query.id for query in queries]
    user_ids = [query.user_id for query in queries]
    if len(queries) != 500 or len(set(query_ids)) != 500:
        raise RuntimeError("LongMemEval-S must expose exactly 500 unique queries")
    if any(not user_id for user_id in user_ids) or len(set(user_ids)) != 500:
        raise RuntimeError("LongMemEval-S must expose exactly 500 isolated users")
    observed_types = collections.Counter(
        query.meta.get("question_type") for query in queries
    )
    if dict(observed_types) != EXPECTED_QUERY_TYPES:
        raise RuntimeError("LongMemEval-S question type counts are incompatible")
    documents = dataset.load_documents("s", user_ids=set(user_ids))
    if len(documents) != 23_867:
        raise RuntimeError("LongMemEval-S must expose exactly 23,867 documents")
    return {
        "schemaVersion": "paw.local-longmemeval-verification.v1",
        "dataset": "LongMemEval-S",
        "datasetBytes": EXPECTED_DATASET_BYTES,
        "datasetSha256": EXPECTED_DATASET_SHA256,
        "upstreamCommit": EXPECTED_UPSTREAM_COMMIT,
        "queries": len(queries),
        "users": len(set(user_ids)),
        "documents": len(documents),
        "questionTypeCounts": observed_types,
        "contentFree": True,
    }


def require_tcp_service(host: str, port: int, label: str) -> None:
    try:
        with socket.create_connection((host, port), timeout=3):
            return
    except OSError as error:
        raise RuntimeError(f"{label} is unavailable at {host}:{port}") from error


def require_embedding_service() -> None:
    require_tcp_service("127.0.0.1", 18081, "local embedding service")
    with urllib.request.urlopen("http://127.0.0.1:18081/health", timeout=5) as response:
        payload = json.loads(response.read())
    if payload.get("status") != "ok" or payload.get("dimensions") != 1536:
        raise RuntimeError("local embedding service identity is incompatible")


def load_or_create_seed(path: Path) -> str:
    if path.exists():
        seed = path.read_text(encoding="utf-8").strip()
        if len(seed) < 32:
            raise RuntimeError("local selection seed is too short")
        return seed
    path.parent.mkdir(parents=True, exist_ok=True)
    seed = secrets.token_hex(32)
    path.write_text(seed, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return seed


def run_local(args: argparse.Namespace) -> None:
    verify_local_dataset()
    require_tcp_service("127.0.0.1", 54329, "PostgreSQL")
    require_embedding_service()

    run_root = HERE / "runs" / "longmemeval" / "local"
    run_root.mkdir(parents=True, exist_ok=True)
    seed_path = args.seed_file or run_root / ".secrets" / "selection.seed"
    seed = load_or_create_seed(seed_path)
    output = args.output or run_root / f"paw-local-{args.mode}.json"
    log_path = output.with_suffix(".retrieval.jsonl")
    cache_dir = output.with_suffix(".llm-cache")
    os.environ.setdefault("PAW_AMB_LOG", str(log_path))
    os.environ.setdefault("PAW_AMB_LLM_CACHE_DIR", str(cache_dir))

    runner_args = [
        str(HERE / "run_paw_longmemeval_retrieval.py"),
        "--output",
        str(output),
        "--store-key",
        f"paw-local-longmemeval-{args.mode}-v1",
        "--seed",
        seed,
    ]
    if args.mode == "full":
        runner_args.append("--full-split")
    else:
        runner_args.extend(("--per-type", "1"))
    if not args.retrieval_only:
        runner_args.append("--answer")
    if args.reuse_index:
        runner_args.append("--reuse-index")
    runner_args.append(
        "--no-query-expansion" if args.no_query_expansion else "--query-expansion"
    )
    sys.argv = runner_args
    runpy.run_path(str(HERE / "run_paw_longmemeval_retrieval.py"), run_name="__main__")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("verify", help="Verify the pinned local dataset only.")
    run_parser = subparsers.add_parser("run", help="Run a local smoke or full suite.")
    run_parser.add_argument("--mode", choices=("smoke", "full"), default="smoke")
    run_parser.add_argument("--output", type=Path)
    run_parser.add_argument("--seed-file", type=Path)
    run_parser.add_argument("--retrieval-only", action="store_true")
    run_parser.add_argument("--reuse-index", action="store_true")
    run_parser.add_argument("--no-query-expansion", action="store_true")
    args = parser.parse_args()
    if args.command == "verify":
        print(json.dumps(verify_local_dataset(), ensure_ascii=False, indent=2))
    else:
        run_local(args)


if __name__ == "__main__":
    main()
