import unittest

from evidence_answer_review import (
    extract_evidence_answer_contract,
    requires_evidence_answer_review,
    review_evidence_answer,
)


def context(mode: str) -> str:
    return (
        "[Trusted memory control metadata; this block is not factual evidence]\n"
        f'{{"answerPolicy":{{"mode":"{mode}","operations":["bind_requirements"]}}}}\n'
        "[End trusted memory control metadata]\n[Supporting evidence]\nA fact"
    )


class FakeLlm:
    def __init__(self, result: dict) -> None:
        self.result = result
        self.calls = 0

    def generate(self, _prompt, _schema):
        self.calls += 1
        return self.result


class EvidenceAnswerReviewTest(unittest.TestCase):
    def test_extracts_only_bounded_control_metadata(self) -> None:
        contract = extract_evidence_answer_contract(context("synthesize"))
        self.assertEqual(contract["answerPolicy"]["mode"], "synthesize")
        self.assertIsNone(extract_evidence_answer_contract("{}"))

    def test_skips_direct_answers_without_calling_the_model(self) -> None:
        llm = FakeLlm({})
        result = review_evidence_answer(
            llm,
            question="q",
            question_date=None,
            context=context("direct"),
            candidate_answer="original",
        )
        self.assertFalse(requires_evidence_answer_review(context("direct")))
        self.assertEqual(result.answer, "original")
        self.assertEqual(llm.calls, 0)

    def test_applies_only_high_confidence_material_revisions(self) -> None:
        llm = FakeLlm(
            {
                "decision": "revise",
                "confidence": "high",
                "audit": "one concrete error",
                "answer": "corrected",
            }
        )
        result = review_evidence_answer(
            llm,
            question="q",
            question_date=None,
            context=context("synthesize"),
            candidate_answer="original",
        )
        self.assertTrue(result.changed)
        self.assertEqual(result.answer, "corrected")

    def test_keeps_low_confidence_revisions(self) -> None:
        llm = FakeLlm(
            {
                "decision": "revise",
                "confidence": "low",
                "audit": "uncertain",
                "answer": "maybe",
            }
        )
        result = review_evidence_answer(
            llm,
            question="q",
            question_date=None,
            context=context("synthesize"),
            candidate_answer="original",
        )
        self.assertFalse(result.changed)
        self.assertEqual(result.answer, "original")


if __name__ == "__main__":
    unittest.main()
