# Paw 记忆系统（Memory Runtime）

> 权威设计：`文档/记忆机制spec/`（v1）+ `文档/记忆机制spec-v2/`（v2 文献驱动重设计）  
> 工程替换方案：`plans/memory-full-cutover-plan.md`  
> 实现：`packages/memory/src/db/**` + `packages/memory/src/runtime/**` + `packages/memory/src/longterm/**`

## 两代 Runtime

| 后端 | 说明 |
|------|------|
| **v2**（**默认在线路径**） | `MemoryRuntimeV2`：PostgresMemoryStoreEngine + MemoryWritePipeline（五道关异步写入）+ TriggeredRetriever（T1–T4 事件触发检索） |
| **v1**（回滚路径） | `MemoryRuntimeImpl`：TaskSession / Governance / ContextBuilder；`PAW_MEMORY_RUNTIME=v1` 或 `runtime: "v1"` 显式启用 |
| **file** | **已从 Agent 在线路径移除**；仅 `migrate-legacy` 读取旧 MD |

**Cutover 进度：** Phase 0–5（删在线 file 路径）完成 + v2 接入主管线完成（2026-08-09）。无 Postgres 时 **degrade**（空记忆，worker 静默）。

## v2 在线路径（默认）

```
beginTask ──► opaque taskId + 进程内轨迹缓冲（goal/branch）
buildContextSection ──► T1 task_start 检索（≤500 tokens XML 注入段）
onToolResult ──► 轨迹跟踪 + 测试结果（verdict 门控）；失败且可行动 → T2 action_failed 检索注入 [Memory hint]
压缩后 ──► T3 post_compact 检索注入（复用 SessionMemory 提示去重）
completeTask ──► 入队 outbox（异步）：failed→试用通道 / 测试全过→固化 / 无测试→session_finalize 兜底（conf≤0.6）
```

- **LLM 接线**（`AgentOrchestrator` 选项 `memoryLlm: "agent"|"settings"|"off"`，默认 "agent"）：
  蒸馏/精排用主模型（fake 模型自动跳过），裁决用 settings.local.json 解析的强模型；缺失时降级
  （无蒸馏 → append-only 原文摘要；无裁决 → 直 ADD；无精排 → 召回直取 k 减半）
- **写入语义**：`completeTask` 只入队，`memory.extracted` 事件的 entries = 已入队事件数（异步固化）；失败教训先入 trial 池，同主题任务验证成功后转正为 `source=trial_graduated` 的正式 episodic
- **注入门控**：精排（或无精排时的启发式）给 applicable/reference；不适用则弱措辞「历史参考」，避免硬推旧经验
- **画像写入**：`admitProfile` 证据≥3 + 行为描述门槛；满 15 条时 EDIT 合并或按效用 REMOVE 腾位；janitor 强制 `enforceProfileCapacity`
- **存量迁移**：`paw-ts memory migrate-v1-to-v2 [--dry-run] [--repo <id>]`（type→kind 映射 + 重算 embedding，幂等）

## 使用默认 db（v2 同样适用）

### 1. Postgres

```bash
createdb paw_memory
export DATABASE_URL="postgresql:///paw_memory"
```

### 2. 迁移

```bash
bun run memory:migrate
```

### 3. 工作区配置（可选 scope）

`.paw/settings.local.json`：

```json
{
  "user_id": "local",
  "repository_id": "my-project",
  "workspace_id": "my-project"
}
```

```bash
export DATABASE_URL=postgresql:///paw_memory
```

### 4. 诊断

```bash
bun run cli -- doctor
# 或
bun run apps/cli/src/main.ts doctor
```

期望在 db 模式下看到：

```text
── memory ──
backend: db
postgres ping: ok
migrations: N applied, 0 pending
Memory backend db: ready
```

若有 pending migration，doctor 退出码为 1，并提示 `bun run memory:migrate`。

## 运行时行为（db，v1 回滚路径）

一次 Agent Run：

1. `beginTask` — 创建 TaskSession + WorkingMemory  
2. `buildContextSection` — Retriever + ContextBuilder → system prompt  
3. 每工具 `onToolResult` — 脱敏、ExecutionRecorder、更新 WM  
4. `completeTask` — Writer → Governance → Executor → `memory_items`  
5. 工具 `memory.list/read/save` 走 Runtime（save 经治理）

DB 不可达时：**不**回退写 file；Run 继续，记忆段为空（degraded）。

## 验证命令

