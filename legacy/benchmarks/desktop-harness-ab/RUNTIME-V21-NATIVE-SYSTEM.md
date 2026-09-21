# V21: native ZCode decision replay and Paw guidance ablation

2026-09-08. Follow-up to V20's negative state-view action-latency result. No production model, prompt, tool or runtime setting is changed in this investigation.

## Question and controls

V16's native ZCode request 3 eventually emitted TodoWrite after 265.743 seconds, completing at 267.367 seconds. This experiment first replays that captured JSON body, then replaces only its first two system text blocks with Paw's production agent identity and coding-execution guidance. The third ZCode system block (environment, context management and other guidance), cache markers, tools, messages, signed thinking, tool results, metadata and all model parameters remain identical. It tests the identity/harness-guidance bundle, not the language, individual sentence, full ZCode/Paw system difference or live desktop runtime independently.

Frozen input: `.runs/2026-09-08-v16-zcode-queue-max/request-f0171202-fe89-4c41-8ab3-2d845a273974.json`, SHA-256 `ae7e8cb166d100d372dab0198d749a0c2df45a5b93798bcccef42db07e45e194`.

Both arms use the same Anthropic-compatible endpoint, `glm-5.3-flash`, `output_config.effort=max`, `thinking.budget_tokens=32000`, `max_tokens=128000`, `tool_choice=auto`, eight original tools and a 360-second observation limit. Temperature and top_p remain omitted. No unsigned thinking conversion, retry, effort downgrade, Docker startup, tool execution or extra judge call occurs.

Transport is a direct host fetch, using x-api-key and the same captured Anthropic-version/content-type headers. The older native container relay sent both x-api-key and Authorization with the same credential; this direct runner sends x-api-key only. Consequently this is exact JSON-body replay, not a claim of byte-identical entire HTTP transport or live ZCode execution. The two new arms use identical transport. Cache age and server conditions are uncontrolled, so single samples cannot establish stable performance or a causal speedup.

`protocol-decision-probe.ts` adds `native-zcode` and `native-paw-system` modes without altering the previous conversion modes' request behavior. Each run freezes the probe and production prompt source. `verify-native-decision.py` independently checks original-body identity or exactly two system text replacements, preserved native history, raw SSE reconstruction and complete tool arguments against their JSON schemas. On timeout, initial usage is provisional and final usage remains unknown.

## Results

Tool fragments, complete tool-call responses, successful file execution and full-task verification are distinct outcomes; this decision-only experiment measures only the first two.

The first control reproduces a complete tool-call response: first TodoWrite delta at **291.361 seconds**, provider message_stop at **293.798 seconds**, 42,368 reasoning characters and 67 visible text characters. Its single TodoWrite argument object is complete and passes the frozen tool schema. Reported usage is 3,421 input tokens, 960 cache-read input tokens and 10,309 output tokens (provider fields reported separately). This response has not written implementation files or completed the task. The historical native response took 267.367 seconds, so even the reproduced behavior is not a fixed latency.

The control's raw response and unchanged JSON input pass the independent verifier. Original signed thinking/history is preserved; no native provider state is synthesized or removed. The prompt arm runs second with identical transport and stopping rules.

Both arms have now finished and independently passed raw-response, input-difference and tool-schema verification:

| Condition | First tool delta | Complete response | Reasoning characters | Visible text characters | Tool |
| --- | ---: | ---: | ---: | ---: | --- |
| Native ZCode request | 291.361 s | 293.798 s | 42,368 | 67 | TodoWrite, 624 argument characters |
| Same request, Paw identity/execution guidance | 273.648 s | 275.502 s | 39,467 | 115 | TodoWrite, 465 argument characters |

The Paw-guidance arm reports 3,632 input tokens, 960 cache-read input tokens and 9,369 output tokens. Both end with `tool_use` and `message_stop`; neither is interrupted. These separate provider usage fields are not a measured bill. One sample per condition, uncontrolled serving/cache effects and the prompt's changed language/size preclude claiming that Paw's prompt is faster or cheaper.

**Paw's current identity and coding guidance do not, on their own, prevent max from transitioning to tools in this retained ZCode context.** This is a concrete counterexample to that narrow hypothesis. It does not prove that Paw's complete system prompt is optimal: the third ZCode block remains, and both arms retain its tool contract, tool-result format, prior trajectory and Anthropic-compatible configuration. Both still spend more than four minutes before a planning tool. A TodoWrite does not establish implementation progress, test success or task completion; no emitted calls execute in this experiment.

The next discriminator is the remaining request bundle: native tools/history/observation format versus Paw's, and provider-specific thinking settings. Repeating generic execution reminders or deleting preserved thinking is not supported by these results. A same-endpoint tool/history experiment or a longer, matched protocol comparison can test those alternatives; the earlier converted Paw/Anthropic probes lasted only 240 seconds, shorter than **both** complete responses here.

Local captures: `.runs/2026-09-08-v21-native-zcode` and `.runs/2026-09-08-v21-paw-system`. The former freezes the pre-format probe and the latter freezes its formatted equivalent; independent input checks confirm the only JSON differences are the two intended system text fields. Both retain the same production prompt snapshot hash. Probe Biome checks and verifier Python import/UTF-16 smoke checks pass. All model calls are settled, no test container was started and no native app was changed.

The replaced blocks contain 42 + 1,153 characters in the control and 641 + 154 characters in the treatment. The retained third block has 1,292 characters. This replacement changes wording, language and size together; it cannot isolate any of those. The eight native tools occupy 8,810 serialized characters, versus 10,982 for the 24 frozen Paw definitions. Tool count alone therefore exaggerates the size difference and is not a diagnosis. The native TodoWrite is a plan update, not implementation: the earlier full ZCode trace required a subsequent Write call to create code.

## Reproduce

The Bun commands make paid model requests. The Python command is read-only verification of captures, with no model/tool execution.

```powershell
bun run benchmarks/desktop-harness-ab/protocol-decision-probe.ts <native-request-3.json> <fresh-control> native-zcode
bun run benchmarks/desktop-harness-ab/protocol-decision-probe.ts <native-request-3.json> <fresh-treatment> native-paw-system
python benchmarks/desktop-harness-ab/verify-native-decision.py <settled-control> <settled-treatment>
```
