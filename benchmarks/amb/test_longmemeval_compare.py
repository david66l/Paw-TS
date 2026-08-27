import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from compare_paw_longmemeval_blind import compare_reports, exact_mcnemar_p


PROJECT_GATE = {
    "minimumTreatmentAccuracy": 0.75,
    "minimumQuestionTypeAccuracy": 0.60,
    "minimumPairedAccuracyGain": 0.075,
    "maximumRetrievalDegradation": 0.02,
    "maximumContextTokenIncreaseRatio": 0.50,
    "maximumTreatmentMemoryCallsPerQuery": 2.0,
    "maximumTreatmentMemoryWorkloadTokensPerQuery": 4_000.0,
}


class LongMemEvalPairedComparisonTest(unittest.TestCase):
    def test_exact_mcnemar_is_two_sided(self) -> None:
        self.assertAlmostEqual(0.125, exact_mcnemar_p(0, 4))
        self.assertEqual(1.0, exact_mcnemar_p(0, 0))

    def test_comparison_is_paired_verified_and_content_free(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [
                ("a", "single-session-user", True, True),
                ("b", "single-session-assistant", True, False),
                ("c", "multi-session", False, True),
                ("d", "temporal-reasoning", False, True),
                ("e", "knowledge-update", True, True),
                ("f", "single-session-preference", False, False),
            ]
            paths = {}
            for arm, correctness_index in (("baseline", 2), ("treatment", 3)):
                sealed_path = root / f"{arm}-sealed.json"
                public_path = root / f"{arm}-public.json"
                sealed = {
                    "manifest": {
                        "contentFree": True,
                        "blindPlan": {"planId": "shared-plan", "arm": arm},
                        "artifactBinding": {"source": "same"},
                        "experimentProtocol": {
                            "schemaVersion": "same",
                            "projectReleaseGate": PROJECT_GATE,
                        },
                        "questionTypeCounts": {
                            question_type: 1 for _, question_type, _, _ in rows
                        },
                    },
                    "rows": [
                        {
                            "queryHmac": query_hmac,
                            "questionType": question_type,
                            "answerCorrect": values[correctness_index - 2],
                            "goldDocumentCount": 1,
                            "hit": values[correctness_index - 2],
                            "goldRecall": float(values[correctness_index - 2]),
                            "contextTokens": 100 if arm == "baseline" else 130,
                        }
                        for query_hmac, question_type, *values in rows
                    ],
                    "providerStats": {
                        "atomBudget": {
                            "remoteCalls": 0 if arm == "baseline" else 6,
                            "cacheHits": 0,
                            "workloadTotalTokens": 0 if arm == "baseline" else 6_000,
                            "costEvidenceComplete": True,
                            "providerCacheHitTokens": 0 if arm == "baseline" else 100,
                            "providerCacheMissTokens": 0 if arm == "baseline" else 900,
                            "cachedOriginProviderCacheHitTokens": 0,
                            "cachedOriginProviderCacheMissTokens": 0,
                        }
                    },
                }
                sealed_path.write_text(json.dumps(sealed), encoding="utf-8")
                correct = sum(row["answerCorrect"] for row in sealed["rows"])
                hit_rate = sum(row["hit"] for row in sealed["rows"]) / len(rows)
                public = {
                    "answerMetrics": {
                        "overall": {
                            "queries": len(rows),
                            "correct": correct,
                            "accuracy": correct / len(rows),
                        }
                    },
                    "metrics": {
                        "overall": {
                            "queries": len(rows),
                            "hitRate": hit_rate,
                            "macroRecall": hit_rate,
                        }
                    },
                    "sealedLedger": {
                        "sha256": hashlib.sha256(sealed_path.read_bytes()).hexdigest(),
                        "rowCount": len(rows),
                    },
                }
                public_path.write_text(json.dumps(public), encoding="utf-8")
                paths[f"{arm}_public_path"] = public_path
                paths[f"{arm}_sealed_path"] = sealed_path

            report = compare_reports(**paths)
            serialized = json.dumps(report)

            self.assertTrue(report["contentFree"])
            self.assertEqual(1, report["contingency"]["baselineCorrectTreatmentWrong"])
            self.assertEqual(2, report["contingency"]["baselineWrongTreatmentCorrect"])
            self.assertAlmostEqual(
                1.0 / 3.0,
                report["pairedStatistics"]["relativeErrorReduction"],
            )
            self.assertNotIn("shared-plan", serialized)
            self.assertNotIn('"queryHmac"', serialized)
            self.assertEqual(
                "blind-plan",
                report["projectReleaseGate"]["binding"],
            )
            self.assertTrue(
                report["projectReleaseGate"]["checks"]["costEvidence"]
            )
            self.assertTrue(
                report["projectReleaseGate"]["checks"]["memoryWorkloadTokens"]
            )
            self.assertTrue(report["cost"]["evidenceComplete"])
            self.assertAlmostEqual(0.3, report["cost"]["contextTokenIncreaseRatio"])
            self.assertEqual(1.0, report["cost"]["treatmentMemoryCallsPerQuery"])
            self.assertEqual(
                1_000.0,
                report["cost"]["treatmentMemoryWorkloadTokensPerQuery"],
            )

            treatment_sealed = json.loads(
                paths["treatment_sealed_path"].read_text(encoding="utf-8")
            )
            treatment_sealed["providerStats"]["atomBudget"][
                "costEvidenceComplete"
            ] = False
            paths["treatment_sealed_path"].write_text(
                json.dumps(treatment_sealed),
                encoding="utf-8",
            )
            treatment_public = json.loads(
                paths["treatment_public_path"].read_text(encoding="utf-8")
            )
            treatment_public["sealedLedger"]["sha256"] = hashlib.sha256(
                paths["treatment_sealed_path"].read_bytes()
            ).hexdigest()
            paths["treatment_public_path"].write_text(
                json.dumps(treatment_public),
                encoding="utf-8",
            )
            incomplete_cost = compare_reports(**paths)
            self.assertFalse(incomplete_cost["cost"]["evidenceComplete"])
            self.assertFalse(
                incomplete_cost["projectReleaseGate"]["checks"]["costEvidence"]
            )

            treatment_public = json.loads(
                paths["treatment_public_path"].read_text(encoding="utf-8")
            )
            treatment_public["metrics"]["overall"]["hitRate"] = 1.0
            paths["treatment_public_path"].write_text(
                json.dumps(treatment_public),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "public metrics"):
                compare_reports(**paths)


if __name__ == "__main__":
    unittest.main()
