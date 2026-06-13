#!/usr/bin/env python3
"""
Download open-source benchmark datasets and cache as JSON for TypeScript tests.

Usage:
    python benchmarks/download-data.py

Requires:
    pip install datasets tqdm
"""

import json
import os
from pathlib import Path

from datasets import load_dataset

CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR.mkdir(exist_ok=True)


def save_jsonl(path: Path, records: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def download_repobench(max_samples: int = 200) -> None:
    """Download RepoBench cross-file first subset (Python)."""
    print("Downloading RepoBench...")
    try:
        ds = load_dataset("RepoBench", "cross_file_first", split="test")
    except Exception as e:
        print(f"  Failed to load RepoBench/cross_file_first: {e}")
        print("  Trying fallback: tianyang/repobench ...")
        try:
            ds = load_dataset("tianyang/repobench", "cross_file_first", split="test")
        except Exception as e2:
            print(f"  Fallback also failed: {e2}")
            return

    samples = []
    for i, row in enumerate(ds):
        if i >= max_samples:
            break
        samples.append({
            "id": f"repo-{i}",
            "prefix": row.get("prefix", ""),
            "in_file": row.get("in_file", ""),
            "ground_truth": row.get("ground_truth", ""),
            "crossfile_context": row.get("crossfile_context", []),
            "metadata": {k: v for k, v in row.items() if k not in {
                "prefix", "in_file", "ground_truth", "crossfile_context"
            }},
        })

    save_jsonl(CACHE_DIR / "repobench.jsonl", samples)
    print(f"  Saved {len(samples)} samples to {CACHE_DIR / 'repobench.jsonl'}")


def download_longbench_code(max_samples: int = 100) -> None:
    """Download LongBench code subset."""
    print("Downloading LongBench (code)...")
    try:
        ds = load_dataset("THUDM/LongBench", "code", split="test")
    except Exception as e:
        print(f"  Failed to load THUDM/LongBench/code: {e}")
        return

    samples = []
    for i, row in enumerate(ds):
        if i >= max_samples:
            break
        samples.append({
            "id": f"long-{i}",
            "context": row.get("context", ""),
            "input": row.get("input", ""),
            "answers": row.get("answers", []),
            "length": len(row.get("context", "")),
        })

    save_jsonl(CACHE_DIR / "longbench-code.jsonl", samples)
    print(f"  Saved {len(samples)} samples to {CACHE_DIR / 'longbench-code.jsonl'}")


if __name__ == "__main__":
    download_repobench(max_samples=200)
    download_longbench_code(max_samples=100)
    print(f"\nAll datasets cached in {CACHE_DIR}")
