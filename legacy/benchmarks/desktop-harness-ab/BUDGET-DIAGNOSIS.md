# Long-task diagnosis after the prompt replacement

Follow-up: [code-level diagnosis](CODE-LEVEL-DIAGNOSIS.md) locates the relevant functions and implements independent verification cadence. It also confirms the recorded shell command required approval: the benchmark's unconditional approval callback approved it, while ordinary desktop sessions use the user approval callback. Neither approval path provides filesystem isolation.

This investigation separates three observations: time spent before a tool call, termination by the evaluation harness, and correctness of the delivered work. The general agent system prompt remains in place. No production runtime policy, model settings or recovery behavior was changed for this investigation.

## Why the previous run stopped

The replacement-prompt run (`.runs/2026-09-07-deepseek-base-prompt`) was aborted by `tool-wire-probe.ts`, not by a fixed desktop product token limit. Its wrapper adds provider-reported total tokens after every physical request, including cached input, and rejects the next request once the cumulative count reaches 160000. The ninth completed request took the total from 155991 to 193118. This is a between-request cutoff, which explains the overshoot.

The saved `budget-ledger.json` records each request's contribution. Of the 193118 tokens, 155520 were cached input, 8587 uncached input and 29011 completion. These remain real token usage, but are not equivalent billing categories. Counting them together is useful for a fixed token-efficiency evaluation; it does not establish that the desktop cannot finish with a larger allowance.

The agent had not run its tests or entered final completion review before the abort. The independent grader subsequently found 11/15 contract checks and 25/28 generated tests passing. Three contract failures came from `_publicJob()` omitting stored result/error; another was missing README. The three failing generated tests also contained invalid expectations: completing a still-pending job, omitting another running job from a list, and expecting restore to preserve running status despite the requirement to requeue it. These are unfinished implementation and test-authoring defects, not evidence that the agent tried and failed to repair them.

## Why thinking and input overhead remain

Raw SSE in both providers' prior runs contained sustained reasoning without tool-call deltas. The parser did not drop an available tool call. The new budget diagnostic again spent its third request extensively planning implementation, validation and edge cases before checking the environment.

`packages/progress-advisor/src/projector.ts` projects settled model/tool facts. Successful writes reset its progress gap; it cannot intervene inside one still-streaming model request. `packages/agent-loop/src/agent-loop.ts` awaits model settlement before executing validated tool calls. Executing incomplete tool arguments is not a remedy.

