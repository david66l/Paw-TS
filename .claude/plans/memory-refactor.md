# paw 记忆机制重构方案

## Context

基于 Notion 文章《Coding Agent 记忆机制》的思路，对 paw 当前记忆系统进行完整重构。当前系统问题：

- **5 条提取通道混杂**：end-of-run LLM、compact→highlight、short-session LLM、BackgroundReview、manual save — 逻辑重叠，维护成本高
- **V5 功能堆在 V1 产品上**：HRR 重排、矛盾检测、consolidation 压缩、BackgroundReview — 都是文章建议"高级阶段再做"的功能
- **记忆类型混乱**：`user/feedback/project/reference` 四个类型无法清晰区分"用户偏好"和"项目约定"和"失败经验"
- **没有 Context Builder 概念**：检索出来的记忆直接塞进 prompt，缺乏"本轮需要什么 vs 不需要什么"的判断
- **10 个 settings 字段**：大半将被砍掉的功能依赖
- **写入无门槛**：sub-agent 摘要、compact 产物都无差别写入，缺乏置信度过滤

## 目标架构

```
┌──────────────────────────────────────┐
│           Context Builder             │  ← 本轮决定加载什么、不加载什么
│   (token budget + relevance gate)     │
└──────────────────────────────────────┘
                   ▲
                   │
┌──────────────────────────────────────┐
│           Memory Router               │  ← keyword → semantic → LLM 三级
│   混合检索：关键词 + 语义 + 最近任务     │
└──────────────────────────────────────┘
         ▲            ▲
         │            │
┌────────────┐  ┌──────────────┐
│ Session    │  │   Project    │
│ Memory     │  │   Memory     │  ← 6 类结构化记忆
│ (working)  │  │   (长期)      │
└────────────┘  └──────────────┘
```

## 核心改动

### 1. 记忆类型重构：4 类 → 6 类

| 新类型 | 对应文章概念 | 说明 |
|--------|-------------|------|
| `project_rule` | Project Memory | 项目约定、架构决策、技术栈 |
| `module_summary` | Codebase Semantic | 模块职责、文件关系、关键函数 |
| `task_episode` | Episodic Memory | 任务做了什么、结果如何、经验教训 |
| `user_preference` | User Preference | 用户风格偏好、技术栈偏好 |
| `failure_pattern` | Failure Memory | 错误原因→修复方式→验证结果 |
| `working_state` | Working Memory | 当前任务检查点，任务结束后压缩 |

兼容旧类型：`user→user_preference`、`feedback→failure_pattern`、`project→project_rule`、`reference→project_rule`（自动迁移）。

### 2. 提取通道精简：5 → 2

**保留：**

| 通道 | 触发时机 | 产出类型 | 成本 |
|------|---------|---------|------|
| end-of-run 提取 | Run 结束，conversation > min_tokens | task_episode + failure_pattern | 1 次 LLM 调用 |
| compact→highlight | compact 触发后 | project_rule + failure_pattern | 零成本（复用 compact 输出） |

**砍掉：**
- `maybeGenerateShortSessionMemory`：短 Run 不需要记忆提取，下次任务开头自然会描述需求
- `BackgroundReview`：与 compact→highlight 功能重叠；长 Run 最终会触发 compact，产出一样
- `runConsolidation`：V5 功能，paw 的记忆量远达不到 500 条的压缩阈值
- `detectContradictions`：V5 功能，程序化检测准确率低，误报代价高
- `hrrSimilarity`：HRR 重排在 embedding 维度 < 100 时无明显收益，增加复杂度

### 3. Context Builder 新增

在 `orchestrator.ts` 的 `initializeRun()` 中，不直接把所有检索结果塞进 system prompt。而是：

1. **分层加载**：
   - 固定层：加载 `project_rule` 类型（项目约定，每次都要）
   - 动态层：按需检索 `task_episode` + `failure_pattern`（与当前任务相关才加载）
   - 偏好层：加载 `user_preference`（跨项目通用）

2. **Token 预算**：
   - 项目约定：max 800 tokens
   - 任务经历：max 500 tokens
   - 失败经验：max 300 tokens
   - 用户偏好：max 200 tokens
   - 总计：~1800 tokens（远低于现在的无上限检索）

3. **格式化输出**：每类记忆用统一的结构化格式注入 system prompt，而非现在的平铺式。

### 4. 检索简化

- 砍掉 HRR 融合（`memory-hrr.ts`，136 行）
- 简化 cascade LLM 回退：去掉分片循环，一次 LLM 调用从候选池精选 ≤5 条
- 去掉 `memory-query.ts` 中的低命中率规则检测器（`isMemoryMetaQuery`、`isArchitectureQuery`）
- 保留关键词 + embedding 语义重排（3:1 权重，关键词主导）

### 5. Settings 精简：10 → 5

