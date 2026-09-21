# ZCode / Paw: the same persistent queue task on GLM max

Date: 2026-09-08. This is a single-task diagnostic, not a framework ranking.

## Result

ZCode progressed substantially further on the same goal, but neither run fully completed. ZCode's own tests and its final closeout remain unfinished despite passing the independent functional checks.

| Observation | Paw V14, latest desktop loop | ZCode native bundled runtime |
| --- | ---: | ---: |
| First tool delta from run start | 8.096 s | 11.635 s |
| First implementation file observed | None | 318.999 s |
| Long third model response | Interrupted at 180.521 s | Completed in 267.367 s |
| Third response's first visible text / tool delta | Neither | 265.477 / 265.743 s after request start |
| Independent functional checks | 0/15 | 15/15 |
| Delivered `npm test` | Missing | Exit 1: invalid test invocation |
| Direct `node --test` diagnostic | No delivered tests | 27 passed, 4 failed |
| README | Missing | Present, first observed at 588.348 s |
| Total run duration | 193.751 s | 720.528 s |
| Main requests | 3 | 25, last one interrupted |
| Final status | Incomplete: reasoning-only timeout | Outer wall timeout, exit 137 |

ZCode's third request contains 45,124 UTF-16 reasoning characters. It then emits a TodoWrite action; the following request writes `src/queue.js`, with only 3.966 seconds to the first tool delta and 32.993 seconds to full response completion. Queue, store, CLI and package files appear by 352.730 seconds. File appearances are polled every 250 ms; they are not exact tool completion timestamps. Prior tool results in subsequent native requests confirm those writes succeeded. Tool deltas are mapped to timestamped raw byte chunks.

Across 24 completed ZCode responses, provider-reported usage sums to 37,129 `input_tokens`, 509,376 `cache_read_input_tokens` and 27,076 `output_tokens`, with those fields reported separately. The interrupted 25th response has no final usage. These are incomplete usage totals, not a monetary bill or a fair token-efficiency comparison with Paw's earlier interruption.

## Why 15/15 is not full completion

The frozen independent check verifies the presence of README and a test script; it does not run that script as part of its 15 checks. The separate own-test check is therefore mandatory.

ZCode delivered `"test": "node --test test/"`, which fails under the recorded Node 24 runtime with `Cannot find module '/workspace/test'`. Running the unchanged test files with `node --test` discovers 31 tests: 27 pass and four fail. Inspection identifies mistaken assertions in the generated suite:

- `test/queue.test.js:75` expects `list()` in dequeue order, although the contract requires enqueue order. The prior dequeue-order assertions pass.
- `test/queue.test.js:185` reads the completion result from job B even though job A was completed; the same test also assigns the retry error to the wrong job.
- `test/store.test.js:116` expects deduplication for an enqueue without a supplied key.
- `test/cli.test.js:65` expects the next process to skip a running job, while the specified restore behavior returns interrupted running jobs to pending.

These explain the observed failures without proving the implementation correct in every untested case. The benchmark deliverables were not repaired by the evaluator. ZCode had begun inspecting these failures and manually reproducing CLI recovery when the outer time allowance expired. Several native Bash commands pipe test output through `tail`, `grep` or `sed`, so a successful tool-result envelope is not proof that the underlying tests passed.

## What this changes in the Paw diagnosis

1. **The present 180-second hard cutoff can stop a response that would later act.** `packages/models/src/request-supervision.ts:7` fixes `reasoningOnlyMs` at 180,000; its timer aborts when reasoning has started and no action is observed. The adapter applies it around the model request. Applied to the captured ZCode trace, this rule would terminate it about 85 seconds before its first visible action. This is a trace-based counterfactual, not proof that extending Paw's deadline alone would reproduce ZCode's output.
2. **Long pre-action reasoning is not exclusive to Paw.** ZCode also spends more than four minutes in the planning response. The difference here is that it eventually transitions to tools, preserves the resulting context and continues implementation. A long wait by itself does not establish a dead loop.
3. **A longer timeout is not a complete fix.** Earlier Paw samples still produced no tool calls through 360 seconds, and the older queue wire sample remained reasoning-only for roughly 699 seconds. ZCode differs in prompt, tool descriptions, protocol, history and task-progress actions. This experiment does not isolate which of those causes the different transition time.
4. **The next production change should separate slow progress from hard failure.** A reasoning-duration threshold should produce an observable slow-state signal, with cancellation retained for inactivity, a bounded overall deadline or user cancellation. Keep model effort unchanged during diagnosis. Then retest latest Paw with the same task and comparable waiting allowance before attributing improvement to prompt/tool simplification. Completion must still require working test invocation, actual test success and final closeout.

