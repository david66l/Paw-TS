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

Paw Next 当前另提供显式、受控的 **V2 Fresh、Existing、catalog scanner 与隐藏一次性 CLI gate**：`paw-ts paw-next --startup-scan-v2 --root <absolute-workspace>` 只读取该 canonical workspace 的严格 V2 profile/settings，不尝试 V1、cwd/env、默认 provider 或 Fake fallback。File payload 的 Existing 在 repair 前后重建 exact-prefix evidence，scanner 对 terminal/pending 只读分类并重验完整 Session authority。Protocol、Agent Loop 与 Runtime 现已具备 canonical `work.segment_started`、唯一 reducer v2、不绑定产品的纯 planner + fenced expected-tail CAS 开段原语，以及 segment-aware Inbox/Context/final/checkpoint 消费语义。严格 Manifest/Profile V3、V1/V2/V3 exact catalog 身份与 V3 Fresh/Existing 受控运行骨架现已就绪。V3 另有显式 known-run new-work 程序入口：调用方必须指定 exact FIFO queue input，在一次 fenced scope 内完成全门、必要 repair、durable accept、原子 marker/promotion 与单段 Loop；同 ID 附件重试按 exact evidence 保持逻辑幂等，后续 backlog 不自动 drain。唯一 programmatic catalog scanner 现也能 exact 路由 V3：terminal/pending/no-marker continue 严格只读，只有 durable marker 活动段或 open lifecycle repair 可被 discovered 恢复；scanner 绝不自动 accept/start。Main 现新增两个独立隐藏 V3-only 一次性 gate：`--startup-scan-v3` 只恢复已有 durable 工作，`--new-work-v3` 用 exact known-run IDs + bounded strict stdin `{content}` 显式准入一段文本工作；两者报告都不含 workspace 路径或敏感 resolution，且互不共享 scanner/accept 能力。Runtime 现已完成 authority-referenced recovery snapshot v2；它只是 canonical prefix cache，恢复后仍校验全部原始 journal refs，不改变 head/inventory，也不声称已有性能收益。另新增显式离线 `--legacy-export-v1`：它只从调用方指定的 legacy runtime root 严格读取旧 Core JSONL + AppState，并以私有权限、不可覆盖方式导出 `paired_unbound` 原始证据；bundle 明确 `continuable:false`、不收集旁侧 artifact，也不生成或升级成 V3 journal。CLI attachment/file input、可续跑旧日志转换、真实网络 provider 烟测与断电 E2E 尚未完成。详见最新的 [`实施进度日志`](文档/记忆机制spec-v2/实施进度日志.md)。

## Docs

- Memory cutover / Runtime: [`docs/MEMORY.md`](docs/MEMORY.md)
- Architecture (repo): [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Spec: [`文档/记忆机制spec/`](文档/记忆机制spec/)

## Benchmarks

```bash
bun run benchmark          # all under benchmarks/
bun run benchmark:judge
```

SWE qualification runs can inject a trusted official instance-image shell
environment into Paw's normal Runtime. The isolated checkout is mounted at
`/testbed`; the container has no network, never pulls during an agent run, and
host model credentials are not copied into the checkout. See the newest entry
in `文档/记忆机制spec-v2/实施进度日志.md` for the frozen protocol and evidence.

### M2x source-grounded topic dossiers

The optional memory plugin now materializes revision-aware L2 topic dossiers without teaching Runtime about memory. Models may select only known memory and temporal-relation IDs; durable statements, timestamps, and evidence references are rebuilt deterministically from L1/L0. Small topics require no model call, while invalid large-topic proposals are repaired once and then replaced by a bounded deterministic fallback. `memory.read_topic` prefers the verified dossier and keeps legacy flat topic states as a compatibility fallback.

`memory.resolve_context` is now the primary read path. It compiles one complete query across L1, L2 dossiers, and exact L0 spans, returns explicit coverage plus a stop signal, and content-addresses the bounded packet. Lower-level tools are staged behind this result: sufficient coverage closes memory drill-down, while partial or missing coverage permits focused fallback reads. This remains entirely inside plugin composition and does not add memory semantics to Runtime.