| 保留 | 砍掉 | 原因 |
|------|------|------|
| `memory_retrieval` | `background_review_interval` | 随 BackgroundReview 移除 |
| `paid_memory_extraction` | `disable_session_highlight_extraction` | 合并到 `paid_memory_extraction` |
| `max_extractions_per_run` | `memory_extraction_min_tokens` | 合并为 `memory_min_conversation_tokens` |
| `memory_embedding_model` | `memory_provider` | FileProvider 是唯一实现，砍掉抽象 |
| `session_pool_size` | `sandbox.memory_mb` | 这是沙箱配置，不属于记忆系统 |

合并后的 settings：
```typescript
memory_retrieval: "keyword" | "cascade"     // 检索策略
memory_embedding_model: string              // Ollama embedding 模型名
paid_memory_extraction: boolean             // 付费提取总开关（同时控制 end-of-run 和 compact→highlight）
max_extractions_per_run: number             // 单 Run 最大 LLM 提取次数
session_pool_size: number                   // 检索池历史回合数
```

### 6. MemoryProvider 接口移除

`FileProvider` 是唯一实现，`memory_provider` 配置项从未被使用。直接使用 `AutoMemoryStore`，去掉 `MemoryProvider` 接口（106 行）和 `FileProvider` 适配器（163 行）。

## 文件变更清单

### 删除（~1,200 行）

| 文件 | 行数 | 原因 |
|------|------|------|
| `packages/memory/src/memory-hrr.ts` | 136 | V5 功能，无实际收益 |
| `packages/memory/src/memory-contradict.ts` | 104 | V5 功能，准确率低 |
| `packages/agent/src/orchestrator/background-review.ts` | 162 | 与 compact→highlight 重叠 |
| `packages/memory/src/memory-provider.ts` | 106 | 单一实现，无需抽象 |
| `packages/memory/src/file-provider.ts` | 163 | 适配器，砍掉接口后直接使用 AutoMemoryStore |

### 大幅精简

| 文件 | 当前行数 | 预计行数 | 改动 |
|------|---------|---------|------|
| `memory-reflector.ts` | 527 | ~250 | 移除 `runConsolidation`，保留 `runReflection` (merge/archive) |
| `memory-retrieve.ts` | 262 | ~180 | 移除 HRR 融合、简化 cascade LLM |
| `memory-query.ts` | 445 | ~250 | 移除 `isMemoryMetaQuery`、`isArchitectureQuery`、规则检测器 |
| `session-summarizer.ts` | 291 | ~160 | 移除 `maybeGenerateShortSessionMemory` |
| `orchestrator.ts` | ~2700 | ~2500 | 移除 BackgroundReview 方法/字段/调用、移除 short-session 调用链、添加 Context Builder |

### 新增/重写

| 文件 | 说明 |
|------|------|
| `packages/memory/src/memory-types.ts` | 6 类记忆枚举 + 结构化 schema（每个类型有独立字段） |
| `packages/memory/src/context-builder.ts` | Context Builder：分层加载、token 预算、格式化输出 |

### 改动

| 文件 | 说明 |
|------|------|
| `packages/memory/src/index.ts` | 更新 re-exports |
| `packages/core/src/index.ts` | 更新 re-exports |
| `packages/settings/src/schema.ts` | 精简 memory 相关字段 |
| `packages/memory/src/auto-memory.ts` | type 字段支持新 6 种类型 |
| `packages/memory/src/memory-retrieve.ts` | 砍 HRR、简化 cascade |
| `packages/memory/src/memory-retrieval-cascade.ts` | 简化 LLM 回退逻辑 |
| `packages/agent/src/orchestrator/memory-extraction.ts` | 适配新类型体系 |

## 不变的部分

- `SessionMemoryStore` + compact→highlight 管道：工作正常，保持不变
- `AutoMemoryStore` + YAML frontmatter + sharded index：存储层不变
- `KeywordMemoryRetriever` + BM25 变体：检索核心不变
- `EmbeddingCache` + Ollama embedding：语义增强保留
- `memory-turn-retrieve.ts`：每轮动态注入保留
- Project memory（`CLAUDE.md` 加载）：不变

## 验证

1. `cd packages/memory && npx jest --passWithNoTests` — 记忆模块测试
2. `cd packages/agent && npx jest --passWithNoTests` — agent 测试
3. `npx tsc --noEmit` — 类型检查（packages/memory, packages/core, packages/agent, packages/settings）
4. 手动验证：创建测试项目，跑一次完整 Run，确认记忆提取、检索、注入全链路正常

## 预期结果

- 删除 ~1,200 行死代码
- 精简 ~600 行冗余逻辑
- 净减 ~1,800 行（从 ~4,300 → ~2,500）
- 提取通道：5 → 2
- 记忆类型：4 → 6（更结构化）
- Settings：10 → 5
- 新增 Context Builder 分层加载
