"""Boundary-only builder for the sealed multi-session target address manifest.

This is the sole place in the evidence-set workflow that partitions benchmark
records.  It emits HMAC addresses only; the selector consumes that sealed list
and never receives the partition field.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

try:
    from .preference_user_authority_shadow import keyed_revision, sha256_file
    from .temporal_event_ledger_shadow import eval_hmac, load_json, required_string
except ImportError:
    from preference_user_authority_shadow import keyed_revision, sha256_file  # type: ignore[no-redef]
    from temporal_event_ledger_shadow import eval_hmac, load_json, required_string  # type: ignore[no-redef]


SCHEMA_VERSION = "paw.multi-session-evidence-set-target-manifest.v1"
TARGET_COUNT = 133


def build_target_manifest(dataset: list[dict[str, Any]], dataset_path: Path, key: bytes) -> dict[str, Any]:
    """Seal exactly the declared multi-session query addresses, with no contents."""

    selected = [
        eval_hmac(required_string(item, "question_id"), key)
        for item in dataset
        if item.get("question_type") == "multi-session"
    ]
    if len(selected) != TARGET_COUNT or len(selected) != len(set(selected)):
        raise ValueError("expected exactly 133 unique multi-session targets")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "contentFree": True,
        "artifactPolicy": {
            "datasetSha256": sha256_file(dataset_path),
            "hmacKeyId": keyed_revision("paw.multi-session-evidence-set", key, "key-id"),
            "producerCodeSha256": sha256_file(Path(__file__)),
        },
        "queryHmacs": sorted(selected),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    dataset = load_json(args.dataset)
    key = args.eval_hmac_key.read_bytes()
    if not isinstance(dataset, list) or not key or any(not isinstance(item, dict) for item in dataset):
        raise ValueError("target builder input is invalid")
    payload = build_target_manifest(dataset, args.dataset, key)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