[DeepSeek's thinking-mode protocol](https://api-docs.deepseek.com/guides/thinking_mode/) requires replaying prior `reasoning_content` when tools are present, including prior thinking without tool calls. Retention is therefore not itself an adapter defect. Blindly removing it is not a valid optimization. Any fresh-context/checkpoint strategy must preserve tool-call protocol consistency and verified task state.

Current context compaction is primarily window-pressure driven. The default trigger is 80% of the soft input target, with a fallback for omitted timeline units. With this model's 1000000-token window, 384000 output reserve and 256 margin, that nominal trigger is about 492595 estimated input tokens. Cumulative usage can cross an evaluation budget much earlier through repeated replay. The two mechanisms measure different things; this does not prove the compactor is broken. A cost-aware checkpoint policy would be a separate feature requiring correctness and efficiency evaluation.

## Budget-only diagnostic

Run: `.runs/2026-09-07-deepseek-budget-diagnosis`.

```powershell
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-07-deepseek-budget-diagnosis --queue --single-agent --deepseek-flash --wall-and-call-budget
```

Only the cumulative reported-token cutoff is disabled. The 12-minute wall limit, 40 physical requests and 32-step limit remain. DeepSeek V4 Flash uses max and its native 384000 output allowance, through the current desktop `runDesktopNext` / agent-loop path. Delegation and environment auditors are disabled for isolation; auxiliary completion review remains. Memory and Langfuse are disabled. Automatic task routing is bypassed by explicit standard mode, so this does not evaluate the entire normal desktop configuration.

`budget-only-request-check.json` confirms the first provider request is byte-content equivalent as parsed JSON, all other relevant protocol settings match, and only the benchmark runner changed among frozen source files. This is a fresh stochastic run, not continuation of the previous workspace. It cannot establish that the previous trajectory would have recovered, nor is it a matched token-efficiency comparison. `prompt-comparison.py` now rejects comparisons with differing token-threshold enforcement.

## Settled diagnostic result

| Metric | Strict token cutoff | Token cutoff disabled |
| --- | ---: | ---: |
| Wall duration, including abort settlement | 244.715 s | 726.083 s |
| Physical model attempts | 9 | 29 |
| Reported tokens | 193118 | 1595814 |
| Attempts without usage | 0 | 1 |
| First successful implementation write | 157.416 s | 258.910 s |
| Independent contract checks | 11/15 | 15/15 |
| Delivered tests, independently rerun | 25/28 | 50/50 |
| Terminal runtime status | Token-budget abort | Wall-budget abort |
| Final completion review | Not reached | Not reached |

The relaxed run's 28 completed responses reported 1533219 prompt tokens (1511168 cached, 22051 cache misses) and 62595 completion tokens. Attempt 29 was aborted before a response was captured and has unknown usage; the reported total is not a complete-cost claim. Raw response assembly and Paw parsing match on the captured responses. The offline reporter now explicitly records requests with no response, while still rejecting missing capture files when receipt records exist.

The agent first ran `npm test` at 529.845 seconds: 46/50 passed. It repaired the tests and implementation; its second invocation completed successfully at 617.591 seconds. Independent grading after termination also passes all 50 tests and all 15 external contract checks. This demonstrates that this trajectory can implement and repair the requested behavior. It does not demonstrate reliable end-to-end completion: the runtime still never delivered its final answer/review before the wall cutoff.

After the passing tests, it attempted additional CLI demonstrations. One used an undefined `%cd_root%` and failed; the next mixed an expected bad-argument case into a command chain and returned exit 1. It updated README to explain that loading a persisted running job requeues it, so repeated CLI `next` can claim that job again. Some follow-up checking was useful, but the overall plan left verification late and did not reserve a predictable path to final completion.

### Observed task-scope violation

At 634.440 seconds the agent's shell command changed to `%TEMP%`, invoked removal/recreation of `jq-demo`, then attempted to execute a script through the undefined `%cd_root%`. The returned module-not-found path confirms execution in `%TEMP%/jq-demo`, outside the assigned workspace. The shell's starting `cwd` was inside the workspace, which did not constrain later `cd` or filesystem operations inside the command. The trace does not establish whether that temporary directory existed before the command; it is not possible to claim that no pre-existing content was affected. No cleanup or manual repair of that directory was performed in this investigation.

This violates the explicit workspace-only requirement even though the graded code passes. The functional/test score does not include shell scope enforcement and must not be reported as complete task success. Strong command isolation is needed; a project prompt and a validated starting directory are insufficient enforcement. No further paid run was started after this finding.

## Next implementation targets

1. Keep completion-under-budget and completion-within-wall-time as separate reported outcomes. Preserve cache-hit, cache-miss, completion and unknown usage separately.
2. Evaluate bounded action selection before a large speculative implementation plan, while keeping user-selected reasoning settings. The prior timeout/micro-edit recovery experiments did not establish a reliable improvement and remain opt-in.
3. Distinguish file activity from verified progress. Encourage a small runnable implementation and focused checks before expanding tests and documentation; avoid task-specific system-prompt rules or fixed tiny edit sizes.
4. Evaluate provider-compliant checkpoints only when they offer measured benefit. Preserve requirements, actual changes, failing checks and remaining work; do not discard reasoning fields from an active tool conversation arbitrarily.
5. Enforce the requested shell filesystem boundary through actual process isolation or fail closed when such a boundary cannot be provided. Add adversarial checks for command-internal directory changes and absolute paths. Scope compliance must be graded separately from output correctness before treating future runs as successful.

These are priorities for subsequent changes, not claims that the runtime has already been fixed.
