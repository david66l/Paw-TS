"""Small real-DB/real-model smoke for Paw M2a atom ingest (not an AMB score)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
UPSTREAM_SRC = HERE / "upstream" / "src"
sys.path.insert(0, str(UPSTREAM_SRC))
sys.path.insert(0, str(HERE))


def configure_deepseek() -> None:
    settings_path = ROOT / ".paw" / "settings.local.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        provider_name = settings.get("provider", "deepseekv4flash")
        config = settings.get("models", {}).get(provider_name, {})
        if config.get("apiKey"):
            os.environ.setdefault("DEEPSEEK_API_KEY", config["apiKey"])
        if config.get("baseUrl"):
            os.environ.setdefault("DEEPSEEK_BASE_URL", config["baseUrl"])
        if config.get("model"):
            os.environ.setdefault("DEEPSEEK_MODEL", config["model"])
    if not os.environ.get("DEEPSEEK_API_KEY"):
        raise RuntimeError("DeepSeek credential is not configured")


def main() -> None:
    configure_deepseek()
    # Match the isolated local AMB Postgres container used by the benchmark
    # harness. An explicitly supplied DATABASE_URL always wins.
    os.environ.setdefault(
        "DATABASE_URL",
        "postgresql://postgres@127.0.0.1:54329/paw_memory_test",
    )
    os.environ["PAW_AMB_INGEST_MODE"] = "atom"
    os.environ.setdefault("PAW_AMB_RETRIEVAL_POLICY", "rrf")
    os.environ.setdefault(
        "PAW_AMB_LOG", str(ROOT / "logs" / "amb" / "paw-m2a-atom-smoke.jsonl")
    )
    from memory_bench.models import Document
    from paw_provider import PawMemoryProvider

    provider = PawMemoryProvider()
    try:
        provider.prepare(
            HERE / "runs" / "paw-m2a-atom-smoke-store",
            unit_ids={"atom-smoke-user"},
            reset=True,
        )
        provider.ingest(
            [
                Document(
                    id="atom-smoke-document",
                    user_id="atom-smoke-user",
                    content=(
                        "请记住：我偏好使用中文编写技术文档。"
                        "这个偏好适用于以后的项目说明、设计文档和实施日志。"
                    ),
                )
            ]
        )
        documents, raw = provider.retrieve(
            "用户偏好用什么语言编写技术文档？",
            k=5,
            user_id="atom-smoke-user",
        )
        if not documents:
            raise RuntimeError("Atom smoke stored no retrievable memory")
        stats = provider.stats()
        atom_budget = stats.get("atomBudget") or {}
        atom_checkpoint = stats.get("atomCheckpoint") or {}
        result = {
            "schemaVersion": "paw.amb-atom-smoke.v1",
            "variant": provider.variant,
            "returned": len(documents),
            "sourceDocumentRecovered": any(
                document.id == "atom-smoke-document" for document in documents
            ),
            "providerStatus": (raw or {}).get("status"),
            "ingestMode": (raw or {}).get("ingestMode"),
            "atomRemoteCalls": atom_budget.get("remoteCalls"),
            "atomWriteCacheHits": atom_budget.get("cacheHits"),
            "checkpointCompleted": atom_checkpoint.get("completedCount"),
            "note": "Real model/store smoke only; this is not an AMB score.",
        }
        output = HERE / "runs" / "paw-m2a-atom-smoke.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
    finally:
        provider.cleanup()


if __name__ == "__main__":
    main()
