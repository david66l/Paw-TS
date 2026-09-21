# V19: what the model receives at each desktop execution stage

2026-09-08. Read-only analysis of captured requests and current source. No paid model calls, generated-code execution or production context changes in this investigation.

**The clearest context weakness is an insufficiently explicit current working state before and during implementation.** The new loop preserves the transcript and adds threshold-based advice, but the ordinary main-model request does not consistently present a compact, current account of established facts, changed files, remaining obligations and the next useful action. This is a concrete design gap compared with the legacy renderer, not proof that it alone causes GLM max's long reasoning.

## Evidence and scope

- V17 max: the first request stalls for six minutes; no tools execute.
- V14 max: preliminary inspection succeeds; request 3 stalls before implementation.
- V12 high: the same queue task completes, exposing implementation, testing and completion-review contexts. Its 24 original tools match the V17 definitions. Relevant context, prompt, progress-advice, composition and completion-review files present in its source-hash manifest still match current source. Execution timings are historical, not a fresh end-to-end run.
- V16 ZCode: inspect the native pre-implementation input to avoid assuming it has a phase summary that Paw lacks.
- The experiments explicitly use ordinary single-agent mode with memory and independent environment auditing disabled. Optional routing, memory and compaction behavior below is source analysis unless a captured request is identified.

`context-stage-audit.py` independently inventories every captured request by role, content category, repeated goal, advice placement, phase and provider usage. Character counts below use UTF-16 and exclude JSON envelope overhead unless noted. Input token counts are provider-reported, not derived from character counts. Local results are in `.runs/2026-09-08-v19-context-stage-audit/audit.json`.

## 0. Optional desktop task arrangement

When the desktop has not explicitly selected a mode, `apps/desktop/agent-host/task-arrangement.ts` classifies a goal into standard/long and whether visual auditing is needed. It sees routing instructions and at most 24,000 goal characters, with no tools. It selects an arrangement; it does not construct the ordinary executor's current implementation objective. Long mode adds its own manager guidance in `paw-next.ts`; that separate multi-stage path was bypassed in these single-agent tests.

Do not mistake the lack of a phase summary in the standard benchmark for proof that the desktop has no long-task mode. Conversely, selecting standard does not make the model's multi-file coding work automatically incremental.

## 1. Initial main request

`apps/desktop/agent-host/paw-next-profile.ts:79` composes static agent identity, coding guidance, workspace/shell context, bounded project rules and a skill catalog if present. The user goal is a separate message; the tool registry is sent separately.

V17 contains exactly:

- One system message, 1,327 characters.
- One user goal, 2,639 characters.
- 24 tool definitions, 10,982 serialized characters.
- No historical reasoning, tool results, progress advice or task checkpoint.

V14/V12 report about 3,810 input tokens for this normalized initial request; V17 itself has no final usage. The model has a declared one-million-token window. Initial stalling therefore does not require a large history, a memory-retrieval failure or a context-window overflow. The generic guidance already says to inspect and take a small verifiable step. Its presence does not prove the model follows it.

The model has all the final requirements but no separately represented immediate objective or current evidence state. That is a useful intervention point, though the V18 unchanged request also started tools quickly, so this input is not deterministically broken.

## 2. After inspection, before the first implementation write

V14 request 3 has eight messages. In addition to the unchanged system and goal it includes 67 historical reasoning characters, 78 tool-argument characters and 3,611 tool-result characters. The user goal occurs twice: once as the task and once inside the content read from `REQUIREMENTS.md`.

This duplication follows from the benchmark fixture copying the task into a file; it is not evidence that every production task is automatically duplicated. Reading that file delivers the original requirements correctly, but does not itself transform them into a current work plan.

There is no host advice at this point. `packages/progress-advisor/src/projector.ts` only emits inspection-gap advice after four settled model turns without meaningful progress; the third request follows two settled turns. `packages/agent-loop/src/agent-loop.ts:224` builds context between model calls. A timer cannot insert new context into a request already streaming reasoning. Thus this control does not intervene when the model stalls in request 1 or request 3.

This is the highest-priority gap to test: the transition from “requirements observed” to “implement a bounded part.” A factual state view can say which files were read and whether anything has been changed or tested, without falsely declaring that all necessary inspection is complete.

## 3. Implementation

The main path in `packages/runtime/src/context/journal-context.ts` projects journal input/model/tool units in order, preserves native tool exchanges and reasoning passback, and applies optional checkpoints and annotations. The history is evidence-complete, but a growing history is not equivalent to a current working-state summary.

In V12 high request 4, after the first write, the model receives 7,760 historical reasoning characters, 7,850 tool-argument characters and 6,394 tool-result characters. The code sent in earlier write calls, the corresponding write reports and earlier design reasoning remain in later inputs. This can require the model to reconstruct which revision and decision is current; it does not establish attention failure or justify blindly deleting these records.

The first verification reminder appears in request 6, after four mutation turns. It correctly asks for a relevant check before expanding further. This mechanism is useful but reactive: it does not supply an immediate objective on every iteration, and it cannot act during a single unfinished model response.

## 4. Test execution and repair

V12 request 10 includes an additional `verification_repair` message after a test command produced no trustworthy pass/fail outcome. Its advice is concrete: simplify to a direct command, preserve the test runner's exit status, and avoid trying different display filters. The actual error/output remains available in native tool results. This stage has substantially better guidance than the pre-write stage.

