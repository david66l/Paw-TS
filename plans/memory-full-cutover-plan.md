# 新记忆机制完整替换旧记忆机制 — 实施总案

> 状态：**Cutover 完成（在线路径仅 db）**；legacy 模块仍可 import 供 migrate/测试  
> 日期：2026-07-09  
> 更新：2026-07-09 — Phase 5：orchestrator/harness 去掉 FileProvider 在线路径  
> 权威设计：`文档/记忆机制spec/`  
> 权威实现：`packages/memory/src/db/**`  
> 被替换实现：`packages/memory/src/*`（非 `db/`）+ agent/core/harness 中所有旧记忆接线

---

## 0. 一句话目标

**让 Agent 主路径只认新记忆系统（Postgres + TaskSession/WorkingMemory/Governance/Store/Retriever/ContextBuilder），旧 file 记忆链路从读写默认路径上彻底退出，并可在验证后删除。**

不是「再加一个 provider」，不是「双写长期并存」。

---

## 1. 成功标准（Done 定义）

全部满足才算替换完成：

| # | 标准 | 验证方式 |
|---|------|----------|
| S1 | 一次完整 Run：create Task → 检索 → 注入上下文 → 工具更新 WM → complete → 候选 → 治理 → 正式记忆 | agent + FakeModel e2e |
| S2 | 第二次 Run 能从 DB 召回第一次写入的 active 记忆 | e2e 跨 run |
| S3 | 任何正式记忆写入必经 Governance；禁止 agent/工具直写 `memory_items` | code review + 测试 |
| S4 | 进入模型 prompt 的记忆只经新 `ContextBuilder` | 断言 prompt 含其 rendered 结构，无旧 bullet 散装路径 |
| S5 | `memory.list/read/save` 只打新系统 | harness 单测 |
| S6 | 默认配置下无 `FileProvider` / `AutoMemoryStore` / `UnifiedMemoryStore` / 旧 `retrieveRoutedMemories` 调用 | `rg` 门禁 + 删除或移入 `legacy/` |
| S7 | `bun run typecheck` + `bun run test:ts` 绿；`packages/memory` db-e2e 绿 | CI |
| S8 | 无 Postgres 时有明确失败/降级策略（见 §7），不静默退回旧写路径 | 测试 |

**非目标（本方案不做）：**

- 不把记忆拆成独立微服务（HTTP API 仅保留为可选运维面，agent **进程内**调用）
- 不在本轮重做 Self-Evolving 产品化调度（模块保留，批任务可后置）
- 不保证旧 MD 100% 语义无损迁移（见 §8 迁移等级）
- 不重写上下文压缩 L1/L2（仍属 `@paw/core` ContextManager）

---

## 2. 设计原则

1. **单一权威源**：`memory_items`（Postgres）是长期记忆唯一权威；索引/缓存是派生。
2. **单一写入门**：正式变更只经 `MemoryGovernance` → `GovernanceExecutor` / `MemoryStore`。
3. **单一入 prompt 门**：记忆进入模型只经 `db/ContextBuilder`（可与 system prompt 其它段拼接，但记忆段不另开旁路）。
4. **状态所有权**：
   - TaskSession → `TaskSessionManager`
   - WorkingMemory → `WorkingMemoryManager`
   - MemoryItem → `MemoryStore` / GovernanceExecutor
   - 对话消息窗口 → 仍属 `ContextManager`（core），不迁入 memory 包
5. **Agent 只依赖一个门面**：`MemoryRuntime`，禁止 orchestrator 散调 10 个 db module。
6. **先接线、再删旧**：flag 默认新 → 验证 → 删旧代码；禁止长期双写双主。
7. **降级不等于回退旧写**：DB 不可用时允许跳过记忆读写并告警，**禁止**自动 `FileProvider` 写入。

---

## 3. 替换后目标架构

```text
                    apps/cli | apps/tui
                            │
                            ▼
                   AgentOrchestrator
                            │
              ┌─────────────▼─────────────┐
              │     MemoryRuntime          │  ← 唯一门面 @paw/memory
              │  (进程内，非 HTTP)          │
              └─────────────┬─────────────┘
        ┌───────────┬───────┼───────┬───────────┐
        ▼           ▼       ▼       ▼           ▼
 TaskSession   Working   Retriever  Context   Write pipeline
 Manager       Memory              Builder    Writer→Gov→Exec
        │           │       │       │           │
        └───────────┴───────┴───────┴───────────┘
                            │
                     Postgres (paw_memory)
```