```bash
# v2 Runtime 闭环 e2e
DATABASE_URL=postgresql:///paw_memory_test bun test packages/memory/test/runtime-v2.e2e.test.ts

# v2 Agent 接线
DATABASE_URL=postgresql:///paw_memory_test bun test packages/agent/test/memory-v2-cutover.test.ts

# v1 回滚路径
DATABASE_URL=postgresql:///paw_memory_test bun test packages/memory/test/runtime.e2e.test.ts
DATABASE_URL=postgresql:///paw_memory_test bun test packages/agent/test/memory-runtime-cutover.test.ts

# v2 引擎/管线/迁移
DATABASE_URL=postgresql:///paw_memory_test bun test packages/memory/test/longterm-store.test.ts
DATABASE_URL=postgresql:///paw_memory_test bun test packages/memory/test/write-pipeline.test.ts
DATABASE_URL=postgresql:///paw_memory_test bun test packages/memory/test/migrate-v1-to-v2.test.ts

# Runtime 闭环 e2e（v1）
DATABASE_URL=postgresql:///paw_memory_test bun run memory:test:runtime

# 模块级 db e2e
DATABASE_URL=postgresql:///paw_memory_test bun run memory:test:db

# MemoryAgentBench 四维验（内置 coding-mini；需真实 LLM）
DATABASE_URL=postgresql:///paw_memory_test bun run cli -- memory mab --builtin --provider <name> --json
# 官方 HF 全量（缓存目录 benchmarks/memory-agent-bench/hf-cache）
DATABASE_URL=postgresql:///paw_memory_test bun run packages/memory/scripts/run-mab-hf.ts
# 达标：meanΔ>0 且配对 wins>losses；SF 抑制率≥0.8（若跑了 current）

# SWE-Exp 配对（memory on/off → 最终测试是否通过；P1）
bun run apps/cli/src/main.ts eval swe-exp --mode fake --json
# deterministic 需 Postgres：seed 历史经验 → 召回打补丁 → node 测试
DATABASE_URL=postgresql:///paw_memory_test bun run apps/cli/src/main.ts eval swe-exp --mode deterministic --json
```

## 相关包

| 路径 | 职责 |
|------|------|
| `packages/memory/src/runtime/` | **MemoryRuntime** 门面（v1 + v2 两个实现，工厂按开关选择） |
| `packages/memory/src/longterm/` | **v2 长记忆管线**（写入五道关、触发式检索、存储引擎、生命周期、可观测、CLI、评测） |
| `packages/memory/src/db/` | Schema、DAO、治理与检索实现（v1 底座 + v2 复用表） |
| `packages/memory/src/shared/` | 查询清洗、共享类型、embedding cache |
| `packages/memory/src/session/` | L2 会话压缩记忆 |
| `packages/memory/src/project/` | 项目指令（PAW/CLAUDE） |
| `packages/memory/src/compat/` | 旧 MD 读写（仅迁移用） |
| `packages/agent/src/orchestrator.ts` | 在线路径走 MemoryRuntime（默认 v2） |
| `packages/harness` | `memory.*` 工具走 Runtime |

### `packages/memory/src` 目录（按职责拆分，避免单夹文件过多）

```
src/
  runtime/     门面、health、scope、legacy 迁移
  db/
    dao/       表访问
    migrations/
    modules/
      task/      任务会话、WorkingMemory、工具执行
      write/     Writer → Governance → Store
      read/      Retriever、ContextBuilder
      platform/  policy、embedding、id、outbox、index、obs
      security/  安全与审计
      evolution/ 自进化、评估、代码索引、admin
  shared/      memory-record / query / types
  session/     SessionMemory
  project/     ProjectMemory
  compat/      AutoMemory MD（迁移）
```

## 从旧 file 记忆导入（Phase 4）

将 `~/.paw/projects/{hash}/memory/*.md`（AutoMemory）导入 Postgres，**幂等**：

```bash
export DATABASE_URL=postgresql:///paw_memory
bun run memory:migrate          # schema
bun run memory:migrate-legacy -- --root /path/to/workspace
# 预览不写库：
bun run memory:migrate-legacy -- --root . --dry
```

- `subjectKey` = `legacy:file:{name}`，重跑会 skip 已导入条目  
- 源 MD **不删除**，可人工核对  
- 低风险条目经 Governance 自动 promote；failure 等可能 pending review  

## CI

- `check` job：`check:ts` + `scripts/check-memory-cutover.sh`  
- `memory-db` job：Postgres (pgvector) + migrate + runtime/health/legacy/agent cutover 测试  

## 代码清理说明

已删除 Agent/Harness **在线**旧路径（FileProvider 检索/提取/写入）。

仍保留在 `packages/memory` 中的遗留代码（**非在线主路径**）：

| 模块 | 用途 |
|------|------|
| `auto-memory.ts` | `migrate-legacy` 读旧 MD |
| `session-memory.ts` | L2 上下文压缩会话摘要 |
| `project-memory.ts` | PAW.md / CLAUDE 项目指令 |
| `memory-record.ts` 等 | `extractCleanMemoryQuery` 与类型 |

在线唯一入口：`createMemoryRuntime` / `@paw/memory` Runtime。
