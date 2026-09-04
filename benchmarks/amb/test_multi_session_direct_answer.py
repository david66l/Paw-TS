"""Unit tests for query-bound direct-reader policies."""

from run_multi_session_evidence_set_direct_answer import boundary_protocol


def test_boundary_protocol_is_query_derived_and_narrow() -> None:
    assert boundary_protocol("How many homes before the offer?")
    assert "seven-day" in boundary_protocol("How many hours did I run last week?")
    assert "appointment" in boundary_protocol("What time did I reach the clinic?")
    assert "research or education stage" in boundary_protocol(
        "At which university was my undergrad poster?"
    )
    assert boundary_protocol("How many albums did I acquire?") == ""
