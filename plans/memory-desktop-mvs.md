# 记忆系统 × 桌面右栏 MVS（收敛方案）

> 状态：执行中 · Phase 1  
> 原则：复用 `MemoryRuntime` + Postgres；不新写；不换 file 主存；不做 evolution / 工具审批

## 1. 目标

| 右栏 | 目标效果 |
|------|----------|
| **Plan** | 子任务列表 + status 逐步 done（事件驱动，非 L2） |
| **Context** | 预算 + 本 run 相关文件/变更指针（工作集，非全量塞 prompt） |
| **Memory** | **本次命中列表** + **总库列表**（L2 Runtime） |

记忆做好 → **模型 prompt 变瘦**（topK 注入）；右栏 Context 可以展示更多指针。

## 2. 非目标（本轮不做）

- Self-Evolving / 新 MemoryType 平台
- 换 SQLite / 退回 file 权威存储
- 工具审批 UI
- LLM extract Writer 大改（Phase 2）
- 真 embedding 换模型（Phase 2）

## 3. 保留 / 改 / 停用

| 动作 | 内容 |
|------|------|
| **保留** | `MemoryRuntime`、Governance 写入、`memory_items`、桌面 defer/finalize、scope |
| **改** | retrieve 事件 payload、桌面 Memory/Context UI、list 接线、plan 事件可带 items |
| **停用（主路径不碰）** | evolution 在线、空转表叙事 |

## 4. 数据契约

### 4.1 `memory.retrieve.done`（已有，补全消费）

```ts
selectedMemories: {
  id, title, source, summary, relatedFiles,
  type?: string,   // 新增可选
  score?: number,  // 新增可选
}[]
```

### 4.2 Host：`memory.list`

```json
→ { "type": "memory.list", "requestId", "workspaceRoot?", "limit?" }
← { "type": "memory.list.done", "requestId", "ok", "items": MemoryListItem[], "error?" }
```

`MemoryListItem`: id, title, summary, type, status, confidence, updatedAt?

### 4.3 `plan.updated`（增强）

保留 revision / itemCount / reason；**增加可选** `items?: { id, text, status? }[]`，避免桌面只靠 `agent.action` 拼状态。

### 4.4 Context 面板（Phase 1 轻量）

- 已有 budget / cost / turn
- 增加 **recentFiles**：从本 run Changes（读/写路径）投影，最多 N 条

## 5. Phase 拆分

### Phase 1 — 产品可见（本轮）

1. Runtime/orchestrator：selectedMemories 带 summary/type/score  
2. 桌面解析 selectedMemories → Memory「本次」  
3. agent-host + IPC `memory.list` → Memory「总库」  
4. plan.updated 可选 items + 桌面合并  
5. Context 展示 recentFiles + 预算  
6. 单测：事件解析 / list 函数；typecheck  

### Phase 2 — 记忆质量（后续）

- Writer：显式 + extract；少垃圾 summary  
- 检索 topK / embedding 升级  
- usage 记录  

### Phase 3 — 瘦身文档

- 标明主路径模块；evolution offline  

## 6. 验收（Phase 1）

1. Run 触发检索后，Memory 面板显示命中条目标题（非仅 count）  
2. 点刷新/打开总库可见 list（DB 可用时）  
3. Plan 在 plan_update 后列表更新；有 status 时 done 样式  
4. Context 在读/写文件后出现路径  
5. 无 DB 时 degrade 不崩，总库提示不可用  
6. `bun` typecheck memory/agent/desktop 相关通过  

## 7. 关键文件

- `packages/core/src/run-events.ts`
- `packages/memory/src/runtime/*`（items 映射）
- `packages/agent/src/orchestrator.ts` / `action-handlers.ts` / `conversation-memory-bind.ts`
- `apps/desktop/agent-host/run.ts`
- `apps/desktop/electron/main.cjs` / `preload.cjs`
- `apps/desktop/src/agent/useRightPanelData.ts`
- `apps/desktop/src/components/RightPanel.tsx`
