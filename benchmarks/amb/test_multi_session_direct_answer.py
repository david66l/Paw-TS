"""Unit tests for query-bound direct-reader policies."""

from multi_session_set_plan import compile_set_plan
from run_multi_session_evidence_set_direct_answer import (
    INSUFFICIENT_ANSWER,
    boundary_protocol,
    finalize_answer,
)


def test_boundary_protocol_is_query_derived_and_narrow() -> None:
    assert boundary_protocol("How many homes before the offer?")
    assert "seven-day" in boundary_protocol("How many hours did I run last week?")
    assert "appointment" in boundary_protocol("What time did I reach the clinic?")
    assert "research or education stage" in boundary_protocol(
        "At which university was my undergrad poster?"
    )
    assert boundary_protocol("How many albums did I acquire?") == ""


def test_zero_count_is_fail_closed_without_affecting_nonzero_or_measure() -> None:
    count = compile_set_plan("How many egg tarts did I bake?")
    assert finalize_answer(count, "0 times") == INSUFFICIENT_ANSWER
    assert finalize_answer(count, "2 times") == "2 times"
    measure = compile_set_plan("How many hours did I exercise last week?")
    assert finalize_answer(measure, "0.5 hours") == "0.5 hours"
