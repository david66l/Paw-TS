# V28: high-mode cost attribution and unnecessary work

Date: 2026-09-08. Desktop host, Paw Next V3, GLM-5.3-Flash high.

## What the previous run actually cost

`phase-cost-report.py` attributes saved wire requests to the root loop, child loop and auxiliary phases. It reports provider usage and character counts separately, preserves missing usage as unknown, and refuses active runs or ambiguous multiple-wire-request usage attribution. It never executes generated project code or prints prompts.

The V26 queue run reconciles exactly with its existing report:

| Phase | Requests | Reported tokens |
| --- | ---: | ---: |
| Root coding loop | 21 | 611,810 |
| Independent audit child | 3 | 39,263 |
| Memory query planning | 2 | unknown |
| Memory extraction | 1 | unknown |

The 651,073 reported total consists of 630,641 prompt tokens and 20,432 completion tokens. Prompt usage includes 405,696 cached tokens and 224,945 cache-miss tokens. Thus the reported noncached input plus output is 245,377 tokens, with three additional requests whose usage is unknown. These are provider counters, not monetary estimates.

Root-loop traffic includes 794,566 tool-result characters, 614,051 tool-argument characters and 317,173 native-reasoning characters, counting retransmission across requests. These sizes are not tokenizer counts. The largest practical cost remains the growing coding history. This change preserves the native output limit, tool evidence, reasoning passback and independent acceptance checks.

## Fixes

### Empty retrieval was starting a model request during budget measurement

In `packages/memory-plugin/src/retrieval-input-port.ts`, `settleRetrieval` called both context planning and building even when the provider returned zero cards. The decorated context can perform optional model-assisted resolution. Consequently, a budget calculation for an empty injection started a paid auxiliary request inside the outer two-second retrieval deadline. Cancellation removed that context cache entry, allowing another request during the real model context build.

Empty retrieval now records its completed/degraded receipt immediately. There is no section to fit, so no context calls are needed. Nonempty retrieval retains both planned/actual token checks. This matches the existing empty-section behavior in `memory-section.ts` and the legacy host renderer's empty-result behavior; no old execution loop is imported.

The deterministic regression uses context methods that throw if called. Both completed and degraded empty retrieval preserve their status/reason, journal one receipt, and do not repeat retrieval at the next boundary. The live long-task run has one initial planning call, compared with two in V26.

### Directory references produced an opaque audit failure

The first live small task wrote the exact required bytes. Its auditor also listed `.` in `evidencePaths`, even though that field represents successfully read regular files. The path fingerprint guard correctly refused it, but the broad exception handler reported `AuditUnavailable`. That led to a new repair segment and auxiliary memory work until the probe's eight-call limit stopped it. This sample is retained as aborted, not counted as a successful task.

`apps/cli/src/paw-next/environment-audit.ts` now states the file-only constraint explicitly and returns `AuditEvidencePathInvalid` with a specific explanation for invalid references. The guard still rejects directories, private state and paths outside the workspace. It does not silently discard invalid citations or turn a suspect report into acceptance.

### An informational field caused the entire coding task to repeat

The first long-task audit returned a valid conclusion and file references plus an informational `notes` string. The exact-key check rejected the whole report as `AuditReportInvalid`, creating another root work segment. Its output subsequently passed the independent 15/15 checks and all 32 delivered tests, but the run exhausted its 720-second budget and remains recorded as aborted.

The report contract now accepts optional string `notes` up to 2,000 characters and includes them in the bounded review summary. Required fields, file-read grounding and verdict rules remain enforced. Unknown fields and object/oversized notes are rejected. Tests also establish that notes cannot override incomplete criteria or missing file evidence.

### Code-review prose and negative browser metadata

The final core sample's first audit included `constructor({maxAttempts=3}={})` in prose before its single terminal JSON fence. The old first-brace scanner treated that signature as the start of the report. The envelope parser now recognizes an explicit terminal JSON fence without confusing ordinary code signatures with JSON. Earlier JSON-like objects, multiple fences, truncated reports and trailing commentary remain rejected.

That same captured report also contained `browserRequired: false` and `browserChecks: []`. The schema now accepts these explicit negative fields when browser auditing is disabled. A positive requirement or a nonempty browser-check list is still rejected in that mode. This does not enable browser tools or confer browser evidence.

The final queue sample's first two audits had commentary **after** their JSON fences. They remain invalid under the current parser. The audit prompt now explicitly forbids Markdown and surrounding commentary and provides bounded summary/notes fields for explanations. This is a prompt constraint, not a guarantee that a model will conform.

### Format retries should not invent implementation defects

`apps/cli/src/paw-next/request-guidance.ts` now distinguishes `AuditReportInvalid` and `AuditEvidencePathInvalid` from evidence of a code or test defect. A request-only annotation tells the root to preserve implementation and valid verification evidence, and submit a concise grounded conclusion for another independent review. Actual defects still require investigation; acceptance remains unverified until review succeeds.