**与对话上下文的边界：**

```text
MemoryRuntime.buildPromptSection()  →  记忆/任务相关字符串
ContextManager (core)               →  消息历史、prune/compact
system-prompt assembler             →  拼 system：环境 + 工具 + MemoryRuntime 段 + skills...
```

**旧组件退役映射：**

| 旧 | 新 | 处置 |
|----|----|------|
| `TaskStateManager` | `WorkingMemory` + TaskSession | 删除旧类，逻辑迁 WM 同步 |
| `FileProvider` / `AutoMemoryStore` | `MemoryStore` + items | 删除在线路径 |
| `SessionMemoryStore` | `task_summary` / WM snapshot / task_trace | 删除独立 session md 写路径 |
| `UnifiedMemoryStore` | Retriever scope 查询 | 删除 |
| `retrieveRoutedMemories` / 旧 router/scorer | `MemoryRetriever` | 删除在线路径 |
| `retrieveTurnMemories` | 可选：同 Retriever 限量 refresh | 删除旧实现 |
| agent `buildContextPackage` | `db/ContextBuilder` | 删除 agent 版记忆组装 |
| 旧 `createMemoryWriter` + extract 多通道 | `writeFromFinalSnapshot` + Governance 批处理 | 收敛为一条 |
| `resolveMemoryProvider` | `createMemoryRuntime` | 替换 |
| core re-export 整包 memory 旧 API | 仅保留非记忆工具（fs/path） | 拆循环依赖 |

---

## 4. 核心交付物：`MemoryRuntime` 门面

### 4.1 位置与导出

```text
packages/memory/src/runtime/
  memory-runtime.ts      # 门面实现
  scope.ts               # workspaceRoot → scope 映射
  types.ts               # Runtime 对外 DTO（给 agent 用的稳定类型）
  migrate-legacy.ts      # 可选：MD → DB
  index.ts

packages/memory/src/index.ts
  → 主导出改为 Runtime + 必要类型
  → 旧 API 暂挂 legacy 子路径或直接删除（按阶段）

packages/memory/package.json
  "./db" 保留底层
  "." 以 Runtime 为产品 API
```

### 4.2 对外接口（agent 只准用这些）

```typescript
// 概念签名 — 实现时以代码为准

interface MemoryRuntimeOptions {
  workspaceRoot: string;
  userId?: string;           // 默认 "local"
  repositoryId?: string;     // 默认 hash(workspaceRoot) 或 git remote
  workspaceId?: string;      // 默认同 repositoryId
}

interface MemoryRuntime {
  /** 健康检查；失败时 orchestrator 进入 no-memory 模式 */
  ping(): Promise<boolean>;

  /** Run 开始：创建并 start TaskSession，初始化 WM */
  beginTask(input: {
    runId: string;
    goal: string;
    title?: string;
    branch?: string;
    baseCommit?: string;
    resumeTaskId?: string;
  }): Promise<{ taskId: string }>;

  /** Run 初 / 按需：检索 + ContextBuilder → 可注入文本 */
  buildContextSection(input: {
    taskId: string;
    query: string;
    tokenBudget: number;
    currentUserRequest: string;
  }): Promise<{
    promptSection: string;
    items: readonly { id: string; title: string; score: number }[];
    degraded: boolean;
    tokens: number;
  }>;

  /** 工具执行后：规范化 + 更新 WM + 记 execution（幂等 key） */
  onToolResult(input: {
    taskId: string;
    toolName: string;
    args: unknown;
    ok: boolean;
    summary: string;
    rawPayload?: unknown;
    idempotencyKey: string;
  }): Promise<void>;

  /** 计划/约束/hypothesis 等结构化更新（替代 TaskStateManager 写口） */
  patchWorkingMemory(input: {
    taskId: string;
    patch: {
      goal?: string;
      plan?: string[];
      constraints?: string[];
      nextStep?: string;
      // ... 与 WorkingMemory 字段对齐的子集
    };
  }): Promise<void>;

  /** Run 正常结束：complete → Writer → Governance → Executor */
  completeTask(input: {
    taskId: string;
    finalMessage?: string;
    status: "completed" | "failed" | "cancelled";
  }): Promise<{
    candidates: number;
    approved: number;
    rejected: number;
    writtenMemoryIds: string[];
  }>;

  /** 工具 memory.list / read / save */
  listMemories(query?: { limit?: number; type?: string }): Promise<MemoryListItem[]>;
  readMemory(idOrSubject: string): Promise<MemoryListItem | null>;
  /** 用户显式保存：进 candidate + 治理，禁止直写 active（除 policy 允许的低风险自动批） */
  saveMemory(input: {
    title: string;
    summary: string;
    type?: string;
    content?: string;
  }): Promise<{ candidateId: string; decision: string }>;

  shutdown(): Promise<void>;
}
```

