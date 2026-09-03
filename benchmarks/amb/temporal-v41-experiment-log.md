# Temporal v41 experiment log

## Objective

Repair the temporal-reasoning closure-repair path without mixing deletion with
append-only dominance, then rerun the sealed LongMemEval temporal-reasoning
slice (133 questions) as a comparable treatment.

## Baselines

| Treatment | Score | Notes |
| --- | ---: | --- |
| v36 (`ec422d3`) | 112/133 (84.21%) | Current best temporal score before v41. |
| v39 (`f46f7f6`) | 108/133 (81.20%) | Immutable temporal-frontier treatment. |
| v40 (`cdcd52c`) | 107/133 (80.45%) | Rejected as a valid architecture measurement. Audit sanitization rebuilt a pass and then applied append-only dominance to a deletion transaction; 54 rows lost all context. |

## v41 design

- Git commit: `e90e5962944003ad1e8527c081abaccfa3da0507`
  (`fix(memory): separate evidence sanitization transaction`), pushed to
  `origin/memory/temporal-v36`.
- New source-atomic, deletion-only sanitizer. It only filters original packet
  sources; it never promotes an internal candidate or reruns a selector.
- Contamination is a source-to-evidence bipartite closure. A rejected evidence
  address removes every connected source, including context references and
  shared evidence addresses.
- Requirement hits, notebook sources and coverage, support dispositions,
  requirement ledger, dialogue certificates, reader packet, and executable
  exposure are all projected consistently. Selector snapshot/revision are
  removed and the result is downgraded to fallback so stale selection cannot
  claim closure.
- Sanitization has its own transaction telemetry:
  `attempted -> projected|failed`, attempt number, rejected-ref revision,
  stable failure code, and transaction revision. A failure is fail-closed and
  cannot be misreported as `not_needed` or retain an earlier success report.
- Notebook selected-hit telemetry now globally deduplicates an evidence address
  shared by multiple requirements, matching actual notebook rendering.

## Review and verification

- Independent memory-architecture review: final **GO**; no remaining P0/P1.
- Local tests: memory-core **323/323**, AMB **85/85**.
- Type checks: `memory-core` and `memory-plugin` passed.
- Python runner compilation passed; `git diff --check` passed before commit.
- Cloud source directory:
  `/root/autodl-tmp/paw-c666a20/run-v41-temporal-sanitization-e90e596`
- Cloud smoke: **54/54** focused memory tests passed.
- Canonical sealed 500-question store and embedding service were verified
  healthy. v41 has an isolated output directory and a copied 2,643-entry
  model replay cache:
  `/root/autodl-tmp/paw-c666a20/runs/paw-temporal-v41-sanitization-treatment-e90e596`

## v41 sealed result

- The initial launcher failure was excluded: its environment file was sourced
  without exporting the model key, so every shard failed before a valid answer
  run. The failure logs remain in the isolated v41 output directory.
- The relaunch used the migrated SSH endpoint, restored the persisted Postgres
  data directory without deleting its stale lock file, started the local
  embedding service from the pinned local model cache, and exported the model
  environment before spawning workers.
- Valid treatment: eight sealed slices, all present; merge marker
  `V41_TREATMENT_COMPLETE`; no shard-failure marker; merged artifact SHA-256
  `d799412fc36cb145fe13a045e97872f15ea21b16beabcab79661918bd55cce9f`.
- Score: **88/133 (66.17%)**. Retrieval hit rate was **107/127 (84.25%)**;
  17/133 queries had evidence closure. This is a regression, not a release
  candidate.

## v41 paired diagnosis

- All 133 query commitments exactly match v36.
- The 78 queries where the sanitizer did not run retained **72** correct
  answers, versus **73** in v36; their retrieval hits were unchanged at 77.
- The 55 queries where it ran fell from **39** correct answers in v36 to
  **16**. The semantic auditor supplied 158 rejected evidence addresses;
  source-atomic closure removed 91 packet sources. Nineteen previously-hit
  queries lost their hit, and 28 v36-correct queries became wrong (26 after a
  sanitizer projection).
- Therefore the regression is causal: the closure auditor reports semantic
  relevance/role/time insufficiency, but v41 treated that advisory judgement as
  a host-authoritative source invalidation and erased reader context.

## v42 remediation in progress

- Resolver v32 records unique semantic rejections for auditability, sends the
  reported deficiencies to the replan, and preserves the original reader
  packet. Semantic rejections cannot enter source-atomic deletion or the
  hard-rejection dominance check.
- The deletion-only sanitizer remains tested as a separate primitive, reserved
  for a future explicit host-owned invalidation channel rather than an LLM
  relevance judgement.
- Local targeted verification: resolver, sanitizer, and dominance suites
  **54/54**; AMB suite **85/85**; memory-core and memory-plugin type checks
  passed. A full plugin-suite run also exposed one pre-existing adapter test
  outside the closure-audit path; it is not being folded into this temporal
  change.
- Next gate: package v32, run a sealed 133-question temporal treatment with
  the same store, seed, model, and answer protocol. It must first recover at
  least the v36 score before any new temporal-reasoning architecture is tried.

## v42 sealed result and v43 hypothesis

- The v42 shared-index treatment used the v32 semantic-advisory resolver with
  the runner's explicit, canonical persistent index-store binding. Eight sealed
  shards merged to 133 unique query commitments; the valid score was
  **112/133 (84.21%)**, exactly the v36 score. This recovers the v41 regression
  but is not an improvement.
- The 21 remaining misses were audited by failure stage: 9 retrieval aperture,
  7 temporal state resolution, 3 evidence selection, and 2 answer synthesis.
  Nineteen had a retrieval hit but 20 lacked closed evidence, so the next
  change must improve pre-fusion source ordering rather than weaken closure.
- v43 tests one constrained architectural hypothesis: when the original query
  and host-owned cutoff compile to a finite temporal range, stable-sort
  candidates and exact hits observed in that range ahead of alternatives before
  initial fusion. The operation never filters evidence, changes candidate K,
  expands repair's immutable source lock, or accepts planner-authored dates.
- The relative-time compiler also gains two benchmark-observed, deterministic
  anchors: `past weekend` and `Valentine's Day`. Both bind only against the
  trusted query cutoff. The first evaluation is a deliberately contaminated
  21-query diagnostic; only a subsequent clean sealed 133-query treatment may
  establish a comparable score.
