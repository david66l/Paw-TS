"""Content-safe temporal event-card shadow evaluation.

This is intentionally not a production retrieval route.  It tests one bounded
architectural hypothesis against a frozen LongMemEval ledger:

* preserve V44's already-returned source-session set;
* enumerate only user turns with an explicit temporal cue inside that set;
* pass compact, addressable event cards to the answer model; and
* record only HMAC IDs, hashes, counts, and verdicts.

The evaluator never uses ``has_answer`` to construct a card.  That annotation is
consulted neither during card generation nor answer generation; it remains a
benchmark-only diagnostic label.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "paw.temporal-event-card-shadow.v1"
CARD_LIMIT = 32
CARD_CONTENT_LIMIT = 256
TEMPORAL_CUE = re.compile(
    r"\b(?:last|next|this|past|ago|yesterday|today|tomorrow|weekend|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"january|february|march|april|may|june|july|august|september|"
    r"october|november|december|week|weeks|month|months|year|years|"
    r"day|days|hour|hours|before|after|earlier|later|first|second|"
    r"third|fourth|fifth|\d{1,2}[/-]\d{1,2})\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class EventCard:
    document_id: str
    turn_index: int
    content: str


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def eval_hmac(value: str, key: bytes) -> str:
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_retrieved_document_hashes(path: Path) -> dict[str, set[str]]:
    """Index V44 retrieval telemetry by plaintext-query digest.

    A query can call retrieval more than once.  The union is the conservative
    fixed source boundary for this shadow; no additional session retrieval is
    performed here.
    """

    results: dict[str, set[str]] = defaultdict(set)
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") != "retrieve":
            continue
        detail = event.get("detail")
        if not isinstance(detail, dict):
            continue
        query_hash = detail.get("queryHash")
        source_hashes = detail.get("returnedSourceDocumentHashes")
        if not isinstance(query_hash, str) or not isinstance(source_hashes, list):
            continue
        results[query_hash].update(
            value for value in source_hashes if isinstance(value, str)
        )
    return results


def enumerate_cards(item: dict[str, Any], returned_document_hashes: set[str]) -> list[EventCard]:
    question_id = required_string(item, "question_id")
    cards: list[EventCard] = []
    session_ids = item.get("haystack_session_ids")
    sessions = item.get("haystack_sessions")
    if not isinstance(session_ids, list) or not isinstance(sessions, list):
        raise ValueError("LongMemEval session arrays are invalid")
    for session_id, turns in zip(session_ids, sessions):
        if not isinstance(session_id, str) or not isinstance(turns, list):
            raise ValueError("LongMemEval session entry is invalid")
        document_id = f"{question_id}_{session_id}"
        if sha256_text(document_id) not in returned_document_hashes:
            continue
        for turn_index, turn in enumerate(turns, start=1):
            if not isinstance(turn, dict):
                continue
            role = str(turn.get("role", "")).strip().lower()
            content = str(turn.get("content", "")).strip()
            if role != "user" or not content or not TEMPORAL_CUE.search(content):
                continue
            cards.append(
                EventCard(
                    document_id=document_id,
                    turn_index=turn_index,
                    content=content[:CARD_CONTENT_LIMIT],
                )
            )
    # Deterministic source-order is intentional: this shadow measures candidate
    # coverage, not a new ranking heuristic.
    return cards[:CARD_LIMIT]


def required_string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ValueError(f"LongMemEval {key} is invalid")
    return result


def benchmark_answer_text(value: dict[str, Any]) -> str:
    """Mirror the benchmark's permissive gold-answer interpolation.

    LongMemEval contains one numeric answer in this diagnostic and abstention
    explanations may be blank.  Neither case is malformed for the official
    judge prompt, which renders values with normal string interpolation.
    """

    result = value.get("answer", "")
    if isinstance(result, (str, int, float, bool)) or result is None:
        return "" if result is None else str(result)
    raise ValueError("LongMemEval answer has an unsupported shape")


def chat_completion(*, prompt: str, model: str, base_url: str, api_key: str) -> str:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
            }
        ).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"model request failed with HTTP {error.code}") from error
    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("model response has no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("model response content is invalid")
    return content.strip()


def answer_prompt(question: str, cards: list[EventCard]) -> str:
    evidence = "\n\n".join(
        f"[Event {index}; source-turn {card.turn_index}]\n{card.content}"
        for index, card in enumerate(cards, start=1)
    )
    return f"""Answer the memory question using only the event cards below.
Each card is a user statement from a retrieved conversation.  A conversation
date is not an event date, so do not infer a date not stated by a card.  Preserve
the order of events when the question asks for a sequence.  If the cards do not
establish the answer, say that the information is insufficient.

Question: {question}

