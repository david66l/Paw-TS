"""Small local OpenAI-compatible embedding server for Paw AMB dense ablations."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np
import torch
from huggingface_hub import snapshot_download
from sentence_transformers import SentenceTransformer


MODEL = os.environ.get(
    "PAW_LOCAL_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
)
HOST = os.environ.get("PAW_LOCAL_EMBEDDING_HOST", "127.0.0.1")
PORT = int(os.environ.get("PAW_LOCAL_EMBEDDING_PORT", "18081"))
OUTPUT_DIMENSIONS = 1536
WINDOW_WORDS = int(os.environ.get("PAW_LOCAL_EMBEDDING_WINDOW_WORDS", "180"))
WINDOW_OVERLAP_WORDS = int(
    os.environ.get("PAW_LOCAL_EMBEDDING_WINDOW_OVERLAP_WORDS", "30")
)
TORCH_THREADS = int(os.environ.get("PAW_LOCAL_EMBEDDING_TORCH_THREADS", "8"))
if not 32 <= WINDOW_WORDS <= 240:
    raise RuntimeError("PAW_LOCAL_EMBEDDING_WINDOW_WORDS must be between 32 and 240")
if not 0 <= WINDOW_OVERLAP_WORDS < WINDOW_WORDS:
    raise RuntimeError("PAW_LOCAL_EMBEDDING_WINDOW_OVERLAP_WORDS is invalid")
if not 1 <= TORCH_THREADS <= 8:
    raise RuntimeError("PAW_LOCAL_EMBEDDING_TORCH_THREADS must be between 1 and 8")
LOG_PATH = Path(
    os.environ.get(
        "PAW_LOCAL_EMBEDDING_LOG",
        str(Path(__file__).resolve().parents[2] / "logs" / "amb" / "local-embedding.jsonl"),
    )
)

# Encoding is serialized below. Keeping PyTorch and HTTP on one bounded worker
# avoids per-request thread-local allocator growth during a multi-thousand-turn
# benchmark ingest, while preserving exactly the same embedding function.
torch.set_num_threads(TORCH_THREADS)
torch.set_num_interop_threads(1)
DEFAULT_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
REVISION = os.environ.get("PAW_LOCAL_EMBEDDING_REVISION", DEFAULT_REVISION)


def artifact_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(
        (item for item in root.rglob("*") if item.is_file()),
        key=lambda item: item.relative_to(root).as_posix(),
    ):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


_model_snapshot = Path(snapshot_download(repo_id=MODEL, revision=REVISION))
MODEL_ARTIFACT_SHA256 = artifact_sha256(_model_snapshot)
_model = SentenceTransformer(str(_model_snapshot))
_native_dimensions = _model.get_sentence_embedding_dimension()
if not isinstance(_native_dimensions, int) or not 1 <= _native_dimensions <= OUTPUT_DIMENSIONS:
    raise RuntimeError(
        f"Local embedding dimension must be between 1 and {OUTPUT_DIMENSIONS}"
    )
_encode_lock = Lock()
_log_lock = Lock()


def log(event: str, detail: dict[str, Any]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schemaVersion": "paw.local-embedding-log.v1",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event,
        "detail": detail,
    }
    with _log_lock:
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def embed(texts: list[str]) -> list[list[float]]:
    started = time.perf_counter()
    windows: list[str] = []
    ranges: list[tuple[int, int]] = []
    for text in texts:
        start = len(windows)
        words = text.split()
        step = WINDOW_WORDS - WINDOW_OVERLAP_WORDS
        for offset in range(0, max(1, len(words)), step):
            window = " ".join(words[offset : offset + WINDOW_WORDS])
            if window:
                windows.append(window)
            if offset + WINDOW_WORDS >= len(words):
                break
        ranges.append((start, len(windows)))
    with _encode_lock:
        window_vectors = _model.encode(
            windows,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    output = []
    for start, end in ranges:
        vector = np.mean(window_vectors[start:end], axis=0)
        norm = float(np.linalg.norm(vector))
        if norm > 0:
            vector = vector / norm
        values = [float(value) for value in vector.tolist()]
        values.extend([0.0] * (OUTPUT_DIMENSIONS - len(values)))
        output.append(values)
    log(
        "embedding_batch",
        {
            "model": MODEL,
            "revision": REVISION,
            "artifactSha256": MODEL_ARTIFACT_SHA256,
            "count": len(texts),
            "windowCount": len(windows),
            "inputHashes": [hashlib.sha256(text.encode("utf-8")).hexdigest() for text in texts],
            "nativeDimensions": _native_dimensions,
            "outputDimensions": OUTPUT_DIMENSIONS,
            "windowWords": WINDOW_WORDS,
            "windowOverlapWords": WINDOW_OVERLAP_WORDS,
            "torchThreads": TORCH_THREADS,
            "transportMode": "single-thread-bounded",
            "durationMs": round((time.perf_counter() - started) * 1000, 1),
        },
    )
    return output


class Handler(BaseHTTPRequestHandler):
    server_version = "PawLocalEmbedding/1"

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in {"/health", "/v1/models"}:
            self._json(404, {"error": "not_found"})
            return
        if self.path.rstrip("/") == "/health":
            self._json(
                200,
                {
                    "status": "ok",
                    "model": MODEL,
                    "revision": REVISION,
                    "artifactSha256": MODEL_ARTIFACT_SHA256,
                    "dimensions": OUTPUT_DIMENSIONS,
                    "windowWords": WINDOW_WORDS,
                    "windowOverlapWords": WINDOW_OVERLAP_WORDS,
                    "torchThreads": TORCH_THREADS,
                    "transportMode": "single-thread-bounded",
                },
            )
            return
        self._json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in {"/embeddings", "/v1/embeddings"}:
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 8 * 1024 * 1024:
                raise ValueError("invalid_content_length")
            payload = json.loads(self.rfile.read(length))
            raw_input = payload.get("input")
            texts = [raw_input] if isinstance(raw_input, str) else raw_input
            if (
                not isinstance(texts, list)
                or not texts
                or len(texts) > 64
                or not all(isinstance(text, str) and text.strip() for text in texts)
            ):
                raise ValueError("invalid_input")
            vectors = embed(texts)
            self._json(
                200,
                {
                    "object": "list",
                    "model": MODEL,
                    "data": [
                        {"object": "embedding", "index": index, "embedding": vector}
                        for index, vector in enumerate(vectors)
                    ],
                    "usage": {"prompt_tokens": 0, "total_tokens": 0},
                },
            )
        except (ValueError, json.JSONDecodeError) as error:
            self._json(400, {"error": error.__class__.__name__})
        except Exception as error:  # pragma: no cover - defensive server boundary
            log("embedding_failed", {"errorCode": error.__class__.__name__})
            self._json(500, {"error": error.__class__.__name__})

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    log(
        "server_start",
        {
            "model": MODEL,
            "revision": REVISION,
            "artifactSha256": MODEL_ARTIFACT_SHA256,
            "host": HOST,
            "port": PORT,
            "nativeDimensions": _native_dimensions,
            "outputDimensions": OUTPUT_DIMENSIONS,
            "windowWords": WINDOW_WORDS,
            "windowOverlapWords": WINDOW_OVERLAP_WORDS,
            "torchThreads": TORCH_THREADS,
            "transportMode": "single-thread-bounded",
        },
    )
    print(
        json.dumps(
            {
                "status": "ready",
                "baseUrl": f"http://{HOST}:{PORT}/v1",
                "model": MODEL,
                "revision": REVISION,
                "nativeDimensions": _native_dimensions,
                "outputDimensions": OUTPUT_DIMENSIONS,
                "windowWords": WINDOW_WORDS,
                "windowOverlapWords": WINDOW_OVERLAP_WORDS,
                "torchThreads": TORCH_THREADS,
                "transportMode": "single-thread-bounded",
            }
        ),
        flush=True,
    )
    try:
        HTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        log("server_stop", {"reason": "keyboard_interrupt"})
        sys.exit(0)
