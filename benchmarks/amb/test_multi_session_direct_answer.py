"""Unit tests for query-bound direct-reader policies."""

from run_multi_session_evidence_set_direct_answer import boundary_protocol


def test_boundary_protocol_is_query_derived_and_narrow() -> None:
    assert boundary_protocol("How many homes before the offer?")
    for question in (
        "How many hours did I run last week?",
        "What time did I reach the clinic?",
        "At which university was my undergrad poster?",
        "How many albums did I acquire?",
    ):
        assert boundary_protocol(question) == ""