The advice is inserted after its historical source unit. In request 15 the original verification-due reminder has 23 messages after it and the repair reminder has 13. In request 22 they have 40 and 30 messages after them. Both are explicitly marked as historical and potentially superseded; they are not secretly treated as fresh facts. The runtime preserves their positions for transcript/prefix stability, and fallback content is used when an anchor is omitted.

That prevents stale advice from silently becoming current authority, but still leaves the model to infer today's status from later logs. A small current verification view should identify the latest relevant command, outcome, mutation revision and unresolved failure, while retaining the underlying evidence for detail. This is preferable to appending every old warning again at the end.

## 5. Main-model closeout and independent review

At request 22 the successful high sample has 55 messages:

| Input category | Characters |
| --- | ---: |
| Static system | 1,327 |
| Original user goal | 2,639 |
| Host advice | 1,671 |
| Visible assistant text | 2,030 |
| Historical reasoning | 29,950 |
| Historical tool arguments | 60,338 |
| Tool results | 62,081 |
| Total content, excluding envelope and tool definitions | 160,036 |

The provider reports 46,101 input tokens, including 45,696 cached prompt tokens. This is not 46,101 newly billed uncached tokens. It is well below the declared window; the concern is how clearly the current state is expressed, not input overflow. No legacy `[Current State]` block or semantic task checkpoint appears in these requests.

After the assistant proposes completion, request 23 changes to a dedicated review context: two messages, no tools or historical reasoning, a 2,310-character reviewer system and a 21,091-character evidence packet. The packet contains the original goal, proposed answer, source revision, eight recent bounded observations and current verification by target. Its recognized `npm test` evidence is passed and current. Input usage is 6,226 tokens.

`packages/completion-review/src/evidence-packet.ts` is a stronger example of purpose-specific context assembly: it projects relevant facts for one decision. The main executor could benefit from the same idea earlier. However, the reviewer only runs after a completion proposal, so it cannot prevent pre-write overthinking. Eight observations and recognized verification are also bounded evidence, not an exhaustive semantic proof.

## 6. Compaction, continuation and optional memory

The existing checkpoint schema is already useful: goal, confirmed facts, hypotheses, ruled-out ideas, changed files, verification, unresolved work and next action, all with journal source references (`packages/context-compaction/src/checkpoint-distiller.ts:26`). It is not missing from the system.

The automatic trigger serves input-budget pressure: 80% of the soft input target, or fallback omission. With a one-million-token window and 128,000 output tokens reserved, that ordinary ratio threshold is approximately 697,000 estimated input tokens. These roughly 46,000-token contexts do not approach it. User-requested compaction is a separate path. None of the audited runs invoked a semantic compaction phase.

Consequently, the existence of a checkpoint with `nextAction` does not mean the model gets a current task summary during an ordinary medium-length run. A cheap working-state projection should be independent of whether expensive model-assisted compaction is warranted. Preserved provider reasoning must not be arbitrarily rewritten under the guise of this projection.

Desktop memory can add bounded retrieved evidence through `createToolDrivenMemoryContextV1`; it was disabled in these tests. Its absence cannot establish that enabled memory would help or hurt. Retrieval evidence and current task execution state solve different problems.

## Legacy comparison and proposed priority

The legacy path has a concrete reference implementation:

- `packages/agent/src/orchestrator.ts:3228` passes `formatTaskProgressForContext(taskSnap)` into host state, with a current objective when `nextStep` exists.
- `packages/agent/src/task-state.ts:842` renders `[Current State]`, including acceptance status, files read/changed, commands, tests, revision freshness, pinned facts and next step.
- `packages/agent/src/context-assembler.ts:443` adds the host state to the model view separately from the durable user conversation.

The new task-progress service in `composition.ts:2785` is a tool execution service, not an automatic equivalent of this host-state renderer. New logs, progress advice and budget-triggered checkpoints cover parts of that role but do not provide the same always-available current-state projection in the audited standard path.

This should be migrated as a bounded, pure projection of canonical journal facts, not as a second mutable TaskState or another agent. Suggested fields are current user objective, relevant observed files, actual mutations, latest verification and freshness, known blockers, remaining recorded obligations and the model's still-valid next step. Missing information should remain unknown; the host must not invent acceptance criteria or assert a stage is complete from tool names alone.

Keep a stable system prefix and native tool history, and update the compact host-state view when its supporting facts change. Do not force every small task through a planning button or add a model call to summarize every turn. An initial target such as 800–1,200 tokens would be an experimental design choice, not an already measured optimum.

The first controlled intervention should be at the frozen post-inspection request. Compare original context with one current-state projection under unchanged max and tools, measuring complete write calls and then full-task verification. Do not simultaneously remove tools, change effort, rewrite all instructions and lower the compaction threshold.

## Causality limits

ZCode's corresponding pre-write request also has the full task, tool results and earlier thinking, without an explicit current-state summary. It still spends 267 seconds on that response before advancing. Therefore the missing state view is not, by itself, a demonstrated explanation for the Paw/ZCode difference.

The evidence supports a concrete context-organization improvement and identifies the earliest control gap. It does not establish that one summary solves max, that all historical reasoning is harmful, or that the old runtime is empirically superior. The existing single-agent high success and variable first-call max behavior remain counterexamples to any deterministic failure claim.

Reproduce the read-only inventory:

```powershell
python benchmarks/desktop-harness-ab/context-stage-audit.py <fresh-audit-directory> <V17-run> <V14-run> <V12-high-run>
```
