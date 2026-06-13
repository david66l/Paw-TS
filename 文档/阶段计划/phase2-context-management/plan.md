# Phase 2 规划分析 — 上下文管理架构优化

> **前提**: 本文档为规划分析，任何代码修改需经确认后执行。
> **撰写时间**: 2026-05-14
> **对应文档**: 《ARCHITECTURE_AND_FEATURES_PLAN.md》第二节「上下文管理架构」
> **状态**: ✅ 已完成（P2.1-P2.4）

---

## 一、Phase 1 回顾

Phase 1 对应文档第一节「Agent 编排架构」：
- ✅ Orchestrator 状态机重构（1301行 → 6模块+主入口）
- ✅ 并行 Sub-agents（AgentGroup.launchAll）
- ✅ DeepSeek V4 兼容（reasoning_content round-trip）
- ✅ 模型路由（pro/flash 分离）

Phase 2 对应文档第二节「上下文管理架构」。

---

## 二、当前上下文管理现状（实施前）

### 2.1 三层渐进式压缩（已有，保留）

| 层级 | 触发条件 | 机制 | 成本 |
|------|----------|------|------|
| **Layer 1: Prune** | token > 预算 | 截断旧工具结果（>500行/50KB） | 0 LLM 调用 |
| **Layer 2: Compact** | token > 阈值 | Sub-agent 生成结构化摘要 | 1 LLM 调用 |
| **Layer 3: Auto-compact** | thrashing 检测 | 自动触发 Compactor | 1 LLM 调用 |

### 2.2 实施前的问题

- Token 估算：`text.length / 4`（中文场景误差 2-3 倍）
- 无 Head/Tail Protection（前几条消息可能被截断）
- Tool result 截断只保留头部，丢失尾部关键信息（如错误堆栈）

---

## 三、Phase 2 实施结果

### 范围（实际执行）

| 步骤 | 内容 | 状态 |
|---|---|---|
| P2.1 | `TokenEstimator` 接入（替换 `length/4`） | ✅ 完成 |
| P2.2 | `ContextCompactor` / `orchestrator` 全部改用 estimator | ✅ 完成 |
| P2.3 | Head/Tail Protection（语义保护 + 降级规则） | ✅ 完成 |
| P2.4 | Tool result 截断策略（头部+尾部保留） | ✅ 完成 |
| P2.5 | 完整 ContextBudget 分配 | ⏸️ 延后（有运行数据后再评审） |

---

## 四、分项实施详情

### P2.1 TokenEstimator（已完成）

**实现文件**: `packages/core/src/token-estimator.ts`

```typescript
export interface TokenEstimator {
  count(text: string): number;
  countMessages(messages: readonly ChatMessage[]): number;
}

export class TiktokenEstimator implements TokenEstimator {
  private enc = getSharedEncoding(); // tiktoken WASM, cl100k_base
  // ...
}

export class ApproximateEstimator extends TiktokenEstimator {}
```

**关键调整**:
- 原计划使用 `js-tiktoken`（纯 JS）
- **实际发现性能灾难**：5000 字符编码需 4 秒，100 万字符测试超时
- **紧急切换为 `tiktoken`（Rust WASM）**：相同数据 5000 字符仅需 31ms，快 130 倍
- 全局共享 encoding 实例，避免重复加载

**接入点**:
- `ContextManager.estimatedTokens` → `this._estimator.countMessages(messages)`
- `ContextManagerOptions` 新增 `estimator?: TokenEstimator`

---

### P2.2 Compactor / Orchestrator 改用 Estimator（已完成）

**实现文件**: `packages/core/src/context-compactor.ts`

`ContextCompactor` 构造函数新增 `estimator?: TokenEstimator` 参数：
```typescript
constructor(config?: Partial<CompactorConfig>, estimator?: TokenEstimator)
```

**接入点**:
- `check()` → `this.estimator.countMessages(messages)`
- `determineBoundaries()` → `this.estimator.countMessages([m])`
- `packages/agent/src/orchestrator.ts` → `new ContextCompactor({}, ctxMgr.estimator)`

---

### P2.3 Head/Tail Protection（已完成）

**实现文件**: `packages/core/src/context-manager.ts`

**保护对象**:
- **Head**: `history` 中第一条非 tool-result 的 `user` 消息（initial goal）
- **Tail**: 从末尾往前数 N 个 `assistant` 消息到末尾的所有消息
- **System**: 单独存储在 `systemMessage`，自然保留（不在 history 中）

**降级规则**（`maybeTruncate()` 中实现）:
```
Level 1: initial goal + 3 tail turns
Level 2: initial goal + 2 tail turns  (超预算时自动降级)
Level 3: initial goal + 1 tail turn
Level 4: initial goal only
Level 5: 无保护（极限情况，system 仍在）
```

**配置**:
- `ContextManagerOptions.tailTurnCount?: number`（默认 3）
- `ContextManager.tailTurnCount` getter