### 4.3 `completeTask` 内部固定流水线

与 spec 一致，**不得跳过**：

```text
1. WorkingMemory 最终快照（可附 finalMessage）
2. TaskSessionManager.completeTask / failTask
3. MemoryWriter.writeFromFinalSnapshot → memory_candidates
4. 对每个 candidate：MemoryGovernance.evaluate
5. 对 APPROVED：GovernanceExecutor.execute（或 MemoryStore.execute）
6. 写 audit / 发 outbox（已有则调用）
7. 返回统计供 RunEvent
```

**禁止**复用 `db/api.ts` 里「POST /memories 直写 memoryItemDao.create」的模式到 agent 路径。

### 4.4 Scope 映射规则（必须写死）

| 字段 | 默认规则 |
|------|----------|
| `userId` | settings `user_id` \|\| env `PAW_USER_ID` \|\| `"local"` |
| `repositoryId` | settings `repository_id` \|\| `git remote` hash \|\| `sha256(workspaceRoot).slice(0,16)` |
| `workspaceId` | settings `workspace_id` \|\| `repositoryId` |

写入 `.paw/settings.local.json` 可选覆盖。所有检索/写入必须带同一 scope，避免串库。

---

## 5. Orchestrator 接线改造（替换真正发生处）

### 5.1 `initializeRun`（替换记忆初始化块）

**删除：**

- `resolveMemoryProvider` / `FileProvider.initialize`
- `UnifiedMemoryStore` 构造
- `retrieveRoutedMemories` + 旧 embedding/HRR 查询拼装
- 旧 `memoryIndex` 塞 system prompt 的分片索引路径（由 ContextBuilder 接管）

**改为：**

```text
runtime = await createMemoryRuntime({ workspaceRoot })
ok = await runtime.ping()
if (!ok) → emit memory.degraded; runtime = null（只读空）

task = await runtime.beginTask({ runId, goal, branch, ... })
section = await runtime.buildContextSection({ taskId, query, tokenBudget, ... })
// section.promptSection → system prompt 记忆段 / 或首条 user 附加
emit memory.retrieve.done（字段对齐新结构）
```

`PhaseContext` 增加：`memoryRuntime` + `taskId`；删除 `MemoryProvider` 传递。

### 5.2 `executeTurn`

| 旧 | 新 |
|----|----|
| `TaskStateManager.recordToolResult` | `runtime.onToolResult` + 可选本地缓存镜像 |
| `retrieveTurnMemories` 周期性注入 | 策略二选一（本方案选 A）：**A.** 仅 run 初检索 + WM 热数据由 ContextBuilder 每轮 refresh；**B.** 每 N 轮再 `buildContextSection`。默认 **A**，简单且省 DB |
| `refreshContextPackage` 用旧 builder | 每轮若需刷新：用 WM 最新 + 缓存的 retrievalResult 调 ContextBuilder（不重复全库检索除非 goal 变） |
| `memoryProvider` 传入 tool-runner | 传 `MemoryRuntime` |

### 5.3 Run 结束

**删除多通道写：**

- `runMemoryExtractionAfterRun` / `extractMemories` 直写 FileProvider  
- `extractSessionHighlightsToAutoMemory`  
- `maybeGenerateShortSessionMemory` 写 SessionMemoryStore  
- `background-review` 写 AutoMemory（若有）

**改为单通道：**

```text
await runtime.completeTask({ taskId, status, finalMessage })
emit memory.write.done { candidates, approved, writtenMemoryIds }
```