No production timeout, model selection or system prompt was changed in this comparison. Changes are limited to reproducible diagnostic runners, grading and this report.

## Reproduction and controls

The actual official desktop-bundled ZCode runtime (`D:\zcode\resources\glm\zcode.cjs`, version 0.16.1) runs the exact goal from the [latest V14 Paw desktop sample](RUNTIME-V14-LIVE-MAX.md). Bundle SHA-256: `8a25adb6fb0999415956f7d83f2229cd8b715cb3a1dfd09026192eeb20147146`.

The task requires a persistent queue, immutable returned values, validated recovery, atomic storage, a CLI, own tests and a README. Both artifacts are graded with the same frozen 15-check verifier; its SHA-256 is `71777e78f2d56f9c8f6585ce6c3e4f54486226b468b29b988f92f4f5c21b3792`. Independent checks run before generated tests and mount delivered files read-only.

ZCode uses an isolated temporary configuration and workspace. The user's existing configuration, sessions and desktop app are untouched. Delegation, skills, plugins, MCP and memory are disabled. Eight native coding/progress tools remain: Bash, Edit, Read, TaskOutput, TaskStop, TodoRead, TodoWrite and Write. This is the native bundled runtime exercised headlessly, not a GUI end-to-end test.

Raw requests must match `glm-5.3-flash`, `output_config.effort=max`, `thinking.type=enabled`, `thinking.budget_tokens=32000` and `max_tokens=128000`. A mismatch fails the relay; it does not silently rewrite the request. The last value is an output ceiling, not observed usage; the requested thinking budget is not proof that the service enforces that exact limit.

Execution uses Docker with no network, a read-only root, dropped capabilities, no-new-privileges, UID 1000, 1 GiB memory, two CPUs, 128 PIDs and an ephemeral `/tmp`. Only the task workspace, isolated runtime state, read-only ZCode bundle and model-only file relay are mounted. The API key stays outside the container. The image has the same pinned Node 24 Alpine base as Paw, but adds Bash/git/ripgrep/runtime libraries: the execution images are **not identical**.

The outer experiment allows 720 seconds, 40 physical model requests and 32 main requests. ZCode's help advertises several unsupported flags in this version, including `--settings`, `--allowed-tools` and `--max-turns`; isolated configuration, supported `--disallowed-tools` and relay-enforced request bounds are used instead. These accounting units differ from Paw's 32 loop steps. Paw's current per-request supervision additionally stops pure reasoning at 180 seconds; ZCode's test does not add that cutoff.

```powershell
bun run benchmarks/desktop-harness-ab/zcode-glm-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max <fresh-zcode-run> queue
python benchmarks/desktop-harness-ab/zcode-comparison-report.py benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max <settled-zcode-run>
```

Local evidence: `.runs/2026-09-08-v16-zcode-queue-max/`. Protocol, source snapshots, timestamped raw streams, native state and final grading are recorded there. Raw model logs and native state are intentionally not published.

## Protocol controls before the native comparison

Two decision-only probes replayed Paw V14 request 3 with its logical prompt, task, tools and tool history preserved, converted to the Anthropic-compatible endpoint used by ZCode. Both omit the original 67 characters of reasoning history symmetrically because unsigned OpenAI reasoning cannot be converted into a valid signed Anthropic thinking block. No returned tools execute.

| Probe | Sampling | Observation window | Thinking characters | Tool calls |
| --- | --- | ---: | ---: | ---: |
| `v16-protocol-anthropic` | Paw's temperature 1 / top_p 0.95 | 241.947 s | 35,813 | 0 |
| `v16-protocol-anthropic-default` | Both fields omitted, as in ZCode | 240.005 s | 43,028 | 0 |

Both raw streams pass independent parsing and logical-input checks. Neither reached provider completion, so final usage is unknown; the initial zero usage placeholders are not a zero-cost result. The first probe includes about 1.947 seconds of cancellation/flush overhead beyond its 240-second bound.

These censored samples do not establish that protocol or sampling is irrelevant: native ZCode's long response also outlasted 240 seconds. They show only that changing these fields did not produce action within four minutes with the retained Paw input.
