from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from memory_bench.llm.base import LLM, Schema


CACHE_ENTRY_SCHEMA = "paw.amb-llm-cache-entry.v2"
STRUCTURED_MESSAGE_POLICY = "paw.amb-structured-messages.v1:stable-schema-prefix"


class StructuredOutputError(ValueError):
    """The provider returned a final answer that violates the JSON contract."""


def _structured_messages(prompt: str, schema_json: dict) -> list[dict]:
    """Place the reusable response contract before query-specific content."""
    contract = (
        f"Structured output policy: {STRUCTURED_MESSAGE_POLICY}\n"
        "Return exactly one valid JSON object matching the schema below. "
        "Do not wrap it in markdown.\n"
        + json.dumps(
            schema_json,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return [
        {"role": "system", "content": contract},
        {"role": "user", "content": prompt},
    ]


class DeepSeekFlashLLM(LLM):
    """OpenAI-compatible DeepSeek Flash adapter for AMB structured outputs."""

    def __init__(
        self,
        model: str | None = None,
        tool_profile: str | None = None,
    ) -> None:
        from openai import OpenAI

        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise RuntimeError("DEEPSEEK_API_KEY is not configured")
        self._model = model or os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")
        self._temperature = float(os.environ.get("DEEPSEEK_TEMPERATURE", "0"))
        self._evidence_ledger = os.environ.get(
            "PAW_AMB_EVIDENCE_LEDGER", "0"
        ).strip().lower() in {"1", "true", "on"}
        self._tool_profile = (
            (tool_profile or os.environ.get("PAW_AMB_TOOL_PROFILE", "full"))
            .strip()
            .lower()
        )
        if self._tool_profile not in {"full", "l0_only"}:
            raise RuntimeError("PAW_AMB_TOOL_PROFILE must be 'full' or 'l0_only'")
        if not 0 <= self._temperature <= 2:
            raise RuntimeError("DEEPSEEK_TEMPERATURE must be between 0 and 2")
        self._client = OpenAI(
            api_key=api_key,
            base_url=os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        )
        self._memory_provider = None
        self._memory_user_id: str | None = None
        self._stats = {
            "calls": 0,
            "cacheHitCalls": 0,
            "cacheHitsWithOriginUsage": 0,
            "cacheHitsWithoutOriginUsage": 0,
            "remoteCalls": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "totalTokens": 0,
            "promptCacheHitTokens": 0,
            "promptCacheMissTokens": 0,
            "cachedOriginPromptTokens": 0,
            "cachedOriginCompletionTokens": 0,
            "cachedOriginTotalTokens": 0,
            "cachedOriginPromptCacheHitTokens": 0,
            "cachedOriginPromptCacheMissTokens": 0,
            "memoryToolCalls": 0,
            "memoryToolExecutedCalls": 0,
            "memoryToolLimitedCalls": 0,
            "memoryToolRounds": 0,
            "memoryToolCacheHits": 0,
            "memoryToolFailures": 0,
            "memoryToolResultChars": 0,
        }

    def bind_memory_tools(self, provider, user_id: str | None) -> None:
        """Bind one query's scope; the provider never accepts tenant IDs from the model."""
        self._memory_provider = provider
        self._memory_user_id = user_id

    def stats(self) -> dict:
        workload_prompt_tokens = (
            self._stats["promptTokens"] + self._stats["cachedOriginPromptTokens"]
        )
        workload_completion_tokens = (
            self._stats["completionTokens"]
            + self._stats["cachedOriginCompletionTokens"]
        )
        return {
            **self._stats,
            "workloadPromptTokens": workload_prompt_tokens,
            "workloadCompletionTokens": workload_completion_tokens,
            "workloadTotalTokens": workload_prompt_tokens
            + workload_completion_tokens,
            "costEvidenceComplete": self._stats["cacheHitsWithoutOriginUsage"] == 0,
            "modelId": self.model_id,
            "temperature": self._temperature,
            "thinking": "enabled",
            "reasoningEffort": "max",
            "toolProfile": self._tool_profile,
            "structuredMessagePolicy": STRUCTURED_MESSAGE_POLICY,
        }

    @property
    def model_id(self) -> str:
        return f"deepseek:{self._model}"

    def generate(self, prompt: str, schema: Schema) -> dict:
        schema_json = {
            "type": "object",
            "properties": schema.properties,
            "required": schema.required,
            "additionalProperties": False,
        }
        initial_messages = _structured_messages(prompt, schema_json)
        prompt_hash = hashlib.sha256(
            json.dumps(
                initial_messages,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "policy": (
                        (
                            "paw.amb-llm-cache.v10-ledger-delta"
                            if self._evidence_ledger
                            else (
                                "paw.amb-llm-cache.v11-l0-control"
                                if self._tool_profile == "l0_only"
                                else "paw.amb-llm-cache.v24-stable-schema-prefix"
                            )
                        )
                        if self._memory_provider is not None
                        else "paw.amb-llm-cache.v2-stable-schema-prefix"
                    ),
                    "model": self.model_id,
                    "promptHash": prompt_hash,
                    "schema": schema_json,
                    "temperature": self._temperature,
                    "thinking": "enabled",
                    "reasoningEffort": "max",
                    "memoryTools": self._memory_provider is not None,
                    "memoryToolProfile": self._tool_profile,
                    "cacheFormat": CACHE_ENTRY_SCHEMA,
                },
                sort_keys=True,
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        cache_dir = Path(
            os.environ.get(
                "PAW_AMB_LLM_CACHE_DIR",
                str(Path(__file__).resolve().parent / "runs" / ".llm-cache"),
            )
        )
        cache_path = cache_dir / f"{cache_key}.json"
        if cache_path.exists():
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            cached_result, cached_usage = _read_cache_entry(cached, schema)
            if cached_result is not None:
                self._stats["calls"] += 1
                self._stats["cacheHitCalls"] += 1
                if cached_usage is None:
                    self._stats["cacheHitsWithoutOriginUsage"] += 1
                else:
                    self._stats["cacheHitsWithOriginUsage"] += 1
                    for source, target in (
                        ("promptTokens", "cachedOriginPromptTokens"),
                        ("completionTokens", "cachedOriginCompletionTokens"),
                        ("totalTokens", "cachedOriginTotalTokens"),
                        (
                            "promptCacheHitTokens",
                            "cachedOriginPromptCacheHitTokens",
                        ),
                        (
                            "promptCacheMissTokens",
                            "cachedOriginPromptCacheMissTokens",
                        ),
                    ):
                        self._stats[target] += cached_usage[source]
                _log(
                    "llm_settlement",
                    {
                        "model": self.model_id,
                        "status": "success",
                        "cacheHit": True,
                        "promptHash": prompt_hash,
                        "durationMs": 0,
                        "promptTokens": 0,
                        "completionTokens": 0,
                        "totalTokens": 0,
                        "cachedOriginPromptTokens": (
                            cached_usage["promptTokens"]
                            if cached_usage is not None
                            else None
                        ),
                        "cachedOriginCompletionTokens": (
                            cached_usage["completionTokens"]
                            if cached_usage is not None
                            else None
                        ),
                        "cachedOriginTotalTokens": (
                            cached_usage["totalTokens"]
                            if cached_usage is not None
                            else None
                        ),
                        "costEvidenceComplete": cached_usage is not None,
                        "memoryToolProfile": self._tool_profile,
                        "structuredMessagePolicy": STRUCTURED_MESSAGE_POLICY,
                    },
                )
                return cached_result
        started = time.perf_counter()
        delay = 5
        for attempt in range(6):
            try:
                result, usage_totals, tool_stats = self._generate_remote(
                    initial_messages
                )
                missing = [key for key in schema.required if key not in result]
                if missing:
                    raise StructuredOutputError(
                        "structured response omitted required fields"
                    )
                cache_dir.mkdir(parents=True, exist_ok=True)
                temp_path = cache_path.with_suffix(f".{os.getpid()}.tmp")
                temp_path.write_text(
                    json.dumps(
                        {
                            "schemaVersion": CACHE_ENTRY_SCHEMA,
                            "result": result,
                            "usage": usage_totals,
                            "toolStats": tool_stats,
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
                os.replace(temp_path, cache_path)
                self._stats["calls"] += 1
                self._stats["remoteCalls"] += 1
                for key, value in {**usage_totals, **tool_stats}.items():
                    if key in self._stats and isinstance(value, int):
                        self._stats[key] += value
                _log(
                    "llm_settlement",
                    {
                        "model": self.model_id,
                        "status": "success",
                        "cacheHit": False,
                        "attempt": attempt + 1,
                        "promptHash": prompt_hash,
                        "durationMs": round((time.perf_counter() - started) * 1000, 1),
                        **usage_totals,
                        **tool_stats,
                        "memoryToolProfile": self._tool_profile,
                        "structuredMessagePolicy": STRUCTURED_MESSAGE_POLICY,
                    },
                )
                return result
            except Exception as error:
                status = getattr(error, "status_code", None)
                retryable = status in (429, 500, 502, 503, 504) or isinstance(
                    error, StructuredOutputError
                )
                if retryable and attempt < 5:
                    if not isinstance(error, StructuredOutputError):
                        time.sleep(delay)
                        delay *= 2
                    continue
                _log(
                    "llm_settlement",
                    {
                        "model": self.model_id,
                        "status": "failed",
                        "attempt": attempt + 1,
                        "promptHash": prompt_hash,
                        "durationMs": round((time.perf_counter() - started) * 1000, 1),
                        "errorCode": error.__class__.__name__,
                        "structuredMessagePolicy": STRUCTURED_MESSAGE_POLICY,
                        **({"httpStatus": status} if status is not None else {}),
                    },
                )
                raise
        raise RuntimeError("DeepSeek retries exhausted")

    def _generate_remote(
        self, initial_messages: list[dict]
    ) -> tuple[dict, dict, dict]:
        messages = [dict(message) for message in initial_messages]
        all_tools = (
            _memory_tool_definitions(self._evidence_ledger, self._tool_profile)
            if self._memory_provider is not None
            else None
        )
        tools = all_tools
        if all_tools is not None and self._tool_profile == "full":
            tools = [
                tool
                for tool in all_tools
                if tool["function"]["name"] == "memory_resolve_context"
            ]
        totals = {
            "promptTokens": 0,
            "completionTokens": 0,
            "totalTokens": 0,
            "promptCacheHitTokens": 0,
            "promptCacheMissTokens": 0,
        }
        tool_calls = 0
        executed_tool_calls = 0
        limited_tool_calls = 0
        tool_rounds = 0
        tool_cache_hits = 0
        tool_failures = 0
        tool_result_chars = 0
        evidence_ledger_new_items = 0
        evidence_ledger_repeated_items = 0
        evidence_ledger_seen: set[str] = set()
        tool_cache: dict[str, dict] = {}
        tools_exhausted = False
        for _round in range(7):
            kwargs = {
                "model": self._model,
                "messages": messages,
                "response_format": {"type": "json_object"},
                "temperature": self._temperature,
                "extra_body": {
                    "thinking": {"type": "enabled"},
                    "reasoning_effort": "max",
                },
            }
            if tools is not None and not tools_exhausted:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            response = self._client.chat.completions.create(**kwargs)
            usage = response.usage
            totals["promptTokens"] += int(getattr(usage, "prompt_tokens", 0) or 0)
            totals["completionTokens"] += int(
                getattr(usage, "completion_tokens", 0) or 0
            )
            totals["totalTokens"] += int(getattr(usage, "total_tokens", 0) or 0)
            totals["promptCacheHitTokens"] += int(
                getattr(usage, "prompt_cache_hit_tokens", 0) or 0
            )
            totals["promptCacheMissTokens"] += int(
                getattr(usage, "prompt_cache_miss_tokens", 0) or 0
            )
            message = response.choices[0].message
            pending = list(message.tool_calls or [])
            if not pending:
                result = _parse_json_object(message.content or "")
                return (
                    result,
                    totals,
                    {
                        "memoryToolCalls": tool_calls,
                        "memoryToolExecutedCalls": executed_tool_calls,
                        "memoryToolLimitedCalls": limited_tool_calls,
                        "memoryToolRounds": tool_rounds,
                        "memoryToolCacheHits": tool_cache_hits,
                        "memoryToolFailures": tool_failures,
                        "memoryToolResultChars": tool_result_chars,
                        "memoryEvidenceLedgerNewItems": evidence_ledger_new_items,
                        "memoryEvidenceLedgerRepeatedItems": evidence_ledger_repeated_items,
                    },
                )
            if self._memory_provider is None:
                raise ValueError("model requested an unavailable memory tool")
            tool_rounds += 1
            messages.append(
                {
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            },
                        }
                        for call in pending
                    ],
                }
            )
            for call in pending:
                arguments = json.loads(call.function.arguments or "{}")
                if not isinstance(arguments, dict):
                    raise ValueError("memory tool arguments must be an object")
                remaining = min(8_000, 24_000 - tool_result_chars)
                if tool_calls >= 6 or remaining < 256:
                    content = json.dumps(
                        {
                            "schemaVersion": "paw.amb-memory-tool-result.v1",
                            "tool": call.function.name,
                            "ok": False,
                            "code": "MEMORY_TOOL_BUDGET_EXHAUSTED",
                            "message": "Use the evidence already returned and answer with appropriate uncertainty.",
                        },
                        ensure_ascii=False,
                    )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": content,
                        }
                    )
                    tool_calls += 1
                    limited_tool_calls += 1
                    tools_exhausted = True
                    continue
                cache_key = json.dumps(
                    [call.function.name, arguments],
                    sort_keys=True,
                    ensure_ascii=False,
                )
                if cache_key in tool_cache:
                    result = tool_cache[cache_key]
                    tool_cache_hits += 1
                else:
                    try:
                        result = self._memory_provider.memory_tool(
                            call.function.name,
                            arguments,
                            self._memory_user_id,
                        )
                    except (TypeError, ValueError):
                        result = {
                            "schemaVersion": "paw.amb-memory-tool-result.v1",
                            "tool": call.function.name,
                            "ok": False,
                            "code": "MEMORY_TOOL_ARGUMENTS_INVALID",
                            "message": "Use a valid known memory identifier or continue with evidence already returned.",
                        }
                        tool_failures += 1
                    tool_cache[cache_key] = result
                if call.function.name == "memory_resolve_context":
                    stop = result.get("stop") if isinstance(result, dict) else None
                    if stop == "sufficient":
                        tools_exhausted = True
                    elif all_tools is not None:
                        tools = [
                            tool
                            for tool in all_tools
                            if tool["function"]["name"]
                            != "memory_resolve_context"
                        ]
                if self._evidence_ledger:
                    result, ledger_new, ledger_repeated = (
                        _project_memory_evidence_delta(result, evidence_ledger_seen)
                    )
                    evidence_ledger_new_items += ledger_new
                    evidence_ledger_repeated_items += ledger_repeated
                content = _bounded_tool_result(result, remaining)
                tool_result_chars += len(content)
                executed_tool_calls += 1
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": content,
                    }
                )
                tool_calls += 1
                if tool_calls >= 6 or 24_000 - tool_result_chars < 256:
                    tools_exhausted = True
        raise ValueError("memory tool round budget exceeded")


