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

## v43 diagnostic result and v44 hypothesis

- The v43 21-query diagnostic recovered **3/21** former v42 misses, with no
  answer regression inside that all-wrong diagnostic cohort. One recovery
  gained a correct session in the selected source set; the other two retained
  the same session-level recall and changed downstream evidence use.
- The treatment is not a formal score: projecting its three recoveries onto
  v42 reaches only 115/133 (86.47%), still below the release target. A full
  sealed 133-question run is therefore deferred until a stronger hypothesis
  clears the paired diagnostic and a clean control.
- Session-hash telemetry shows that six of the remaining 18 wrong answers had
  one or more gold sessions in logged raw top-16 discovery but not in the
  fixed eight-source pre-lock aperture. The other twelve retained their
  available gold sessions and require source-local turn localization, state
  resolution, or answer synthesis work instead.
- v43's observed-time reordering also dropped two gold sessions for one
  already-wrong query. It did not create an answer regression, but confirms
  that a global rank reorder is not a monotonic source-acquisition strategy.
- v44 therefore adds a host-bound **two-source temporal aperture reserve**:
  when at least one bound leaf has a non-unbounded temporal operation, source
  acquisition grows from 8 to 10 before the immutable source lock. The
  semantic prefix is retained and the two slots are appended by the existing
  deterministic fair allocator; reader/notebook budgets, authority rules,
  temporal event-time semantics, and locked repair apertures are unchanged.
- First gate: rerun the same 21-query diagnostic with fresh answer cache, then
  run a clean control set of prior temporal successes before deciding whether a
  sealed 133-question treatment is warranted.

## v44 diagnostic result and next decision

- The rerun used the canonical shared index after validating all **13,059**
  source items and all **10,291** required dense embeddings. A first launch was
  discarded before retrieval because its manually copied embedding-version
  string had one extra character; the valid run derived the version directly
  from the prior valid manifest.
- The valid fresh-answer diagnostic completed all 21 sealed rows. Against v43,
  it moved from **3/21** to **4/21** correct: one recovery and **no regressions**
  within this previously-wrong cohort. The result remains a diagnostic, not a
  133-question score.
- The aperture change is real in the emitted telemetry: average selected
  sources rose from 8.00 to 9.81, recalled documents from 7.62 to 9.29, and
  reader context from 2,546 to 2,815 tokens (+10.6%). Gold-session recall rose
  from 0.822 to 0.865. Three rows gained a gold session, but none of those three
  became answer-correct; the one recovered answer already had its gold sessions
  and the same notebook-hit count. Therefore the gain is too small to justify
  widening the aperture again.
- If the one new recovery held with no unseen regressions, the optimistic
  projection would be 116/133 (87.22%), still below the 90% release goal. No
  full 133 treatment is authorized from this signal alone.
- The 17 remaining errors now cluster by audited repair stage as: 7
  source-local/retrieval, 4 temporal state resolution, 3 evidence selection,
  and 3 answer synthesis. Their query forms are five ordered histories, three
  duration/interval calculations, eight cutoff-relative event lookups, and one
  temporal abstention. This points to missing event-level provenance and typed
  temporal operations, rather than another session-level aperture adjustment.
- Next architecture gate: design and test an event-grounding lane that extracts
  date-bearing, source-cited event candidates from the already locked sessions;
  it must produce a typed timeline/interval certificate for ordering, relative
  date lookup, duration, and abstention. It may only augment discovery and
  reader projection; it must not treat conversation `observedAt` as event time,
  replace the semantic source prefix, weaken authority/cutoff checks, or make
  source-lock repair expand its source set. Before implementation, collect a
  per-error reachability audit showing whether the exact gold turn is present
  in the source-local candidate pool and whether an existing execution frame
  can build a valid event-time certificate.

## v44 state-frame reachability audit

- A separate four-query retrieval-only shadow run enabled the existing state
  binder and verifier but did not inject its projection or invoke answer/judge
  models. All four queries had a session-level retrieval hit; the audit is
  therefore isolated from answer-model variation.
