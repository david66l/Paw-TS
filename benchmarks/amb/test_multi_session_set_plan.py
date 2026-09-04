"""Tests for the label-blind multi-session set plan and executor."""

from __future__ import annotations

import inspect

import pytest

import multi_session_set_plan as subject


PACKET = {"evidenceIds": ["e1", "e2", "e3"]}


def member(key: str, entity: str, value=None, unit=None, *, ids=None, disposition="include", event_time=None):
    return {
        "memberKey": key,
        "evidenceIds": ids or ["e1"],
        "entity": entity,
        "value": value,
        "unit": unit,
        "eventTime": event_time,
        "disposition": disposition,
    }


def proposal(operator: str, members, *, status="complete"):
    return {
        "status": status,
        "operator": operator,
        "members": members if status == "complete" else [],
        "calculation": "model scratch" if status == "complete" else None,
        "answer": "untrusted" if status == "complete" else None,
    }


@pytest.mark.parametrize(
    ("question", "operator", "basis", "arity", "minimum", "exhaustive"),
    [
        ("How many cities did I visit?", subject.Operator.COUNT_MEMBERS, subject.CountBasis.ENUMERATED_MEMBERS, 1, 1, True),
        ("How many attendees were there in total?", subject.Operator.COUNT_MEMBERS, subject.CountBasis.STATED_CARDINALITY, 1, 1, True),
        ("What was the total cost in dollars?", subject.Operator.SUM_VALUES, None, 1, 1, True),
        ("What is the average rating?", subject.Operator.AVERAGE, None, 1, 1, True),
        ("What is the difference between A and B?", subject.Operator.DIFFERENCE, None, 2, 2, False),
        ("What percentage is A of B?", subject.Operator.RATIO_PERCENT, None, 2, 2, False),
        ("Which trip had the highest cost?", subject.Operator.ARGMAX, None, 1, 2, True),
        ("Which score was the lowest?", subject.Operator.ARGMIN, None, 1, 2, True),
        ("List all unique pets.", subject.Operator.COLLECT_UNIQUE, None, 1, 1, True),
        ("Who was my dentist?", subject.Operator.LOOKUP, None, 1, 1, False),
    ],
)
def test_compile_all_operations(question, operator, basis, arity, minimum, exhaustive):
    plan = subject.compile_set_plan(question)
    assert plan is not None
    assert (plan.operator, plan.count_basis, plan.arity, plan.minimum_logical_members, plan.exhaustive_set_required) == (operator, basis, arity, minimum, exhaustive)


def test_compiler_is_text_only_and_recognizes_temporal_modes():
    assert subject.compile_set_plan("What was the latest appointment?").temporal_mode is subject.TemporalMode.LATEST
    assert subject.compile_set_plan("List all meetings between January and March.").temporal_mode is subject.TemporalMode.RANGE
    assert subject.compile_set_plan("How many hours did I exercise last week?").temporal_mode is subject.TemporalMode.RANGE
    assert subject.compile_set_plan("Explain this poem.") is None
    source = inspect.getsource(subject)
    assert "question" + "_type" not in source
    assert "has" + "_answer" not in source


def test_measure_questions_and_fallback_interrogatives_are_not_misclassified():
    hours = subject.compile_set_plan("How many hours in total did I spend driving?")
    assert hours.operator is subject.Operator.SUM_VALUES
    assert hours.requested_unit == "hour"

    money = subject.compile_set_plan("What is the total money spent in the past few months?")
    assert money.operator is subject.Operator.SUM_VALUES
    assert money.requested_unit == "usd"

    assert subject.compile_set_plan("How many pages do I have left to read?").operator is subject.Operator.DIFFERENCE
    assert subject.compile_set_plan("How much will I save by taking the train instead?").operator is subject.Operator.DIFFERENCE
    assert subject.compile_set_plan("Did I receive a higher discount?").operator is subject.Operator.LOOKUP
    assert subject.compile_set_plan("At which university did I present a poster?").operator is subject.Operator.LOOKUP
    assert subject.compile_set_plan("How many homes did I see before making an offer?").temporal_mode is subject.TemporalMode.RANGE


def test_validation_rejects_unknown_evidence_duplicate_keys_and_operator_mismatch():
    plan = subject.compile_set_plan("What was the total cost?")
    with pytest.raises(ValueError, match="not in packet"):
        subject.validate_extraction(plan, PACKET, proposal("sum_values", [member("a", "A", 2, "usd", ids=["bad"])]))
    with pytest.raises(ValueError, match="unique"):
        subject.validate_extraction(plan, PACKET, proposal("sum_values", [member("a", "A", 2, "usd"), member("a", "B", 3, "usd")]))
    with pytest.raises(ValueError, match="differs"):
        subject.validate_extraction(plan, PACKET, proposal("average", [member("a", "A", 2, "usd")]))


