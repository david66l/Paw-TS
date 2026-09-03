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

## Current state

The first detached 8-shard runner launch did not remain registered in `screen`.
No result file or merged score has been accepted from it. Before relaunch, inspect
its master log and slice files, then launch the sealed 133-question treatment in
an explicitly monitored detached process. Do not compare a result until all eight
sealed slice ledgers are present and merger validation succeeds.

## Connectivity note

On 2026-09-04, immediately after the initial detached-launch check, the cloud
SSH endpoint at `connect.nmb1.seetacloud.com:20021` began refusing TCP
connections. This is recorded as infrastructure state, not as an experiment
result. No recovery, cleanup, or result acceptance action has been taken while
the endpoint is unreachable.