- The result rules out a simple projection switch: no query produced a complete
  execution root or a reader projection. Two cutoff-relative lookups proposed
  one and two state observations respectively, but the verifier rejected every
  proposal, leaving no binding certificates. A third query failed the runtime
  coverage-identity guard before a state frame was built. The duration query
  accepted one start observation but left it `unbound`, with no distinct end
  event or endpoint certificate, so `measure_duration` remained partial.
- This is not an evidence-deletion problem. It is an abstraction mismatch: the
  current state binder tries to synthesize a single state value and then prove
  it, while the residual workload requires a set of independently cited events
  plus an order/range/duration operator. The next design must add that event
  layer rather than lower verifier standards or inject partial state frames.

## Rejected v45 source-relative binder trial

- Hypothesis: permit a binder to quote an unambiguous relative-time phrase from
  a locked source and mechanically resolve it against that same source's
  immutable session timestamp. The implementation required an exact quoted
  phrase, used no wall clock or query-authored time, and was covered by focused
  unit tests.
- Result: the four-query shadow gate still produced **zero** complete execution
  roots. The model did not reliably select and verify the newly permitted
  relative-time spans; one lookup remained fully rejected, two hit the existing
  coverage-identity guard, and the duration query retained no valid endpoint.
  Changing the binder's output vocabulary is therefore not sufficient.
- The implementation was reverted in commit `e13ea48` rather than left as an
  unproven opt-in path. The next event-grounding design must enumerate and
  normalize source-local date candidates deterministically before semantic
  selection; an LLM may choose among those immutable candidates, but may not be
  responsible for inventing the event-time representation.

## v46 event-card reachability gate

- The V44 trace was joined back to the pinned benchmark only through hashed
  query, document, and evidence addresses. Across the 21-query temporal
  diagnostic, **20/21** rows already returned at least one gold session, but
  only **5/46** labeled answer turns were admitted to the evidence notebook.
  For the 17 still-wrong rows the corresponding figures were 16/17 and 4/35.
  This makes source-local turn admission, rather than another source-aperture
  expansion, the primary bottleneck.
- A deterministic, label-blind scan of only the V44-returned sessions found
  explicit temporal cues on **33/46** labeled turns (and 33/41 whose sessions
  were returned). It yielded a median of 21 candidate user events per query
  (maximum 29); truncating each immutable event record to 256 characters needs
  at most 6,549 characters in this diagnostic. That fits under the existing
  8,192-character notebook ceiling without using session `observedAt` as an
  event timestamp.
- A content-safe V46 shadow harness is therefore running before a production
  route is proposed. It freezes V44's returned-source union, enumerates only
  explicit-temporal user events, does not read `has_answer` during card
  construction, and emits only HMAC IDs, counts, hashes, and judge verdicts.
  Its answer result is a gate for an event-card reader lane, not a score claim
  or an authorization to change the production resolver.

## Rejected v46 event-card replacement shadow

- The completed 21-query shadow retained the frozen V44 returned-source union
  and kept the candidate policy label-blind. It completed all 21 answer and
  judge calls, with a median 21 cards per row (maximum 29) and an average card
  payload of 4,302 characters.
- Replacing the normal evidence notebook with those cards scored **1/21**
  (4.76%), versus V44's **4/21** on the identical rows. The paired outcome was
  one recovery, four regressions, and 16 rows still incorrect. This is a strong
  negative result: a temporal event card is not a standalone reader context.
- The result does **not** invalidate the reachability finding. It distinguishes
  two requirements for the production design: retain the current semantic
  evidence packet and dialogue context, then add a bounded, source-locked event
  ledger as a supplemental typed view. Any later treatment must prove its
  additive packet preserves the baseline evidence set and stays inside the
  reader token budget; it must not replace the notebook or report V46 as a
  benchmark improvement.
