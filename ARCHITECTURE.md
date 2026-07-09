# Paw-TS Architecture (summary)

Repo-local overview for reviewers and implementers.

## Stack

- **Runtime**: Bun + TypeScript monorepo (`packages/*`, `apps/*`)
- **Apps**: `apps/cli` (headless), `apps/tui` (OpenTUI + Solid)
- **Agent core**: `packages/agent` — `AgentOrchestrator` ReAct loop
- **Platform**:
  - `packages/core` — sessions, context compression, events, system prompt
  - `packages/memory` — MemoryRuntime + Postgres modules (and legacy file store)
  - `packages/harness` — tools, MCP, shell guard
  - `packages/workspace` — file / git / LSP / code-index
  - `packages/models` — LLM adapters
  - `packages/settings` — local config
  - `packages/store` — TaskPlanner

## Turn loop

```
User goal
  → MemoryRuntime.beginTask + buildContextSection
  → context check (prune → compact if over threshold)
  → model stream
  → parse action (tool | final | ask_user | plan | abort | run_agent)
  → tool runner + onToolResult → WorkingMemory
  → persist session + run events
  → finish → MemoryRuntime.completeTask (Writer → Governance → Store)
```

## Context compression (three layers)

| Layer | Module | LLM? | Role |
|-------|--------|------|------|
| L1 Prune | `context/pruner.ts` | No | Cap/compact old tool outputs |
| L2 Compact | `context/compactor.ts` + `compression-agent.ts` | Yes | Summarize middle history |
| L3 Protect | `context/manager.ts` | No | System prompt, recent turns, memory |

## Memory

Two backends (see [docs/MEMORY.md](docs/MEMORY.md)):

| Backend | Path |
|---------|------|
| **db** (only online) | `MemoryRuntime` → TaskSession / WM / Governance / Postgres |
| **legacy MD** | Offline import via `migrateLegacyMemories` |

Design authority: `文档/记忆机制spec/`.  
Engineering cutover: `plans/memory-full-cutover-plan.md`.

**db closed loop:**

```
beginTask → buildContextSection → onToolResult*
         → completeTask → candidates → governance → memory_items
```

**Doctor:** `bun run cli -- doctor` reports settings + memory backend (Postgres ping + migrations when `db`).

## Multi-agent

- Sub-agents via `SubAgentLauncher` (explore, compression, …)
- Parent receives summarized result; child events fold into parent log
- db mode: sub-agent summaries patch parent WorkingMemory (no separate TaskSession in MVP)

## Security / harness

- Tool approval hooks (`resolveToolApproval`)
- Shell guard / AST policy / optional Docker sandbox
- Path guard on workspace tools

## Verification

```bash
bun run check:ts
bun run memory:migrate
DATABASE_URL=postgresql:///paw_memory_test bun run memory:test:runtime
bun run cli -- doctor
```
