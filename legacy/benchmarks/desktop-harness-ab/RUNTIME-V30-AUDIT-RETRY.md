# V30: bounded audit-only timeout recovery

Date: 2026-09-09. Desktop host and Paw Next V3. This implements the recovery issue found in the V29 high run; it is not a new live-model benchmark.

## Problem and behavior

V29 delivered code passing 15/15 external checks and 31/31 project tests, but a 120-second audit timeout reopened the coding loop. The generic fallback asked the executor to recheck the diff and rerun verification. One optional memory query plus four root requests added 151,629 reported tokens before another independent audit began. The task eventually exhausted its global wall budget.

New desktop runs now retry `AuditTimeout` once **inside completion review**, against the same candidate and original tool evidence. No repair input is inserted between the two attempts, so the timeout alone does not rerun root implementation or verification. Each attempt has a distinct durable review ID and child call ID. If the second attempt also times out, acceptance stays unverified and desktop returns incomplete instead of starting another coding segment. Explicit new queued user work still follows the existing input path.

The per-attempt deadline remains 120 seconds and the per-auditor limit remains 12 model turns. At most two attempts are allowed for one candidate; the caller's cancellation signal and any enclosing task wall/call limit still apply. There is no background retry, increased root step allowance or unbounded loop. An explicit defect/block verdict continues through normal implementation repair. Other errors, including invalid report formats, retain their existing handling.

## Implementation

- `packages/completion-review/src/controller.ts`: opt-in `retryOnceOn`, with the initial review ID unchanged and a single `-retry-1` identity. Both claims and settlements are journaled. Recreating the controller reuses existing results; retry eligibility never comes from an in-memory attempt counter. Parent cancellation cannot publish a late allow. A journal-tail check and compare-and-set claim prevent new input racing the retry guard from silently starting another old audit.
- `apps/cli/src/paw-next/composition.ts`: reprojects the candidate and checks pending input before retrying. Changed candidate hashes or pending input decline the retry. A second timeout exits review without adding generic implementation feedback. Audit child call IDs include the retry suffix; root-only retry options are removed from child profiles.
- `apps/cli/src/paw-next/environment-audit.ts`: forwards the attempt identity to its existing independent child runner. The existing file-read, current-content, browser and verdict checks remain responsible for acceptance. Each new auditor reads files independently; partial findings from a timed-out auditor do not become proof of success.
- V3 profile/manifest and desktop run records: `environmentAuditRetry` freezes `paw.environment-audit-retry.v1` into new audited desktop identities. It requires environment auditing. Old identities omit it, and desktop recovery reconstructs that exact absence. Existing persisted fallback text and feedback IDs are unchanged.
- The wire probe now also snapshots the completion-review controller and continuation source, so later experiments retain the new implementation.

The legacy MEA auditor (`packages/agent/src/mea/auditor.ts`) already treats timeout conservatively but uses a separate 300-second budget and does not provide this durable retry mechanism. This change uses the V3 journal/controller and child recovery paths; it does not import the old runtime or adopt its longer timeout.

## Validation

The targeted integration regression passed 85 tests across nine files, covering desktop auditing, legacy identity recovery, product identity, review envelopes, memory admission and request guidance. After adding the final claim-race check, the controller plus desktop-audit suites passed 22 tests (97 assertions). These suites overlap and are not added together as a unique test count. CLI, desktop renderer/host and completion-review typechecks pass; Git whitespace checks pass.

Desktop fault tests exercise real file tools, child runs, durable journals, monitor projection and recovery with a deterministic model. Only the 120-second audit timer is compressed to three seconds; production deadlines and model settings are unchanged. They establish:

| Fault / outcome | Root model calls | Audit model calls | Result |
| --- | ---: | ---: | --- |
| First audit times out, retry reads and passes | 2 | 4 | verified |
| Both audits time out | 2 | 4 | unverified; no new coding segment |
| File changes at the first timeout | 2 | 2 | unverified; stale-candidate retry declined |

The root's two calls are the initial write and its final answer. Recovery after both success and exhaustion makes zero additional model calls. Two real subprocess-crash tests stop after either the initial audit claim or the retry claim is committed; recovery reuses the intended identity without repeating the root write. A pre-retry audited desktop session also restores with its original config hash and no model calls.

Controller tests cover retry exhaustion across reconstruction, a crash between attempts, declined retries, input racing the claim, parent cancellation/late results, and non-timeout outcomes. Memory admission tests show that a timed-out audit and an unsettled retry cannot supply verified memory; only the successful, bound retry can.

Logs are retained under ignored `.runs/2026-09-08-v30-*` and `.runs/2026-09-09-v30-*` (work crossed local midnight). No cloud model calls, Docker startup or PostgreSQL startup were required for these checks. Paw's PostgreSQL remains stopped following the user's pause/resource-release request.

## Limits and next measurement

This demonstrates bounded recovery and the absence of root re-execution in fault tests. It does not establish a live high-mode completion rate, a latency improvement or a measured token saving. A retry starts a fresh independent audit against the retained executor evidence; it does not resume an unfinished model generation or trust a partial report. Provider/header delays may still consume either attempt's deadline.

The next measurement is a fresh high queue task using the same external verifier and original overall budget, including the V29 report-length fix and this new frozen recovery policy. Preserve unknown usage and unsuccessful outcomes when comparing it with V29. Do not retroactively reclassify the V29 run or claim its 151,629-token repair cost as an observed saving.
