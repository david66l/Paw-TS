# V25: clarify the purpose of the existing todo tool

2026-09-08. Decision-only follow-up to V24. No production prompt, tool schema, tool exposure or runtime setting changes.

## Intervention

The only added description text is:

> Create and update a task list as your working plan for the current task.

It prefixes `workspace_todo_write`'s frozen description, preserving the existing durable-list replacement, one-in-progress and completion-update rules verbatim. The name, parameter schema, IDs, status enum and tool position remain unchanged. This clarifies planning purpose without requiring a plan for every task or fabricating a user-visible rendering guarantee.

The control is V24's settled 11-tool response. The treatment keeps all 11 definitions except that one description, the full system/history/results, Anthropic endpoint, sampling omissions, max effort, 32,000 thinking budget, 128,000 maximum output and 360-second observation limit. Both retain the previously documented symmetric removal of 67 reasoning-history characters. This experiment is conditional on the 11-tool catalog, not a direct test of the original 24-tool desktop request.

It reuses the prior control; provider load, cache age and stochastic variation are uncontrolled. The wording intervention also changes description length and tokenization, so a positive result alone cannot identify a semantic mechanism. A planning call, complete tool response, executed file write and completed task are separate outcomes. No returned tool executes and no effort downgrade, retry, Docker startup or extra model judge occurs.

## Results

| Arm | First thinking | Observed duration | Thinking characters | Visible text | Tool calls | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| V24: original todo description | 5.678 s | 360.018 s | 62,569 | 0 | 0 | Wall timeout |
| V25: planning-purpose prefix | 4.589 s | 360.004 s | 67,125 | 0 | 0 | Wall timeout |

Both return HTTP 200 and stream thinking without a tool event or provider terminal event. Character counts use UTF-16 length, not token counts or task progress. Initial zero usage fields are provisional; final usage is unknown. Neither run executed a tool or established task completion.

Paired verification passes: derived source and transmitted request differ only in the description prefix; schemas, history, other definitions and request settings remain identical; both raw streams independently reproduce the recorded response counts and lack of tool events. With no complete tool calls, tool-argument schema validation is not claimed.

## Interpretation and next comparison

Adding this one planning-purpose sentence did not induce action within six minutes in this sample. The result does not support adopting that sentence as a production stall fix. It cannot exclude all possible wording effects, prove equal latency or predict eventual completion beyond the censored window. The experiment tests this sentence in V24's reduced catalog, not all todo guidance or the full native ZCode/Paw contract difference.

V22 through V25 have not produced a positive action signal from interface conversion, sampling omission, catalog filtering or this description prefix. Continuing to add speculative prompt rules is therefore a weak next step. Return to the previously successful native ZCode request as a fresh positive control, retaining the same observation policy. If it no longer acts, do not attribute a subsequent treatment failure to the changed field; account for baseline variability first.

Once the control reproduces, test one representation boundary at a time, starting with historical tool-result presentation while preserving observed facts. Do not simultaneously rename tools, change schemas, replace the system or strip signed native thinking. This is a proposed experiment, not a completed result or a claim that historical result formatting is the cause. Any positive decision result still needs repetition and actual isolated coding execution before a production fix is justified.

A read-only cross-check also confirms the native request already includes the full REQUIREMENTS.md through its first Bash result, followed by .gitignore/environment inspection. Thus both Paw and ZCode saw the requirements in user text and tool output; absence of the requirement read in ZCode is not a supported explanation. The exact observed inspection facts and their representation are not identical between the two histories and must be distinguished in any conversion.

No production file changes follow from this negative result. The new work is an offline input/verification helper, this report and the benchmark index. Input equality checks, helper syntax, paired raw-response verification and changed-file whitespace checks pass. The broad application suite was not rerun for this diagnostic-only work. The paid request has settled; no model request from this experiment remains active.

## Evidence and reproduction

Source: `.runs/2026-09-08-v24-catalog-input/request.json`, SHA-256 `f4cb2dfb09f0cc3551b4d23175a6317c77014a22a7e2dc71f592413101993b75`.

Derived source: `.runs/2026-09-08-v25-todo-input/request.json`, SHA-256 `5234c7f86e1ab1825201283de19911bef6cdcc1903b42f5a57d2fbdfefc31299`.
Helper SHA-256: `2816cf08eddb7abbb994004f3403be1d16ddb7fe78ca8280d490e7b113b81c5e`.
Treatment evidence: `.runs/2026-09-08-v25-todo-guidance-360`, including request, protocol/probe snapshot, raw SSE, result, independent check and guidance comparison.

The offline helper guards this frozen source and exact old description, derives only the prefixed description, and records source/derived/helper hashes and its own snapshot. Verification checks both the derived source and actual transmitted request, preserving everything except the description prefix, and independently reconstructs each raw response. The protocol probe is unchanged.

```powershell
python benchmarks/desktop-harness-ab/todo-guidance-decision.py prepare benchmarks/desktop-harness-ab/.runs/2026-09-08-v24-catalog-input/request.json benchmarks/desktop-harness-ab/.runs/2026-09-08-v25-todo-input
bun run benchmarks/desktop-harness-ab/protocol-decision-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v25-todo-input/request.json benchmarks/desktop-harness-ab/.runs/2026-09-08-v25-todo-guidance-360 anthropic-default-sampling --extended
python benchmarks/desktop-harness-ab/todo-guidance-decision.py verify benchmarks/desktop-harness-ab/.runs/2026-09-08-v24-catalog-11-360 benchmarks/desktop-harness-ab/.runs/2026-09-08-v25-todo-guidance-360
```

Run from the repository root with fresh directories and existing ignored local credentials. Only the probe sends a paid request. Evidence, including `guidance-comparison.json`, remains in the ignored treatment directory.
