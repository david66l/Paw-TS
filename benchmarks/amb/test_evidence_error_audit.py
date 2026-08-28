import unittest

from evidence_error_audit import audit_evidence_error


class FakeLlm:
    def __init__(self, result: dict) -> None:
        self.result = result
        self.calls = 0

    def generate(self, _prompt, _schema):
        self.calls += 1
        return self.result


class EvidenceErrorAuditTest(unittest.TestCase):
    def test_accepts_only_closed_taxonomy_labels(self) -> None:
        llm = FakeLlm(
            {
                "primary_cause": "temporal_ordering",
                "repair_stage": "state_resolution",
                "evidence_status": "sufficient",
                "confidence": "high",
            }
        )
        result = audit_evidence_error(
            llm,
            question="q",
            question_type="temporal-reasoning",
            context="evidence",
            candidate_answer="candidate",
            accepted_answers=["gold"],
            judge_reason="incorrect",
        )
        self.assertEqual("temporal_ordering", result.primary_cause)
        self.assertEqual("state_resolution", result.repair_stage)
        self.assertEqual(1, llm.calls)

    def test_invalid_labels_fail_closed_without_retaining_rationale(self) -> None:
        result = audit_evidence_error(
            FakeLlm(
                {
                    "primary_cause": "made-up",
                    "repair_stage": "made-up",
                    "evidence_status": "made-up",
                    "confidence": "made-up",
                    "rationale": "must not be retained",
                }
            ),
            question="q",
            question_type="multi-session",
            context="evidence",
            candidate_answer="candidate",
            accepted_answers=["gold"],
            judge_reason="incorrect",
        )
        self.assertEqual("invalid", result.primary_cause)
        self.assertFalse(hasattr(result, "rationale"))


if __name__ == "__main__":
    unittest.main()
