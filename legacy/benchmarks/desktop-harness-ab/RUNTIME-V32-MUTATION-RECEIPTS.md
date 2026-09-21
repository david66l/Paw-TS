# V32: compact mutation receipts with exact output recall

Date: 2026-09-09. Production scope: fresh desktop Paw Next V3 root execution.

## Finding

V31's 22 root requests repeatedly transmit 694,940 characters of tool-result text. Write results account for 289,800 characters and edit results for 121,294. A write already carries the new code in its native arguments; its result also carries a diff, often 2,048 characters, which remains in subsequent requests. These receipts are usually below the existing 12,000-character large-output threshold, so the output-recall projector leaves them intact.

Native reasoning and write arguments also contribute substantial repeated context. This change preserves them. Z.AI's [preserved-thinking contract](https://docs.z.ai/guides/capabilities/thinking-mode) requires complete, unmodified reasoning in its original order when that mode is enabled. Removing reasoning is a separate provider-policy experiment, not interchangeable with shortening tool receipts.

## Change

The legacy runtime already has archive-and-preview behavior in `packages/core/src/context/pruner.ts`. V3 already provides verified journal-bound artifacts and `context_recall`. This change reuses that V3 mechanism, following the selective retrieval approach described in Anthropic's [context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

`packages/output-recall/src/mutation-receipt.ts` projects successful `workspace_write_file` and `workspace_edit_file` results into a compact receipt:

- Preserve every non-diff field, including path, byte/replacement/line counts, diagnostics and unknown future metadata.
- Replace only the recorded diff with an exact artifact reference and bounded recall arguments, and only when the reference saves at least 256 serialized characters.
- Require a completed, non-error, changed result and a durable artifact. Small, inline, failed, cancelled, no-op and unrelated results keep the existing projection behavior.
- Preserve original journal payloads, native arguments, reasoning, call/result identity, validation evidence and desktop display data. `context_recall` returns the original recorded result; its existing per-call, turn and run limits apply.

This projection is stable from the first receipt onward; it does not age out or rewrite an earlier receipt at a moving turn boundary. Its effect on actual provider caching still requires live measurement.

The `compactMutationReceipts` option is frozen as `paw.mutation-receipt.v1` in the V3 manifest. Fresh desktop identities enable it. Existing identities with no flag retain the original projection during recovery and continuation. Legacy recall identities cannot opt into this policy. Audit children retain their original context behavior; the Manager role has no mutation tools and does not apply this projection.

## Offline measurement

Input: the unchanged settled V31 run `.runs/2026-09-09-v31-queue-high`. Output: `.runs/2026-09-09-v32-mutation-receipts/mutation-receipt-report.json`.

| Cumulative size across the same 22 root requests | Original | With receipt projection | Reduction |
| --- | ---: | ---: | ---: |
| Tool-result text characters | 694,940 | 455,589 | 239,351 / 34.4% |
| Complete serialized request JSON characters | 2,645,841 | 2,385,237 | 260,604 / 9.8% |

Seventeen distinct receipts change across 201 repeated transmissions. Complete request JSON also includes JSON escaping, so its character delta differs from unescaped tool-result text.

The reporter reads the authority-committed journal, resolves and hashes the original payloads, and requires every captured root tool result to exactly match the original projector. It then applies the production receipt projector and asserts preservation of all non-diff metadata, status wrappers, assistant reasoning, native arguments, user/system messages, tool definitions and provider settings. Original captures and journal are not modified; the report records source-request hashes and the authoritative head.

```powershell
bun benchmarks/desktop-harness-ab/mutation-receipt-report.ts benchmarks/desktop-harness-ab/.runs/2026-09-09-v31-queue-high benchmarks/desktop-harness-ab/.runs/2026-09-09-v32-mutation-receipts
```

These are **character measurements on fixed historical requests**, not token, monetary, latency or task-quality improvements. A live model may make different decisions or spend additional calls recalling a diff. V31's completion and grading remain historical baseline results; the separate V32 live experiment is reported below.

## Validation

- Output-recall and desktop receipt tests cover metadata/diagnostic retention, original evidence immutability, exact recall through the real desktop host, unchanged native reasoning/arguments, small/error/inline exclusions, frozen opt-in, invalid policy rejection and cancellation.
- A real file write followed by `context_recall` through Paw Next retrieves the original diff. New and pre-policy desktop sessions recover with the same config hash and zero repeated model/tool calls. The model is deterministic in these integration tests; no external API is used.
- Related desktop, audit, memory-admission, product-identity and journal-context tests pass: **126 tests across nine files**. This includes bounded audit timeout recovery, stale-candidate rejection, process-crash recovery, old recall compatibility and context compaction/continuation.
- Output-recall, CLI and desktop renderer/host TypeScript checks pass.

