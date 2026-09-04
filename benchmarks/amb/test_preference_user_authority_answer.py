from types import SimpleNamespace
import unittest

from run_preference_user_authority_answer import (
    answer_instruction,
    compile_preference_profile,
    preference_profile_prompt,
)


class PreferenceUserAuthorityAnswerTest(unittest.TestCase):
    def packet(self):
        return SimpleNamespace(
            evidence_items=(
                ("M01T001", "I enjoy quiet trails."),
                ("M02T001", "I avoid crowded places."),
            )
        )

    def test_compiles_only_addressed_user_evidence(self) -> None:
        proposal = {
            "status": "complete",
            "positiveEvidenceIds": ["M01T001"],
            "negativeEvidenceIds": ["M02T001"],
            "goalEvidenceIds": [],
            "experienceEvidenceIds": [],
            "contextEvidenceIds": [],
        }

        context, count = compile_preference_profile(self.packet(), proposal)

        self.assertEqual(2, count)
        self.assertIn("I enjoy quiet trails.", context or "")
        self.assertIn("I avoid crowded places.", context or "")

    def test_rejects_unknown_or_empty_profile(self) -> None:
        unknown = {
            "status": "complete",
            "positiveEvidenceIds": ["forged"],
            "negativeEvidenceIds": [],
            "goalEvidenceIds": [],
            "experienceEvidenceIds": [],
            "contextEvidenceIds": [],
        }
        empty = {key: [] for key in unknown if key != "status"}
        empty["status"] = "complete"

        self.assertEqual((None, 0), compile_preference_profile(self.packet(), unknown))
        self.assertEqual((None, 0), compile_preference_profile(self.packet(), empty))

    def test_profile_protocol_separates_selection_from_synthesis(self) -> None:
        prompt = preference_profile_prompt("Where should I hike?", "[M01T001] quiet")

        self.assertIn("never paraphrases or new facts", prompt)
        self.assertIn("new recommendations", answer_instruction("evidence_profile_v3"))


if __name__ == "__main__":
    unittest.main()