The annotation is derived only from authenticated, pending completion-review feedback matching the current work-segment input. It expires after a newer review or user steer. Existing durable fallback-feedback content and IDs are unchanged, preserving recovery compatibility. Tests cover deterministic replay, a spoofed user caller and expiration. The generated final answers in the core/queue samples attributed their earlier audit failures to missing or masked test evidence; the host records instead say `AuditReportInvalid`. Those model explanations are not treated as diagnostic evidence.

## Validation and interpretation

The targeted regression suite passed 59 tests across memory retrieval, audited memory, environment auditing and desktop integration. CLI, desktop renderer/host and memory-plugin typechecks passed. The cost reporter reconciled V26 totals, cache accounting and unknown usage against the previous independent report; an unsettled run is rejected.

The wire probe now captures the affected memory-context/retrieval sources and the core-milestone verifier. A new explicit `--background-memory` option exercises the current desktop delivery mode while keeping its ingress under the isolated probe directory. Historical/default model-injected probes use synchronous maintenance; comparisons must state the mode. The first V28 small and long runs predate these added source-list entries; their original frozen manifests are retained.

An explicit `--desktop-chain-budget` keeps the original root step limits, adds the audit's existing 120-second / 12-call allowance, and adds one startup memory call (plus 30 seconds only for synchronous terminal memory). The old small/core/queue budgets remain the default. Failed old-budget samples are retained. The final core and queue functional validations overlap in time, so their timing and cache behavior are not controlled performance comparisons.

These changes remove demonstrably unnecessary work and improve failure diagnosis. They do not establish a general speedup or a lower monetary cost. Fresh task observations follow below.

## Fresh high-mode observations

All samples use the actual desktop host and Paw Next V3 with the configured GLM-5.3-Flash high profile, native output limit, memory enabled, independent completion audit, and Docker-isolated generated commands. The root does not delegate implementation work; audit children remain enabled.

| Run suffix (2026-09-08-v28-) | Runtime result | Seconds | Physical requests | Reported tokens / requests without usage | Independent verification |
| --- | --- | ---: | ---: | --- | --- |
| small-high | aborted | 37.166 | 8 | 24,752 / 3 | Exact 18 bytes present; directory citation rejected |
| queue-high | aborted | 720.177 | 26 | 604,241 / 3 | 15/15 external; 32/32 own tests |
| small-high-fixed | completed / verified | 40.361 | 7 | 23,932 / 1 | Exact 18 bytes |
| core-high-fixed | aborted | 180.091 | 12 | 104,168 / 2 | 9/9 external; own tests passed |
| core-high-final | completed / verified | 286.279 | 21 | 199,067 / 2 | 9/9 external; 19/19 own tests |
| queue-high-final | completed / verified | 817.431 | 40 | 800,863 / 3 | 15/15 external; 31/31 own tests |

The first small/queue samples used synchronous terminal memory. The other four use isolated background ingress. The final core/queue samples explicitly use the additional desktop-chain allowance: 300/840 seconds and 25/53 physical calls, respectively, with original root step limits unchanged. Original failed samples remain failures even when delivered artifacts pass independent tests.

The final long run reports 561,231 tokens in 19 root requests and 239,632 in 18 audit-child requests. Its 800,863 total includes 509,760 cached input tokens, 264,557 cache-miss input tokens and 26,546 completion tokens. Three optional memory-planning calls have unknown usage. There is one startup planning request; repair segments produce separate queries. Optional provider HTTP 429 errors remain unresolved. The audit fraction and repeated verification are material remaining costs.

**Source-version boundary:** the successful live samples include the empty-retrieval and notes/path fixes, but started before the final fenced-prose parser, negative-browser metadata and format-retry guidance changes. They prove completion on their frozen manifests, not a measured benefit from those later changes. Native window QA and background PostgreSQL draining were not repeated here; isolated background ingress is retained for inspection, and V27 contains the real durable-worker validation.

After the final fixes, 38 completion-review, environment-audit and request-guidance tests passed (151 assertions); CLI and desktop typechecks passed. The earlier memory-plugin suite passed 35 tests and the integration regression passed 59 tests. These suites overlap and are not summed into a claimed unique test count.

The exact three saved failed reports were also replayed through the current reviewer without model calls, tool execution or historical journal modification. The core report now passes envelope validation and correctly stops at `AuditEvidenceMissing`, since this envelope-only replay deliberately supplies no file evidence. Both queue reports still produce `AuditReportInvalid` due to their trailing commentary. This checks the parsing boundary while preserving the evidence requirement; it does not retroactively grant acceptance.

Evidence stays in ignored `.runs/2026-09-08-v28-*`: source manifests, raw wire, phase reports, verifier outputs, `2026-09-08-v28-envelope-replay.json`, and regression/typecheck logs. `grade-core-probe.py` and `single-agent-report.py` execute delivered tests and frozen external verifiers only in restricted Docker containers. `phase-cost-report.py` executes no generated code.

The next controlled experiment should keep task, root limits, model settings and auxiliary mode fixed while checking whether the final format handling prevents redundant repair segments. Only then should it be used to claim lower request counts or token cost. Broader transcript reduction still needs separate evidence-preserving context work.