**可选增强（P1，不阻塞替换）：**  
在 `writeFromFinalSnapshot` 之外，允许 **一个** LLM 辅助步骤：把对话摘要变成 **candidates 草稿**（仍必须进 Governance），替代旧 extractMemories。实现位置：`MemoryRuntime.completeTask` 内部钩子 `optionalLlmCandidateEnricher`，默认 off 或 background。

### 5.4 压缩路径

L1/L2 压缩 **不写长期记忆**。  
旧「compact 后 extractSessionHighlights → AutoMemory」**直接删除**。  
若需保留会话摘要价值：压缩摘要只进 **当前 Task 的 WorkingMemory.completedSteps / notes**，等 `completeTask` 统一生成 candidate。

### 5.5 子 Agent

子 Agent **默认不创建独立 TaskSession**（避免记忆碎片）：

- 子 Agent 结果汇总回父 → 父 `onToolResult` / `patchWorkingMemory`
- 若未来需要：子 Task `rootTaskId = parent.taskId`（schema 已支持），本轮不做

### 5.6 工具层 `packages/harness`

`execution.ts` 中 `memory.list/read/save`：

- 删除 `new AutoMemoryStore` / `new FileProvider` 分支
- `HarnessContext.memoryProvider` → `memoryRuntime: MemoryRuntime`
- list/read → Runtime  
- save → Runtime.saveMemory（治理后）

### 5.7 System prompt（`packages/core`）

- `system-prompt/sections/memory.ts`：改为接收 **已渲染的 `promptSection` 字符串**（由 Runtime 产出），core **不再** import 旧 MemoryRecord 检索类型拼 bullet
- 借此打破 `core → memory` 循环：core 只保留 `memoryDir` 等路径常量迁出或下沉到 `workspace-paths`；记忆类型从 core 公共 API 移除

---

## 6. 分阶段实施计划

### Phase 0 — 准备（0.5–1 天）

| 任务 | 产出 |
|------|------|
| Postgres 本地/CI：`DATABASE_URL`、migrate 脚本进文档与 CI | `.github/workflows` 或 devcontainer |
| 新增 `MemoryRuntime` 骨架 + 单测 mock | 可 ping / begin / complete 空转 |
| 设置项：`memory_backend: "db"`（唯一支持值可先只 db） | settings schema |
| 盘点并列表冻结旧 API（本文 §10） | 删除清单 |

**验收：** migrate 一键；Runtime 单元测试绿。

---

### Phase 1 — Runtime 闭环（2–3 天）

在 **不改 orchestrator** 的前提下，用 Runtime 包装已有 db modules：

1. `beginTask` → TaskSessionManager + start  
2. `buildContextSection` → Retriever + ContextBuilder  
3. `onToolResult` → ToolResultProcessor + WorkingMemoryManager + executionRecorder  
4. `completeTask` → Writer → Governance → Executor 全自动批  
5. list/read/save  

补齐缺口（实现时很可能遇到）：

- complete 后 **批量 evaluate + execute**（api.ts 目前只 write candidates，agent 路径必须自动 promote 低风险）
- revision 冲突重试（WM update）
- `saveMemory` 用户路径的 governance 策略（低风险 auto-approve）

**验收：** 扩展 `db-e2e` 或新建 `runtime.e2e.test.ts`：模拟假工具序列 → complete → 二次 retrieve 命中。

---

### Phase 2 — Orchestrator 接线（2–3 天）

| 改动文件 | 动作 |
|----------|------|
| `agent/orchestrator.ts` | initializeRun / executeTurn / complete 换 Runtime |
| `agent/orchestrator/types.ts` | PhaseContext 字段替换 |
| `agent/orchestrator/tool-runner.ts` | 传 Runtime；工具后 `onToolResult` |
| `agent/orchestrator/action-handlers.ts` | plan 更新 → `patchWorkingMemory` |
| `agent/task-state.ts` | **删除**或薄封装转调 Runtime（推荐删除） |
| `agent/context-builder.ts` | **删除** |
| `agent/resolve-memory-provider.ts` | **删除**，改 `createMemoryRuntime` |
| `agent/orchestrator/memory-extraction.ts` | **删除**在线调用 |
| `agent/orchestrator/session-summarizer.ts` | 去掉 AutoMemory 写；摘要仅进 WM |
| `agent/memory-extraction-agent.ts` | 移入 Runtime 可选 enricher 或删 |
| `agent/orchestrator-factory.ts` | 装配 Runtime 生命周期 |
| `harness/context.ts` + `execution.ts` | memory 工具换 Runtime |
| `core/system-prompt/*` | 记忆段改为注入字符串 |

