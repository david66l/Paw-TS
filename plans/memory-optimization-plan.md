# Paw-TS 记忆系统 6 项优化实现方案

## Context

Paw-TS 当前记忆检索系统通过 Phase 3 验证（命中率 80%），但 6 项设计优化未实现：
A.3 优先级+自动遗忘、A.4 分片索引、B.1 结构化强约束抽取、B.2 记忆反思、B.3 三级召回、B.4 动态 token 分配。

目标：不破坏现有 456 tests 的前提下，逐一实现。

---

## 总体架构

```
抽取（B.1 结构化 prompt）→ 存储（A.3 priority + A.4 分片 MEMORY.md）
                                    ↓
检索（B.3 关键词→语义→LLM 三级 + B.4 动态 token）
                                    ↓
维护（A.3 90天归档 + B.2 夜间反思合并去重）
```

---

## 一、A.3 — 优先级 + 自动遗忘

### 方案

`MemoryRecord` / `AutoMemoryEntry` 加 `priority: "high" | "mid" | "low"` 字段。

- **打分**：`score()` 末尾乘系数：high×1.3, mid×1.0, low×0.7
- **归档**：`buildIndex()` 扫描 low 优先级 + updatedAt > 90 天 → 移至 `memory/archive/`
- **抽取**：prompt 要求 LLM 标记每条 priority，默认 mid

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/core/src/memory-record.ts` | 加 `priority` 字段到 `MemoryRecord`；`autoMemoryToRecord` 映射 |
| `packages/core/src/auto-memory.ts` | `AutoMemoryEntry` 加 `priority`；frontmatter 读写；新增 `archiveExpired()` |
| `packages/core/src/memory-retriever.ts` | `score()` 末尾乘 priority 系数 |
| `packages/agent/src/memory-extraction-agent.ts` | prompt 加 priority 输出要求 |
| 测试文件 | 验证映射、系数、归档 |

---

## 二、A.4 — 分片索引

### 方案

`MEMORY.md` 拆分为 `MEMORY-1.md`/`MEMORY-2.md`，每片 ≤180 条。

- **`buildIndex()`**：按 180 条分片，写一个总目录 `MEMORY.md`（仅列出分片文件名 + 条目数）
- **`loadAllIndexShards()`**：拼接所有分片内容，供 system prompt 注入
- **Cascade LLM**：循环各分片送入 LLM 选择器，合并所有选中 ID（不再单次 200 条截断）

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/core/src/auto-memory.ts` | `buildIndex()` 分片写入 + `loadAllIndexShards()` |
| `packages/core/src/memory-retrieve.ts` | cascade 模式：分片循环 LLM 选择 |
| `packages/core/src/system-prompt.ts` | 使用 `loadAllIndexShards()` |
| 测试文件 | 分片生成/读取/检索 |

---

## 三、B.1 — 结构化强约束抽取

### 方案

扩展 frontmatter，prompt 改为强制 JSON 输出。

**新字段**：
```typescript
priority: "high" | "mid" | "low"       // A.3 共用
error_signatures: string[]               // TS2307, "Cannot find module"
tools_used: string[]                     // 涉及的 MCP/工具名
valid_until?: number                     // 过期时间戳
linked_memories?: string[]               // 关联记忆 name
```

**Extraction prompt 改造**：从 markdown 自由格式 → JSON 强制输出。解析从 regex 改为 `JSON.parse`，大幅降低解析错误率。

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/core/src/auto-memory.ts` | 扩展接口 + frontmatter 序列化 |
| `packages/core/src/memory-record.ts` | `MemoryRecord` 扩展 + 映射新字段 |
| `packages/agent/src/memory-extraction-agent.ts` | 重写 prompt 为 JSON 输出；JSON.parse 替代 regex |
| 测试文件 | 新字段读写、JSON 解析 |

---

## 四、B.2 — 记忆反思子模块

### 方案

新增 `MemoryReflector`（`packages/core/src/memory-reflector.ts`），后台异步执行。

- **触发**：extraction 后检查计数器（持久化到 `.reflection_state.json`），每 20 次 run 触发
- **执行**：读取全部记忆 → LLM 分析 → 输出 `{ merges, archive, conflicts }` → 执行合并/归档
- **LLM prompt**：输入所有记忆的元数据（title/summary/type/priority/tags），不送 content → 输出结构化操作指令
- **合并逻辑**：保留 updatedAt 最新的，删除旧的；合并 content

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/core/src/memory-reflector.ts` | **新文件**：`MemoryReflector` 类 |
| `packages/core/src/index.ts` | 导出 |
| `packages/agent/src/orchestrator/memory-extraction.ts` | 检查 reflection 触发 |
| 测试文件 | reflection 逻辑 |