def _memory_tool_definitions(
    evidence_ledger: bool = True,
    tool_profile: str = "full",
) -> list[dict]:
    if tool_profile not in {"full", "l0_only"}:
        raise ValueError("unsupported memory tool profile")
    tools = [
        {
            "type": "function",
            "function": {
                "name": "memory_resolve_context",
                "description": "Resolve the complete question once across L1 facts, L2 topic dossiers, and exact L0 evidence. Call this first. If stop is sufficient, answer without more memory calls; use lower-level tools only for a necessary missing fact.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "memory_search_atoms",
                "description": (
                    "Search L1 memory for preferences, facts, decisions, reasons, and outcomes. "
                    + (
                        "Results are session deltas; repeated evidence is counted but not resent."
                        if evidence_ledger
                        else ""
                    )
                ).strip(),
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "query": {"type": "string"},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 8},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "memory_list_topics",
                "description": "List the stable L2 topic index before reading a detailed topic.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 32}
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "memory_read_topic",
                "description": "Read one L2 topic body for why, change, and evolution questions.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "topic_id": {"type": "string"},
                        "max_states": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 24,
                        },
                    },
                    "required": ["topic_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "memory_search_conversation",
                "description": "Search L0 conversation evidence when summaries are incomplete or an exact reason needs verification.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "query": {"type": "string"},
                        "max_results": {"type": "integer", "minimum": 1, "maximum": 8},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "memory_read_evidence",
                "description": "Read exact L0 evidence references returned by atom or topic tools before making an important factual or causal claim.",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "evidence_refs": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 8,
                            "items": {"type": "string"},
                        },
                        "memory_ids": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 16,
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["evidence_refs", "memory_ids"],
                },
            },
        },
    ]
    if tool_profile == "l0_only":
        return [
            tool
            for tool in tools
            if tool["function"]["name"] == "memory_search_conversation"
        ]
    return tools


