# Paw-TS Architecture (summary)

Full narrative diagrams live in internal/Obsidian notes. This file is the **repo-local** overview for reviewers and interviewers.

## Stack

- **Runtime**: Bun + TypeScript monorepo (`packages/*`, `apps/*`)
- **Apps**: `apps/cli` (headless), `apps/tui` (terminal UI)
- **Agent core**: `packages/agent` — `AgentOrchestrator` ReAct loop
- **Platform**: `packages/core` (sessions, context, memory, events), `packages/harness` (tools, MCP, shell guard), `packages/workspace` (file/git tools), `packages/models` (LLM adapters)

## Turn loop

```
User goal
  → memory.retrieve (keyword or hybrid)
  → context check (prune → compact if over threshold)
  → model stream
  → parse action (tool | final | ask_user | plan | abort | run_agent)
  → tool runner (parallel execute, sequential approval, checkpoint)
  → persist session + run events
  → loop or finish
```

## Context compression (three layers)

| Layer | Module | LLM? | Role |
|-------|--------|------|------|
| L1 Prune | `context-pruner.ts` | No | Cap/compact old tool outputs |
| L2 Compact | `context-compactor.ts` + `compression-agent.ts` | Yes | Summarize middle history, keep head/tail |
| L3 Protect | `context-manager.ts` | No | System prompt, recent turns, injected memory |

See ADR: [`文档/架构决策/001-context-compression.md`](文档/架构决策/001-context-compression.md).

## Memory

- **Retrieval**: default `KeywordMemoryRetriever`; optional **hybrid** (`memory_retrieval: "hybrid"` + Ollama `embedding_model`) via `HybridMemoryRetriever`
- **Stores**: project memory under `~/.paw/projects/{hash}/memory/`; rules in `.paw/CLAUDE.md`
- **Extraction**: `extractMemories()` after **completed** runs when `subAgentLauncher` is set (`memoryExtraction`: `background` | `await` | `off`)

## Multi-agent

- Sub-agents via `SubAgentLauncher` (explore, compression, memory extraction)
- Parent receives summarized result; child events folded into parent run log

## Security / harness

- Tool approval hooks (`resolveToolApproval`)
- Shell guard blocks destructive patterns
- Path guard on workspace tools

## Verification

```bash
bun run check:ts              # CI gate
bun run benchmark:compression
bun run benchmark:memory
```

## Related docs

- [`文档/工程/INTERVIEW_READINESS_PLAN.md`](文档/工程/INTERVIEW_READINESS_PLAN.md)
- [`文档/工程/BENCHMARK_RESULTS.md`](文档/工程/BENCHMARK_RESULTS.md)
- [`文档/架构/ARCHITECTURE_AND_FEATURES_PLAN.md`](文档/架构/ARCHITECTURE_AND_FEATURES_PLAN.md) — long-form gap analysis
