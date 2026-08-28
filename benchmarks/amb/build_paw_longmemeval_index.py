from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from memory_bench.dataset import get_dataset

from paw_provider import PawMemoryProvider
from run_paw_longmemeval_retrieval import (
    EXPECTED_LONGMEMEVAL_S_DOCUMENT_COUNT,
    EXPECTED_LONGMEMEVAL_S_QUERY_COUNT,
    ROOT,
    artifact_binding,
    configure_provider,
    local_embedding_artifact,
    resolved_release_provider_env,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Resume the local Paw LongMemEval-S index without answering queries."
    )
    parser.add_argument(
        "--store-dir",
        type=Path,
        default=(
            ROOT
            / "benchmarks"
            / "amb"
            / "runs"
            / "longmemeval"
            / "paw-longmemeval-full-500-v1-store"
        ),
    )
    parser.add_argument(
        "--log-name",
        default="paw-longmemeval-local-index-resume",
        help="Content-free retrieval log stem under logs/amb.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset = get_dataset("longmemeval")
    queries = list(dataset.load_queries("s"))
    user_ids = {query.user_id for query in queries if query.user_id}
    documents = dataset.load_documents("s", user_ids=user_ids)
    if len(queries) != EXPECTED_LONGMEMEVAL_S_QUERY_COUNT:
        raise RuntimeError(f"unexpected query count: {len(queries)}")
    if len(user_ids) != EXPECTED_LONGMEMEVAL_S_QUERY_COUNT:
        raise RuntimeError(f"unexpected user count: {len(user_ids)}")
    if len(documents) != EXPECTED_LONGMEMEVAL_S_DOCUMENT_COUNT:
        raise RuntimeError(f"unexpected document count: {len(documents)}")

    embedding_artifact = local_embedding_artifact()
    artifacts = artifact_binding(dataset, embedding_artifact)
    configure_provider(
        Path(args.log_name),
        resume=True,
        reuse_index=False,
        query_expansion=True,
        strict=True,
        source_artifact_sha256=artifacts["retrievalSourceArtifactSha256"],
        retrieval_environment=resolved_release_provider_env(embedding_artifact),
    )

    provider = PawMemoryProvider()
    started = time.perf_counter()
    try:
        provider.prepare(args.store_dir, unit_ids=user_ids, reset=False)
        provider.ingest(documents)
        stats = provider.stats()
    finally:
        provider.cleanup()

    print(
        json.dumps(
            {
                "status": "complete",
                "users": len(user_ids),
                "documents": len(documents),
                "elapsedSeconds": round(time.perf_counter() - started, 1),
                "provider": {
                    "requiredEmbeddings": stats.get("requiredEmbeddings"),
                    "presentRequiredEmbeddings": stats.get(
                        "presentRequiredEmbeddings"
                    ),
                    "incompleteUsers": stats.get("incompleteUsers"),
                },
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
