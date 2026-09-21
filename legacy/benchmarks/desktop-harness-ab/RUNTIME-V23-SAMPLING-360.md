# V23: omit sampling fields from the frozen Paw Anthropic request

2026-09-08. Follow-up to V22. This is a decision-only probe; no production configuration or agent behavior changes.

## Intervention

Use the existing `anthropic-default-sampling --extended` probe mode on the same V14 request 3. Against V22's Anthropic arm, the actual request differs only by omission of `temperature: 1` and `top_p: 0.95`. The model, max effort, 32,000 thinking budget, 128,000 output limit, endpoint, 24 tool definitions, system/user text, historical calls/results and 360-second observation window are identical. Both arms remove the same 67 historical reasoning characters for the previously documented protocol-conversion constraint.

This matches the sampling-field omissions in the native ZCode captures. It does not assert what defaults the provider actually applies internally, whether these fields affect this model, or whether omitting them is generally preferable. Two fields change together, so their separate effects cannot be identified.

The control is the completed V22 Anthropic run, rather than a simultaneous or randomized new control. Cache age, provider load and stochastic variation are uncontrolled. A positive difference would require fresh control/repetition before changing production defaults or claiming causality.

Frozen source: `.runs/2026-09-08-v14-live-queue-max/request-3.json`, SHA-256 `2d112d270ffc3c3e3f9e9f7dffda3f7e0586e82e4210c6c9fa6f0a9db3125e30`.

## Results

| Arm | First thinking | Observed duration | Thinking characters | Visible text | Tool calls | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| V22 control: temperature 1 / top_p 0.95 | 4.842 s | 360.008 s | 65,010 | 0 | 0 | Wall timeout |
| V23: both sampling fields omitted | 4.621 s | 360.007 s | 69,138 | 0 | 0 | Wall timeout |

Both return HTTP 200 and continue streaming thinking, but neither returns a tool event or provider terminal event within the observation window. Counts are UTF-16 characters, not tokens or progress. The initial zero-valued usage records are provisional; final usage is unknown for both timed-out requests.

The pair verifier passes: request equality after removing exactly the two fields, identical source and probe hashes, matched endpoint/wait policy, and independent raw SSE reconstruction for both runs. No completed tool arguments exist, so schema validity is not asserted and no generated tool executes. This run does not evaluate coding quality or task completion.

## Interpretation and next step

Omitting these fields did not make the frozen Paw request act within six minutes in this sample. Together with V22's negative interface result, this lowers the priority of changing production sampling defaults as a proposed fix. It does not prove sampling has no effect, establish equal latency, or predict whether either censored response would eventually act.

The next bounded intervention should change only the available tool catalog, retaining the V23 endpoint, sampling omissions, full system/history/results, max configuration and 360-second limit. Preserve tools needed by this queue task and every tool referenced by the historical calls; remove unrelated integrations from the diagnostic catalog. Compare complete tool responses, not only thinking length. A positive result would require repetition and full-task validation before implementing task-aware tool exposure in production.

This is a tool-catalog hypothesis, not a finding that 24 tools is intrinsically excessive. Paw already exposes `workspace_todo_write`, file read/write/edit/patch and shell execution tools. The source request's successful inspection calls also show tool use is possible. ZCode's remaining environment/context-management system block and its historical tool-result representation remain separate candidates and should not be changed simultaneously with the tool list.

No production change follows from this negative result. `glmRequestFields()` in `packages/models/src/openai-compatible.ts` retains its current sampling settings. The new work consists of this report, the benchmark index and a reusable pair verifier. Python syntax checking and the actual paired input/raw-response checks pass; the application suite was not rerun for this diagnostic-only change. The paid probe has finished and no background model request remains from this run.

## Evidence and reproduction

The new `verify-sampling-decision.py` asserts that only the two sampling fields differ, checks identical source/probe snapshots, endpoint and wait policy, invokes independent raw-response verification for each arm, and writes `sampling-comparison.json` in the treatment directory. It never executes tools or evaluates task completion.

Treatment evidence: `.runs/2026-09-08-v23-default-sampling-360` contains the request, protocol, frozen probe source, raw SSE, result, independent check and sampling comparison. The existing V22 control evidence is revalidated without rerunning its paid request.

Pair verifier SHA-256: `ff6b3539bcc0464d74d762d361fd56800ae9652f0e45a6b655007db0641f59a7`.
Raw response verifier SHA-256: `44dfcd8f156640c936168294fd1ab9f0970b74aa742d6ef03f613c81c736ea07`.
Unchanged probe SHA-256: `980113a48274539c8968c9a20f370d86b581343f6723a708446a530ef4ceddf9`.

```powershell
bun run benchmarks/desktop-harness-ab/protocol-decision-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max/request-3.json benchmarks/desktop-harness-ab/.runs/2026-09-08-v23-default-sampling-360 anthropic-default-sampling --extended
python benchmarks/desktop-harness-ab/verify-sampling-decision.py benchmarks/desktop-harness-ab/.runs/2026-09-08-v22-anthropic-360 benchmarks/desktop-harness-ab/.runs/2026-09-08-v23-default-sampling-360
```

The probe requires a fresh output directory and existing ignored local credentials. It sends one paid request, executes no generated tool, performs no retry, and does not start Docker or the user's ZCode app.
