# V26: desktop V3 with configured high, environment audit and PostgreSQL

2026-09-08. Max ablations are paused. The ignored local GLM-5.3-Flash preset now selects `high`; the new `--configured-profile` probe uses that profile without a wire override. This is a correctness and integration exercise, not a controlled efficiency benchmark.

## Concrete failures and fixes

1. **Continuing a conversation after completion review.** `apps/cli/src/paw-next/composition.ts` now re-anchors a terminal decision after `completion.review_settled`, using the existing maintenance refresh. Pending accepted inputs are skipped when finding this maintenance tail. The strict work-segment planner still rejects unsupported facts after a terminal decision. The original symptom was `Only pending input.accepted facts may follow the current segment terminal decision`.
2. **Valid audit JSON preceded by prose.** `environment-audit.ts` used `JSON.parse(result.summary)`, so completed auditor responses became generic `AuditUnavailable` and caused executor rechecks. Recorded recovery responses 7 and 15 each end in a complete report with zero unmet criteria (summary lengths 407 and 1,853), preceded by prose. The legacy MEA parser already tolerated report envelopes. V3 now accepts a single final object, optionally fenced, while rejecting malformed, truncated, multiple or ambiguous objects. Bad format is `AuditReportInvalid`. Strict field validation, successful tool reads, file fingerprints, workspace boundaries and browser proof binding remain mandatory.
3. **Auditor output pagination denied by its own workspace boundary.** `context_recall` advertised its private backing directory as a workspace file resource. The auditor correctly denies direct `.paw` access, which inadvertently blocked pagination of its own large tool result. Recall now declares no workspace file resources: authorization remains the exact artifact binding in the current canonical session journal, with the existing quota and exclusive workspace lock. Private file reads and arbitrary path IDs remain denied. The plugin identity is bumped to `paw.output-recall.v3:journal-authority`; old frozen runs are not silently relabeled. Desktop recovery still requires the original configuration; changed configurations require a new task.
4. **Blocking Git inspection.** The live high run again recorded `git_status: spawnSync git ETIMEDOUT`. After that run, Harness's status/log/diff paths were switched to cancellable asynchronous native Git processes, retaining the 10-second timeout, 1 MiB output bound and shared parsers. Legacy synchronous APIs remain available. On the same settled workspace, the actual Harness tools subsequently succeeded in 93/79/82 ms. This removes synchronous host blocking; it does not establish the lower-level cause of every Windows Git timeout. Tests cover actual native Git output, cancellation, missing cwd, resource locks and permissions. A legacy test fixture's shell quoting was also made portable using argument arrays.

Two deterministic model fixtures were also corrected: the ordinary greeting fixture now respects the separate delivery-review JSON contract, and the long-horizon fresh-repair fixture actually reads the file it claims to recheck.

## Settled pre-fix observations

| Run | Memory | Audit | Duration | Physical requests | Reported tokens | Outcome |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `2026-09-08-v26-minimal-high` | Off | Off | 49.199 s | 4 | 12,759 | Completed; exact file bytes passed |
| `2026-09-08-v26-queue-high-audit` | Off | On | 720.184 s | 25 | 533,068 | Outer deadline interrupted audit; independent 15/15, own tests 19/19 |
| `2026-09-08-v26-queue-high-recover` | Off | On | 363.704 s | 15 | 392,635 | Same canonical run recovered, then incomplete/unverified after invalid report parsing; independent 15/15, own tests 19/19 |

The recovery row is additional work on the preceding run, not a fresh independent sample. Its report's `recoveries` counter concerns experimental reasoning recovery, not the explicit recovery invocation. The first queue attempt has one request with missing usage. Reported tokens include cached input; these totals are not billed-token estimates. Concurrent local validation and uncontrolled provider conditions prevent speedup claims.

## Post-fix full task

