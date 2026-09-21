# Single-agent long-task experiment

Multi-agent changes are deferred. This experiment uses the desktop Paw Next execution path with one coding agent, GLM-5.3-Flash **max**, and its **128000** native output limit. It does not change local model settings or enable Langfuse.

## Acceptance

The queue task must deliver the entire library, persistence, CLI, tests and README. Success requires all three: the runtime completes, the frozen independent verifier passes all 15 checks, and the delivered `npm test` command passes. An early tool call, scaffold, or partial implementation does not qualify. Unknown usage on interrupted requests prevents claims of total token savings.

## Opt-in recovery

`packages/models/src/thinking-recovery.ts` is an experimental wrapper, currently invoked **only by the benchmark**, not enabled in ordinary desktop sessions. Instantiate once per run, with the enclosing run's cancellation signal and wall/call budgets.

- Main streaming requests retain their original model parameters and complete history.
- A request has 90 seconds to begin text or a raw tool fragment. A thinking-only request can be interrupted and retried once. A silent request stops without retry.
- The allowance is shared across the run: at most two recoveries. A second stall in the same logical call stops the experiment immediately. Ordinary network/parser failures and user cancellation are not recovery triggers.
- Tool fragments disarm the guard before complete tool arguments are assembled. This avoids mistaking a large file-write argument for stalled thinking. The enclosing 12-minute run budget remains active.
- Pre-action reasoning is buffered; interrupted reasoning is discarded, never replayed as native assistant state. This delays the thinking preview. Recovery events are local metadata, with unknown usage explicitly marked.
- Version 1 requested one bounded next action on retry. Version 2 keeps an incremental instruction active after the first interruption, asking for one function/method/test at a time, approximately 60 changed lines. The model still chooses the next action, and the complete original acceptance criteria remain in context. This is a prompt preference, not a structural guarantee.
- Version 3 starts with the same small increments, then permits one coherent slice of related methods or tests (approximately 200 changed lines) after two confirmed file operations since recovery. Only distinct calls with provider-neutral completed, non-error results count. Another recovery resets this threshold. This reduces repeated context overhead without treating a successful write as verified functionality.

This guard bounds a specific failure mode; it does not establish that every task is correct or that all possible agent loops converge. Production adoption still requires durable recording of every interrupted attempt/effective request, user-visible recovery status, and a successful matched evaluation. Hidden retries must not be introduced into ordinary journal/replay semantics.

## Reproduce

Use a fresh output directory for each paid run:

```powershell
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <output> --queue --thinking-recovery
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <control-output> --queue --single-agent
```

Both conditions remove `workspace_delegate` from provider requests and reject any emitted delegation call before runtime execution. Environment auditors are disabled; the existing auxiliary completion review remains. This is one coding agent, not one model request. The 12-minute, 40-call, 160000-reported-token thresholds are unchanged; the token threshold is checked between requests, not a hard billing limit. The old audit-enabled queue run is not a matched control.

The runner now automatically copies and verifies hashed sources at `<output>/source-snapshot/<relative-path>`. Earlier v1/v2 runs were copied and verified manually before source changes. Once the run settles:

```powershell
python benchmarks/desktop-harness-ab/single-agent-report.py <output>
```

The reporter verifies the frozen source snapshot, real request parameters, absence of delegation, full functional behavior, and the generated test command. It records unknown-usage requests separately from reported tokens.

## Results

| Experiment | Time | Recovery | Independent checks | Own tests | Full completion |
| --- | ---: | ---: | ---: | --- | --- |
| v1, `.runs/2026-09-07-single-recovery` | 196.917 s | 1 | 0/15 | Missing | No |
| v2, `.runs/2026-09-07-single-recovery-v2` | 323.315 s | 1 | 10/15 | Failed | No |
| v3, `.runs/2026-09-07-single-recovery-v3` | 520.733 s | 1 | 11/15 | Failed | No |

Version 1 stopped after the original request and its retry each exceeded the 90-second no-action deadline. Four physical requests; 6865 reported tokens, with **two interrupted requests missing usage**. No implementation files were produced. The guard stopped the waste, but the recovery wording did not solve task execution.

Version 2 began implementing after recovery and continued editing methods. Seventeen physical requests exhausted the reported-token threshold at 162886 tokens (checked between calls), with one interrupted request still missing usage. The core queue and part of persistence were produced, but CLI, tests and documentation were incomplete. This improved observable progress but did not finish the task: overly small increments increased repeated context overhead. Both frozen implementations are retained; current source contains the v3 follow-up.

Version 3 switched from small increments to batching at physical request 6, confirmed from the captured request instructions. Fourteen requests reached 174638 reported tokens, with one interrupted request missing usage. It passed 11/15 independent checks and did not complete. Fewer calls did not translate to fewer reported tokens or shorter elapsed time in this sample. The experiment is **not ready for default desktop activation**. Raw SSE independently matched Paw's assembled tools and text/thinking counts in all three runs.

## DeepSeek control

The user-requested comparison uses the locally configured `deepseek-v4-flash` preset, max effort, and its declared native output limit of 384000, without changing the desktop's selected GLM preset. The same complete task, desktop host, single-agent tools and enclosing budgets apply. Recovery is disabled:

```powershell
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <output> --queue --single-agent --deepseek-flash
```

The latest runner also freezes the desktop entry point, shared Paw Next composition, model adapter and `packages/agent-loop/src/agent-loop.ts`. The actual execution path is `runDesktopNext -> runFreshPawNextTaskV3 -> runAgentLoop`; the shared composition's location under `apps/cli` does not mean this benchmark runs the old CLI agent. This directly exercises the desktop host, not Electron window rendering or automatic task routing.

The DeepSeek control began while the tail of the GLM v3 experiment was still running against a different provider. They use isolated workspaces; timings are descriptive single samples, not a controlled latency ranking.

Completed result: 340.629 seconds, 7 requests, 189700 reported tokens with no missing usage; stopped at the between-call token threshold. Independent functionality passed 15/15, but the requested test suite was absent (`npm test` points to missing `test/`), so the task did not fully complete. Request 3 spent about 275 seconds and 27002 completion tokens before checking Node/npm versions and Git status. This reproduces long within-request thinking under another model, while also showing that the models' eventual implementation outcomes differ. See [SYSTEM-PROMPT-REVIEW.md](SYSTEM-PROMPT-REVIEW.md) for the actual prompt and the distinction between prompt weaknesses and retained reasoning overhead.
