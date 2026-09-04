"""Integrity tests for LongMemEval full-split shard merging."""

from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path

import pytest

from merge_paw_longmemeval_slices import (
    OFFICIAL_FULL_SPLIT_COUNTS,
    load_validated_slices,
)


def _write_slice(root: Path, index: int, count: int, rows: list[dict]) -> Path:
    public_path = root / f"slice{index}.json"
    sealed_path = root / f"slice{index}-sealed.json"
    type_counts = dict(Counter(row["questionType"] for row in rows))
    sealed = {
        "schemaVersion": "sealed.v1",
        "runnerPolicy": "runner.v1",
        "memoryPolicy": "memory.v1",
        "searchPolicy": "search.v1",
        "queryExpansionEnabled": True,
        "k": 8,
        "manifest": {
            "schemaVersion": "manifest.v1",
            "dataset": "longmemeval",
            "split": "s",
            "seed": "secret",
            "seedCommitment": "commitment",
            "evalKeyId": "key",
            "fullSplit": True,
            "selectionPolicy": f"official-full-split-seeded-order-v1+query-slice-{index}-of-{count}",
            "queryCount": len(rows),
            "documentCount": len(rows),
            "queryHmacs": [row["queryHmac"] for row in rows],
            "userHmacs": [f"u-{row['queryHmac']}" for row in rows],
            "questionTypeCounts": type_counts,
            "questionTypeTargets": type_counts,
            "historyDocumentCounts": [1] * len(rows),
            "answerProtocol": "evidence_policy",
            "longMemEvalProtocol": {
                "sourceIdentityPolicy": "dataset-scoped-physical-id-v1",
                "physicalDocumentIdCollisionCount": index,
            },
            "experimentProtocol": {
                "common": {
                    "readerFeatureFlags": {
                        "recommendationUserAuthorityMode": "replace"
                    }
                }
            },
        },
        "rows": rows,
    }
    sealed_bytes = json.dumps(sealed).encode()
    sealed_path.write_bytes(sealed_bytes)
    public_path.write_text(
        json.dumps(
            {
                "sealedLedger": {
                    "sha256": hashlib.sha256(sealed_bytes).hexdigest(),
                    "rowCount": len(rows),
                }
            }
        ),
        encoding="utf-8",
    )
    return public_path


def _full_rows() -> list[dict]:
    rows = []
    index = 0
    for question_type, count in OFFICIAL_FULL_SPLIT_COUNTS.items():
        for _ in range(count):
            rows.append({"queryHmac": f"q-{index}", "questionType": question_type})
            index += 1
    return rows


def test_full_split_merge_validates_complete_disjoint_union(tmp_path: Path) -> None:
    rows = _full_rows()
    paths = [_write_slice(tmp_path, index, 2, rows[index::2]) for index in range(2)]
    merged, metadata, configuration = load_validated_slices(paths)
    assert len(merged) == 500
    assert [item["sliceIndex"] for item in metadata] == [0, 1]
    assert configuration["manifest"]["fullSplit"] is True


def test_merge_rejects_duplicate_missing_or_mismatched_slices(tmp_path: Path) -> None:
    rows = _full_rows()
    paths = [_write_slice(tmp_path, index, 2, rows[index::2]) for index in range(2)]
    with pytest.raises(ValueError, match="duplicated or inconsistent"):
        load_validated_slices([paths[0], paths[0]])
    with pytest.raises(ValueError, match="at least two"):
        load_validated_slices(paths[:1])

    sealed_path = tmp_path / "slice1-sealed.json"
    sealed = json.loads(sealed_path.read_text())
    sealed["manifest"]["experimentProtocol"]["common"]["readerFeatureFlags"][
        "recommendationUserAuthorityMode"
    ] = "off"
    sealed_bytes = json.dumps(sealed).encode()
    sealed_path.write_bytes(sealed_bytes)
    public_path = tmp_path / "slice1.json"
    public = json.loads(public_path.read_text())
    public["sealedLedger"]["sha256"] = hashlib.sha256(sealed_bytes).hexdigest()
    public_path.write_text(json.dumps(public))
    with pytest.raises(ValueError, match="configurations"):
        load_validated_slices(paths)
