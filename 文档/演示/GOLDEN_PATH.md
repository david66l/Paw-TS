# Golden Path Demo

5-minute walkthrough for reviewers or interviewers. Assumes Bun is installed.

## 1. Install and verify

```bash
cd paw-ts
bun install
bun run check:ts
```

Expected: lint + typecheck pass; **492+ tests pass**, Ollama E2E skipped.

## 2. CLI smoke test (fake model, no API key)

```bash
bun run cli -- run "list files in this directory" --workspace .
```

Uses `FakeLanguageModel` when no provider is configured. You should see tool calls and `run.completed`.

## 3. TUI (optional)

```bash
bun run tui
```

Type a short goal (e.g. `list files here`). Exit with Ctrl+C or the app quit command.

## 4. Benchmarks (quantitative talking points)

```bash
bun run benchmark:compression   # L1 prune ~90% token reduction on tool-heavy fixture
bun run benchmark:memory        # recall@5 on golden retrieval set
```

Sample numbers: [`文档/工程/BENCHMARK_RESULTS.md`](../工程/BENCHMARK_RESULTS.md).

## 5. Architecture narrative

- Repo summary: [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- Compression ADR: [`文档/架构决策/001-context-compression.md`](../架构决策/001-context-compression.md)
- Full plan: [`文档/工程/INTERVIEW_READINESS_PLAN.md`](../工程/INTERVIEW_READINESS_PLAN.md)

## 6. Optional: live model (Ollama)

```bash
# Terminal 1: ensure Ollama is running with a coder model
ollama pull qwen2.5-coder:14b

# Terminal 2: configure .paw/settings.local.json in your workspace, then:
RUN_OLLAMA_E2E=1 bun test packages/cli-core/test/e2e-ollama.test.ts
```

## 7. Memory extraction (post-run)

After a **completed** run with a configured `SubAgentLauncher`, the orchestrator background-extracts durable memories into `~/.paw/projects/{hash}/memory/`. Watch for `memory.extracted` in run events or inspect `MEMORY.md` in that directory.
