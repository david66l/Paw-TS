# Phase 2：记忆质量（细任务）

> 执行方式：Grok 定任务 → Claude Code 实现 → Grok 验收  
> 原则：复用 MemoryRuntime + Postgres + Governance；不新写系统；不做 evolution / 工具审批 / 换存储

## 0. 目标与非目标

### 目标

1. **少写垃圾**：默认少产生空洞 `task_summary`；工具跑完 ≠ 一定写长期记忆  
2. **显式记住可写**：用户说「记住以后用 X」→ 可靠进 L2  
3. **检索更干净**：topK + 类型配额 + minScore；偏好优先  
4. **可选 extract 钩子**：completeTask 可注入候选 enricher（默认不强制调 LLM）

### 非目标

- Self-Evolving / 新表 / file 双写  
- 桌面 UI 大改  
- 强制每次 complete 都调 LLM（成本）  
- 工具审批  

### 验收总闸

```bash
bun test packages/memory/test/memory-quality.test.ts
bun test packages/memory/test/runtime.e2e.test.ts   # 需 DATABASE_URL
bun run --filter @paw/memory typecheck
bun run --filter @paw/agent typecheck
# 可选：bun apps/desktop/scripts/cdp-complex-scenarios.mjs
```

---

## Task 2.1 — Writer：默认少写 task_summary（P0）

**负责人：Claude Code**  
**范围仅限：**

- `packages/memory/src/db/modules/write/memoryWriter.ts`
- `packages/memory/src/shared/memory-quality.ts`（可扩展辅助函数）
- `packages/memory/test/memory-quality.test.ts`
- 如需：`packages/memory/test/` 下新增 `memory-writer-quality.test.ts`（可 mock-free 单测纯函数）

### 行为

1. **`buildTaskSummary` 更严**  
   - 仅当满足任一：  
     - `modifiedFiles.length > 0` 或 `diffSummary.filesChanged > 0`  
     - 存在 failure 工具  
     - `completedSteps` 中有决策信号（非 system finalize）且总长度/信息量足够  
     - **不要**仅因「有 read 工具 + 长 goal」就写 summary  
2. **`buildProjectKnowledgeCandidates` 更严**  
   - 禁止只写「Modified N files: …」这种无语义条目  
   - 仅当有可复述的 assertion 时再写（本任务可先：**直接 return []** 关掉弱 knowledge，或要求 files + durable goal）  
3. **保持** `buildPreferenceFromGoal` + durable 过滤（已有 ephemeral 规则）  
4. **`isWorthWritingLongTermMemory`** 与 Writer 一致：纯读文件会话默认 `false`，除非 durable preference  

### 验收

- 单测：  
  - 只有 read 工具 + 普通 goal → `isWorthWriting` false 或 writer 不产出 task_summary  
  - durable「记住以后用 vitest」→ 仍 worth / 有 preference  
  - 有 modifiedFiles → 可写  
- 现有 `runtime.e2e` 仍绿（e2e 有 write + fail 工具，应仍写得出）  
- typecheck 绿  

### 禁止

- 改 evolution / migrations / desktop  
- 删除 Governance  

---

## Task 2.2 — 显式「记住」快写（P0）

**负责人：Claude Code**  
**范围：**

- `packages/memory/src/shared/memory-quality.ts`  
  - 新增 `extractExplicitRememberText(goal: string): string | null`  
  - 匹配：`记住[：:]?...` / `remember that...` / `以后都用...` 等  
  - 若命中 ephemeral（暗号等）→ null  
- `packages/memory/src/runtime/memory-runtime.ts`  
  - 新增可选方法或在 `completeTask` / 独立 API：  
    `async rememberExplicit?(text: string): Promise<SaveMemoryResult>`  
    **实现优先：增强现有 `saveMemory`，由 agent 调用**  
- `packages/agent/src/orchestrator.ts`（或 complete 前）  
  - 当 `!deferMemoryComplete` 且 goal 含显式记住 → `runtime.saveMemory({ type: user_preference, title, summary })`  
  - 桌面多轮：在 **finalize** 时若 finalMessage/goal 历史里有显式记住也可（可选，本任务至少 CLI 单 run 路径）

更稳方案（推荐实现）：