## Fresh live high validation

Directory: `.runs/2026-09-09-v32-queue-high`. Run ID: `desktop-next-f73860d6-7b98-4bbc-96b5-bf6c5ad8fd6f`. Frozen config hash: `076cea23e172335aea2b3590975fd17a29a82ed2f249352d97ad256201a132ee`.

The desktop record confirms both `compactMutationReceipts: true` and `environmentAuditRetry: true`. The same queue task, GLM-5.3-Flash high, 128,000-token native output limit, 840-second wall budget, 53-call cap, 32 root steps and Docker isolation are used. All comparison checks match, including actual root model settings and tool schemas. Source snapshots include the new receipt projector.

| Measure | V31 | V32 live, before the parser fix below |
| --- | ---: | ---: |
| Runtime | completed / verified | completed / verified |
| Seconds | 751.449 | 760.315 |
| Independent functional checks | 15/15 | 15/15 |
| Generated project tests | 29/29 | 39/39 |
| Physical requests | 26 | 34 |
| Reported tokens | 700,936 | 737,650 |
| Cache-hit input tokens | 378,112 | 478,656 |
| Cache-miss input tokens | 299,252 | 231,094 |
| Completion tokens | 23,572 | 27,900 |
| Requests without usage | 1 | 2 |
| Audit attempts | 1 | 2 |
| Explicit output-recall calls | 0 | 0 |

The external grader executes the generated tests and independent verifier in Docker after settlement. V32 passes all checks. The first successful file write occurs at 190.983 seconds, versus 243.520 in V31; receipt projection has not yet affected context before that write, so this difference cannot be attributed to it.

Root implementation uses 24 calls and 621,685 reported tokens; audit children use eight calls and 115,965 tokens. Two memory-planner calls have unknown usage. Before the first audit, V32 reports 502,844 tokens versus V31's 662,864. Audit and subsequent work then cost 234,806 versus 38,072. Whole-run reported usage **increases by 36,714 tokens**, despite smaller root tool-result history. Known cache-miss input plus completion falls to 258,994 from 322,824, but missing usage and changed cache behavior prevent a complete monetary comparison. One fresh implementation per condition does not establish causality or a general success rate.

The first audit lasts 94.213 seconds and settles as `AuditReportInvalid`. This starts one repair segment with three additional root model calls and four root tools (three shell calls and one Git diff). No code mutation occurs in that repair segment. A second audit inspects nine files and passes in 89.606 seconds. There is no audit timeout, so the timeout-only retry branch is not exercised.

The failed audit's final response contains a valid 5,077-character report envelope. Its 2,681-character leading explanation contains the inline CLI example `add <JSON-payload> [priority]`. The unfenced parser rejects any square brackets in that explanation, so it rejects this otherwise valid terminal JSON object. The root model later attributes the audit failure to test-command evidence; the captured response and parser condition identify the actual format rejection. Earlier shell commands did mask failing tests, and the model subsequently corrects them, but that is a distinct issue.

## Post-run audit envelope fix

After the experiment settles, `parseAuditReportEnvelope` in `apps/cli/src/paw-next/environment-audit.ts` is changed to ignore square brackets inside paired single-line inline-code spans when checking leading prose. Raw array delimiters, earlier object braces, multiple reports, truncated JSON, Markdown fences in the wrong place and trailing commentary still fail. Verdict schema and file/browser evidence checks remain unchanged.

The exact visible response is retained in `apps/cli/test/fixtures/v32-audit-report.txt`. Seven parser/evidence tests pass, including a test using this captured report with synthetic read evidence: it is accepted when the referenced files have grounded read facts and rejected when those facts are absent. This validates parsing and evidence gates, not the quality of synthetic fixture files. Together with the earlier checks, **133 tests across eleven files pass**. CLI typechecking passes after the parser fix.

This parser fix is **not part of the recorded V32 live source snapshot** and has not received another fresh live queue run. Historical audit failures and usage are unchanged. Do not subtract the extra audit/repair cost and present that counterfactual as a measured result.

## Cleanup and next validation

Local PostgreSQL was started for the live experiment and stopped again after grading. No Paw container or Bun process remains running. Unrelated Docker services were left untouched. Background memory ingress was isolated but not drained; this experiment does not newly validate durable extracted memory writes.

The next check is a fresh high-mode run with the parser fix, measuring whether audit closeout avoids format-driven root work. Further context changes should be isolated from that check; native reasoning and historical write arguments remain unchanged in this step.
