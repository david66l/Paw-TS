# V14 live max retest

2026-09-08. Real GLM-5.3-Flash API retest through `runDesktopNext` after the V13 token-count cache and V14 historical-payload path optimizations. This is a new live sample, not recorded-response replay.

**Result: the max reasoning-without-action failure reproduces.** The runtime finishes `incomplete` after 193.751 seconds; independent grading is 0/15 and no implementation or project tests were written. The local performance improvements did not remove this failure in the new sample.

## Results and comparison

| Measurement | V12 max | V14 max retest |
| --- | ---: | ---: |
| Total run duration | 193.049 s | 193.751 s |
| First successful tool | 7.131 s | 8.096 s |
| First successful implementation write | none | none |
| Physical model requests | 3 | 3 |
| Third request duration | 180.589 s | 180.521 s |
| First thinking delta to interruption, third request | 176.945 s | 176.766 s |
| Raw thinking characters, third request | 27,808 | 25,186 |
| Raw visible text / tool-argument characters, third request | 0 / 0 | 0 / 0 |
| Parsed tool calls, third request | 0 | 0 |
| Independent checks | 0/15 | 0/15 |
| Runtime status | incomplete | incomplete |

The new sample first completes `workspace_list_dir`, `workspace_git_status`, and two `workspace_read_file` calls. Request 3 begins at 13.244 seconds and only emits reasoning until `ModelReasoningWithoutActionTimeout`. The real request body confirms `glm-5.3-flash`, `max`, `max_tokens=128000`, and streaming. Normalized initial request SHA-256 remains `e975d81926c38429053bb91d1fae4d9e0c26fa703f480e3de1a280b3a4f2fcb0`.

Model-request phases total 189.757 seconds, tool activity union is 1.195 seconds, and other host time is approximately 2.799 seconds by subtraction. These are wall-clock observations, not server CPU measurements. The final observer event arrives milliseconds after the outer terminal event.

This trace rules out a received tool call being lost by Paw's parser/executor for the stalled request: both the raw wire and parsed result have zero tools. It also places the wait before completion review and memory maintenance. It does **not** prove the model would never act if allowed to run beyond the existing three-minute limit, nor rule out interaction between prompting, tool definitions, reasoning settings and harness supervision.

Only the first two requests report usage: 7,845 tokens (7,780 prompt, 65 completion, including 3,776 cached prompt). The interrupted third request has unknown usage/cost; its 25,186 reasoning characters must not be presented as a token count or zero cost. No automatic retry was attempted.

## Conditions

- Same persistent queue/library/CLI/test/README task as the V12 max failure.
- Actual main request: `reasoning_effort=max`, `max_tokens=128000`, streaming enabled. No model parameter override, automatic reasoning recovery or extra retry.
- The normalized first request is identical to V12 max after replacing only the temporary workspace path. The later requests may differ because model decisions and tool results differ.
- Existing supervision remains unchanged: 90-second idle limit, 180-second reasoning-without-action limit measured from request start, 360-second request wall limit. Overall task budget: 720 seconds / 40 requests / 32 steps; cumulative reported-token threshold disabled as in V12.
- Desktop V3 composition `paw.product-composition.v3.26:bounded-memory-maintenance`. Single-agent experiment: delegation removed, external memory and independent environment auditor disabled, auxiliary completion review retained. This does not exercise every default desktop service or native Electron rendering.
- Same pinned Docker image, network-isolated shell, read-only container root and only a fresh temporary task workspace mounted. No Docker Desktop restart and no Langfuse.
- Source snapshots additionally include the token estimator/cache, file session, lease and file payload store, so the latest performance changes are part of the frozen evidence. Credentials/HTTP headers are not logged.

## Evidence

Ignored run directory: `.runs/2026-09-08-v14-live-queue-max/`. It retains actual request JSON, raw response bytes, parsed model results, model phase events, tool events, final result, independent grading and frozen source files.

Reproduce:

```powershell
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <fresh-output-dir> --queue --single-agent --wall-and-call-budget --docker
python benchmarks/desktop-harness-ab/single-agent-report.py <settled-output-dir>
python benchmarks/desktop-harness-ab/runtime-validation-report.py <settled-output-dir>
```

This is one new sample. Provider load, caching and sampling are uncontrolled; it cannot establish a general success rate or assign all causal responsibility to either model or harness.
