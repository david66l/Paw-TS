# V18: audit the tool schemas behind the max no-action sample

2026-09-08. **There are real documentation/contract defects, but no evidence that malformed schemas made tool calls impossible.** A fresh replay of the unchanged V17 request returns valid tool calls in 4.627 seconds, although the earlier live sample emitted only reasoning through its six-minute allowance. The revised definitions also return valid calls. Neither decision replay executes tools or establishes complete-task success.

## Structural checks and legacy comparison

The actual V17 request contains 24 function definitions, serialized to 10,982 characters. Every definition passes JSON Schema Draft 2020-12 validation. Names are unique, meet the provider's identifier restrictions, and required fields exist in the advertised properties. Basic read, write, shell, todo and output-recall examples validate. A file write requires only `path` and `content`; there is no impossible required parameter combination.

The provider documents JSON Schema parameters and restricted function names; it supports up to 128 functions. Twenty-four functions do not violate that contract. This is not proof that every provider handles every schema keyword equally well. Missing `strict` or OpenAI-style all-fields-required behavior should not be diagnosed as an error under this API. [Z.AI API reference](https://docs.z.ai/api-reference/llm/chat-completion).

The original 24 tool definitions are exactly equal to those in the V12 high queue sample, which completed with 15/15 independent checks. This comparison changes effort and uncontrolled sampling; it shows that the definitions can support the task, not that max has equivalent behavior.

Legacy `packages/agent/src/orchestrator.ts:4848` also obtains its built-ins from `toolDefinitions(mcp, { shellSandbox })`. Most base schemas are shared, not separately rewritten in the new loop. The new output-recall plugin, however, had replaced the legacy top-level description without replacing incompatible parameter documentation.

## Corrections applied

| Location | Verified defect or ambiguity | Correction |
| --- | --- | --- |
| `packages/harness/src/registry/definitions.ts`, read | Says content contains line numbers, but the implementation returns plain content and separate counts; offset basis is unspecified | State plain-text content and zero-based offset, default 0; explain omitted limit |
| Same file, write | Does not say parent directories default to creation or distinguish whole-file replacement from an edit | Document default parent creation and whole-file semantics; retain the existing parameters and behavior |
| `packages/output-recall/src/index.ts`, V3 recall entry | Parameter text promises archive ids / keyword fallback, but the resolver accepts only `paw-payload:v1:<hash>`; the schema does not expose instance-specific limits | Publish the exact id pattern, no-search behavior, non-negative safe offset and actual per-call cap in the V3 schema; leave the legacy schema intact |
| `packages/task-progress/src/plugin.ts`, todo | “Once per tool batch” can read as mandatory repetition; completion wording does not explicitly identify `done` | Say at most once when progress changes, retain stable ids and name the actual `done` enum |

These changes improve the advertised contract. They do not add a compulsory planning step, change the system prompt, prune tools, change max, retry a response or alter tool execution behavior. Revised definitions occupy 11,519 serialized characters, so this is not a token-reduction claim.

Other observations remain distinct from the corrections: the first request exposes MCP/web/LSP and background-job tools even for this isolated task; file creation is possible through multiple interfaces; patch documentation has no worked example. These may affect tool selection, but neither tool count nor these ambiguities has been isolated as the cause of the long reasoning. The generic legacy argument validator also checks a narrower set of constraints than JSON Schema; it runs after a call and cannot explain a response containing no tool-call bytes.

## Decision probes

Both probes use the V17 first request: same task, system messages, 24 names and order, max effort, sampling, 128,000 output capacity and endpoint. The revised input replaces only four tool definitions from production exports. It changes descriptions and recall parameter constraints together; it is not a JSON-grammar-only intervention. The original probe reproduces the captured request body exactly.

| Condition, in execution order | First tool delta | Provider completion | Complete returned calls | Usage reported |
| --- | ---: | ---: | --- | ---: |
| Revised definitions | 10.032 s | 10.533 s | list directory; read requirements | 3,950 prompt + 60 completion |
| Original definitions | 4.627 s | 5.323 s | list directory; check Node/npm versions | 3,810 prompt + 49 completion |

All returned arguments independently validate against the corresponding schemas. Both raw streams end with `finish_reason=tool_calls` and provider DONE; raw parsing matches the probe's recorded calls and counts. Both report zero cached prompt tokens. No returned tool executes, no code is written and no full-task grading is performed for these replays.

The unchanged request acting quickly is strong counterevidence to a deterministic “bad schema prevents every tool call” explanation. The slower revised sample is not evidence that the corrections hurt performance either: one sequential sample per condition, different provider latency and stochastic generation do not support a ranking. The V14/V16 traces also show that initial inspection can succeed while implementation planning later stalls. The next useful causal comparison should freeze the post-inspection decision and isolate tool presentation or system guidance there, rather than equating a first inspection call with coding progress.

## Validation and evidence

- 20 regression tests pass across output recall, task progress, tool ordering and desktop runtime hardening. The six output-recall tests are rerun after adding checks that advertised id/cap constraints match an instance with an eight-character limit.
- Output-recall and task-progress TypeScript checks pass.
- Harness TypeScript checking is blocked by three errors in unchanged `src/shell/session.ts`: missing `buildDockerSessionSpawnSpecV1` export, unused `initialCwd`, and an optional number passed to a required-number parameter. None points to the schema files changed here; they are not silently fixed in this investigation.
- Future live-probe source snapshots now include base definitions, output recall and task-progress definitions, alongside existing execution code.

Ignored local evidence:

- `.runs/2026-09-08-v18-schema-input/`: production-derived request, derivation, source snapshots and independent schema/argument checks.
- `.runs/2026-09-08-v18-schema-decision-max/`: revised full response and independent stream checks.
- `.runs/2026-09-08-v18-schema-original-max/`: unchanged full response and independent stream checks.

```powershell
bun run benchmarks/desktop-harness-ab/tool-schema-input.ts <V17-request-1.json> <fresh-input-directory>
bun run benchmarks/desktop-harness-ab/thinking-decision-probe.ts <input-directory>/request.json <fresh-revised-run> --extended-max
bun run benchmarks/desktop-harness-ab/thinking-decision-probe.ts <V17-request-1.json> <fresh-original-run> --extended-max
python benchmarks/desktop-harness-ab/verify-thinking-decision.py <revised-run>
python benchmarks/desktop-harness-ab/verify-thinking-decision.py <original-run>
python benchmarks/desktop-harness-ab/verify-tool-schema.py <V17-request-1.json> <input-directory> <V12-high-run> <revised-run> <original-run>
```