def _bounded_tool_result(result: dict, max_chars: int) -> str:
    """Keep valid JSON while fitting complete evidence documents in order."""
    list_key = next(
        (
            key
            for key in ("documents", "evidence", "topics", "states", "spans")
            if isinstance(result.get(key), list)
        ),
        None,
    )
    base = {
        key: value
        for key, value in result.items()
        if key not in {list_key, "rawResponse"}
    }
    items = result.get(list_key) if list_key is not None else None
    if not isinstance(items, list) or list_key is None:
        encoded = json.dumps(base, ensure_ascii=False)
        if len(encoded) > max_chars:
            raise ValueError("memory tool metadata exceeded character budget")
        return encoded
    selected: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        candidate = json.dumps(
            {**base, list_key: [*selected, item]},
            ensure_ascii=False,
        )
        if len(candidate) <= max_chars:
            selected.append(item)
            continue
        text_key = next(
            (key for key in ("content", "statement") if isinstance(item.get(key), str)),
            None,
        )
        if text_key is None:
            break
        low = 0
        high = len(item[text_key])
        best = ""
        while low <= high:
            middle = (low + high) // 2
            clipped = item[text_key][:middle]
            encoded_candidate = json.dumps(
                {
                    **base,
                    list_key: [
                        *selected,
                        {**item, text_key: clipped},
                    ],
                },
                ensure_ascii=False,
            )
            if len(encoded_candidate) <= max_chars:
                best = clipped
                low = middle + 1
            else:
                high = middle - 1
        if len(best) >= 64:
            item[text_key] = best
            selected.append(item)
        break
    encoded = json.dumps({**base, list_key: selected}, ensure_ascii=False)
    if len(encoded) > max_chars:
        raise ValueError("memory tool result exceeded character budget")
    return encoded