Flag（仅切换窗口用）：

```json
{
  "memory_backend": "db"
}
```

**不允许** `"file"` 作为写入后端。若需紧急回滚：用 git revert / feature branch，不在代码里保留双写。

**验收：**

```bash
bun test packages/agent
# 关键：FakeLanguageModel read→write→final
# 断言：memory.retrieve.done、complete 后 DB 有 active item、无 .paw/memory 新写入
```

---

### Phase 3 — 事件、可观测、设置（1 天）

- RunEvent 对齐：`memory.retrieve.done` / `memory.write.done` / `memory.degraded` / `working_memory.updated`
- TUI 如依赖旧 selectedMemories 字段，适配新 DTO
- `paw doctor`：检查 DB 连通与 migration 版本
- README / ARCHITECTURE 更新记忆章节

---

### Phase 4 — 旧数据迁移（1–2 天，可并行）

见 §8。  
**验收：** 抽样仓库 migrate 后 list/retrieve 可见；幂等重跑不翻倍。

---

### Phase 5 — 删除旧代码（1–2 天）

按 §10 清单删除；测试迁移到 Runtime/db。  
拆 `core ↔ memory` 循环依赖。  
`rg` CI 门禁禁止再引入：

```text
FileProvider|AutoMemoryStore|UnifiedMemoryStore|retrieveRoutedMemories|SessionMemoryStore
```

**验收：** `test:ts` 全绿；包体积/依赖边清晰。

---

### Phase 6 — 硬化（后置，不阻塞「替换完成」）

- LLM candidate enricher（替代旧 extract 质量）
- Self-Evolving 定时任务
- 真 embedding 服务替换 n-gram
- HTTP API 与 Runtime 共用同一 app service 层（去掉 api 直写 items）

---

## 7. 可用性与降级

| 场景 | 行为 |
|------|------|
| DB 不可达 | `ping` 失败 → `memory.degraded`；Run **继续**；无检索无写入；工具 `memory.*` 返回明确错误 |
| migrate 未执行 | doctor 失败；Runtime beginTask 抛 `E_MEMORY_SCHEMA` |
| Governance 全拒 | complete 成功但 `writtenMemoryIds=[]`；不失败整个 Run |
| WM revision 冲突 | Runtime 内最多重试 3 次 load+patch；仍失败则记 audit，不炸 Run |
| 检索超时 | degraded 检索，ContextBuilder 仅 WM hot |

**明确禁止：** 降级到 FileProvider 写入。

---

## 8. 旧数据迁移

### 8.1 源

```text
.paw/ 或 ~/.paw/projects/{hash}/memory/
  *.md / MEMORY*.md
session memory 目录（若有）
```

### 8.2 策略

| 等级 | 做法 | 推荐 |
|------|------|------|
| L0 | 不迁移，clean break | 演示/新项目 |
| L1 | 每条 MD → 1 candidate → auto governance（低置信） | **默认推荐** |
| L2 | 映射 kind→MemoryType，尽量填 subjectKey/relatedFiles | 有余力 |

### 8.3 命令

```bash
bun run packages/memory/src/runtime/migrate-legacy.ts --root <workspace>
# 幂等：subjectKey = legacy:file:{relativePath} 或 content hash
```

### 8.4 不迁移

- 旧 embedding 缓存文件  
- 旧 session 压缩摘要（除非用户要 L2）

迁移完成后 **停止写入** 旧目录；可保留只读备份，不在代码读取。

---

## 9. 测试方案

### 9.1 保留并扩展

- `packages/memory/test/db-e2e.test.ts` — 模块级真理  
- 新增 `runtime.e2e.test.ts` — 门面级  
- 新增 `agent` 集成：`memory-cutover.e2e.test.ts`

### 9.2 必须覆盖的用例

