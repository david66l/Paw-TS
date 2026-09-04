from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "upstream" / "src"))
sys.path.insert(0, str(HERE))

from deepseek_llm import (  # noqa: E402
    DeepSeekFlashLLM,
    ProviderContentFilterError,
    StructuredOutputError,
    _memory_tool_definitions,
    _normalize_structured_result,
    _normalize_structured_result_with_mode,
    _parse_json_object,
    _structured_messages,
)


class DeepSeekToolProfileTest(unittest.TestCase):
    def test_structured_schema_is_a_stable_prefix(self) -> None:
        schema = {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": False,
        }
        first = _structured_messages("first question", schema)
        second = _structured_messages("second question", schema)

        self.assertEqual(first[0], second[0])
        self.assertEqual("system", first[0]["role"])
        self.assertEqual("first question", first[1]["content"])
        self.assertNotIn('"properties"', first[1]["content"])

    def test_l0_control_exposes_only_conversation_search(self) -> None:
        tools = _memory_tool_definitions(False, "l0_only")
        self.assertEqual(
            ["memory_search_conversation"],
            [tool["function"]["name"] for tool in tools],
        )

    def test_full_profile_preserves_product_memory_tools(self) -> None:
        names = {
            tool["function"]["name"] for tool in _memory_tool_definitions(False, "full")
        }
        self.assertEqual(
            {
                "memory_search_atoms",
                "memory_list_topics",
                "memory_read_topic",
                "memory_search_conversation",
                "memory_read_evidence",
                "memory_resolve_context",
            },
            names,
        )

    def test_unknown_profile_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported memory tool profile"):
            _memory_tool_definitions(False, "unknown")

    def test_malformed_final_answer_is_retryable_contract_error(self) -> None:
        with self.assertRaises(StructuredOutputError):
            _parse_json_object("not json")

    def test_exact_schema_echo_recovers_values_after_full_schema_validation(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "reasoning": {"type": "string"},
                "answer": {"type": "string"},
            },
            "required": ["reasoning", "answer"],
            "additionalProperties": False,
        }
        echoed = {
            "type": "object",
            "properties": {
                "reasoning": "the locked evidence supports one handle",
                "answer": "@correct_handle",
            },
            "required": ["reasoning", "answer"],
            "additionalProperties": False,
        }

        self.assertEqual(
            {
                "reasoning": "the locked evidence supports one handle",
                "answer": "@correct_handle",
            },
            _normalize_structured_result(echoed, schema),
        )

        complex_schema = {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["complete", "insufficient"]},
                "members": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "value": {"type": ["number", "string", "null"]}
                        },
                        "required": ["value"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["status", "members"],
            "additionalProperties": False,
        }
        complex_echo = {
            "type": "object",
            "properties": {
                "status": "complete",
                "members": [{"value": 2.5}, {"value": None}],
            },
            "required": ["status", "members"],
            "additionalProperties": False,
        }
        self.assertEqual(
            complex_echo["properties"],
            _normalize_structured_result(complex_echo, complex_schema),
        )
        self.assertEqual(
            (complex_echo["properties"], "direct"),
            _normalize_structured_result_with_mode(
                complex_echo["properties"], complex_schema
            ),
        )
        self.assertEqual(
            (complex_echo["properties"], "exact_schema_echo"),
            _normalize_structured_result_with_mode(complex_echo, complex_schema),
        )

    def test_schema_echo_recovery_rejects_ambiguous_or_invalid_shapes(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "reasoning": {"type": "string"},
                "answer": {"type": "string"},
            },
            "required": ["reasoning", "answer"],
            "additionalProperties": False,
        }
        variants = {
            "partial_top_level": {
                "type": "object",
                "properties": {"reasoning": "nested", "answer": "nested"},
                "required": ["reasoning", "answer"],
                "additionalProperties": False,
                "answer": "top-level",
            },
            "extra_wrapper_field": {
                "type": "object",
                "properties": {"reasoning": "ok", "answer": "ok"},
                "required": ["reasoning", "answer"],
                "additionalProperties": False,
                "other": "ambiguous",
            },
            "nested_schema_not_value": {
                "type": "object",
                "properties": {
                    "reasoning": {"type": "string"},
                    "answer": {"type": "string"},
                },
                "required": ["reasoning", "answer"],
                "additionalProperties": False,
            },
            "wrong_required": {
                "type": "object",
                "properties": {"reasoning": "ok", "answer": "ok"},
                "required": ["answer"],
                "additionalProperties": False,
            },
            "reordered_required": {
                "type": "object",
                "properties": {"reasoning": "ok", "answer": "ok"},
                "required": ["answer", "reasoning"],
                "additionalProperties": False,
            },
        }
        for name, value in variants.items():
            with self.subTest(name=name), self.assertRaises(StructuredOutputError):
                _normalize_structured_result(value, schema)

        wrapper_collision_schema = {
            "type": "object",
            "properties": {"type": {"type": "string"}},
            "required": ["type"],
            "additionalProperties": False,
        }
        with self.assertRaises(StructuredOutputError):
            _normalize_structured_result(
                {
                    "type": "object",
                    "properties": {"type": "answer"},
                    "required": ["type"],
                    "additionalProperties": False,
                },
                wrapper_collision_schema,
            )

    def test_schema_validation_rejects_enum_and_non_finite_number(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["complete"]},
                "score": {"type": "number"},
            },
            "required": ["status", "score"],
            "additionalProperties": False,
        }
        for name, value in {
            "enum": {"status": "unsupported", "score": 1},
            "nan": {"status": "complete", "score": float("nan")},
            "infinity": {"status": "complete", "score": float("inf")},
        }.items():
            with self.subTest(name=name), self.assertRaises(StructuredOutputError):
                _normalize_structured_result(value, schema)

    def test_repeated_content_filter_is_a_typed_hard_failure(self) -> None:
        adapter = DeepSeekFlashLLM.__new__(DeepSeekFlashLLM)
        adapter._model = "glm-5.3-flash"
        create = unittest.mock.Mock(side_effect=RuntimeError("contentFilter 1301"))
        adapter._client = SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=create))
        )
        with patch("deepseek_llm.time.sleep"), self.assertRaises(
            ProviderContentFilterError
        ):
            adapter._create_with_content_filter_resilience({"model": adapter._model})
        self.assertEqual(3, create.call_count)

    def test_schema_retry_accounts_all_remote_usage_and_reports_recovery_mode(self) -> None:
        with TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {
                "DEEPSEEK_API_KEY": "test-key",
                "PAW_AMB_LLM_CACHE_DIR": directory,
                "PAW_AMB_LOG": str(Path(directory) / "llm.jsonl"),
            },
            clear=False,
        ):
            schema = SimpleNamespace(
                properties={"answer": {"type": "string"}},
                required=["answer"],
            )
            adapter = DeepSeekFlashLLM()
            responses = iter(
                [
                    (
                        {"answer": 3},
                        {
                            "promptTokens": 10,
                            "completionTokens": 2,
                            "totalTokens": 12,
                            "promptCacheHitTokens": 0,
                            "promptCacheMissTokens": 10,
                        },
                        {"memoryToolCalls": 0},
                    ),
                    (
                        {
                            "type": "object",
                            "properties": {"answer": "ok"},
                            "required": ["answer"],
                            "additionalProperties": False,
                        },
                        {
                            "promptTokens": 11,
                            "completionTokens": 3,
                            "totalTokens": 14,
                            "promptCacheHitTokens": 1,
                            "promptCacheMissTokens": 10,
                        },
                        {"memoryToolCalls": 0},
                    ),
                ]
            )
            adapter._generate_remote = lambda _messages: next(responses)  # type: ignore[method-assign]

            self.assertEqual({"answer": "ok"}, adapter.generate("question", schema))
            stats = adapter.stats()
            self.assertEqual(26, stats["workloadTotalTokens"])
            self.assertEqual(2, stats["remoteCalls"])
            self.assertEqual(1, stats["structuredRejectedCalls"])
            self.assertEqual(1, stats["structuredEchoObservedCalls"])
            self.assertEqual(1, stats["structuredEchoRecoveredCalls"])
            rows = [
                __import__("json").loads(line)
                for line in (Path(directory) / "llm.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(
                "exact_schema_echo",
                rows[-1]["detail"]["structuredNormalizationMode"],
            )

    def test_cache_envelope_preserves_origin_usage_for_cost_accounting(self) -> None:
        with TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {
                "DEEPSEEK_API_KEY": "test-key",
                "PAW_AMB_LLM_CACHE_DIR": directory,
                "PAW_AMB_LOG": str(Path(directory) / "llm.jsonl"),
            },
            clear=False,
        ):
            schema = SimpleNamespace(
                properties={"answer": {"type": "string"}},
                required=["answer"],
            )
            usage = {
                "promptTokens": 100,
                "completionTokens": 30,
                "totalTokens": 130,
                "promptCacheHitTokens": 25,
                "promptCacheMissTokens": 75,
            }
            first = DeepSeekFlashLLM()
            first._generate_remote = lambda _messages: (  # type: ignore[method-assign]
                {"answer": "ok"},
                usage,
                {"memoryToolCalls": 0},
            )
            self.assertEqual({"answer": "ok"}, first.generate("question", schema))
            self.assertEqual(130, first.stats()["workloadTotalTokens"])
            self.assertTrue(first.stats()["costEvidenceComplete"])
            self.assertIn("stable-schema-prefix", first.stats()["structuredMessagePolicy"])

            second = DeepSeekFlashLLM()
            self.assertEqual({"answer": "ok"}, second.generate("question", schema))
            stats = second.stats()
            self.assertEqual(1, stats["cacheHitCalls"])
            self.assertEqual(1, stats["cacheHitsWithOriginUsage"])
            self.assertEqual(100, stats["cachedOriginPromptTokens"])
            self.assertEqual(30, stats["cachedOriginCompletionTokens"])
            self.assertEqual(130, stats["workloadTotalTokens"])
            self.assertTrue(stats["costEvidenceComplete"])


if __name__ == "__main__":
    unittest.main()
