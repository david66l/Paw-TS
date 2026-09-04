from __future__ import annotations

from dataclasses import dataclass
import inspect
import json
import hashlib
import copy
import unittest

import typed_source_locked_reader as reader


@dataclass(frozen=True)
class Document:
    id: str
    content: str
    timestamp: str


def document(source_id: str, date: str, *turns: tuple[str, str]) -> Document:
    return Document(
        source_id,
        json.dumps([{"role": role, "content": text} for role, text in turns]),
        date,
    )


def certificate_raw(
    question: str,
    authority: str,
    recalled: list[Document],
    authorized_ids: list[str] | None = None,
    reader_ids: list[str] | None = None,
    reader_contents: list[str] | None = None,
) -> dict:
    origin_revision = hashlib.sha256(b"test-origin").hexdigest()
    ids = [item.id for item in recalled]
    reader_ids = ids if reader_ids is None else reader_ids
    reader_contents = (
        [item.content for item in recalled]
        if reader_contents is None
        else reader_contents
    )
    if len(reader_ids) != len(reader_contents):
        raise ValueError("reader ids and contents must have equal length")
    evidence_use = (
        "assistant_report"
        if authority == "explicit_assistant"
        else "shared_dialogue_artifact"
    )
    authorized_items = []
    authorized_pairs = []
    if authority in {
        "explicit_assistant",
        "explicit_shared",
        "dialogue_artifact_unowned",
    }:
        for item in recalled:
            if authorized_ids is not None and item.id not in authorized_ids:
                continue
            for turn_order, turn in enumerate(json.loads(item.content), start=1):
                if turn["role"] != "assistant":
                    continue
                authorized_items.append(
                    {
                        "sourceId": item.id,
                        "evidenceRef": f"{item.id}#source-{turn_order}",
                        "turnOrder": turn_order,
                        "evidenceUse": evidence_use,
                        "allowedModes": ["dialogue_materialization"],
                    }
                )
                if turn_order > 1 and json.loads(item.content)[turn_order - 2]["role"] == "user":
                    predecessor = json.loads(item.content)[turn_order - 2]
                    authorized_pairs.append(
                        {
                            "sourceId": item.id,
                            "assistantEvidenceRef": f"{item.id}#source-{turn_order}",
                            "assistantContentHash": hashlib.sha256(turn["content"].encode("utf-8")).hexdigest(),
                            "assistantTurnOrder": turn_order,
                            "assistantRole": "assistant_output",
                            "predecessorEvidenceRef": f"{item.id}#source-{turn_order - 1}",
                            "predecessorContentHash": hashlib.sha256(predecessor["content"].encode("utf-8")).hexdigest(),
                            "predecessorTurnOrder": turn_order - 1,
                            "predecessorRole": "user_input",
                            "relation": "immediate_predecessor",
                            "allowedModes": ["dialogue_pair_context"],
                            "evidenceTimeUpperBound": "2025-01-03T00:00:00Z",
                            "verifierVersion": "test-verifier",
                            "verificationRevision": hashlib.sha256(b"test-verification").hexdigest(),
                            "dialogueCertificateRevisions": [
                                hashlib.sha256(
                                    f"pair-{item.id}-{turn_order}".encode()
                                ).hexdigest()
                            ],
                        }
                    )
    identity = {
        "schema": "paw.dialogue-materialization-certificate.v5",
        "policy": "paw.core-final-packet-authority.v5:canonical-pair-proof-lineage",
        "queryHash": hashlib.sha256(question.encode()).hexdigest(),
        "originKind": authority,
        "originRevision": origin_revision,
        "queryCutoff": "2025-01-03T00:00:00.000Z",
        "sourceLockIds": ids,
        "sourceLockDigest": hashlib.sha256(
            json.dumps(ids, separators=(",", ":")).encode()
        ).hexdigest(),
        "authorizedItems": authorized_items,
        "authorizedPairContext": authorized_pairs,
        "resolutionRevision": hashlib.sha256(b"test-resolution").hexdigest(),
        "readerDocumentIds": reader_ids,
        "readerDocumentDigest": hashlib.sha256(
            json.dumps(reader_ids, separators=(",", ":")).encode()
        ).hexdigest(),
        "readerPacketDigest": hashlib.sha256(
            json.dumps(
                [
                    {
                        "id": source_id,
                        "contentHash": hashlib.sha256(content.encode()).hexdigest(),
                    }
                    for source_id, content in zip(
                        reader_ids, reader_contents, strict=True
                    )
                ],
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest(),
    }
    return {
        "evidenceFirstQueryAnswerOriginKind": authority,
        "evidenceFirstQueryAnswerOriginRevision": origin_revision,
        "evidenceFirstDialogueMaterializationCertificate": {
            **identity,
            "certificateRevision": hashlib.sha256(
                json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
        },
    }


def resign_certificate(raw: dict) -> None:
    certificate = raw["evidenceFirstDialogueMaterializationCertificate"]
    identity = {key: value for key, value in certificate.items() if key != "certificateRevision"}
    certificate["certificateRevision"] = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class TypedSourceLockedReaderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.earlier = document(
            "source-a",
            "2025-01-01",
            ("user", "Please suggest a name"),
            ("assistant", "I suggested Aurora"),
        )
        self.later = document(
            "source-b",
            "2025-01-02",
            ("user", "I bought two red books"),
            ("assistant", "Noted"),
            ("user", "I bought three blue books"),
        )
        self.documents = {item.id: item for item in (self.earlier, self.later)}

    def route(self, question: str, raw: dict, recalled=None):
        recalled = [self.later, self.earlier] if recalled is None else recalled
        authority = raw.get("evidenceFirstQueryAnswerOriginKind")
        if authority in {
            "explicit_assistant",
            "explicit_shared",
            "dialogue_artifact_unowned",
        } and "evidenceFirstDialogueMaterializationCertificate" not in raw:
            raw = certificate_raw(question, authority, recalled)
        return reader.route_typed_source_locked_reader(
            question=question,
            query_timestamp="2025-01-03",
            recalled=recalled,
            documents_by_id=self.documents,
            raw=raw,
            legacy_context="legacy",
        )

    def test_assistant_route_preserves_adjacent_roles_and_time_order(self) -> None:
        result = self.route(
            "What did you suggest in our previous conversation?",
            {"evidenceFirstQueryAnswerOriginKind": "explicit_assistant"},
        )
        self.assertEqual("assistant_dialogue", result.route)
        self.assertLess(result.context.index("source-a") if "source-a" in result.context else result.context.index("S01"), result.context.index("S02"))
        self.assertIn("USER: Please suggest a name", result.context)
        self.assertIn("ASSISTANT: I suggested Aurora", result.context)
        self.assertNotIn("three blue books", result.context)
        self.assertEqual(4, result.turn_count)

    def test_set_route_hydrates_complete_user_sessions_and_omits_assistant_noise(self) -> None:
        result = self.route("How many books did I buy in total?", {})
        self.assertEqual("evidence_set", result.route)
        self.assertIn("two red books", result.context)
        self.assertIn("three blue books", result.context)
        self.assertNotIn("Noted", result.context)
        self.assertEqual("count_members", result.plan["operator"])

    def test_authority_and_set_shape_are_orthogonal(self) -> None:
        result = self.route(
            "How many names did you suggest in our previous conversation?",
            {"evidenceFirstQueryAnswerOriginKind": "explicit_assistant"},
        )
        self.assertEqual("assistant_dialogue_set", result.route)
        self.assertIn("ASSISTANT: I suggested Aurora", result.context)
        self.assertIn("prior-dialogue artifact protocol", result.protocol)
        self.assertIn("typed complete evidence-set execution protocol", result.protocol)

    def test_lookup_stays_legacy_and_post_cutoff_hydration_fails_hard(self) -> None:
        self.assertEqual("legacy", self.route("What color is my bicycle?", {}).route)
        future = document("future", "2025-02-01", ("user", "future fact"))
        with self.assertRaises(reader.SourceLockInvariantError):
            reader.route_typed_source_locked_reader(question="How many books did I buy?", query_timestamp="2025-01-03", recalled=[future], documents_by_id={future.id: future}, raw={}, legacy_context="legacy")

    def test_cutoff_comparison_uses_instants_not_mixed_precision_text(self) -> None:
        just_after = document(
            "after",
            "2025-01-03T00:00:00.100Z",
            ("user", "post-cutoff fact"),
        )
        with self.assertRaises(reader.SourceLockInvariantError):
            reader.route_typed_source_locked_reader(
                question="Where is my bicycle?",
                query_timestamp="2025-01-03T00:00:00Z",
                recalled=[just_after],
                documents_by_id={just_after.id: just_after},
                raw={},
                legacy_context="legacy",
            )
        at_cutoff = document(
            "at",
            "2025-01-03T00:00:00.100Z",
            ("user", "cutoff-valid fact"),
        )
        result = reader.route_typed_source_locked_reader(
            question="Where is my bicycle?",
            query_timestamp="2025-01-03T00:00:00.100Z",
            recalled=[at_cutoff],
            documents_by_id={at_cutoff.id: at_cutoff},
            raw={},
            legacy_context="legacy",
        )
        self.assertEqual("legacy", result.route)

    def test_scalar_lookups_stay_on_the_legacy_reader(self) -> None:
        for question in (
            "What time did I go to bed before the appointment?",
            "Where is my bicycle?",
        ):
            self.assertEqual("legacy", self.route(question, {}).route)

    def test_domain_words_do_not_prove_a_cross_fact_lookup(self) -> None:
        for question in (
            "When did I submit my research paper?",
            "What time did I arrive at the clinic?",
            "At which university did I present my thesis poster?",
        ):
            self.assertEqual("legacy", self.route(question, {}).route)

    def test_missing_locked_canonical_source_fails_hard(self) -> None:
        missing = document("missing", "2025-01-01", ("user", "unavailable"))
        with self.assertRaises(reader.SourceLockInvariantError):
            self.route("How many books did I buy?", {}, [self.later, missing])

    def test_shared_and_unowned_authority_are_certificate_scoped(self) -> None:
        shared = self.route("What did we decide?", {"evidenceFirstQueryAnswerOriginKind": "explicit_shared"})
        self.assertEqual("shared_dialogue", shared.route)
        unowned = self.route("What did we decide?", {"evidenceFirstQueryAnswerOriginKind": "dialogue_artifact_unowned"})
        self.assertEqual("unowned_dialogue", unowned.route)
        with self.assertRaises(reader.CertificateInvariantError):
            self.route("What did we decide?", {"evidenceFirstQueryAnswerOriginKind": "explicit_assistant", "evidenceFirstDialogueMaterializationCertificate": {}})

    def test_named_empty_authorization_is_safe_insufficient_not_fatal(self) -> None:
        question = "What did you recommend?"
        raw = certificate_raw(
            question,
            "explicit_assistant",
            [self.later, self.earlier],
            authorized_ids=[],
        )
        result = self.route(question, raw)
        self.assertEqual("assistant_dialogue_insufficient", result.route)
        self.assertEqual("empty_authorized_source_scope", result.fallback_reason)
        self.assertNotIn("red books", result.context)

    def test_typescript_canonical_certificate_golden(self) -> None:
        raw = certificate_raw(
            "What did you recommend?",
            "explicit_assistant",
            [self.later, self.earlier],
        )
        self.assertEqual(
            "70db6906a1de78f0e03211b0760f7176d970a83da68c0d10b8527ed55472969a",
            raw["evidenceFirstDialogueMaterializationCertificate"][
                "certificateRevision"
            ],
        )

    def test_forged_pair_context_is_semantically_rejected_after_resigning(self) -> None:
        question = "What did you recommend?"
        variants = {
            "assistant_hash": lambda pair, certificate: pair.__setitem__("assistantContentHash", "0" * 64),
            "predecessor_hash": lambda pair, certificate: pair.__setitem__("predecessorContentHash", "1" * 64),
            "cross_source": lambda pair, certificate: pair.__setitem__("sourceId", "source-a"),
            "non_adjacent": lambda pair, certificate: pair.__setitem__("predecessorTurnOrder", 0),
            "nested_extra": lambda pair, certificate: pair.__setitem__("nested", {}),
            "v4": lambda pair, certificate: (
                certificate.__setitem__("schema", "paw.dialogue-materialization-certificate.v4"),
                certificate.__setitem__("policy", "paw.core-final-packet-authority.v4:item-scoped-pair-proven"),
            ),
            "orphan": lambda pair, certificate: certificate.__setitem__("authorizedPairContext", []),
            "extra_pair": lambda pair, certificate: certificate["authorizedPairContext"].append(copy.deepcopy(pair)),
        }
        for name, mutate in variants.items():
            with self.subTest(name=name):
                raw = certificate_raw(question, "explicit_assistant", [self.later, self.earlier])
                certificate = raw["evidenceFirstDialogueMaterializationCertificate"]
                pair = certificate["authorizedPairContext"][0]
                mutate(pair, certificate)
                resign_certificate(raw)
                with self.assertRaises(reader.CertificateInvariantError):
                    self.route(question, raw)

    def test_pair_lineage_is_exact_sorted_unique_bounded_lowercase_sha256(self) -> None:
        question = "What did you recommend?"
        variants = {
            "old_scalar": lambda pair: (
                pair.__setitem__(
                    "dialogueCertificateRevision",
                    pair["dialogueCertificateRevisions"][0],
                ),
                pair.__delitem__("dialogueCertificateRevisions"),
            ),
            "empty": lambda pair: pair.__setitem__("dialogueCertificateRevisions", []),
            "duplicate": lambda pair: pair.__setitem__(
                "dialogueCertificateRevisions",
                [pair["dialogueCertificateRevisions"][0]] * 2,
            ),
            "unsorted": lambda pair: pair.__setitem__(
                "dialogueCertificateRevisions",
                ["f" * 64, "0" * 64],
            ),
            "uppercase": lambda pair: pair.__setitem__(
                "dialogueCertificateRevisions", ["A" * 64]
            ),
            "over_limit": lambda pair: pair.__setitem__(
                "dialogueCertificateRevisions",
                [f"{value:064x}" for value in range(17)],
            ),
        }
        for name, mutate in variants.items():
            with self.subTest(name=name):
                raw = certificate_raw(
                    question, "explicit_assistant", [self.later, self.earlier]
                )
                pair = raw["evidenceFirstDialogueMaterializationCertificate"][
                    "authorizedPairContext"
                ][0]
                mutate(pair)
                resign_certificate(raw)
                with self.assertRaises(reader.CertificateInvariantError):
                    self.route(question, raw)

    def test_pair_lineage_revision_cannot_be_reused_across_pairs(self) -> None:
        question = "What did you recommend?"
        raw = certificate_raw(
            question, "explicit_assistant", [self.later, self.earlier]
        )
        pairs = raw["evidenceFirstDialogueMaterializationCertificate"][
            "authorizedPairContext"
        ]
        self.assertGreaterEqual(len(pairs), 2)
        pairs[1]["dialogueCertificateRevisions"] = list(
            pairs[0]["dialogueCertificateRevisions"]
        )
        resign_certificate(raw)
        with self.assertRaises(reader.CertificateInvariantError):
            self.route(question, raw)

    def test_sorted_distinct_pair_lineage_materializes_one_assistant_pair(self) -> None:
        question = "What did you recommend?"
        raw = certificate_raw(
            question, "explicit_assistant", [self.later, self.earlier]
        )
        pair = raw["evidenceFirstDialogueMaterializationCertificate"][
            "authorizedPairContext"
        ][0]
        pair["dialogueCertificateRevisions"] = ["0" * 64, "f" * 64]
        resign_certificate(raw)

        execution = self.route(question, raw)
        self.assertEqual("assistant_dialogue", execution.route)
        self.assertIn("I suggested Aurora", execution.context)

    def test_pair_cutoff_accepts_equivalent_fractional_precision(self) -> None:
        question = "What did you recommend?"
        raw = certificate_raw(
            question, "explicit_assistant", [self.later, self.earlier]
        )
        certificate = raw["evidenceFirstDialogueMaterializationCertificate"]
        certificate["authorizedPairContext"][0]["evidenceTimeUpperBound"] = (
            "2025-01-03T00:00:00.000Z"
        )
        resign_certificate(raw)

        execution = self.route(question, raw)
        self.assertEqual("assistant_dialogue", execution.route)

    def test_pair_context_rejects_zero_based_logical_turn_addresses(self) -> None:
        question = "What did you recommend?"
        recalled = [self.later, self.earlier]
        raw = certificate_raw(question, "explicit_assistant", recalled)
        certificate = raw["evidenceFirstDialogueMaterializationCertificate"]
        pair = certificate["authorizedPairContext"][0]
        pair["assistantEvidenceRef"] = f"{pair['sourceId']}#source-1"
        pair["assistantTurnOrder"] = 1
        pair["predecessorEvidenceRef"] = f"{pair['sourceId']}#source-0"
        pair["predecessorTurnOrder"] = 0
        resign_certificate(raw)

        with self.assertRaises(reader.CertificateInvariantError):
            reader._certificate_sources(
                raw=raw,
                question=question,
                cutoff="2025-01-03T00:00:00Z",
                recalled=tuple(recalled),
            )

    def test_assistant_certificate_requires_assistant_report_use(self) -> None:
        question = "What did you recommend?"
        raw = certificate_raw(
            question,
            "explicit_assistant",
            [self.later, self.earlier],
        )
        certificate = raw["evidenceFirstDialogueMaterializationCertificate"]
        certificate["authorizedItems"][0]["evidenceUse"] = (
            "shared_dialogue_artifact"
        )
        identity = {
            key: certificate[key]
            for key in (
                "schema",
                "policy",
                "queryHash",
                "originKind",
                "originRevision",
                "queryCutoff",
                "sourceLockIds",
                "sourceLockDigest",
                "authorizedItems",
                "resolutionRevision",
                "readerDocumentIds",
                "readerDocumentDigest",
                "readerPacketDigest",
            )
        }
        certificate["certificateRevision"] = hashlib.sha256(
            json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        with self.assertRaises(reader.CertificateInvariantError):
            self.route(question, raw)

    def test_unowned_certificate_limits_rendering_to_its_exact_source_scope(self) -> None:
        question = "What did we decide?"
        recalled = [self.later, self.earlier]
        raw = certificate_raw(
            question,
            "dialogue_artifact_unowned",
            recalled,
            authorized_ids=["source-a"],
        )
        result = self.route(question, raw, recalled)
        self.assertEqual("unowned_dialogue", result.route)
        self.assertIn("I suggested Aurora", result.context)
        self.assertNotIn("red books", result.context)
        self.assertEqual(1, result.source_count)
        self.assertEqual(2, result.locked_source_count)

    def test_unowned_missing_certificate_stays_legacy_but_poison_fails(self) -> None:
        result = reader.route_typed_source_locked_reader(
            question="What did we decide?",
            query_timestamp="2025-01-03",
            recalled=[self.later, self.earlier],
            documents_by_id=self.documents,
            raw={"evidenceFirstQueryAnswerOriginKind": "dialogue_artifact_unowned"},
            legacy_context="legacy",
        )
        self.assertEqual("legacy", result.route)
        raw = certificate_raw(
            "What did we decide?",
            "dialogue_artifact_unowned",
            [self.later, self.earlier],
        )
        raw["evidenceFirstDialogueMaterializationCertificate"]["queryCutoff"] = (
            "2099-01-01T00:00:00Z"
        )
        with self.assertRaises(reader.CertificateInvariantError):
            self.route("What did we decide?", raw)

    def test_duplicate_and_malformed_locked_sources_fail_hard(self) -> None:
        with self.assertRaises(reader.SourceLockInvariantError):
            self.route("How many books did I buy?", {}, [self.later, self.later])
        malformed = Document("bad", "{", "2025-01-01")
        with self.assertRaises(reader.SourceLockInvariantError):
            reader.route_typed_source_locked_reader(question="Where is my bicycle?", query_timestamp="2025-01-03", recalled=[malformed], documents_by_id={"bad": malformed}, raw={}, legacy_context="legacy")

    def test_router_is_invariant_to_evaluation_metadata(self) -> None:
        baseline = self.route("How many books did I buy?", {})
        poisoned = self.route(
            "How many books did I buy?",
            {
                "question_type": "single-session-assistant",
                "gold_answers": ["999"],
                "has_answer": False,
                "historical_correctness": 1.0,
            },
        )
        self.assertEqual(baseline, poisoned)
        source = inspect.getsource(reader.route_typed_source_locked_reader)
        for forbidden in ("question_type", "gold_answers", "has_answer", "historical_correctness"):
            self.assertNotIn(forbidden, source)

    def test_ordinary_evidence_set_uses_bound_core_lock(self) -> None:
        question = "How many books did I buy?"
        raw = certificate_raw(question, "explicit_user", [self.later, self.earlier])
        result = self.route(question, raw)
        self.assertEqual("evidence_set", result.route)
        self.assertEqual(2, result.locked_source_count)

    def test_legacy_projection_is_transport_bound_but_not_parsed_as_dialogue(self) -> None:
        question = "Which bicycle do I prefer?"
        projection = Document(
            "user-authority:revision",
            "[Certified user preference projection]",
            "not-a-source-time",
        )
        raw = certificate_raw(
            question,
            "explicit_user",
            [self.later, self.earlier],
            reader_ids=[projection.id],
            reader_contents=[projection.content],
        )
        result = self.route(question, raw, [projection])
        self.assertEqual("legacy", result.route)
        self.assertEqual("legacy", result.context)
        self.assertEqual(2, result.locked_source_count)

    def test_certificate_binds_exact_presentation_ids(self) -> None:
        question = "Which bicycle do I prefer?"
        raw = certificate_raw(
            question,
            "explicit_user",
            [self.later, self.earlier],
            reader_ids=["user-authority:expected"],
            reader_contents=["projection"],
        )
        with self.assertRaises(reader.CertificateInvariantError):
            self.route(
                question,
                raw,
                [Document("user-authority:changed", "projection", "")],
            )

    def test_certificate_binds_exact_presentation_content(self) -> None:
        question = "Which bicycle do I prefer?"
        raw = certificate_raw(
            question,
            "explicit_user",
            [self.later, self.earlier],
            reader_ids=["user-authority:expected"],
            reader_contents=["projection"],
        )
        with self.assertRaises(reader.CertificateInvariantError):
            self.route(
                question,
                raw,
                [Document("user-authority:expected", "changed", "")],
            )


if __name__ == "__main__":
    unittest.main()
