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
    StructuredOutputError,
    _memory_tool_choice,
    _memory_tool_definitions,
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

    def test_forced_resolve_is_scoped_to_an_active_memory_binding(self) -> None:
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key"}, clear=False):
            llm = DeepSeekFlashLLM()
            llm.bind_memory_tools(object(), "user", force_resolve=True)
            self.assertTrue(llm._force_memory_resolve)
            llm.bind_memory_tools(None, None, force_resolve=True)
            self.assertFalse(llm._force_memory_resolve)

    def test_forced_resolve_only_applies_to_the_first_tool_round(self) -> None:
        self.assertEqual(
            {
                "type": "function",
                "function": {"name": "memory_resolve_context"},
            },
            _memory_tool_choice(True, 0),
        )
        self.assertEqual("auto", _memory_tool_choice(True, 1))
        self.assertEqual("auto", _memory_tool_choice(False, 0))

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