Event cards:
{evidence if evidence else '[No temporal event cards were retrieved.]'}

Answer concisely."""


def judge_prompt(question: str, gold: str, answer: str, abstention: bool) -> str:
    if abstention:
        body = f"""I will give you an unanswerable question, an explanation, and a response.
Set correct=true only if the response correctly identifies that the information is incomplete.

Question: {question}
Explanation: {gold}
Model Response: {answer}"""
    else:
        body = f"""I will give you a question, a correct answer, and a response.
Set correct=true if the response contains the correct answer.  It must include
all requested items.  For days, weeks, months, or years, do not penalize an
off-by-one difference.

Question: {question}
Correct Answer: {gold}
Model Response: {answer}"""
    return body + '\nReturn JSON with exactly "correct" (boolean) and "reason" (one sentence).'


def verdict(text: str) -> tuple[bool | None, str]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None, "invalid_json"
    correct = parsed.get("correct") if isinstance(parsed, dict) else None
    reason = parsed.get("reason") if isinstance(parsed, dict) else None
    return (correct if isinstance(correct, bool) else None), (
        reason if isinstance(reason, str) else "missing_reason"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--retrieval-log", type=Path, required=True)
    parser.add_argument("--eval-hmac-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    model = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash").strip()
    base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip()
    if not api_key:
        raise ValueError("DEEPSEEK_API_KEY is required")
    if not model or not base_url:
        raise ValueError("DeepSeek endpoint configuration is invalid")

    dataset = load_json(args.dataset)
    sealed = load_json(args.ledger)
    if not isinstance(dataset, list) or not isinstance(sealed, dict):
        raise ValueError("dataset or ledger is invalid")
    rows = sealed.get("rows")
    if not isinstance(rows, list):
        raise ValueError("sealed ledger rows are invalid")
    key = args.eval_hmac_key.read_bytes().strip()
    if not key:
        raise ValueError("evaluation HMAC key is empty")
    by_hmac = {
        eval_hmac(required_string(item, "question_id"), key): item
        for item in dataset
        if isinstance(item, dict)
    }
    retrieved = load_retrieved_document_hashes(args.retrieval_log)

    result_rows: list[dict[str, Any]] = []
    for index, baseline in enumerate(rows, start=1):
        if not isinstance(baseline, dict):
            raise ValueError("sealed ledger row is invalid")
        query_hmac = baseline.get("queryHmac")
        if not isinstance(query_hmac, str) or query_hmac not in by_hmac:
            raise ValueError("ledger query cannot be bound to the pinned dataset")
        item = by_hmac[query_hmac]
        question = required_string(item, "question")
        cards = enumerate_cards(item, retrieved.get(sha256_text(question), set()))
        answer = chat_completion(
            prompt=answer_prompt(question, cards),
            model=model,
            base_url=base_url,
            api_key=api_key,
        )
        judge = chat_completion(
            prompt=judge_prompt(
                question,
                benchmark_answer_text(item),
                answer,
                required_string(item, "question_id").endswith("_abs"),
            ),
            model=model,
            base_url=base_url,
            api_key=api_key,
        )
        correct, reason = verdict(judge)
        result_rows.append(
            {
                "queryHmac": query_hmac,
                "questionType": item.get("question_type"),
                "baselineCorrect": baseline.get("answerCorrect"),
                "cardCount": len(cards),
                "cardChars": sum(len(card.content) for card in cards),
                "answerHash": sha256_text(answer),
                "judgeReasonHash": sha256_text(reason),
                "correct": correct,
            }
        )
        print(f"completed {index}/{len(rows)}", flush=True)

    judged = [row for row in result_rows if isinstance(row["correct"], bool)]
    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "contentFree": True,
        "candidatePolicy": {
            "sourceBoundary": "frozen_v44_returned_source_union",
            "role": "user_only",
            "temporalCue": "explicit_regex_v1",
            "cardLimit": CARD_LIMIT,
            "cardContentLimit": CARD_CONTENT_LIMIT,
            "usesBenchmarkHasAnswer": False,
        },
        "rows": result_rows,
        "metrics": {
            "count": len(result_rows),
            "judgedCount": len(judged),
            "correctCount": sum(row["correct"] is True for row in judged),
            "accuracy": (
                sum(row["correct"] is True for row in judged) / len(judged)
                if judged
                else None
            ),
            "baselineCorrectCount": sum(
                row["baselineCorrect"] is True for row in result_rows
            ),
            "meanCardCount": (
                sum(row["cardCount"] for row in result_rows) / len(result_rows)
                if result_rows
                else 0
            ),
            "meanCardChars": (
                sum(row["cardChars"] for row in result_rows) / len(result_rows)
                if result_rows
                else 0
            ),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
