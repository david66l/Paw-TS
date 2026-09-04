# Preference user-authority experiment log

Date: 2026-09-04

## Objective

Raise the 30 LongMemEval single-session preference questions from the historical
18/30 (60.00%) result to at least 85% without question-specific rules, gold
labels in the reader, source expansion, or extra model calls.

## Diagnosis

- The frozen v26b source aperture already contained the gold session for 29/30
  questions. Retrieval was not the primary bottleneck.
- The old packet mixed short user statements with much longer assistant
  responses. Recommendation generation therefore treated generic assistant
  advice as if it described the user.
- Exact recommendations are usually not present in memory. Memory should be
  authoritative for user facts and constraints, while the answer model may use
  general knowledge to synthesize a recommendation.

## Frozen treatment architecture

The v2 treatment keeps the existing source lock unchanged and replaces the old
reader packet atomically:

1. Lane A keeps the first four sources in frozen retrieval order.
2. Lane B runs deterministic BM25 over complete user-only sessions inside the
   same top-eight lock and selects two sources.
3. A stable union keeps Lane A first, deduplicates Lane B, and contains at most
   six complete sessions.
4. Every selected session contributes all user turns in chronological order.
   Assistant turns are never injected.
5. The reader distinguishes user-authoritative facts from general-knowledge
   recommendation synthesis. It preserves positive and negative preferences,
   comparisons, goals, constraints, previous effects, novelty, and
   entity-attribute relations.
6. The replacement must fit within the legacy packet character budget. Any
   missing source, incomplete hydration, invalid hash, future turn, duplicate
   reference, out-of-lock evidence, or budget overflow falls back to the whole
   legacy packet.

The selector and reader do not consume `answer`, `answer_session_ids`,
`has_answer`, `question_type`, category labels, or residual correctness. Gold
fields are read only by the post-generation evaluator.

## Frozen shadow evidence

- Target questions: 30
- Source-lock identity preserved: 30/30
- Gold-source coverage in old lock: 29/30
- Gold user endpoints covered: 42/44
- Complete user-endpoint coverage: 29/30
- Assistant turns injected: 0
- Out-of-lock user turns: 0
- Post-cutoff user turns: 0
- Duplicate evidence references: 0
- Projected raw characters: 177,848
- Historical context characters: 312,955
- Projection/historical character ratio: 56.83%
- Two independent shadow runs produced identical packets.

## Formal standalone treatment result

Artifact: `runs/preference-user-authority-v1/answer-v2/merged.json`

- Model: GLM-5.3-flash through the existing OpenAI-compatible adapter
- Memory tools bound: no
- Questions: 30
- Correct: 28
- Accuracy: 93.33%
- Projection-covered questions: 29
- Correct among projection-covered questions: 28/29 (96.55%)
- Mean rendered context: 6,531.8 characters
- Maximum rendered context: 7,740 characters
- Answer calls: 30
- Judge calls: 30

The historical 18/30 run used a different model configuration, so the apparent
+10 row-aligned gain is diagnostic rather than a causal paired A/B claim. A
paper-grade result still requires the same model, prompt, judge, source lock,
and call ordering for both baseline and treatment.

## Remaining two errors

- One covered question mixed recommendations from an unrelated domain into an
  otherwise correct answer. The generic reader rule now says to use only the
  relevant domain; no question- or domain-specific exception was added.
- One question's supporting session was outside the frozen retrieval lock. The
  v1 treatment deliberately does not expand retrieval, so it falls back rather
  than weakening source-lock provenance.

## Product bridge integration

`PAW_AMB_RECOMMEND_USER_AUTHORITY_MODE=off|shadow|replace` controls the path and
defaults to `off`. `shadow` computes and records the projection without changing
the legacy response. `replace` changes the answer packet only after exact
immutable hydration and all validation succeeds. It cannot run together with
the typed execution-reader injection.

The bridge uses the initial deterministic `recommend + user` intent, preserves
the frozen source aperture, adds no LLM call, emits content-free telemetry, and
retains underlying source evidence references in the replacement metadata.

## Verification

- Preference Python tests: 14/14
- Existing temporal Python tests: 49/49
- TypeScript projection tests: 7/7
- Python compilation and Ruff: passed
- New TypeScript module formatting/lint: passed
- Bridge lint with formatting disabled: passed; the file retains its existing
  CRLF style to avoid a whole-file line-ending diff.
- AMB TypeScript project still has pre-existing errors in
  `support-selector-observer`; the new preference projector and bridge changes
  add no TypeScript errors.

Before publishing benchmark claims, run a same-model paired 30-question A/B and
then a full 500-question non-regression evaluation.
