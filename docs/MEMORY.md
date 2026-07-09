# Paw 记忆系统（Memory Runtime）

> 权威设计：`文档/记忆机制spec/`  
> 工程替换方案：`plans/memory-full-cutover-plan.md`  
> 实现：`packages/memory/src/db/**` + `packages/memory/src/runtime/**`

## 两套后端

| 后端 | 说明 |
|------|------|
| **db**（**唯一在线路径**） | Postgres + TaskSession / Governance / ContextBuilder |
| **file** | **已从 Agent 在线路径移除**；仅 `migrate-legacy` 读取旧 MD |

**Cutover 进度：** Phase 0–5（删在线 file 路径）完成。无 Postgres 时 **degrade**（空记忆）。

## 使用默认 db

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

## 运行时行为（db）

一次 Agent Run：

1. `beginTask` — 创建 TaskSession + WorkingMemory  
2. `buildContextSection` — Retriever + ContextBuilder → system prompt  
3. 每工具 `onToolResult` — 脱敏、ExecutionRecorder、更新 WM  
4. `completeTask` — Writer → Governance → Executor → `memory_items`  
5. 工具 `memory.list/read/save` 走 Runtime（save 经治理）

DB 不可达时：**不**回退写 file；Run 继续，记忆段为空（degraded）。

## 验证命令

```bash
# Runtime 闭环 e2e
DATABASE_URL=postgresql:///paw_memory_test bun run memory:test:runtime

# Agent 接线
DATABASE_URL=postgresql:///paw_memory_test bun test packages/agent/test/memory-runtime-cutover.test.ts

# 模块级 db e2e
DATABASE_URL=postgresql:///paw_memory_test bun run memory:test:db
```

## 相关包

| 路径 | 职责 |
|------|------|
| `packages/memory/src/runtime/` | **MemoryRuntime** 门面（agent 唯一推荐入口） |
| `packages/memory/src/db/` | Schema、DAO、治理与检索实现 |
| `packages/memory/src/shared/` | 查询清洗、共享类型、embedding cache |
| `packages/memory/src/session/` | L2 会话压缩记忆 |
| `packages/memory/src/project/` | 项目指令（PAW/CLAUDE） |
| `packages/memory/src/compat/` | 旧 MD 读写（仅迁移用） |
| `packages/agent/src/orchestrator.ts` | 在线路径走 MemoryRuntime（Postgres） |
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