---

## 五、B.3 — 三级召回架构

### 方案

当前：keyword(+语义乘法) → LLM cascade  
改造为：Tier1 keyword 粗排 → Tier2 语义重排 → Tier3 LLM cascade

```
Tier 1: Keyword Retriever
  rankRecords(minScore=5) → top 30 candidates

Tier 2: Semantic Re-rank (有 embedding 时)
  mergedScore = keywordScore×0.7 + (cosineSim×100)×0.3
  重新排序 top 30

Tier 3: LLM Cascade (低置信度时触发)
  阈值: top-1 < 25 或 top1-top2 gap < 5
  分片 manifest → LLM 选择 → 合并
```

语义从 keyword 内部的乘法变为独立第二层，确保语义信号不因低 keyword 分数被浪费。

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/core/src/memory-retriever.ts` | `score()` 中移除语义乘法；`rankRecords` 支持低 minScore |
| `packages/core/src/memory-retrieve.ts` | Tier1→Tier2→Tier3 管道；新增 `semanticRerank()` |
| 测试文件 | 验证三级管道 |

---

## 六、B.4 — 动态 Token 分配

### 方案

根据 goal 自动检测任务类型（纯规则），动态调整记忆注入预算。

```typescript
type TaskProfile = "refactor_arch" | "bug_fix" | "simple_script" | "general";

function classifyTask(goal: string, errorMessage?: string): TaskProfile
```

**预算表**：

| Profile | maxTokens | session 预算 | 条数上限 | 偏好类型 |
|---------|-----------|-------------|---------|---------|
| refactor_arch | 2000 | 1000 | 8 | reference, project |
| bug_fix | 1800 | 1200 | 6 | error 相关优先 |
| simple_script | 500 | 200 | 2 | 无偏好 |
| general | 1500 | 800 | 5 | 无偏好 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/core/src/memory-record.ts` | 新增 `classifyTask()` |
| `packages/core/src/memory-retriever.ts` | `RetrievalQuery` 加 `taskProfile`；`selectRecords` 按 profile 调预算 |
| `packages/core/src/memory-retrieve.ts` | 调用 `classifyTask` 传入 query |
| 测试文件 | 各 profile 预算验证 |

---

## 实施顺序

```
1. A.3  优先级+自动遗忘（基础设施变动最小，被 B.1/B.4 依赖）
2. B.1  结构化抽取（依赖 A.3 的 priority 字段）
3. A.4  分片索引（依赖 B.1 的结构化字段做精准 manifest）
4. B.3  三级召回（依赖 A.4 的分片 manifest）
5. B.4  动态 token（独立性强，但依赖 B.3 管道结构）
6. B.2  记忆反思（依赖前面所有模块接口稳定）
```

每项完成后运行 `bun run check:ts && bun test` 验证。

---

## 关键设计原则

1. **零破坏**：所有变更增量式（加字段、加步骤、加方法），不删已有公开 API
2. **向后兼容**：新 frontmatter 字段可选，旧文件不报错；默认值兜底
3. **零新依赖**：A.3/A.4/B.1/B.2/B.4 纯规则；B.3 仅用已有 EmbeddingCache
4. **可独立验证**：每项有对应测试覆盖，可单独迭代

---

## 验证

```bash
bun run check:ts          # TypeScript 编译
bun test                  # 全量测试（期望 ≥ 456 pass）
bun run benchmark:memory  # 记忆召回 benchmark（如存在）
```
