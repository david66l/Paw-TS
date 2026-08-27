"""Credential-free provider smoke over AMB's published PersonaMem artifact."""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE / "upstream" / "src"))
sys.path.insert(0, str(HERE))

from memory_bench.models import Document  # noqa: E402
from paw_provider import PawMemoryProvider  # noqa: E402


def load(name: str):
    path = HERE / "upstream" / "data" / "personamem" / "32k" / name
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    documents = load("documents.json.gz")
    queries = load("queries.json.gz")
    query = queries[0]
    unit_documents = [doc for doc in documents if doc.get("user_id") == query["user_id"]]
    provider = PawMemoryProvider()
    try:
        provider.initialize()
        provider.prepare(
            HERE / "runs" / "paw-provider-smoke-store",
            unit_ids={query["user_id"]},
            reset=True,
        )
        provider.ingest([Document(**doc) for doc in unit_documents])
        retrieval_query = query.get("meta", {}).get("retrieval_query") or query["query"]
        first, first_raw = provider.retrieve(retrieval_query, k=10, user_id=query["user_id"])
        second, second_raw = provider.retrieve(retrieval_query, k=10, user_id=query["user_id"])
        provider.ingest([Document(**unit_documents[0])])
        after_write, after_write_raw = provider.retrieve(
            retrieval_query, k=10, user_id=query["user_id"]
        )
        result = {
            "schemaVersion": "paw.amb-provider-smoke.v1",
            "upstreamCommit": "62364d7ead2dc1a7225d6daf4ae23f303b925b40",
            "dataset": "personamem",
            "split": "32k",
            "queryId": query["id"],
            "ingestedDocuments": len(unit_documents),
            "firstRetrieved": len(first),
            "secondRetrieved": len(second),
            "afterWriteRetrieved": len(after_write),
            "goldDocumentHit": any(doc.id in set(query["gold_ids"]) for doc in first),
            "secondCacheEvents": [
                event["event"] for event in (second_raw or {}).get("cacheEvents", [])
            ],
            "afterWriteCacheEvents": [
                event["event"]
                for event in (after_write_raw or {}).get("cacheEvents", [])
            ],
            "cacheStats": (after_write_raw or {}).get("cacheStats"),
            "providerStatus": (after_write_raw or {}).get("status"),
            "note": "Provider-only smoke; no answer model or AMB score was used.",
        }
        output = HERE / "runs" / "paw-provider-smoke.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))
        cache_is_safe = (
            "hit" in result["secondCacheEvents"]
            and "miss" in result["afterWriteCacheEvents"]
            and "store" in result["afterWriteCacheEvents"]
        )
        return 0 if cache_is_safe and second and after_write else 1
    finally:
        provider.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
