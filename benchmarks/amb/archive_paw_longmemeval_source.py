from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

from run_paw_longmemeval_retrieval import (
    ROOT,
    SOURCE_ARTIFACT_POLICY,
    source_artifact_paths,
    source_artifact_sha256,
)


BUNDLE_SCHEMA = "paw.longmemeval-source-bundle.v1"
MANIFEST_NAME = "_paw_longmemeval_source_manifest.json"


def create_source_bundle(output: Path) -> dict:
    root = ROOT.resolve()
    paths = source_artifact_paths()
    files = [
        {
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in paths
    ]
    manifest = {
        "schemaVersion": BUNDLE_SCHEMA,
        "sourceArtifactPolicy": SOURCE_ARTIFACT_POLICY,
        "sourceArtifactSha256": source_artifact_sha256(paths),
        "fileCount": len(files),
        "files": files,
    }
    manifest_bytes = json.dumps(
        manifest,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        output,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for path, item in zip(paths, files, strict=True):
            write_deterministic(archive, item["path"], path.read_bytes())
        write_deterministic(archive, MANIFEST_NAME, manifest_bytes)
    return {
        **manifest,
        "bundleSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "bundleBytes": output.stat().st_size,
    }


def write_deterministic(
    archive: zipfile.ZipFile,
    name: str,
    content: bytes,
) -> None:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--manifest-output", required=True, type=Path)
    args = parser.parse_args()
    manifest = create_source_bundle(args.output)
    args.manifest_output.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_output.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
