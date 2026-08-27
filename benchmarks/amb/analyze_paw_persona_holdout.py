"""Merge content-free persona holdout variants and compute pairwise outcomes."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_variants(paths: list[Path]) -> tuple[dict, list[dict]]:
    identity: dict | None = None
    variants: dict[str, dict] = {}
    for path in paths:
        report = json.loads(path.read_text(encoding="utf-8"))
        if report.get("schemaVersion") != "paw.amb-persona-holdout-result.v1":
            raise ValueError(f"unsupported persona holdout report: {path}")
        current_identity = {
            "dataset": report.get("dataset"),
            "split": report.get("split"),
            "partition": report.get("partition"),
            "queryFingerprints": report.get("queryFingerprints"),
            "personaFingerprints": report.get("personaFingerprints"),
            "historyPolicy": report.get("historyPolicy"),
        }
        if identity is None:
            identity = current_identity
        elif identity != current_identity:
            raise ValueError("persona holdout report identities do not match")
        for variant in report.get("variants", []):
            name = variant.get("variant")
            if not isinstance(name, str) or name in variants:
                raise ValueError("persona holdout variants must be uniquely named")
            variants[name] = variant
    if identity is None or not variants:
        raise ValueError("no persona holdout variants were loaded")
    return identity, list(variants.values())


def analyze(paths: list[Path]) -> dict:
    identity, variants = load_variants(paths)
    query_fingerprints = identity["queryFingerprints"]
    summaries = []
    correctness: dict[str, list[bool]] = {}
    for variant in variants:
        rows = variant.get("rows")
        if (
            not isinstance(rows, list)
            or [row.get("queryFingerprint") for row in rows] != query_fingerprints
        ):
            raise ValueError("persona holdout rows do not match the frozen query order")
        name = variant["variant"]
        correctness[name] = [bool(row.get("correct")) for row in rows]
        llm = variant.get("llmStats") or {}
        prompt_tokens = int(llm.get("promptTokens") or 0)
        summaries.append(
            {
                "variant": name,
                "correct": int(variant.get("correct") or 0),
                "accuracy": variant.get("accuracy"),
                "averageInitialContextTokens": variant.get(
                    "averageInitialContextTokens"
                ),
                "promptTokens": prompt_tokens,
                "completionTokens": int(llm.get("completionTokens") or 0),
                "promptCacheHitTokens": int(llm.get("promptCacheHitTokens") or 0),
                "promptCacheMissTokens": int(llm.get("promptCacheMissTokens") or 0),
                "providerCacheHitRatio": (
                    int(llm.get("promptCacheHitTokens") or 0) / prompt_tokens
                    if prompt_tokens
                    else None
                ),
                "memoryToolCalls": int(llm.get("memoryToolCalls") or 0),
                "memoryToolRounds": int(llm.get("memoryToolRounds") or 0),
                "memoryToolResultChars": int(llm.get("memoryToolResultChars") or 0),
            }
        )

    pairwise = []
    for left_index, left in enumerate(variants):
        for right in variants[left_index + 1 :]:
            left_name = left["variant"]
            right_name = right["variant"]
            pairs = list(zip(correctness[left_name], correctness[right_name]))
            pairwise.append(
                {
                    "from": left_name,
                    "to": right_name,
                    "improvements": sum(not a and b for a, b in pairs),
                    "regressions": sum(a and not b for a, b in pairs),
                    "bothCorrect": sum(a and b for a, b in pairs),
                    "bothWrong": sum(not a and not b for a, b in pairs),
                }
            )
    return {
        "schemaVersion": "paw.amb-persona-holdout-analysis.v1",
        **identity,
        "queryCount": len(query_fingerprints),
        "personaCount": len(identity["personaFingerprints"]),
        "variants": summaries,
        "pairwise": pairwise,
        "contentFree": True,
        "note": "Development architecture diagnostic; not a public AMB score.",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("reports", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = analyze(args.reports)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