---

### P2.4 Tool Result 截断策略（已完成）

**实现文件**: `packages/core/src/context-pruner.ts`

`capToolResultContent()` 改进为头尾保留：

```typescript
// Bytes 截断：保留头部 30% + 尾部 30%，中间提示 offset 读取
// Lines 截断：同上，保留头部 N 行 + 尾部 N 行
```

**提示文案**:
```
... (X bytes truncated, use read_file with offset to see full content) ...
... (X lines truncated, use read_file with offset to see full content) ...
```

---

## 五、文件变更清单（实际）

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `packages/core/src/token-estimator.ts` | 新增 | `TokenEstimator` 接口 + `TiktokenEstimator` / `ApproximateEstimator` |
| `packages/core/src/context-manager.ts` | 修改 | 接入 `estimator`；新增 `tailTurnCount`；`maybeTruncate()` 加入保护逻辑 |
| `packages/core/src/context-compactor.ts` | 修改 | `check()` / `determineBoundaries()` 改用 `this.estimator` |
| `packages/core/src/context-pruner.ts` | 修改 | `capToolResultContent()` 头尾保留截断 |
| `packages/agent/src/orchestrator.ts` | 修改 | `ContextCompactor` 创建时传递 `ctxMgr.estimator` |
| `package.json` / `bun.lock` | 修改 | 新增 `tiktoken`，移除 `js-tiktoken` |
| `packages/core/test/token-estimator.test.ts` | 新增 | 7 项单元测试 |
| `packages/core/test/context-protection.test.ts` | 新增 | 7 项保护逻辑测试 |
| `packages/core/test/context-manager.test.ts` | 修改 | 适配 tiktoken 估算值 |
| `packages/core/test/context-compactor.test.ts` | 修改 | 减小数据量避免超时 |
| `packages/core/test/context-pruner.test.ts` | 修改 | 适配新截断文案 |

---

## 六、测试结果

| 包 | 结果 | 说明 |
|---|---|---|
| `packages/core` | **157 pass / 1 fail** | fail 为预存在的 CostTracker 货币符号问题（`$` vs `¥`） |
| `packages/agent` | **46 pass / 0 fail** | 单元测试全部通过 |

---

## 七、风险与实际发生的问题

| 风险 | 是否发生 | 处理 |
|------|----------|------|
| Tokenizer 性能问题 | ✅ **发生** | `js-tiktoken` 纯 JS 实现 5000 字符需 4 秒，紧急切换为 `tiktoken` Rust WASM（31ms） |
| Head/Tail Protection 导致预算超限 | ❌ 未发生 | 降级机制有效，测试覆盖 |
| Tool truncate 丢失关键信息 | ❌ 未发生 | 头尾保留策略确保尾部信息（错误堆栈）不丢失 |
| 压缩触发时机大幅偏移 | ⚠️ 轻微 | 新 estimator 含消息格式开销（4 token/msg + 2 priming），`maxTokens` 阈值相同的场景下保留消息更少。已更新测试期望值。 |

---

## 八、关键决策记录

### ADR-P2-001: TokenEstimator 命名
**决策**: 使用 `TokenEstimator` 而非 `Tokenizer` 或 `PreciseTokenizer`。
**原因**: Claude/DeepSeek/OpenAI 混用场景下，任何单一套 tokenizer 都只能算「更准确估算」。命名避免过度承诺。

### ADR-P2-002: tiktoken vs js-tiktoken
**决策**: 使用 `tiktoken`（Rust WASM）而非 `js-tiktoken`（纯 JS）。
**原因**: `js-tiktoken` 性能灾难级（5000 字符需 4 秒），`tiktoken` 快 130 倍（31ms）。全局共享 encoding 实例避免重复加载。

### ADR-P2-003: buildMessages() 不重写
**决策**: P2.1-P2.4 只做 estimator 替换 + protection + tool truncate，不做完整的 budget-based selection。
**原因**: `buildMessages()` 是最高风险点，会改变上下文顺序和历史保留行为。先降低风险，后逐步增强。

### ADR-P2-004: Head Protection 语义化
**决策**: 不按「前 3 条」机械保护，而是保护 initial goal + 最近 turns。
**原因**: 「前 3 条」可能保护到无关 resume 信息，反而浪费预算。

---

## 九、遗留与下一步

### P2.5 状态
- **暂不进入 Phase 2**，待有实际运行数据后再评审
- 设计草案（比例制 ContextBudget）已就绪，代码未写

### Phase 3 预备
根据《ARCHITECTURE_AND_FEATURES_PLAN.md》，Phase 3 对应「记忆系统架构」：
- 四层记忆 + 向量检索
- sqlite-vec / PGLite 选型
- 记忆图谱设计

是否需要启动 Phase 3 规划，或先处理其他优先级更高的工作，等待项目负责人决策。
