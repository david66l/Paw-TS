# V29: fresh high-mode audit retest

Date: 2026-09-08. This retests the final V28 audit-envelope and retry-guidance changes through the desktop host and Paw Next V3. The live run preserves those frozen sources and model settings. A further report-length fix was implemented only after the run settled, as documented below.

## Protocol

Baseline: `.runs/2026-09-08-v28-queue-high-final`. Fresh run: `.runs/2026-09-08-v29-queue-high`.

Both use the same persistent queue + CLI + tests + README task, GLM-5.3-Flash high, model-native output limit, 840-second wall allowance, 53 physical-call allowance, 32 root steps, and disabled cumulative reported-token cutoff. Both enable independent environment audit, local PostgreSQL memory retrieval and isolated background-memory ingress. Implementation delegation is disabled; audit children remain enabled. Generated commands run only in the same restricted Docker image.

The exact invocation is:

```powershell
bun --env-file=.env.local benchmarks/desktop-harness-ab/tool-wire-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v29-queue-high --queue --docker --configured-profile --memory --background-memory --environment-audit --single-agent --wall-and-call-budget --desktop-chain-budget
```

The recorded source manifests differ only in `apps/cli/src/paw-next/environment-audit.ts` and `apps/cli/src/paw-next/request-guidance.ts`. These contain the final fenced-prose parser, negative browser metadata support, stricter report-only instruction and authenticated format-retry annotation. The source manifests cover listed files, not every transitive dependency.

`compare-high-runs.py` checks matching protocol fields, Docker checks/image/sandbox, and the actual root wire settings and tool catalog across every request. It reports settled, independently graded runs only, preserves missing usage as unknown, and never executes generated code. Its baseline self-comparison reconciles 800,863 reported tokens and three audit children; an active run is refused.

The baseline overlapped another Paw task; this retest runs one Paw task. Fresh model generations, provider cache/load, memory contents and host scheduling are not controlled. Matching task/configuration is not a paired deterministic replay or a statistically established speedup.

## Results

| Metric | V28 baseline | V29 retest |
| --- | ---: | ---: |
| Runtime | completed / verified | aborted at wall limit |
| Seconds | 817.431 | 840.157 |
| Independent checks | 15/15 | 15/15 |
| Delivered tests | 31/31 | 31/31 |
| Physical requests | 40 | 34 |
| Independent audit children | 3 | 2 |
| Reported total tokens | 800,863 | 682,559 |
| Cached input tokens | 509,760 | 403,904 |
| Cache-miss input tokens | 264,557 | 257,416 |
| Completion tokens | 26,546 | 21,239 |
| Requests without usage | 3 | 5 |

All protocol and actual root-wire comparison checks pass. The latest source snapshot is actually exercised, but **this does not establish an end-to-end improvement**: V29 did not achieve verified completion within the unchanged budget. Lower reported token totals cannot be presented as a saving for an equivalent successful delivery, especially with more unknown-usage requests.

Before the first audit, V29 made 18 requests and reported 440,402 tokens, versus V28's 15 and 361,791. Its first delivered test run had two real failing assertions; the model corrected the implementation/test interpretation and later passed 31 tests. Fresh implementation work is therefore another uncontrolled difference.

From the first audit onward, V29 made 16 requests and reported 242,157 tokens, versus V28's 25 and 439,072. This stage includes audit, memory planning and resumed root work. V29 root requests account for 592,031 reported tokens and audit children for 90,528; three memory-planning requests, one auditor request and the final interrupted root request have unknown usage.

## What prevented completion

1. **First audit: `AuditTimeout`.** Calls 19–23 used the existing shared 120-second audit deadline (`apps/cli/src/paw-next/environment-audit.ts`). Call 22 took 55.181 seconds, including 54.172 seconds before response headers arrived. Call 23 was cancelled after 42.321 seconds when the audit deadline expired. The header timing locates waiting before response headers; it does not distinguish provider queueing from network delay. The auditor was not merely spending 120 seconds on file tools.
2. **Timeout restarted root verification.** `packages/completion-review/src/continuation.ts`, `createCompletionReviewFallbackFeedbackV1`, supplies the generic instruction to recheck the diff and rerun verification even for `AuditTimeout`. This is present verbatim in request 25. Calls 24–28 (one optional memory query and four root requests) added 151,629 reported tokens plus one unknown-usage request before a fresh audit began. The V28 format-specific annotation does not apply to timeouts.
3. **Second audit: valid JSON, overlong explanatory summary.** Call 32 returned one complete JSON object: 2,973 characters total, with a 2,209-character `summary` and 504-character `notes`. Negative browser metadata is accepted by the V28 fix, and there is no trailing prose. The separate 2,000-character summary schema limit caused `AuditReportInvalid`.
4. **Correct format guidance arrived too late.** Request 34 includes the authenticated `[Paw audit report retry]` annotation, which preserves implementation and valid verification evidence. The global wall limit cancelled that request before it produced output. This proves the annotation reaches a real request; it does not prove that the model follows it successfully.

The runtime result remains aborted. Independent grading executes the generated test command and the frozen external verifier in restricted Docker containers; both pass. No historical verdict or captured request was rewritten.

## Follow-up fix: separate explanatory text from acceptance validity

After settling the experiment, `apps/cli/src/paw-next/environment-audit.ts` was changed so explanatory `summary`/`notes` lengths do not invalidate an otherwise structurally valid report. The raw envelope remains capped at 96,000 characters; persisted completed and unknown summaries remain capped at 2,000. Summary must still be a nonempty string, notes must still be a string, and enum values, unknown fields, file references, unmet criteria, actual-read grounding and concurrent-change checks remain strict. The prompt still requests concise text. No JSON is repaired or truncated before parsing.

This follows the legacy separation of parsing and display bounding: `packages/agent/src/mea/audit-report.ts` uses `boundedText` for report prose, and `packages/agent/src/candidate-review.ts` compacts review summaries separately from verdicts. No old execution loop is imported. The old V28 oversized-notes rejection is superseded by this bounded-envelope policy.

Regression coverage verifies acceptance of a 2,209-character explanation while preserving all of the following: incomplete remains blocked with the original unmet criterion; unknown stays unknown; missing file evidence stays unverified; oversized raw envelopes and non-string notes are rejected; every returned summary stays within 2,000 characters. The 38 targeted review/guidance tests pass with 191 assertions. CLI and desktop typechecks pass (a test-only optional-summary typing issue was corrected before the final CLI check).

The exact call-32 SSE text was replayed through the current reviewer with no file facts deliberately supplied. It now passes report parsing and stops at `AuditEvidenceMissing`, granting no acceptance. The two earlier V28 reports with trailing prose remain rejected. This read-only envelope check uses no model or tool execution. The length fix was **not** included in the live V29 run and has no fresh live performance result yet.

## Next engineering step

Isolate transient audit failure from implementation repair. A timed-out review should preserve its valid evidence and retry within explicit limits, without automatically requiring the root to repeat passed tests. Design this at the review boundary with durable identities, cancellation and a shared task budget; do not silently enlarge every timeout or change persisted feedback strings used for recovery identity. Provider waiting must remain visible separately from tool time and reasoning. A future controlled run should exercise both this recovery path and the length fix before making a completion-rate or token-saving claim.

Evidence is retained under the ignored run directory: `high-run-comparison.json`, `phase-cost-report.json`, `single-agent-report.json`, original SSE/requests, protocol and source snapshots. Adjacent V29 review/typecheck logs and `2026-09-08-v29-envelope-replay.json` record the post-run fix checks. No additional Paw probe or grading container is left running.
