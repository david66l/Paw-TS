# V22: equal-window Paw protocol decision comparison

2026-09-08. Follow-up to V21: both successful native ZCode-context responses took longer than the older converted-protocol probes' 240-second limit. This comparison gives both Paw-input arms 360 seconds. No production runtime, provider, prompt, effort or timeout setting is changed.

## Controls and scope

Both sequential requests use the frozen V14 desktop post-inspection request, `.runs/2026-09-08-v14-live-queue-max/request-3.json`, SHA-256 `2d112d270ffc3c3e3f9e9f7dffda3f7e0586e82e4210c6c9fa6f0a9db3125e30`. The model is `glm-5.3-flash`, maximum output is 128,000 tokens, and temperature 1 / top_p 0.95 remain unchanged. The same system/user text, 24 tools, parsed historical tool arguments and tool results are preserved.

The OpenAI-compatible arm calls `https://open.bigmodel.cn/api/paas/v4/chat/completions`, retaining `reasoning_effort=max`, `thinking.clear_thinking=false`, `tool_stream=true` and the captured omission of tool_choice. The Anthropic-compatible arm calls `https://open.bigmodel.cn/api/anthropic/v1/messages`, converts messages/tools, uses `output_config.effort=max`, enabled thinking with `budget_tokens=32000`, and explicit `tool_choice=auto`. This tests the interface plus provider-specific thinking configuration as a bundle; it cannot isolate serialization from budget handling or assume equal internal effective reasoning limits.

Both arms remove the same 67 UTF-16 characters of historical reasoning because native signed Anthropic thinking cannot be fabricated from the OpenAI history. This is a symmetric diagnostic normalization, not a recommendation to strip production reasoning. The OpenAI control therefore differs from an exact production replay in this explicitly recorded respect. Unlike native ZCode, these arms retain Paw's sampling parameters and tool/history contract.

Requests go directly to the service through fetch, bypassing the desktop loop and harness after input capture. No returned tool executes, no Docker instance starts, and there is no retry or effort downgrade. The observation limit covers the complete response, so a late partial tool call is distinct from a complete response, executed code or a completed task. Timed-out streams are censored; their final usage is unknown. Requests run sequentially to avoid intentional overlap, but cache state and provider load remain uncontrolled.

The probe adds an explicit `--extended` flag; existing non-native modes retain their 240-second default and native modes retain 360 seconds. Each run stores the request, source hashes, probe snapshot, raw SSE and result. The independent Python verifier checks logical inputs, wait policy, raw stream reconstruction and any completed tool arguments against the captured JSON schemas.

## Results

| Arm | First thinking | Observed duration | Thinking characters | Visible text | Tool calls | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| OpenAI-compatible, normalized Paw history | 4.394 s | 360.013 s | 49,717 | 0 | 0 | Wall timeout |
| Anthropic-compatible, same logical Paw history | 4.842 s | 360.008 s | 65,010 | 0 | 0 | Wall timeout |

Both return HTTP 200 and ongoing thinking, with neither a tool event nor a provider terminal event. Character counts use JavaScript UTF-16 length; they are not token counts, task progress or a quality metric. OpenAI provides no usage record; Anthropic provides only an initial zero-valued usage record. Neither is a final bill or evidence that no tokens were consumed.

Both independent checks pass: the expected logical inputs, source/probe hashes, 360-second policy and raw SSE counts/tool reconstruction match. A cross-arm input check also confirms identical frozen source and probe snapshot, model, output limit, sampling and tool count. There are no completed tool arguments to validate, so `toolSchemasValid` is null rather than a claimed successful tool execution.

Evidence directories:

- `.runs/2026-09-08-v22-openai-360`: protocol, request, probe snapshot, raw response, result and independent check.
- `.runs/2026-09-08-v22-anthropic-360`: corresponding evidence plus `pair-input-check.json`.

Probe SHA-256: `980113a48274539c8968c9a20f370d86b581343f6723a708446a530ef4ceddf9`.
Verifier SHA-256: `44dfcd8f156640c936168294fd1ab9f0970b74aa742d6ef03f613c81c736ea07`.

## Interpretation and next isolation

The longer matched window does not reproduce V21's tool transition when Paw's tool/history contract and sampling are retained. Merely converting this request to the Anthropic interface and its max thinking configuration did not produce action within six minutes in this sample. This is not proof that protocol never matters, that either response would never finish, or that the two interfaces have equal latency.

Because both raw streams lack tool calls even outside the agent loop, these particular stalls precede tool dispatch. A loop deadlock or failure to execute an already-returned call cannot explain these captures. The production harness still determines the model's input and interruption policy, so this does not exonerate its context design or prove a provider-only cause.

The production request fields to isolate next are `glmRequestFields()` in `packages/models/src/openai-compatible.ts`: Paw explicitly sends temperature 1 and top_p 0.95, whereas the successful native ZCode captures omit them. The older converted default-sampling probe ran only 240 seconds, so it does not settle this difference. A follow-up should keep the Anthropic request and 360-second policy fixed and vary only those sampling fields before changing production defaults. One matched pair remains exploratory because provider load and stochastic variability are uncontrolled.

Then isolate the retained ZCode environment/context-management system block and the tool/history contract separately. V21 changed only two identity/execution blocks; its retained third block, eight native tools and native historical result format remain candidate differences. Tool count by itself is not a demonstrated cause, and a TodoWrite transition is not successful coding. Do not introduce forced plans, remove needed tools, rewrite the whole system prompt or silently lower max on the strength of these samples.

Validation for this benchmark-only change: targeted Biome check, Python syntax/jsonschema import, both independent response verifiers and repository `git diff --check` pass. No new production behavior is claimed; the broad application suite was not rerun for this diagnostic flag and report update. Both paid requests are settled and no generated tools were executed.

## Reproduction

Run from the repository root with the existing ignored local credential configuration and fresh output directories:

```powershell
bun run benchmarks/desktop-harness-ab/protocol-decision-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max/request-3.json benchmarks/desktop-harness-ab/.runs/2026-09-08-v22-openai-360 openai --extended
bun run benchmarks/desktop-harness-ab/protocol-decision-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max/request-3.json benchmarks/desktop-harness-ab/.runs/2026-09-08-v22-anthropic-360 anthropic --extended
python benchmarks/desktop-harness-ab/verify-protocol-decision.py benchmarks/desktop-harness-ab/.runs/2026-09-08-v22-openai-360
python benchmarks/desktop-harness-ab/verify-protocol-decision.py benchmarks/desktop-harness-ab/.runs/2026-09-08-v22-anthropic-360
```