1. begin → tool results → complete → 二次 run retrieve 命中  
2. failure candidate 未验证被拒  
3. 同 subjectKey 去重  
4. memory.save 工具走治理  
5. DB down 时 Run 不崩溃且不写 file  
6. 并发 WM patch revision  
7. 压缩路径 **不** 产生 file 记忆  

### 9.3 旧测试处置

| 旧测试 | 处置 |
|--------|------|
| file provider / auto-memory / session-memory / unified-store | 删除或改为 migrate 单测 |
| memory-router / retriever BM25 | 删除或仅留算法参考目录 `legacy/`（默认删） |
| agent orchestrator memory 相关 | 改断言 DB/Runtime 事件 |

### 9.4 CI

```yaml
services:
  postgres: ...
env:
  DATABASE_URL: postgres://...
steps:
  - bun run --filter @paw/memory migrate
  - bun run check:ts
```

---

## 10. 删除清单（Phase 5）

### 10.1 包 `packages/memory/src/`（非 db）

可删（在线路径）：

```text
auto-memory.ts
file-provider.ts
session-memory.ts
unified-memory-store.ts
memory-retrieve.ts
memory-retriever.ts
memory-router.ts
memory-turn-retrieve.ts
memory-retrieval-cascade.ts
memory-scorer.ts
memory-selector.ts
memory-writer.ts          # 旧 Writer，勿与 db/memoryWriter 混淆
memory-reflector.ts
memory-archive.ts
memory-contradict.ts
memory-hrr.ts
memory-profiles.ts
memory-query.ts
embedding-cache.ts        # 若完全改用 db embeddings
memory-provider.ts        # 旧接口
project-memory.ts         # 若规则改由 MemoryType.rule + PAW.md 分家：PAW.md 仍属 workspace
```

**保留考虑：**

- `project-memory.ts` / 加载 `PAW.md`：属 **项目指令**，不是长期记忆库；建议迁到 `@paw/workspace` 或 core system-prompt，**不要**再叫 memory store。

### 10.2 Agent

```text
resolve-memory-provider.ts
context-builder.ts              # 旧 Context Package
task-state.ts                   # 被 WM 替代
memory-extraction-agent.ts      # 或迁 runtime enricher
orchestrator/memory-extraction.ts
orchestrator/session-summarizer.ts 中 AutoMemory 写路径
```

### 10.3 Core / Harness

- `core/index.ts` 去掉整段 `@paw/memory` re-export  
- `system-prompt` 去 MemoryRecord 依赖  
- harness 去 AutoMemory/FileProvider 分支  

### 10.4 文档

- 更新 README 功能表、「Keyword memory」→ 新机制  
- `plans/memory-refactor-architecture-plan.md` 标注 **被本 cutover 取代**  
- ARCHITECTURE.md 记忆章节重写  

---

## 11. 关键文件变更矩阵（实施时对照）

| 区域 | 文件 | Phase |
|------|------|-------|
| 新建 | `memory/src/runtime/*` | 0–1 |
| 改 | `memory/src/index.ts`, `package.json` | 1 |
| 改 | `db/modules/*` 仅补 complete 批治理胶水 | 1 |
| 大改 | `agent/src/orchestrator.ts` | 2 |
| 改 | `agent/src/orchestrator/*.ts` | 2 |
| 删 | 见 §10.2 | 5 |
| 改 | `harness/src/registry/execution.ts`, `context.ts` | 2 |
| 改 | `core/src/system-prompt/**`, `index.ts` | 2–5 |
| 改 | `settings` schema | 0 |
| 改 | `apps/cli` doctor | 3 |
| 新建 | migrate-legacy + CI postgres | 0/4 |
| 测 | memory/agent e2e | 1–2 |

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| orchestrator 仍 2900 行，接线易漏旁路写 | 旧写残留 | Phase 2 后 `rg` 门禁 + 禁止 file 写集成测 |
| 两套 Writer/ContextBuilder 同名 | 改错文件 | Runtime 内只 import `@paw/memory/db` 路径；旧文件 Phase 5 删除 |
| 检索质量短期下降 | 体感变差 | Phase 6 enricher；迁移 L1 灌库；保留 PAW.md 进 hot |
| CI 无 Postgres | 假绿 | 强制 service |
| complete 不自动 governance | 记忆永不 active | Phase 1 硬性验收「二次 retrieve 命中」 |
| api.ts 直写 items | 旁路腐蚀 | Phase 6 修 API；agent 禁用 HTTP |
| 循环依赖拆包炸类型 | 编译失败 | 先断 core re-export，agent 直依赖 `@paw/memory` |

