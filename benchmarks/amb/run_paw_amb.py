"""Register Paw in the pinned official AMB CLI without patching upstream."""

from __future__ import annotations

import sys
import types
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM_SRC = HERE / "upstream" / "src"
sys.path.insert(0, str(UPSTREAM_SRC))
sys.path.insert(0, str(HERE))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


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
    os.environ.setdefault("OMB_ANSWER_LLM", "deepseek")
    os.environ.setdefault("OMB_JUDGE_LLM", "deepseek")


ROOT = HERE.parents[1]
configure_deepseek()

from paw_provider import PawMemoryProvider  # noqa: E402
from deepseek_llm import DeepSeekFlashLLM  # noqa: E402

# Avoid importing every optional upstream provider. In particular, the pinned
# Hindsight dependency pulls uvloop, which has no Windows build. The official
# runner only needs this package-level registry plus memory.base.
memory_package = types.ModuleType("memory_bench.memory")
memory_package.__path__ = [str(UPSTREAM_SRC / "memory_bench" / "memory")]
sys.modules["memory_bench.memory"] = memory_package

from memory_bench.memory.base import MemoryProvider  # noqa: E402

REGISTRY = {"paw": PawMemoryProvider}


def get_memory_provider(name: str) -> MemoryProvider:
    if name not in REGISTRY:
        raise ValueError(f"Unknown memory provider: {name!r}. Available: {list(REGISTRY)}")
    return REGISTRY[name]()


memory_package.MemoryProvider = MemoryProvider
memory_package.REGISTRY = REGISTRY
memory_package.get_memory_provider = get_memory_provider

from memory_bench import llm as llm_package  # noqa: E402

llm_package.REGISTRY["deepseek"] = DeepSeekFlashLLM

from memory_bench import cli as cli_package  # noqa: E402


def resolve_deepseek_key() -> None:
    if not os.environ.get("DEEPSEEK_API_KEY"):
        import typer

        typer.echo(
            "Error: DEEPSEEK_API_KEY is not set and Paw's credential slot is unavailable.",
            err=True,
        )
        raise typer.Exit(1)


cli_package._resolve_gemini_key = resolve_deepseek_key
app = cli_package.app


if __name__ == "__main__":
    app()
