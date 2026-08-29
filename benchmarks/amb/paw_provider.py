from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

from memory_bench.models import Document


class PawMemoryProvider:
    """AMB adapter for Paw's scoped memory provider and ingest ablations."""

    name = "paw"
    description = "Paw M1 Postgres RRF retrieval with revision-safe read-through cache."
    kind = "local"
    provider = "paw"
    variant = "m1-rrf-retrieval-only"
    concurrency = 1

    def __init__(self) -> None:
        retrieval_policy = os.environ.get("PAW_AMB_RETRIEVAL_POLICY", "rrf").strip().lower()
        ingest_mode = os.environ.get("PAW_AMB_INGEST_MODE", "raw_chunk").strip().lower()
        context_mode = os.environ.get("PAW_AMB_ATOM_CONTEXT_MODE", "atom_only").strip().lower()
        if retrieval_policy not in {"legacy", "rrf"}:
            raise ValueError(
                "PAW_AMB_RETRIEVAL_POLICY must be either 'legacy' or 'rrf'"
            )
        if ingest_mode not in {"raw_chunk", "atom"}:
            raise ValueError("PAW_AMB_INGEST_MODE must be 'raw_chunk' or 'atom'")
        self.description = (
            f"Paw Postgres {retrieval_policy.upper()} retrieval with "
            f"{ingest_mode} ingest ({context_mode}) and revision-safe read-through cache."
        )
        self.variant = (
            f"m2a-{retrieval_policy}-atom-{context_mode}"
            if ingest_mode == "atom"
            else f"m1-{retrieval_policy}-retrieval-only"
        )
        self._process: subprocess.Popen[str] | None = None
        self._next_id = 0
        self._lock = threading.Lock()
        self._memory_tool_calls = 0
        self._memory_tool_result_chars = 0

    def initialize(self) -> None:
        if self._process is not None:
            return
        root = Path(__file__).resolve().parents[2]
        bridge = Path(__file__).with_name("paw-memory-bridge.ts")
        env = os.environ.copy()
        env.setdefault("PAW_AMB_LOG", str(root / "logs" / "amb" / "paw-memory-bridge.jsonl"))
        bun = (
            shutil.which("bun.cmd")
            if os.name == "nt"
            else shutil.which("bun")
        )
        if not bun:
            raise RuntimeError("Bun executable was not found")
        self._process = subprocess.Popen(
            [bun, "run", str(bridge)],
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def cleanup(self) -> None:
        process = self._process
        if process is None:
            return
        try:
            if process.poll() is None:
                self._call("cleanup")
        finally:
            if process.stdin:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            if process.poll() is None:
                process.wait(timeout=15)
            self._process = None

    def prepare(
        self,
        store_dir: Path,
        unit_ids: set[str] | None = None,
        reset: bool = True,
    ) -> None:
        self.initialize()
        result = self._call(
            "prepare",
            storeDir=str(store_dir.resolve()),
            unitIds=sorted(unit_ids) if unit_ids else [],
            reset=reset,
        )
        source_local_required = os.environ.get(
            "PAW_AMB_SOURCE_LOCAL_LOCATOR", ""
        ).strip().lower() in {"1", "true"}
        if source_local_required and (
            not isinstance(result, dict)
            or not result.get("sourceLocalLocatorConfigured", False)
        ):
            raise RuntimeError(
                "Paw AMB bridge did not configure the required source-local locator"
            )

    def ingest(self, documents: list[Document]) -> None:
        self._call(
            "ingest",
            documents=[
                {
                    "id": document.id,
                    "content": document.content,
                    "user_id": document.user_id,
                    "timestamp": document.timestamp,
                }
                for document in documents
            ],
        )

    async def async_ingest(self, documents: list[Document]) -> None:
        await asyncio.to_thread(self.ingest, documents)

    def retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        response = self._call(
            "retrieve",
            query=query,
            k=k,
            userId=user_id,
            queryTimestamp=query_timestamp,
        )
        documents = [
            Document(
                id=item["id"],
                content=item["content"],
                user_id=item.get("user_id"),
            )
            for item in response["documents"]
        ]
        return documents, response.get("rawResponse")

    async def async_retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        return await asyncio.to_thread(
            self.retrieve,
            query,
            k,
            user_id,
            query_timestamp,
        )

    def memory_tool(
        self,
        name: str,
        arguments: dict,
        user_id: str | None = None,
    ) -> dict:
        """Execute one bounded read-only memory tool through the same bridge."""
        if name == "memory_resolve_context":
            query = str(arguments.get("query", "")).strip()
            k = 8
            tool_mode = "resolve_context"
        elif name == "memory_search_atoms":
            query = str(arguments.get("query", "")).strip()
            k = int(arguments.get("max_results", 5))
            tool_mode = "search_atoms"
        elif name == "memory_read_topic":
            query = str(arguments.get("topic_id", "")).strip()
            k = 10
            tool_mode = "read_topic"
            max_states = int(arguments.get("max_states", 16))
            if max_states < 1 or max_states > 24:
                raise ValueError("invalid topic state budget")
        elif name == "memory_search_conversation":
            query = str(arguments.get("query", "")).strip()
            k = int(arguments.get("max_results", 5))
            tool_mode = "search_conversation"
        elif name == "memory_read_evidence":
            evidence_refs = arguments.get("evidence_refs", [])
            memory_ids = arguments.get("memory_ids", [])
            if not isinstance(evidence_refs, list) or not isinstance(memory_ids, list):
                raise ValueError("invalid exact evidence arguments")
            evidence_refs = [str(value).strip() for value in evidence_refs]
            memory_ids = [str(value).strip() for value in memory_ids]
            if (
                not evidence_refs
                or not memory_ids
                or any(not value for value in [*evidence_refs, *memory_ids])
                or len(evidence_refs) > 8
                or len(memory_ids) > 16
            ):
                raise ValueError("invalid exact evidence arguments")
            query = "exact memory evidence references"
            k = len(evidence_refs)
            tool_mode = "read_evidence"
        elif name == "memory_list_topics":
            query = "memory topic index"
            k = int(arguments.get("max_results", 32))
            tool_mode = "navigation"
        else:
            raise ValueError("unsupported memory tool")
        if not query or len(query) > 8192 or k < 1 or k > 32:
            raise ValueError("invalid memory tool arguments")
        response = self._call(
            "retrieve",
            query=query,
            k=min(k, 16),
            userId=user_id,
            toolMode=tool_mode,
            **(
                {"evidenceRefs": evidence_refs, "memoryIds": memory_ids}
                if tool_mode == "read_evidence"
                else {"maxStates": max_states}
                if tool_mode == "read_topic"
                else {}
            ),
        )
        documents = response.get("documents", [])
        payload = response.get("toolPayload")
        result = {
            "schemaVersion": "paw.amb-memory-tool-result.v1",
            "tool": name,
            **(
                payload
                if isinstance(payload, dict)
                else {
                    "documents": [
                        {
                            "id": item.get("id"),
                            "content": item.get("content", ""),
                        }
                        for item in documents
                    ]
                }
            ),
        }
        self._memory_tool_calls += 1
        self._memory_tool_result_chars += len(
            json.dumps(result, ensure_ascii=False)
        )
        return result

    def stats(self) -> dict:
        return {
            **self._call("stats"),
            "memoryToolCalls": self._memory_tool_calls,
            "memoryToolRawResultChars": self._memory_tool_result_chars,
        }

    def _call(self, method: str, **params):
        self.initialize()
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise RuntimeError("Paw AMB bridge is unavailable")
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            process.stdin.write(
                json.dumps({"id": request_id, "method": method, "params": params}) + "\n"
            )
            process.stdin.flush()
            line = process.stdout.readline()
            if not line:
                raise RuntimeError(f"Paw AMB bridge exited with code {process.poll()}")
            response = json.loads(line)
            if response.get("id") != request_id:
                raise RuntimeError("Paw AMB bridge response id mismatch")
            if not response.get("ok"):
                raise RuntimeError(f"Paw AMB bridge error: {response.get('error', 'unknown')}")
            return response.get("result")