---

## 13. 回滚策略

1. **开发期：** feature branch `cutover/memory-db`；主分支不动  
2. **合并后严重问题：** `git revert` 整合并；DB 数据保留不删  
3. **不提供** runtime 热切换回 FileProvider（避免半状态）  
4. 旧 `.paw/memory` 备份保留 ≥ 1 个迭代，仅人工查阅  

---

## 14. 建议排期（单人全职约）

| Phase | 人天 |
|-------|------|
| 0 准备 | 1 |
| 1 Runtime | 2–3 |
| 2 Orchestrator + harness + prompt | 2–3 |
| 3 观测/doctor/文档 | 1 |
| 4 迁移脚本 | 1–2 |
| 5 删旧 + 解循环依赖 | 1–2 |
| **合计** | **约 8–12 人天** |

Phase 6 另计。

---

## 15. 执行顺序（开工检查单）

```text
[x] 0.1 CI/本地 Postgres + migrate（本地 paw_memory_test 已 migrate）
[x] 0.2 MemoryRuntime 骨架（packages/memory/src/runtime/*）
[x] 1.1 begin/buildContext/onTool/complete 全实现
[x] 1.2 complete 含治理执行；runtime.e2e 二次召回通过（6 pass）
[x] 2.1 orchestrator initializeRun 换 Runtime（memory_backend=db）
[x] 2.2 tool-runner / action-handlers onToolResult + plan → WM
[x] 2.3 db 模式关掉 extract/session/highlight 写 file；complete 走 completeTask
[x] 2.4 harness memory.* 优先 Runtime
[x] 2.5 system-prompt memoryContextSection 注入
[x] 2.6 agent 测试绿 + memory-runtime-cutover.test.ts
[x] 3.x doctor（DB ping + migrations）+ docs/MEMORY.md + README/ARCHITECTURE
[x] 3.y 默认仍 file；启用方式文档化
[x] 4.x migrate-legacy（幂等 L1 + 测试 + CLI）
[x] 5.0 CI memory-db job（pgvector）+ check-memory-cutover.sh
[x] 5.0b 默认翻 db
[x] 5.1 删在线 file 路径（orchestrator/harness）+ 扩大门禁
[x] 5.2 删除旧 BM25/FileProvider/extract 模块与 agent 死代码；core 薄 re-export
[ ] 5.3（可选）进一步拆 core↔memory 循环依赖
[x] S1–S8 在线路径验收
```

---

## 16. 决策冻结（本方案默认值）

| 决策项 | 默认 |
|--------|------|
| 集成方式 | 进程内 Runtime，非 HTTP |
| 旧 file 后端 | 不保留双写；不提供 file 写入 fallback |
| 每轮检索 | 默认仅 run 初 + WM；goal 变化可再检索 |
| 子 Agent | 不独立 TaskSession |
| LLM 抽取 | 替换完成不依赖；P1 作 enricher |
| 旧 MD | L1 可选迁移 |
| PAW.md / 项目指令 | 保留为 workspace/prompt，不进 MemoryStore  unless 用户显式 save |

若需改默认，只改本节并同步 Phase 任务，避免口头分叉。

---

## 17. 与既有文档关系

| 文档 | 关系 |
|------|------|
| `文档/记忆机制spec/**` | **设计权威** — Runtime 行为不得违背铁律 |
| `plans/memory-refactor-architecture-plan.md` | 旧轨 P0–P8 收口记录；**被本 cutover 取代为在线权威** |
| `plans/memory-optimization-plan.md` | 旧 BM25 优化；**废弃** |
| 本文 | **替换工程的唯一执行总案** |

---

## 18. 下一步

本方案确认后，建议立即开工 **Phase 0 + Phase 1**（Runtime + e2e），在不动 TUI 的情况下证明「假工具轨迹 → 治理写入 → 召回」；通过后再进 Phase 2 改 orchestrator，避免在 2900 行文件里与未完成门面纠缠。
