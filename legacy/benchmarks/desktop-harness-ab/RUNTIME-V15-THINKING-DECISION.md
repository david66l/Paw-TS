# V15: frozen decision replay and reasoning passback audit

2026-09-08. Follow-up to [V14 live max](RUNTIME-V14-LIVE-MAX.md). This experiment isolates the third request captured from the current desktop `runDesktopNext` runtime. Both max samples remain reasoning-only through six minutes; both high samples return complete native write calls. It does not execute returned tools or measure full-task completion.

## Protocol

- Source: `.runs/2026-09-08-v14-live-queue-max/request-3.json`.
- Source file SHA-256: `2d112d270ffc3c3e3f9e9f7dffda3f7e0586e82e4210c6c9fa6f0a9db3125e30`.
- Sequential order: max, high, high, max. Two samples per effort; reversed second pair reduces a simple order confound but is not randomized or statistically conclusive.
- Every replay has a 360-second wall limit. Max preserves the entire captured JSON object; high changes only `reasoning_effort`. No appended instructions, history removal, tool-choice override, output cap reduction, automatic retry, or generated-tool execution.
- Retained fields: GLM-5.3-Flash, `max_tokens=128000`, thinking enabled, `clear_thinking=false`, temperature 1, top_p 0.95, streaming and tool_stream enabled, the same 24 tools and two completed assistant turns.
- These direct API replays bypass the live runtime's 180-second reasoning-only supervisor and 90-second idle supervisor. Their only request deadline is the explicit six-minute wall limit. They isolate model response behavior under a captured runtime input; they are not another end-to-end desktop run.
- Each run records its actual request, raw SSE, complete assembled tool arguments, result, protocol, and the exact probe source snapshot. Local ignored configuration supplies the existing endpoint and credential. No Langfuse, Docker startup, or additional model calls for judging.
- All four source snapshots have SHA-256 `3b839cef66f9421140ace1c0dc39243ff59eb78d64da23345afa1d4c8e9003fd`; all response streams identify the model as `glm-5.3-flash`.
- Extended modes collect through provider DONE/EOF or timeout, rather than stopping at the first tool fragment. The protocol's `stopCondition` specifies this; its inherited note about first-fragment stopping describes the older non-extended modes only.
- After all four samples settled, the probe's note was made conditional to remove that ambiguity for future runs. This metadata-only correction does not change request bodies or stopping behavior; historical source snapshots remain unchanged.

## Passback audit

Independent Python reconstruction compares the first two provider responses with the assistant history in the third request. Reasoning content, assistant text, tool IDs, names, raw argument strings and order all match exactly. Response 1 contains 67 UTF-16 reasoning characters; response 2 has no reasoning content. An additional audit also matched response 1 against request 2.

Current path:

1. `packages/models/src/openai-stream-parse.ts` retains the raw `reasoning_content` delta separately from display thinking.
2. `packages/models/src/agent-loop-adapter.ts` accumulates `reasoning_passback` and stores it in the canonical model response.
3. `packages/runtime/src/context/journal-context.ts` restores it into completed assistant/native tool turns.
4. `packages/models/src/openai-compatible.ts` serializes it as `reasoning_content`, without trimming or rewriting it.

The old runtime already accumulates the same dedicated field in `packages/agent/src/orchestrator.ts` and passes it through native tool turns. No missing migration or passback corruption was found for this failing decision point. This is a concrete trace audit, not a claim about every compaction or model-switch scenario.

## Results

| Order | Effort | First tool fragment | Response duration | Thinking characters (UTF-16) | Result |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | max | none within 360 s | 360.004 s | 62,687 | wall timeout; no text or tool arguments |
| 2 | high | 107.857 s | 136.778 s | 14,910 | provider DONE; two complete write calls |
| 3 | high | 163.541 s | 186.227 s | 23,929 | provider DONE; two complete write calls |
| 4 | max | none within 360 s | 360.004 s | 53,632 | wall timeout; no text or tool arguments |

Both completed high responses emit `workspace_write_file` calls for `src/queue.js` and `src/store.js`. Their argument JSON, required path/content strings and JavaScript syntax pass independent checks. Syntax checking uses `node --input-type=module --check` on stdin; it does not execute generated code. There is no claim that the files were written, behavior passed tests, or the queue task was completed.

High sample 2 exceeds 180 seconds in total, but its tool stream begins before 180 seconds. That is compatible with the production supervisor: tool fragments end reasoning-only mode while the independent absolute deadline remains active.

Reported usage:

| Sample | Prompt | Cached prompt (included) | Completion | Reasoning (included) | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| high 1 | 4,710 | 0 | 5,394 | 3,486 | 10,104 |
| high 2 | 4,710 | 4,672 | 7,521 | 5,838 | 12,231 |

Interrupted max usage is unknown. Character counts are not token counts. The cache-hit difference and uncontrolled service conditions are additional reasons not to report an exact speedup, cost saving, or general success rate.

## Interpretation and validation

Both max replays remain reasoning-only through six minutes. Content inspection of the first shows it drafting implementation, configuration and tests internally without producing a tool call. The content develops rather than forming a simple verbatim loop. Increasing the observation window alone did not restore action in either sample.

The high controls demonstrate that this exact captured request can reach complete native calls with only an effort change. That narrows the investigation to the interaction between reasoning effort and the supplied task/context/tool contract. It does not prove that prompts are optimal, every max run fails, high always finishes the task, or that the hosted model would never act after six minutes.

No production prompt, timeout policy, model setting, or runtime behavior was changed. Previous incremental-prompt and journal-recovery experiments did not establish a reliable max fix; see [thinking placement](THINKING-PLACEMENT.md) and [V9 recovery](RUNTIME-V9-RECOVERY.md). Avoid deploying another prompt-only retry or simply increasing the global deadline based on these observations.

Validation completed:

- 72 passing regression tests / 340 assertions across GLM serialization, native tool replay, model adapter and journal context.
- 5 passing request-supervision tests / 12 assertions, including tools starting before the reasoning deadline and responses finishing afterward.
- Probe Biome check, Python syntax compilation, independent raw SSE/request/history checks and four generated-file syntax checks.
- Verifier smoke checks cover supplementary Unicode counting, fragmented tool arguments, rejection of post-DONE data and malformed JSON. All four settled replay directories pass independent verification.

The next useful product experiment is an explicit, recorded policy for selecting effort by execution phase, evaluated against fixed-effort controls on full tasks. These isolated results justify testing that direction; they do not yet justify enabling hidden effort fallback or claiming a max/harness fix.

## Reproduce

Each first command below is a paid API call. Use fresh output directories. The verifier makes no model requests and executes no emitted tools.

```powershell
bun run benchmarks/desktop-harness-ab/thinking-decision-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max/request-3.json <fresh-max-output> --extended-max
bun run benchmarks/desktop-harness-ab/thinking-decision-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max/request-3.json <fresh-high-output> --extended-high
python benchmarks/desktop-harness-ab/verify-thinking-decision.py <settled-output>
```

Run directories: `.runs/2026-09-08-v15-decision-extended-max/`, `...-high/`, `...-high-2/`, and `...-max-2/`. `independent-check.json` records verifier/source hashes, exact history checks, permitted request differences, raw counts, complete calls and provider terminal evidence. Timings come from the probe clock; independent verification checks the response contents, not independent network timing instrumentation.
