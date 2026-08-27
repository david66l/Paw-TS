from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from run_facet_persona_holdout import compare_rows, render_facet_context


class FacetPersonaHoldoutTest(unittest.TestCase):
    def test_renders_bounded_structured_evidence(self) -> None:
        context, stats = render_facet_context(
            {
                "queryDiagnostic": {
                    "selection": {
                        "view": "timeline",
                        "omittedEvidenceCount": 1,
                        "evidence": [
                            {
                                "facetId": "facet-1",
                                "facetKey": "community.participation",
                                "bucket": "historical",
                                "state": {
                                    "statement": "Previously avoided the community.",
                                    "validFrom": "2025-01-01T00:00:00Z",
                                    "validTo": "2025-02-01T00:00:00Z",
                                },
                            },
                            {
                                "facetId": "facet-1",
                                "facetKey": "community.participation",
                                "bucket": "current",
                                "state": {
                                    "statement": "Now participates confidently.",
                                    "validFrom": "2025-02-01T00:00:00Z",
                                },
                            },
                        ],
                    }
                }
            }
        )
        self.assertIn("Status: historical", context)
        self.assertIn("Status: current", context)
        self.assertEqual(stats["evidenceCount"], 2)
        self.assertEqual(stats["facetCount"], 1)
        self.assertEqual(stats["view"], "timeline")
        self.assertEqual(stats["omittedEvidenceCount"], 1)

    def test_compares_pairwise_without_answer_content(self) -> None:
        comparison = compare_rows(
            [
                {"queryFingerprint": "a", "correct": True},
                {"queryFingerprint": "b", "correct": True},
                {"queryFingerprint": "c", "correct": False},
                {"queryFingerprint": "d", "correct": False},
            ],
            [
                {"queryFingerprint": "a", "correct": True},
                {"queryFingerprint": "b", "correct": False},
                {"queryFingerprint": "c", "correct": True},
                {"queryFingerprint": "d", "correct": False},
            ],
        )
        self.assertEqual(
            comparison,
            {
                "bothCorrect": 1,
                "bothWrong": 1,
                "facetOnlyCorrect": 1,
                "baselineOnlyCorrect": 1,
                "netCorrectDelta": 0,
            },
        )

    def test_renders_verified_requirement_labels(self) -> None:
        report = {
            "queryDiagnostic": {
                "selection": {"view": "decision", "evidence": []},
                "decisionSupport": {
                    "requirements": [
                        {
                            "requirementId": "req-1",
                            "description": "The user enjoyed a director interview.",
                        }
                    ],
                    "assessments": [
                        {
                            "requirementId": "req-1",
                            "supportingMemoryIds": ["memory-1"],
                            "contradictingMemoryIds": [],
                        }
                    ],
                    "evidence": [
                        {
                            "facetId": "facet-1",
                            "facetKey": "film.interview",
                            "bucket": "event",
                            "state": {
                                "memoryId": "memory-1",
                                "statement": "User enjoyed a director interview.",
                            },
                        }
                    ],
                },
            }
        }
        context, stats = render_facet_context(report)
        self.assertIn("R1: The user enjoyed a director interview.", context)
        self.assertIn("Verified support: R1", context)
        self.assertEqual(stats["requirementCount"], 1)
        self.assertEqual(stats["verifiedAssessmentCount"], 1)


if __name__ == "__main__":
    unittest.main()