`2026-09-08-v26-queue-high-fixed` is a fresh task through the actual desktop entry point, with configured high, memory enabled and independent auditing enabled. It completed in **680.708 seconds**, with **27 physical requests**, **651,073 reported tokens** and **3 requests without usage**. Paw returned `completed` / `acceptance: verified`. The external Docker grader passed **15/15** checks and the delivered `npm test` passed **30/30** tests. There were no delegated workers or experimental reasoning recoveries. The snapshot includes the continuation, audit-envelope and output-recall fixes; the Git asynchronous change was made and tested afterward.

The model needed to repair its own test command and persistence/CLI behavior. The audit gate eventually passed; this sample does not establish a success rate, a token saving, superiority over another coding agent, or exhaustive correctness beyond the checks exercised.

Memory is **partially validated**: two raw evidence spans were durably archived, but there are zero generated formal memory items from this task. Startup retrieval planning had one bounded cancellation and one HTTP 429; terminal extraction also received HTTP 429, code `1305`, with the provider message `该模型当前访问量过大，请您稍后再试`. The journal records `MemoryWriter_CheckpointAuxiliaryModel_Error`, and topic organization was skipped because no source write succeeded. Coding acceptance does not imply automatic memory extraction succeeded. The provider failure is retained as a failure, not converted into fabricated memory. A durable background retry mechanism for failed, unstaged extraction is still needed; this change does not implement it.

## Local memory connection

The existing `paw-amb-postgres` container was stopped. It runs pgvector/PostgreSQL on loopback port 54329. Its `paw_memory_test` database contains approximately 498k test rows and was left intact. A separate empty `paw_memory` database was created in that same container and all 38 repository migrations applied. No additional database container or downloaded image was needed.

The ignored root `.env.local` now points the desktop Bun host at this local database. Cloud PostgreSQL is not connected. `local-memory-smoke.ts` verified real PostgreSQL write/read, text and vector retrieval, scope isolation, persistence after closing/reopening the client, and exact-ID cleanup of its own fixture. This validates storage mechanics, not model-generated memory quality. The new paid queue run enables the desktop memory plugin as well as independent auditing.

## Validation

- Initial broad regression: 837 passed, 3 skipped, 3 failed; all three failures were subsequently addressed. Windows skips concern unprivileged file symlink creation; junction and hardlink checks ran.
- Conversation/long-task/host regression after the first fix: 65 passed; work-segment planner and memory-maintenance boundaries: 39 passed.
- Audit parser cases include prose, fences, quoted braces, malformed/truncated/multiple reports, missing reads and unchanged browser evidence checks.
- A real desktop-host integration fixture reads a large file, successfully invokes `context_recall` inside the restricted auditor, and accepts prose plus JSON without another executor repair.
- Final audit/recall/product regression: 40 passed. Git/permission/resource-lock regression: 24 passed. The stricter native-result assertion for the auditor recall also passed in the subsequent desktop suite.
- CLI and desktop frontend/host typechecks passed after audit/recall changes.
- Native Electron QA passed with real Bun host/preload and isolated user data at 960×640, 1100×800 and 1440×960. Navigation, composer visibility, context popup and overflow checks passed. The compression popup response is a UI fixture; actual compaction behavior is covered separately by deterministic integration tests, not a paid large-context run.

Raw requests, SSE, source snapshots, journals and verification logs remain under ignored `.runs/`. They are diagnostic artifacts, not content to publish.

## Reproduction

```powershell
bun run benchmarks/desktop-harness-ab/local-memory-smoke.ts
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <fresh-output-directory> --queue --single-agent --wall-and-call-budget --docker --configured-profile --environment-audit --memory
python benchmarks/desktop-harness-ab/single-agent-report.py <settled-output-directory>
```

The paid probe uses Docker for generated shell commands, no network and only its isolated task workspace mounted. Host credentials and local PostgreSQL are outside that container. The desktop host itself accesses PostgreSQL. There are no delegated worker agents; the independent read-only auditor remains enabled. Wall/call/step limits remain enforced; cumulative reported-token cutoff is disabled and usage is recorded. The reporter now requires `acceptance: verified` whenever environment auditing is enabled.
