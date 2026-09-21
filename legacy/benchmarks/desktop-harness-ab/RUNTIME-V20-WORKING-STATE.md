# V20: bounded current-state context for desktop V3

2026-09-08. Implements the first intervention proposed in V19. This is a model-context change, not a new UI panel or a second agent.

## Implementation

`apps/cli/src/paw-next/working-state.ts` projects the current work segment from canonical Journal facts. It renders successful file-read operations (which may be partial), actual/uncertain workspace changes, the latest recognized verification per target, and recent unsuccessful actions with source sequence references. It does not infer that inspection is sufficient, create acceptance criteria, select a next action, or treat a model's completion claim as fact. No tool-free initial request is changed.

The legacy references are `formatTaskProgressForContext` in `packages/agent/src/task-state.ts` and its host-state use in the legacy orchestrator/context assembler. This migration reuses their explicit state/freshness principle without copying a mutable legacy TaskState. The new runtime's existing workspace-effect semantics and completion-review evidence projector are reused.

The V3 composition supplies one optional tail annotation through the journal context planner. The planner exposes its already-loaded, exact canonical payload evidence to the pure projection: archived tool outputs are resolved through their existing verified occurrence bindings, with no second archive load or extra model request. The state participates in existing input-token accounting and can be omitted under budget pressure rather than displacing protected user/native tool history. It is not written into the durable conversation.

The serialized state has a 5,000-character ceiling, at most four entries in each displayed list, explicit omission counts and bounded data strings. This is a conservative initial engineering limit, not a measured optimal token count. Static system/tools and native tool exchanges remain unchanged. Replacing the tail state can reduce reuse around the changing suffix; retaining an unchanged system prompt does not guarantee an unchanged cache hit rate.

## Evidence semantics

- Successful write operations are not proof that a feature works. Unknown or partially failed mutations invalidate earlier verification freshness.
- Shell completion without an observed exit code remains indeterminate. Masked pipeline exit status is not promoted to a passing test.
- Verification freshness compares the check's start boundary with the last observed change/uncertainty settlement. Tests overlapping a mutation, including background tests started before an edit, cannot certify the new state.
- Verification describes only its recognized target and tracked workspace effects, not all requirements or unobserved external edits. Recent errors are historical evidence and may have been repaired already.
- Verification targets retain explicit cwd and command setup, so a passing `npm test` in another package cannot replace a failing target's record.
- A new work segment starts a new state projection. Prior work remains in canonical history/checkpoints, rather than silently becoming the new task's completion evidence.
- Existing compaction, provider reasoning passback, timeouts, tools and max effort are retained. Large-output masking and cross-window reset are separate future experiments.

V3 composition identity changes to `paw.product-composition.v3.27:journal-working-state`, including the working-state policy in its manifest. V1/V2 identities remain unchanged.

## Validation and controlled experiment

Regression checks cover the real desktop `runDesktopNext` path with deterministic model responses and real file tools, native history integrity, no additional main-model calls, archived evidence reuse, token accounting, segment isolation, bounded output and conservative verification freshness.

Final validation: **84 tests passed, 676 assertions, zero failures** across the working-state, V3 identity, request-guidance, desktop hardening and journal-context suites. CLI, Runtime and desktop typechecks pass. Targeted Biome checks have no errors (the repository's non-null-assertion style warnings remain); `git diff --check` passes for touched tracked code. Evidence and final source hashes are in `.runs/2026-09-08-v20-final-state-input/validation.json` and `regression.log`.

The real API decision experiment freezes V14 request 3 (after inspection). `working-state-input.ts` uses its canonical journal prefix and appends a 1,029-character state message; all original messages, 24 tool definitions, sampling, max effort and 128,000 output cap stay identical. This fixture contains only read/list/git-status calls and does not require tool-body materialization to derive its state. `verify-working-state.py` independently checks the intervention and source facts; `verify-thinking-decision.py` audits native history against original SSE and each returned response against raw SSE.

The decision probes do not execute returned tools and cannot establish full-task correctness. Both arms have finished:

| Condition, in execution order | Duration | Reasoning characters | Visible text | Tool calls | Final usage |
| --- | ---: | ---: | ---: | ---: | --- |
| Frozen request + current state | 360.014 s | 47,004 | 0 | 0 | Unknown |
| Frozen original request | 360.007 s | 48,346 | 0 | 0 | Unknown |

These are two censored single-request samples, not a repeated full-task evaluation. Neither reaches an action before the six-minute cap. They do not demonstrate an action-latency improvement, equivalent eventual behavior, or a token-cost saving. The code improves explicit evidence/freshness presentation, but **GLM max's pre-write stall remains unresolved**. This result weakens the specific hypothesis that a missing factual state view alone explains this stall; it does not rule out other context/model/harness interactions. The initial-request stall is unaffected by design because no state message is inserted before tool evidence exists.

Local raw evidence: `.runs/2026-09-08-v20-state-max` and `.runs/2026-09-08-v20-original-max`. Both independently pass original-request/history matching and raw SSE reconstruction. No returned code executed, no new full-task correctness result is claimed, and neither interrupted response reports terminal token usage. No model probe remains running.

The treatment ran first and stopped at its 360-second limit: 47,004 reasoning characters, no visible text and no tool calls. Raw SSE has no final usage or terminal DONE, so cost is unknown rather than zero. Its first two native assistant histories match the original streams byte-for-byte, including 67 reasoning characters. The final production projection reproduces the exact paid input (SHA-256 `39221d5c39d77d12d25f17f030fcc309a4f5397d7ec2692c2e98b6ed6f36bd42`) after later formatting and verification-scope/error-label tests; those later refinements do not affect this inspection-only input.

## Design references

- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): structured state and selective context, separate from window capacity.
- [LongHorizon-Harness](https://arxiv.org/html/2608.01964v1): explicit environment-grounded task state. Paw does not claim to reproduce the paper's multi-role architecture or results here.
- [Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): stable prefixes, recoverable external evidence and current objectives.
- [The Complexity Trap](https://arxiv.org/abs/2508.21433): evaluate inexpensive context management before assuming an LLM summary each turn is necessary.
