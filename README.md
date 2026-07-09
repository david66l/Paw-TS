# Paw (TypeScript)

Bun monorepo for a **local-first coding agent**: CLI + TUI, tool harness, context compression, and memory (file or Postgres Runtime).

```bash
cd paw-ts
bun install
bun run tui          # interactive terminal UI
bun run cli -- --help
```

Do not import Python code or depend on `../src/paw` from this tree.

## Monorepo layout

| Path | Role |
|------|------|
| `packages/core` | Session store, context manager, run events, system prompt |
| `packages/memory` | **MemoryRuntime** + Postgres modules + legacy file store |
| `packages/agent` | `AgentOrchestrator`, compression & sub-agents |
| `packages/harness` | Tool registry, MCP, shell guard |
| `packages/workspace` | File/git/LSP tools |
| `packages/models` | OpenAI / Anthropic / Ollama adapters |
| `packages/settings` | Local settings / credentials |
| `packages/store` | Task planner |
| `packages/eval` | Evaluation harness |
| `apps/cli`, `apps/tui` | Entry points |

Turn loop (simplified): **retrieve memory → compress context → model → parse action → run tools → persist → (db) completeTask / (file) extract**.

## Development

```bash
bun run lint          # Biome
bun run typecheck     # tsc --noEmit on all workspaces
bun run test:ts       # unit tests (packages + apps)
bun run check:ts      # lint + typecheck + test:ts (CI gate)
```

GitHub Actions runs `bun run check:ts` on push/PR (see `.github/workflows/ci.yml`).

### Optional: Ollama E2E

```bash
RUN_OLLAMA_E2E=1 bun test packages/agent/test/e2e-ollama.test.ts
```

Without `RUN_OLLAMA_E2E=1`, the test is **skipped** (default in CI).

## Memory

| Backend | Notes |
|---------|--------|
| **db** (only online path) | Postgres + Governance; needs `DATABASE_URL` + migrate |
| **legacy MD** | Import via `memory:migrate-legacy` only |

```bash
export DATABASE_URL=postgresql:///paw_memory
bun run memory:migrate
bun run cli -- doctor    # settings + Postgres ping + migrations
```

```bash
# 旧 MD → Postgres（幂等）
bun run memory:migrate-legacy -- --root .
```

Full guide: **[docs/MEMORY.md](docs/MEMORY.md)**  
Cutover plan: **[plans/memory-full-cutover-plan.md](plans/memory-full-cutover-plan.md)**  
Design spec: **`文档/记忆机制spec/`**

## Agent tools (harness)

| Tool | Purpose | Default approval |
|------|---------|------------------|
| `workspace.read_file` | Read UTF-8 file | No |
| `workspace.list_dir` | List directory | No |
| `workspace.search` | Search under workspace | No |
| `workspace.write_file` | Write/overwrite file | Yes |
| `workspace.run_shell` | Shell command (guarded) | Yes |
| `memory.list` / `read` / `save` | Memory tools | save may approve |

Example:

```json
{"tool":"workspace.run_shell","args":{"command":"npm test","cwd":".","timeout_sec":120}}
```

## Feature status (honest)

| Feature | Status |
|---------|--------|
| Context compression (prune → compact → summarize) | Wired |
| Memory **db** Runtime (TaskSession → Governance) | **Only online path** |
| Legacy MD import | `memory:migrate-legacy` |
| Parallel tool execution | Wired |
| Sub-agent launcher | Wired |

## Docs

- Memory cutover / Runtime: [`docs/MEMORY.md`](docs/MEMORY.md)
- Architecture (repo): [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Spec: [`文档/记忆机制spec/`](文档/记忆机制spec/)

## Benchmarks

```bash
bun run benchmark          # all under benchmarks/
bun run benchmark:judge
```
