# Paw (TypeScript)

Bun monorepo for a **local-first coding agent**: CLI + TUI, tool harness, context compression, and unified memory retrieval. Spec: `架构设计v2`.

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
| `packages/core` | Session store, context manager, memory, run events |
| `packages/agent` | `AgentOrchestrator`, compression & sub-agents |
| `packages/harness` | Tool registry, MCP, shell guard |
| `packages/workspace` | File/git/LSP tools |
| `packages/models` | OpenAI / Anthropic / Ollama adapters |
| `packages/cli-core` | Run operations shared by CLI & TUI |
| `apps/cli`, `apps/tui` | Entry points |

Turn loop (simplified): **compress context → retrieve memory → model → parse action → run tools → persist state**.

## Development

```bash
bun run lint          # Biome (0 errors required for CI)
bun run typecheck     # tsc --noEmit on all workspaces
bun run test:ts       # unit tests (packages + apps)
bun run check:ts      # lint + typecheck + test:ts (CI gate)
```

GitHub Actions runs `bun run check:ts` on push/PR (see `.github/workflows/ci.yml`).

### Optional: Ollama E2E

Local integration test against a running Ollama instance:

```bash
RUN_OLLAMA_E2E=1 bun test packages/cli-core/test/e2e-ollama.test.ts
```

Without `RUN_OLLAMA_E2E=1`, the test is **skipped** (default in CI).

## Agent tools (harness)

Runs use `AgentOrchestrator` with a system message that includes `toolCatalogText()` and the workspace root. The model emits **one JSON object per line** for tools or structured actions.

| Tool | Purpose | Default approval |
|------|---------|------------------|
| `workspace.read_file` | Read UTF-8 file | No |
| `workspace.list_dir` | List directory | No |
| `workspace.search` | Search under workspace | No |
| `workspace.write_file` | Write/overwrite file | Yes |
| `workspace.run_shell` | Shell command (guarded) | Yes |

Example:

```json
{"tool":"workspace.run_shell","args":{"command":"npm test","cwd":".","timeout_sec":120}}
```

Shell commands pass a guard (blocks subshells, leading `rm`/`sudo`, known destructive patterns).

## Feature status (honest)

| Feature | Status |
|---------|--------|
| Context compression (prune → compact → summarize) | Wired in orchestrator |
| Keyword memory retrieval | Wired at run start |
| Parallel tool execution | Wired |
| Sub-agent launcher | Wired |
| **Memory extraction** (`extractMemories`) | **Wired after successful runs** (background; `memoryExtraction: "await"` in tests) |

## Docs

- 非代码文档索引：[`文档/README.md`](文档/README.md)
- Engineering plan: [`文档/工程/INTERVIEW_READINESS_PLAN.md`](文档/工程/INTERVIEW_READINESS_PLAN.md)
- Benchmark samples: [`文档/工程/BENCHMARK_RESULTS.md`](文档/工程/BENCHMARK_RESULTS.md)
- Architecture (repo): [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Benchmarks

```bash
bun run benchmark:compression   # L1/L2 trigger on synthetic tool-heavy context
bun run benchmark:memory        # recall@5 / MRR on golden retrieval set
bun run analyze:memory          # analyze live session memory.retrieve.done logs
```
