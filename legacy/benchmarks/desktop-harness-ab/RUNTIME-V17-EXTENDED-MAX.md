# V17: extend the max reasoning allowance and retest the desktop loop

Date: 2026-09-08.

## Result

**Extending the allowance did not produce action in this sample.** The latest desktop loop ends incomplete after 362.333 seconds with `ModelReasoningWithoutActionTimeout`. Independent grading is 0/15; no implementation, tests or README were created.

| Measurement | V14, previous allowance | V17, extended allowance |
| --- | ---: | ---: |
| Reasoning-only request allowance | 180 s | 360 s |
| Absolute request allowance | 360 s | 600 s |
| Total run duration | 193.751 s | 362.333 s |
| Physical requests | 3 | 1 |
| Successful implementation writes | 0 | 0 |
| Independent checks | 0/15 | 0/15 |
| Final status | Incomplete | Incomplete |

Unlike the V14 sample, which completed preliminary inspection before stalling on request 3, this run remains in its first request. That request lasts 361.101 seconds including supervision polling and cancellation settlement. It emits 55,415 reasoning characters, zero visible-text characters and zero tool-argument characters; independent raw SSE counts match the parsed counts. No tool call was received and then lost by the executor. The first thinking delta arrives 6.467 seconds after request start; the observed span from that delta to cancellation is 354.634 seconds.

The request is interrupted before final usage arrives. The reporter's zero accumulated usage means **no usage report was received**, not zero tokens consumed or zero cost. No automatic retry occurs. The test container is removed after grading.

The normalized initial request hash is identical to V14: `e975d81926c38429053bb91d1fae4d9e0c26fa703f480e3de1a280b3a4f2fcb0`, replacing only the temporary workspace path (effort is separately checked as max). Source snapshot comparison finds only the intended supervision file changed. Thus no simultaneous prompt or model-parameter change explains this test's result, but one stochastic sample does not establish a causal latency effect or prove it would never act after six minutes.

The longer production allowance remains in source as requested. This result shows that the earlier three-minute cutoff is not the whole problem: six minutes alone was insufficient here. Comparing prompts, tool definitions and context structure remains necessary before claiming a root cause or another production fix.

## Change and conditions

At the user's request, `MODEL_REQUEST_SUPERVISION_V1` now allows 360 seconds of reasoning without visible text/tool fragments, up from 180. Its absolute request limit increases from 360 to 600 seconds so a late tool call has time to finish streaming. The 90-second idle timeout, user cancellation, unknown-settlement handling and no-automatic-retry behavior remain unchanged. Both reasoning and wall limits are measured from request start, not first thinking delta.

The policy identity is `paw.model-request-supervision.v1:idle90000:reasoning360000:wall600000:no-retry`. The V3 product manifest already includes that policy, so the known manifest hash changes to `5dc804a022d93e21dd71851fb6029a0bbbbb4fc86dc23bd68d353be0b0ac50ef`; the literal manifest expectation is updated accordingly. V1/V2 identity checks still pass.

The real API test uses `runDesktopNext` and the latest V3 agent loop on the same persistent queue/library/CLI/test/README task as [V14](RUNTIME-V14-LIVE-MAX.md) and the [ZCode comparison](ZCODE-GLM-COMPARISON.md). Its overall budget remains 720 seconds, 40 requests and 32 steps, with the cumulative reported-token cutoff disabled. Main requests retain GLM-5.3-Flash max, 128,000 output capacity and streaming. No prompt, tool, sampling, reasoning-effort or automatic-recovery changes are introduced.

Docker preflight passes. The fresh workspace uses the same pinned Node 24 Alpine image as V14, no network for generated commands, a read-only container root and an ephemeral `/tmp`. Single-agent isolation still disables delegation, external memory and the environment auditor, while retaining completion review. This invokes the desktop host, not the Electron UI.

Among all source files frozen by the benchmark, only `packages/models/src/request-supervision.ts` differs from the V14 snapshot. Goal, runtime profile, task budget and experimental flags are checked against the old protocol before interpreting the result. This is one fresh sample; provider load, cache and sampling are uncontrolled.

## Validation and reproduction

- 32 tests pass, 380 assertions: request supervision, V3 product identity and desktop runtime hardening.
- Models package TypeScript check passes.
- The added regression admits a response that continues reasoning beyond the former scaled cutoff and then produces an action; existing tests retain idle, wall, cancellation and late-result protection.

```powershell
bun test packages/models/test/request-supervision.test.ts apps/cli/test/paw-next-product-v3.test.ts apps/desktop/test/runtimeHardening.test.ts
bun run typecheck:models
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <fresh-run-directory> --queue --single-agent --wall-and-call-budget --docker
python benchmarks/desktop-harness-ab/single-agent-report.py <settled-run-directory>
python benchmarks/desktop-harness-ab/runtime-validation-report.py <settled-run-directory>
```

Local evidence directory: `.runs/2026-09-08-v17-live-queue-max-extended/`. It contains frozen source, actual requests without authorization headers, raw response streams, model phases, tool events and grading artifacts. Interrupted usage must be reported as unknown, not zero cost.