def test_binary_roles_numeric_and_units_fail_closed():
    plan = subject.compile_set_plan("What is the difference between A and B in dollars?")
    with pytest.raises(ValueError, match="left and right"):
        subject.validate_extraction(plan, PACKET, proposal("difference", [member("a", "A", 4, "usd"), member("b", "B", 2, "usd")]))
    with pytest.raises(ValueError, match="incompatible"):
        subject.validate_extraction(plan, PACKET, proposal("difference", [member("a", "A", 4, "usd", disposition="left"), member("b", "B", 2, "hour", disposition="right")]))
    with pytest.raises(ValueError, match="numeric"):
        subject.validate_extraction(plan, PACKET, proposal("difference", [member("a", "A", None, "usd", disposition="left"), member("b", "B", 2, "usd", disposition="right")]))


def test_executor_recomputes_counts_and_arithmetic_not_model_answer():
    count = subject.compile_set_plan("How many cities did I visit?")
    extraction = subject.validate_extraction(count, PACKET, proposal("count_members", [member("x", "Paris"), member("y", "Paris", ids=["e2"]), member("z", "Rome", ids=["e3"])]))
    assert subject.execute_set_plan(count, extraction).answer == "2"

    sum_plan = subject.compile_set_plan("What was the total cost in dollars?")
    sum_result = subject.execute_set_plan(sum_plan, subject.validate_extraction(sum_plan, PACKET, proposal("sum_values", [member("a", "A", "1.20", "USD"), member("b", "B", "2.30", "usd", ids=["e2"])])))
    assert sum_result.answer == "$3.5"
    assert "sum" in sum_result.calculation

    average = subject.compile_set_plan("What was the average rating?")
    average_result = subject.execute_set_plan(average, subject.validate_extraction(average, PACKET, proposal("average", [member("a", "A", 2, None), member("b", "B", 3, None, ids=["e2"])])))
    assert average_result.answer == "2.5"


def test_stated_cardinality_difference_ratio_arg_extremes_and_collection():
    stated = subject.compile_set_plan("How many attendees were there in total?")
    stated_result = subject.execute_set_plan(stated, subject.validate_extraction(stated, PACKET, proposal("count_members", [member("a", "morning", 3, None), member("b", "afternoon", 4, None, ids=["e2"])])))
    assert stated_result.answer == "7"

    diff = subject.compile_set_plan("What is the difference between A and B?")
    diff_result = subject.execute_set_plan(diff, subject.validate_extraction(diff, PACKET, proposal("difference", [member("a", "A", 9, None, disposition="left"), member("b", "B", 4, None, disposition="right", ids=["e2"])])))
    assert diff_result.answer == "5"

    ratio = subject.compile_set_plan("What percentage is A of B?")
    ratio_result = subject.execute_set_plan(ratio, subject.validate_extraction(ratio, PACKET, proposal("ratio_percent", [member("a", "A", 1, None, disposition="left"), member("b", "B", 4, None, disposition="right", ids=["e2"])])))
    assert ratio_result.answer == "25%"

    maximum = subject.compile_set_plan("Which trip had the highest cost?")
    max_result = subject.execute_set_plan(maximum, subject.validate_extraction(maximum, PACKET, proposal("argmax", [member("a", "A", 4, "usd"), member("b", "B", 9, "USD", ids=["e2"])])))
    assert max_result.answer == "B"

    collection = subject.compile_set_plan("List all unique pets.")
    collection_result = subject.execute_set_plan(collection, subject.validate_extraction(collection, PACKET, proposal("collect_unique", [member("a", "cat"), member("b", "Dog", ids=["e2"]), member("c", "cat", ids=["e3"])])))
    assert collection_result.answer == "cat, Dog"


def test_latest_requires_time_and_uses_latest_member_and_noncomplete_is_not_repaired():
    plan = subject.compile_set_plan("What was the latest appointment?")
    with pytest.raises(ValueError, match="eventTime"):
        subject.validate_extraction(plan, PACKET, proposal("lookup", [member("a", "old")]))
    extraction = subject.validate_extraction(plan, PACKET, proposal("lookup", [member("a", "old", event_time="2024-01-01T00:00:00Z"), member("b", "new", ids=["e2"], event_time="2025-01-01T00:00:00Z")]))
    assert subject.execute_set_plan(plan, extraction).answer == "new"
    insufficient = subject.validate_extraction(plan, PACKET, proposal("lookup", [], status="insufficient"))
    assert subject.execute_set_plan(plan, insufficient).status == "insufficient"
