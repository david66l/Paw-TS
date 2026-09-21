# Desktop base-prompt replacement and retest

Follow-up: [budget diagnosis](BUDGET-DIAGNOSIS.md) identifies the premature stop below as an evaluation-wrapper cutoff, not a desktop product token ceiling. The strict-budget scores remain valid for that allowance; they do not establish inability to finish with more execution time/calls. The follow-up separates long in-flight thinking, cumulative replay usage and correctness.

The user-approved general agent prompt is now the desktop base policy, exported from `apps/desktop/agent-host/agent-system-prompt.ts` and composed by `paw-next-profile.ts`. It is identical to the approved Chinese text after line-ending normalization. Workspace skills and mode-specific instructions still compose through the existing host path; the base identity does not prohibit collaboration or require a particular execution mode.

## Validation

- Desktop host typecheck passed.
- Three output/profile integration checks passed (20 assertions): actual initial and recovery requests carry the approved system text; model-native output limits and max reasoning remain intact; child output capacity is still model-specific.
- Four desktop integration checks passed (22 assertions): V3 continuation, later-segment recovery identity, changed child-model binding protection, and the desktop host's JSON protocol.

The Electron app keeps its Bun agent host alive. A host already running before the source change must reload before using the new module. Fresh hosts load it immediately. The existing configuration fingerprint includes the system prompt: an unfinished old run cannot silently recover under different instructions. No journal or historical task state was rewritten.

## Live comparison

Baseline: `.runs/2026-09-07-deepseek-single-control`.
Replacement: `.runs/2026-09-07-deepseek-base-prompt`.

Both run the original full queue task through `runDesktopNext`, DeepSeek V4 Flash max, declared native output limit 384000, single-agent tools, recovery disabled, memory disabled and environment auditing disabled. The existing auxiliary completion review remains. The enclosing limits are 12 minutes, 40 model calls, 160000 reported tokens checked between calls, and 32 steps.

The initial provider requests were independently compared: **only the first system message content changed**. The user message, tool schemas and other model parameters match. Among previously frozen sources, only `paw-next-profile.ts` and the probe changed; the probe change adds the new prompt module to its source snapshot. The new run snapshots the imported module as well.

Use the following after the replacement run settles:

```powershell
python benchmarks/desktop-harness-ab/single-agent-report.py benchmarks/desktop-harness-ab/.runs/2026-09-07-deepseek-base-prompt
python benchmarks/desktop-harness-ab/tool_wire_report.py benchmarks/desktop-harness-ab/.runs/2026-09-07-deepseek-base-prompt
python benchmarks/desktop-harness-ab/prompt-comparison.py benchmarks/desktop-harness-ab/.runs/2026-09-07-deepseek-single-control benchmarks/desktop-harness-ab/.runs/2026-09-07-deepseek-base-prompt
```

## Completed results

| Metric | Previous prompt | General agent prompt |
| --- | ---: | ---: |
| First successful implementation file write | 306.796 s | 157.416 s |
| Longest model request | 275.397 s | 127.778 s |
| Thinking characters in that request | 116047 | 64677 |
| Whole run | 340.629 s | 244.715 s |
| Physical model calls | 7 | 9 |
| Reported tokens, all usage known | 189700 | 193118 |
| Independent functional checks | 15/15 | 11/15 |
| Delivered tests | Missing test directory | 25/28 pass |
| Runtime result | Aborted at token threshold | Aborted at token threshold |
| Fully completed and verified | No | No |

The new prompt began implementation earlier in this sample, but did not eliminate long thinking or improve full-task completion. Both longest requests ultimately checked Node/npm versions rather than writing code. The new run produced a test suite, but did not run it before the budget stopped execution, and did not deliver README. Independent grading afterward found that the generated `_publicJob()` omitted stored `result` and `error` fields, causing three functional checks to fail; the fourth failure was missing README. The generated test suite also had three failing cases. The benchmark workspace was not manually repaired.

The token threshold is checked between calls, so the final completed request can overshoot 160000. The new run used 164107 prompt tokens and 29011 completion tokens; 155520 prompt tokens were reported as cache hits. The old run used 155971 prompt tokens and 33729 completion tokens, with 141312 cache hits. Total reported tokens did not decrease; cached input is not equivalent to uncached billing, and this comparison makes no monetary cost claim.

The first request differed only in system content, all other frozen runtime sources matched, and independent raw SSE assembly matched Paw's tool arguments and text/thinking counts. The actual output limit remained 384000 with max effort and no thinking-recovery intervention.

One sample per prompt cannot establish a success rate, prove a wording caused a timing difference, or isolate language from wording changes. The historical baseline partially overlapped a run against another provider, so timings are descriptive. The replacement is applied as requested; the evidence does **not** justify claiming that prompt replacement alone solved long tasks. Remaining work concerns bounded decision-making, context retention and budget-aware completion/verification. Those require separate runtime changes and evaluation.