def _project_memory_evidence_delta(
    result: dict, seen: set[str]
) -> tuple[dict, int, int]:
    list_key = next(
        (
            key
            for key in ("evidence", "topics", "states", "spans")
            if isinstance(result.get(key), list)
        ),
        None,
    )
    if list_key is None:
        return result, 0, 0
    fresh: list = []
    repeated = 0
    for item in result[list_key]:
        identity = _memory_evidence_identity(result.get("tool"), list_key, item)
        if identity in seen:
            repeated += 1
            continue
        seen.add(identity)
        fresh.append(item)
    ledger = {
        "schemaVersion": "paw.memory-evidence-ledger.v1",
        "newItems": len(fresh),
        "repeatedItems": repeated,
        "totalDistinctItems": len(seen),
    }
    if not fresh and repeated:
        ledger["guidance"] = (
            "No new evidence was returned; use prior evidence or choose a materially "
            "different read."
        )
    return {**result, list_key: fresh, "evidenceLedger": ledger}, len(fresh), repeated


def _memory_evidence_identity(tool: object, list_key: str, item: object) -> str:
    record = item if isinstance(item, dict) else {}
    if list_key == "evidence":
        stable = str(record.get("memoryId", "")).strip()
    elif list_key == "topics":
        stable = str(record.get("topicId", "")).strip()
    elif list_key == "states":
        stable = "\n".join(
            str(record.get(key, "")).strip()
            for key in (
                "topicId",
                "memoryId",
                "status",
                "state",
                "validFrom",
                "validTo",
            )
            if str(record.get(key, "")).strip()
        )
    else:
        stable = "\n".join(
            str(record.get(key, "")).strip()
            for key in ("evidenceRef", "contentHash")
            if str(record.get(key, "")).strip()
        )
    if stable:
        return f"{list_key}:{stable}"
    encoded = json.dumps(item, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return f"{tool}:{list_key}:{digest}"


def _read_cache_entry(
    cached: object,
    schema: Schema,
) -> tuple[dict | None, dict | None]:
    if not isinstance(cached, dict):
        return None, None
    if cached.get("schemaVersion") == CACHE_ENTRY_SCHEMA:
        result = cached.get("result")
        usage = cached.get("usage")
    else:
        # Legacy raw-result entries remain readable for development, but their
        # missing origin usage makes them ineligible for a release cost gate.
        result = cached
        usage = None
    if not isinstance(result, dict) or not all(
        key in result for key in schema.required
    ):
        return None, None
    if usage is None:
        return result, None
    usage_keys = (
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "promptCacheHitTokens",
        "promptCacheMissTokens",
    )
    if not isinstance(usage, dict) or any(
        not isinstance(usage.get(key), int) or usage[key] < 0 for key in usage_keys
    ):
        return result, None
    return result, {key: usage[key] for key in usage_keys}


def _parse_json_object(content: str) -> dict:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1]).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise StructuredOutputError(
                "DeepSeek did not return a JSON object"
            ) from None
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            raise StructuredOutputError(
                "DeepSeek did not return a valid JSON object"
            ) from None
    if not isinstance(parsed, dict):
        raise StructuredOutputError("DeepSeek structured response is not an object")
    return parsed


def _log(event: str, detail: dict) -> None:
    path = Path(os.environ.get("PAW_AMB_LOG", "logs/amb/paw-memory-bridge.jsonl"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {
                    "schemaVersion": "paw.amb-log.v1",
                    "at": datetime.now(timezone.utc).isoformat(),
                    "event": event,
                    "detail": detail,
                },
                ensure_ascii=False,
            )
            + "\n"
        )
