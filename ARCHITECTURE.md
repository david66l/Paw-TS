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
  → AutonomyProfile.apply (shell policy + approval bus)
  → MemoryRuntime.beginTask + buildContextSection
  → TaskLifecycle observe (Context Package + TaskState)
  → model stream
  → parse action (tool | final | ask_user | plan | abort | run_agent)
  → tool runner (unified approval; shell ask pre-approved)
      → ToolFailureRecovery / idle fuse
      → TaskState.update + onToolResult → WorkingMemory
  → VerificationGate (on final_answer if mutations)
  → CompletionPolicy → RunResult { status, outcome, evidence }
  → persist session + run events
  → finish → MemoryRuntime.completeTask (Writer → Governance → Store)
```

**Control plane (TaskLifecycle):** `packages/agent/src/lifecycle/` + `packages/agent/src/autonomy/`

| Module | Role |
|--------|------|
| AutonomyProfile | `interactive` / `supervised` / `headless` — approval + shell policy |
| CompletionPolicy | Honest `completed` / `incomplete` / `failed` + evidence |
| VerificationGate | Mutations require tests or `[skip_verify: …]` |
| ToolFailureRecovery | Error-code driven hints + idle fuse (hard-stop) |
| LifecycleBudget | maxSteps / timeout / childMaxSteps / idleFuseHardStopTrips |

## Context compression (three layers)

| Layer | Module | LLM? | Role |
|-------|--------|------|------|
| L1 Prune | `context/pruner.ts` | No | Cap/compact old tool outputs |
| L2 Compact | `context/compactor.ts` + `compression-agent.ts` | Yes | Summarize middle history |
| L3 Protect | `context/policy.ts` · `context/compactor.ts` · `agent/orchestrator.ts` · `system-prompt/trim.ts` | No | Priority + lifecycle eviction; head/tail/pinned bounds; constraint re-injection; system-prompt trim ladder |

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

- **Collaboration modes** (`createRunOrchestrator` / settings `agent_mode`):
  - `coding` (**default**): single long-run implementer; full TaskLifecycle loop (edit→test→fix); no roster / no spawn tools; budget 64 steps / 30min
  - `orchestrated`: 狸花 + agent roster (`run_agent` / `create_agent`)
- Multi-hour greenfield runs: outer loop in `benchmarks/longrun-harness/` (initializer + coding shifts + Playwright desktop E2E; not infinite `maxSteps`)
- Sub-agents via `SubAgentLauncher` (explore, compression, …) when orchestrated
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