1. 在 `completeTask` 的 Writer 之前：若 `extractExplicitRememberText(wm.goal)` 有值，先 `saveMemory` 一条 preference（经 governance）  
2. 或 Writer 的 `buildPreferenceFromGoal` 只接受 `extractExplicitRememberText` 结果  

### 验收

- 单测 extractExplicitRememberText  
- 「记住以后单测用 vitest」→ 可产出 preference  
- 「记住暗号词蓝鲸」→ null / 不写  
- typecheck 绿  

### 禁止

- 绕过 Governance 直插 memory_items  

---

## Task 3 — Retriever：topK + 类型配额（P1）

**负责人：Claude Code**  
**范围：**

- `packages/memory/src/db/modules/read/memoryRetriever.ts`  
- `packages/memory/src/db/modules/platform/policyEngine.ts`（defaults 可调）  
- 单测：可对 `keywordScore` / 新纯函数配额逻辑单测；e2e 不破坏  

### 行为

1. 默认 `topK` 改为 **6**（或保持 8 但注入前裁）  
2. 类型配额（选中结果上）：  
   - `user_preference` ≤ 3  
   - `decision` ≤ 2  
   - `failure` ≤ 2  
   - `task_summary` ≤ 1  
   - 其余填满 topK  
3. 同 type 按 score 排序；总列表仍按 score  
4. **task_summary** 分数额外 ×0.85（降权）可选  

### 验收

- 单测：给定假 scored 列表，配额函数输出符合上限  
- runtime e2e 二次 retrieve 仍可能命中（query 含 redis 等）  
- typecheck 绿  

### 禁止

- 换 embedding 模型大工程（可另开 Task 3b）  

---

## Task 4 — completeTask 可选 enricher 接口（P1，默认 noop）

**负责人：Claude Code**  
**范围：**

- `packages/memory/src/runtime/types.ts`  
- `packages/memory/src/runtime/memory-runtime.ts`  
- `packages/memory/src/index.ts` 导出类型  
- 单测：注入 fake enricher 多一条 candidate 进治理  

### 行为

```ts
// MemoryRuntimeOptions
readonly candidateEnricher?: (input: {
  taskId: string;
  workingMemory: /* minimal */;
  goal: string;
}) => Promise<readonly {
  title: string;
  summary: string;
  type: "user_preference" | "decision" | "failure" | "project_knowledge";
  confidence?: number;
}[]>;
```

- `completeTask` 在 `writeFromFinalSnapshot` **之后或合并**，把 enricher 结果转成 draft candidates 再 `promoteCandidates`  
- enricher 抛错 → 忽略，不影响主 complete  
- **默认不传 enricher = 现状**  
- **本任务不接真实 LLM**（agent 接线可列为 Task 5，可选）

### 验收

- 单测/runtime 测试 mock enricher  
- 无 enricher 时 e2e 行为不变  
- typecheck 绿  

---

## Task 5（可选后续）— Agent 接线 LLM extract

**暂不自动开。** 等 2.1–2.4 验收后再定。  

---

## 执行顺序

```
2.1 Writer 少写 → 验收
2.2 显式记住 → 验收
2.3 Retriever 配额 → 验收
2.4 enricher 接口 → 验收
（2.5 可选 LLM）
```

每任务独立 commit 语义清晰；失败不阻塞回滚该任务。

## 执行记录（2026-07-10）

| Task | 状态 | 说明 |
|------|------|------|
| 2.1 | ✅ | Claude 提案因环境写权限未落盘；Grok 按方案落地验收 |
| 2.2 | ✅ | extractExplicitRememberText + Writer |
| 2.3 | ✅ | topK=6 + applyTypeQuotas + task_summary 降权 |
| 2.4 | ✅ | MemoryRuntimeOptions.candidateEnricher |
| 2.5 | ⏳ | 未做（agent LLM extract） |

验收：`memory-quality` 22 pass；`runtime.e2e` 6 pass；memory typecheck 绿。

---

## 给 Claude 的通用约束

1. 只改任务「范围」列出的文件；需要例外先说明  
2. 不改 `packages/memory/src/db/migrations`  
3. 不引入新依赖  
4. 保持中文/英文注释风格与现有文件一致  
5. 完成后列出改动文件 + 如何跑测试  
