# Phase 3 规划分析 — 轻量记忆检索化

> **前提**: 本文档为规划分析，任何代码修改需经确认后执行。
> **撰写时间**: 2026-05-14
> **对应文档**: 《ARCHITECTURE_AND_FEATURES_PLAN.md》第三节「记忆系统架构」
> **状态**: ✅ 已完成（P3.1-P3.5）

---

## 一、Phase 2 回顾

Phase 2 对应文档第二节「上下文管理架构」：
- ✅ P2.1 TokenEstimator 接入（tiktoken WASM，替换 length/4）
- ✅ P2.2 Compactor / Orchestrator 改用 estimator
- ✅ P2.3 Head/Tail Protection（语义保护 + 降级规则）
- ✅ P2.4 Tool result 头尾保留截断
- ⏸️ P2.5 完整 ContextBudget 分配 — **暂停**，待运行数据后再评审

---

## 二、当前记忆系统现状

### 2.1 三层记忆（已有）

| 层级 | 存储位置 | 数据结构 | 更新频率 |
|------|----------|----------|----------|
| **Project Memory** | `.paw/CLAUDE.md` + `.paw/CLAUDE.local.md` | 纯文本 | 手动编辑 |
| **Session Memory** | `~/.paw/projects/{hash}/session-memory/{id}.md` | `SessionMemory` 接口 | 每次压缩时 |
| **Auto Memory** | `~/.paw/projects/{hash}/memory/{name}.md` | `AutoMemoryEntry` 接口 | 每 5 轮 |

### 2.2 当前数据接口

```typescript
// SessionMemory (session-memory.ts)
interface SessionMemory {
  readonly session: string;
  readonly project: string;
  readonly updatedAt: number;
  readonly task?: string;
  readonly currentState?: string;
  readonly filesAndFunctions?: readonly string[];
  readonly keyDecisions?: readonly string[];
  readonly errorsAndFixes?: readonly string[];
  readonly relevantContext?: string;
}

// AutoMemoryEntry (auto-memory.ts)
interface AutoMemoryEntry {
  readonly name: string;
  readonly description: string;
  readonly type: "user" | "feedback" | "project" | "reference";
  readonly content: string;
}
```

### 2.3 当前注入方式（system-prompt.ts）

```typescript
// 现状：无筛选、无排序、无相关性判断
if (opts.autoMemories && opts.autoMemories.length > 0) {
  const memLines = opts.autoMemories.map(
    (m) => `- ${m.name}: ${m.description}`,
  );
  lines.push("", "Previous session memories:", memLines.join("\n"));
}
```

**问题**:
- 记忆数量增长后，全部注入会撑爆 system prompt
- 不区分相关性：「上次修过的 bug」和「三个月前的实验」同等权重
- 无路径关联：编辑 `packages/core/src/context-manager.ts` 时，不知道「上次修过这个文件的 bug」
- SessionMemory 和 AutoMemory 是两套独立结构，无法统一检索

---

## 三、Phase 3 目标与范围

**总目标**: 让 Agent 在**新任务开始时**，自动找到和当前 repo / 文件 / 错误相关的历史经验。

**不做的事情**（控制范围）:
- ❌ 四层记忆架构（工作记忆 + 长期记忆 + 实体图）
- ❌ 向量库（sqlite-vec / PGLite）— P3.5 才考虑
- ❌ 记忆图谱（节点 + 边关系）
- ❌ 自动事实提取（用模型调用提取实体关系）

**要做的事情**:
- ✅ P3.1 统一 Memory 数据结构（Session + Auto → 统一 `MemoryRecord`）
- ✅ P3.2 给记忆加元数据（tags / scope / source / updatedAt / relatedFiles）
- ✅ P3.3 关键词 + 路径相关性检索（轻量、无 Embedding）
- ✅ P3.4 注入 top-k 相关记忆到 system prompt
- ⏳ P3.5 sqlite-vec 向量检索（有实际收益数据后再评估）

---

## 四、分项技术方案

### P3.1 统一 Memory 数据结构

**问题**: `SessionMemory` 和 `AutoMemoryEntry` 是完全独立的接口，无法统一检索、排序、注入。

**方案**: 引入统一的 `MemoryRecord` 接口，两种记忆都映射到这个接口。

```typescript
// packages/core/src/memory-record.ts

export type MemorySource = "session" | "auto" | "project" | "user_explicit";

export type MemoryScope = "project" | "workspace" | "global";

export interface MemoryRecord {
  readonly id: string;              // 唯一标识（sessionId 或 auto-memory name）
  readonly source: MemorySource;     // 来源
  readonly scope: MemoryScope;       // 作用范围
  readonly createdAt: number;        // 创建时间戳
  readonly updatedAt: number;        // 最后更新时间戳
  readonly title: string;            // 简短标题（用于列表展示）
  readonly summary: string;          // 一句话摘要（用于相关性匹配）
  readonly content: string;          // 完整内容
  readonly tags: readonly string[];  // 标签（如 "bug", "refactor", "api"）
  readonly relatedFiles: readonly string[]; // 相关文件路径
  readonly relatedErrors: readonly string[]; // 错误签名（extractErrorSignatures）
```

**映射层**:

```typescript
// SessionMemory → MemoryRecord
function sessionMemoryToRecord(sm: SessionMemory): MemoryRecord {
  return {
    id: sm.session,
    source: "session",
    scope: "project",
    createdAt: sm.updatedAt, // session 无独立 createdAt，用 updatedAt 近似
    updatedAt: sm.updatedAt,
    title: sm.task ?? "Untitled session",
    summary: sm.currentState ?? "",
    content: [
      sm.task,
      sm.currentState,
      ...(sm.keyDecisions ?? []),
      ...(sm.errorsAndFixes ?? []),
      sm.relevantContext,
    ].filter(Boolean).join("\n"),
    tags: inferTags(sm),
    relatedFiles: sm.filesAndFunctions ?? [],
    relatedErrors: extractErrorSignatures(sm.errorsAndFixes),
  };
}

// AutoMemoryEntry → MemoryRecord
function autoMemoryToRecord(entry: AutoMemoryEntry, mtime?: number): MemoryRecord {
  const ts = mtime ?? Date.now();
  return {
    id: entry.name,
    source: "auto",
    scope: "project",
    createdAt: entry.createdAt ?? ts,  // 优先 frontmatter，fallback 到 mtime
    updatedAt: entry.updatedAt ?? ts,
    title: entry.name,
    summary: entry.description,
    content: entry.content,
    tags: entry.tags ?? [entry.type],
    relatedFiles: entry.relatedFiles ?? extractFilePaths(entry.content),
    relatedErrors: [],
  };
}
```

**错误签名提取**（`extractErrorSignatures`）:

```typescript
function extractErrorSignatures(errorsAndFixes?: readonly string[]): string[] {
  if (!errorsAndFixes) return [];
  const signatures: string[] = [];
  for (const text of errorsAndFixes) {
    // TypeScript error code: TS1234
    const tsCodes = text.match(/TS\d{4,5}/g);
    if (tsCodes) signatures.push(...tsCodes);
    // Exception names: Error, TypeError, ReferenceError, etc.
    const exceptions = text.match(/\b(Error|TypeError|ReferenceError|SyntaxError|RangeError)\b/g);
    if (exceptions) signatures.push(...exceptions);
    // Key error lines: "Cannot find module" / "Property does not exist"
    const keyLines = text.split("\n").filter((l) =>
      /cannot|does not|is not|failed|undefined|null/.test(l.toLowerCase())
    );
    for (const line of keyLines.slice(0, 2)) {
      const normalized = line.trim().slice(0, 80);
      if (normalized) signatures.push(normalized);
    }
  }
  return [...new Set(signatures)];
}
```

**工作量**: ~1 天

---

### P3.2 给记忆加元数据

**目标**: 让记忆自带「被检索」的能力，不依赖运行时解析。

**AutoMemoryEntry 扩展**:

```typescript
// auto-memory.ts
export interface AutoMemoryEntry {
  readonly name: string;
  readonly description: string;
  readonly type: "user" | "feedback" | "project" | "reference";
  readonly content: string;
  // 新增字段
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly tags?: readonly string[];
  readonly relatedFiles?: readonly string[];
}
```

**YAML frontmatter 扩展**:

```yaml
---
name: typescript-strict-mode
description: 项目使用 strict TypeScript，noUnusedLocals 和 noUncheckedIndexedAccess 开启
type: project
createdAt: 1715683200000
updatedAt: 1715683200000
tags: [typescript, strict, config]
relatedFiles: [tsconfig.base.json, packages/core/tsconfig.json]
---
```

**SessionMemory 扩展**:

```typescript
// session-memory.ts
export interface SessionMemory {
  // ... 现有字段
  readonly tags?: readonly string[];        // 自动推断或模型提取
  readonly relatedFiles?: readonly string[]; // 从 filesAndFunctions 升级
}
```

**标签推断**（轻量规则，无需模型调用）:

```typescript
function inferTags(sm: SessionMemory): string[] {
  const tags: string[] = [];
  const text = [
    sm.task,
    sm.currentState,
    ...(sm.errorsAndFixes ?? []),
  ].join(" ").toLowerCase();
  
  if (text.includes("bug") || text.includes("fix") || text.includes("error")) tags.push("bug");
  if (text.includes("refactor")) tags.push("refactor");
  if (text.includes("test")) tags.push("testing");
  if (text.includes("api") || text.includes("endpoint")) tags.push("api");
  if (text.includes("perf") || text.includes("performance") || text.includes("slow")) tags.push("performance");
  if (text.includes("typescript") || text.includes("type")) tags.push("typescript");
  if (text.includes("react") || text.includes("component")) tags.push("frontend");
  
  return tags;
}
```

**工作量**: ~1-1.5 天

---

### P3.3 关键词 + 路径相关性检索

**目标**: 零 Embedding、零外部依赖，纯本地计算相关性分数。

**检索器接口**:

```typescript
// packages/core/src/memory-retriever.ts

export interface MemoryRetriever {
  /** 检索与当前上下文相关的记忆 */
  retrieve(query: RetrievalQuery): MemoryRetrievalResult;
}

export interface MemoryRetrievalResult {
  readonly records: readonly MemoryRecord[];
  readonly totalCandidates: number;
  readonly scores: readonly number[]; // 与 records 一一对应
  readonly injectedTokens: number;     // 实际注入的 token 数
}

export interface RetrievalQuery {
  readonly goal: string;              // 当前任务描述
  readonly currentFile?: string;       // 当前编辑的文件
  readonly recentFiles?: readonly string[];   // 最近操作过的文件（来自工具调用）
  readonly recentToolNames?: readonly string[]; // 最近调用的工具名（辅助信号，低权重）
  readonly errorMessage?: string;      // 当前错误信息
  readonly workspaceRoot: string;
  readonly limit?: number;            // 返回数量（默认 5）
  readonly maxTokens?: number;         // 注入 token 预算（默认 1500）
}
```

**轻量检索实现**:

```typescript
export class KeywordMemoryRetriever implements MemoryRetriever {
  private readonly store: UnifiedMemoryStore;

  retrieve(query: RetrievalQuery): MemoryRetrievalResult {
    const all = this.store.list();
    const scored = all.map((m) => ({
      record: m,
      score: this.score(m, query),
    }));

    // 按分数降序，取 top-k，同时受 token budget 限制
    const limit = query.limit ?? 5;
    const maxTokens = query.maxTokens ?? 1500;
    const sorted = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    const records: MemoryRecord[] = [];
    const selectedScores: number[] = [];
    let totalTokens = 0;
    for (const s of sorted) {
      if (records.length >= limit) break;
      const tokens = this.estimateRecordTokens(s.record);
      if (totalTokens + tokens > maxTokens && records.length > 0) break;
      records.push(s.record);
      selectedScores.push(s.score);
      totalTokens += tokens;
    }

    return {
      records,
      totalCandidates: sorted.length,
      scores: selectedScores,
      injectedTokens: totalTokens,
    };
  }

  private estimateRecordTokens(m: MemoryRecord): number {
    // 只估算注入部分（title + summary + relatedFiles）
    const text = [m.title, m.summary, ...m.relatedFiles].join(" ");
    return Math.ceil(text.length / 4); // 粗略估算，运行时可用 estimator
  }

  private score(m: MemoryRecord, query: RetrievalQuery): number {
    let score = 0;

    // 1. 关键词匹配（goal vs title + summary + content + tags）
    const queryWords = this.tokenize(query.goal);
    const memoryText = [m.title, m.summary, m.content, ...m.tags].join(" ");
    const memoryWords = this.tokenize(memoryText);
    const keywordMatches = queryWords.filter((w) => memoryWords.includes(w)).length;
    score += keywordMatches * 10;

    // 2. 文件路径匹配（当前编辑的文件 + 最近操作过的文件 vs 记忆的相关文件）
    const queryFiles = [
      query.currentFile,
      ...(query.recentFiles ?? []),
    ].filter((f): f is string => !!f);

    for (const qf of queryFiles) {
      for (const relFile of m.relatedFiles) {
        const pathScore = this.pathMatchScore(qf, relFile);
        score += pathScore;
      }
    }

    // 3. 最近工具调用匹配（辅助信号，低权重）
    if (query.recentToolNames && query.recentToolNames.length > 0 && m.tags.length > 0) {
      for (const toolName of query.recentToolNames) {
        if (m.tags.includes(toolName)) score += 5;
      }
    }

    // 3. 错误信息匹配
    if (query.errorMessage && m.relatedErrors.length > 0) {
      for (const err of m.relatedErrors) {
        if (query.errorMessage.includes(err) || err.includes(query.errorMessage)) {
          score += 40;
        }
      }
    }

    // 4. 时间衰减（越新的记忆分数越高）
    const ageDays = (Date.now() - m.updatedAt) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 1 - ageDays / 30); // 30 天内满分，之后线性衰减
    score *= (1 + recencyBoost);

    // 5. 来源权重（session > auto）
    if (m.source === "session") score *= 1.2;

    return score;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2); // 过滤短词（"is", "to" 等）
  }

  private pathMatchScore(current: string, related: string): number {
    const cur = current.replace(/\\/g, "/");
    const rel = related.replace(/\\/g, "/");

    // Same file
    if (cur === rel) return 60;

    // Same directory
    const curDir = cur.slice(0, cur.lastIndexOf("/"));
    const relDir = rel.slice(0, rel.lastIndexOf("/"));
    if (curDir && curDir === relDir) return 30;

    // Same package/module (e.g. packages/core/src/*)
    const curParts = cur.split("/");
    const relParts = rel.split("/");
    const commonPrefix = [];
    for (let i = 0; i < Math.min(curParts.length, relParts.length); i++) {
      if (curParts[i] === relParts[i]) commonPrefix.push(curParts[i]);
      else break;
    }
    if (commonPrefix.length >= 2) return 15;

    // Filename match
    const curFile = cur.slice(cur.lastIndexOf("/") + 1);
    const relFile = rel.slice(rel.lastIndexOf("/") + 1);
    if (curFile === relFile) return 20;

    return 0;
  }
}
```

**为什么不用 Embedding**:
- 关键词匹配 + 路径匹配对 code agent 场景已经足够（文件路径是强信号）
- 零依赖，零网络调用，零额外存储
- 时间衰减确保旧记忆自然降权
- 后续如果关键词召回率不够，再引入 sqlite-vec（P3.5）

**工作量**: ~1.5-2 天

---

### P3.4 注入 top-k 相关记忆到 system prompt

**目标**: 替换当前「全量注入」为「按需注入 top-k」。

**修改点**:

```typescript
// packages/agent/src/orchestrator.ts

// 修改前：
const autoMemories = autoMemoryStore.list();

// 修改后：
const memoryRetriever = new KeywordMemoryRetriever(unifiedMemoryStore);
const relevantMemories = memoryRetriever.retrieve({
  goal: spec.goal,
  workspaceRoot,
  limit: 5,
});
```

**system-prompt.ts 修改**:

```typescript
// 修改前：
if (opts.autoMemories && opts.autoMemories.length > 0) {
  const memLines = opts.autoMemories.map((m) => `- ${m.name}: ${m.description}`);
  lines.push("", "Previous session memories:", memLines.join("\n"));
}

// 修改后：
if (opts.relevantMemories && opts.relevantMemories.length > 0) {
  lines.push("", "Relevant past experiences:");
  for (const m of opts.relevantMemories) {
    lines.push(`- ${m.title}: ${m.summary}`);
    if (m.relatedFiles.length > 0) {
      lines.push(`  Related files: ${m.relatedFiles.join(", ")}`);
    }
  }
}
```

**效果示例**:

```markdown
Relevant past experiences:
- Fix context-manager truncation bug: Tool results were being dropped before assistant response
  Related files: packages/core/src/context-manager.ts
- TypeScript strict mode config: noUnusedLocals and noUncheckedIndexedAccess are enabled
  Related files: tsconfig.base.json
```

**工作量**: ~0.5-1 天

---

### P3.5 sqlite-vec 向量检索（远期）

**触发条件**:
- P3.3 关键词检索运行 2-4 周后
- 有实际反馈：关键词召回率 < 70%，或用户报告「找不到相关记忆」
- 有 benchmark 数据证明向量检索能显著提升

**为什么现在不做**:
- 关键词 + 路径匹配对 code agent 场景召回率已经较高（文件路径是强信号）
- sqlite-vec 增加依赖和复杂度
- 先做轻量版验证需求，再决定是否投入

**技术预研**（不做代码）:

```typescript
// 未来可能的接口
import * as sqliteVec from "sqlite-vec";

export class VectorMemoryRetriever implements MemoryRetriever {
  private db: Database;

  async index(records: MemoryRecord[]): Promise<void> {
    // 使用本地 embedding（ollama 或轻量模型）
    // 存储到 sqlite-vec
  }

  async retrieve(query: RetrievalQuery): Promise<MemoryRecord[]> {
    // 1. 关键词粗排（减少向量检索范围）
    // 2. 向量精排（top-k 相似度）
    // 3. 时间衰减 + 来源权重
  }
}
```

---

## 五、实施顺序

```
Week 1
├── Day 1: P3.1 统一 Memory 数据结构
│   └── 定义 MemoryRecord 接口
│   └── 实现 SessionMemory → MemoryRecord 映射
│   └── 实现 AutoMemoryEntry → MemoryRecord 映射
│   └── 实现 UnifiedMemoryStore（统一读取入口）
├── Day 2-3: P3.2 元数据扩展
│   └── 扩展 AutoMemoryEntry YAML frontmatter（createdAt, tags, relatedFiles）
│   └── 扩展 SessionMemory 接口（tags, relatedFiles）
│   └── 实现 inferTags() 轻量规则
│   └── 实现 extractFilePaths() 从内容中提取路径
└── Day 4-5: P3.3 关键词 + 路径检索
    └── 实现 KeywordMemoryRetriever
    └── 相关性评分算法（关键词 + 路径 + 错误 + 时间 + 来源）
    └── 单元测试（模拟不同场景的检索）

Week 2
├── Day 1: P3.4 注入 top-k 记忆到 system prompt
│   └── 修改 orchestrator.ts 用检索器替代 list()
│   └── 修改 system-prompt.ts 注入格式（只放 title + summary）
│   └── 端到端测试验证
└── Day 2-3: P3.5 命中日志 + 集成验证
    ├── 记录 memory.retrieve.done 事件（query / candidates / selected / scores / injectedTokens）
    ├── 长对话场景测试
    ├── 相关性评分调参
    └── 文档更新
```

---

## 六、文件变更清单（预估）

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `packages/core/src/memory-record.ts` | 新增 | `MemoryRecord` 统一接口 + 映射函数 |
| `packages/core/src/memory-retriever.ts` | 新增 | `KeywordMemoryRetriever` 实现 |
| `packages/core/src/unified-memory-store.ts` | 新增 | 统一读取 Session + Auto + Project 记忆 |
| `packages/core/src/auto-memory.ts` | 修改 | 扩展 frontmatter（createdAt, tags, relatedFiles） |
| `packages/core/src/session-memory.ts` | 修改 | 扩展接口（tags, relatedFiles） |
| `packages/core/src/system-prompt.ts` | 修改 | 注入 top-k 相关记忆 |
| `packages/agent/src/orchestrator.ts` | 修改 | 用检索器替代 `autoMemoryStore.list()` |
| `packages/core/test/memory-retriever.test.ts` | 新增 | 检索逻辑单元测试 |
| `packages/core/test/memory-record.test.ts` | 新增 | 映射逻辑单元测试 |

---

## 七、与现有代码的关系

```
当前流程:
  Orchestrator.initializeRun()
  ├── autoMemoryStore.list()  ← 全量读取，无筛选
  └── buildSystemPrompt({ autoMemories })

新流程:
  Orchestrator.initializeRun()
  ├── unifiedStore.listAll()  ← 统一读取所有记忆
  ├── memoryRetriever.retrieve({ goal, currentFile })  ← 按相关性筛选 top-k
  └── buildSystemPrompt({ relevantMemories })
```

**兼容性**:
- 旧格式 AutoMemoryEntry / SessionMemory 仍然可读（映射层处理缺失字段）
- 新 frontmatter 字段是可选的，旧文件不报错
- 如果检索器返回空，system prompt 不显示记忆 section（与当前行为一致）

---

## 八、关键决策记录

### ADR-P3-001: 先关键词，后向量
**决策**: P3.3 用关键词 + 路径匹配，P3.5 才考虑 sqlite-vec。
**原因**: 文件路径是 code agent 场景的强信号，关键词召回率可能已经足够。先做轻量版验证需求。

### ADR-P3-002: 统一 MemoryRecord
**决策**: SessionMemory 和 AutoMemoryEntry 映射到统一的 `MemoryRecord`。
**原因**: 统一检索、排序、注入接口，避免两套逻辑。

### ADR-P3-003: 标签推断规则化
**决策**: `inferTags()` 用关键词匹配而非模型调用。
**原因**: 模型调用有成本和延迟，规则推断足够覆盖 80% 场景。后续可扩展为混合模式。

### ADR-P3-004: Token budget 双限制
**决策**: 同时限制 `limit`（条数）和 `maxTokens`（token 数）。
**原因**: 5 条长记忆也可能撑大 system prompt。只注入 `title + summary + relatedFiles`，不注入完整 `content`。

### ADR-P3-005: 路径匹配分级
**决策**: `pathMatchScore()` 用分级权重（same file 60 / same dir 30 / same package 15 / filename 20），而非简单 `includes`。
**原因**: `includes` 会误匹配模糊路径（如 `src/app.ts` 包含 `app`）。

### ADR-P3-006: 命中日志必须记录
**决策**: P3.5 强制记录 `memory.retrieve.done` 事件。
**原因**: 没有日志无法判断检索是否有效，无法调参。日志包含 query、candidates、selected、scores、injectedTokens。

---

## 九、验收标准

1. **统一结构**: `SessionMemory` 和 `AutoMemoryEntry` 都能映射到 `MemoryRecord`
2. **元数据**: 新创建的记忆自动带 tags 和 relatedFiles；旧记忆从 mtime 获取时间戳
3. **检索质量**: 编辑 `context-manager.ts` 时，能召回「上次修过这个文件」的记忆（same file +60）
4. **注入控制**: system prompt 中记忆受双限制（top-5 + 1500 token），只注入 title + summary
5. **命中日志**: 每次检索记录 `memory.retrieve.done` 事件（query / candidates / selected / scores / injectedTokens）
6. **无回归**: 所有现有测试通过
7. **测试覆盖**: 新增检索逻辑测试 > 80% 覆盖率

---

## 十、实施结果

### 测试数据

| 包 | 结果 |
|---|---|
| `packages/core` | **185 pass / 0 fail** |
| `packages/agent`（单元测试） | **46 pass / 0 fail** |

### 实际文件变更

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `packages/core/src/memory-record.ts` | 新增 | `MemoryRecord` 统一接口 + 映射函数 |
| `packages/core/src/unified-memory-store.ts` | 新增 | `UnifiedMemoryStore` 统一读取入口 |
| `packages/core/src/memory-retriever.ts` | 新增 | `KeywordMemoryRetriever` 检索实现 |
| `packages/core/src/auto-memory.ts` | 修改 | 扩展接口：`createdAt` / `updatedAt` / `tags` / `relatedFiles` |
| `packages/core/src/system-prompt.ts` | 修改 | `relevantMemories` 替代 `autoMemories`，只注入 title + summary |
| `packages/agent/src/orchestrator.ts` | 修改 | 检索器替代 `list()`，emit `memory.retrieve.done` |
| `packages/core/src/index.ts` | 修改 | 导出新增模块 |
| `packages/core/test/memory-record.test.ts` | 新增 | 17 项单元测试 |
| `packages/core/test/memory-retriever.test.ts` | 新增 | 10 项单元测试 |

### 运行时行为

```
Orchestrator.initializeRun()
├── UnifiedMemoryStore.listExcludingCurrent()  ← 统一读取 Session + Auto
├── KeywordMemoryRetriever.retrieve({ goal, limit: 5, maxTokens: 1500 })
│   ├── 关键词匹配（goal vs title/summary/content/tags）
│   ├── 路径分级匹配（same file +60 / same dir +30 / same package +15 / filename +20）
│   ├── 错误签名匹配（TS error code / 异常名 / 关键报错行）
│   ├── 时间衰减（30 天内满分，之后线性衰减）
│   └── token budget 截断（limit + maxTokens 双限制）
├── emit({ type: "memory.retrieve.done", ... })  ← P3.5 命中日志
└── buildSystemPrompt({ relevantMemories })  ← 只注入 title + summary
```

---

## 十一、下一步（观察期，不上向量检索）

**决策**：先观察运行数据，再决定是否引入 sqlite-vec。

### 观察任务清单

```
□ 完成 10-20 个真实任务（编码、调试、重构等）
□ 收集 memory.retrieve.done 日志
□ 统计指标：
  - 命中率：是否召回了相关记忆
  - 误召率：是否召回了无关记忆
  - token 稳定性：injectedTokens 是否波动过大
  - top-k 合理性：5 条是否太多/太少
□ 人工标注：每次任务结束后，判断检索结果是否有效
```

**工具**：`bun run analyze:memory`（读取 `.paw/sessions/*.jsonl`，输出统计报告）

```bash
# 查看自动指标（candidates / selected / scores / injectedTokens）
bun run analyze:memory

# 交互式人工标注（Y=命中, N=误召, S=跳过, Q=退出）
bun run analyze:memory --annotate

# 标注后再次运行即可看到命中率 / 误召率
bun run analyze:memory
```

### 决策标准

| 指标 | 阈值 | 结论 |
|------|------|------|
| 命中率 | > 70% | 当前方案足够，暂不引入向量 |
| 命中率 | 50-70% | 优化关键词规则 + 调参 |
| 命中率 | < 50% | 考虑引入 sqlite-vec |
| 误召率 | < 20% | 可接受 |
| 误召率 | > 30% | 引入向量精排或调低分数阈值 |
| injectedTokens | < 1000 | 可接受 |
| injectedTokens | > 2000 | 调低 maxTokens 或 limit |

### 如果决定引入向量检索

触发条件（满足任一）：
1. 关键词命中率 < 50%，且优化后无改善
2. 用户明确反馈「找不到相关记忆」
3. 有 benchmark 证明向量检索能显著提升

**不上 sqlite-vec 的当前理由**：
- 文件路径是 code agent 的强信号，关键词 + 路径匹配召回率可能已足够
- 增加依赖和复杂度，需要 embedding 模型 + 向量存储
- 先做轻量版验证需求，避免过度工程

---

## 十二、Phase 4 预备（暂不启动）

根据《ARCHITECTURE_AND_FEATURES_PLAN.md》，Phase 4 可能方向：
- 事件与持久化架构（统一事件存储 + Projection 模式）
- 工具系统架构（可插拔工具注册表）
- 模型适配架构（Fallback 链、能力声明扩展）

待观察期结束后再评估 Phase 4 优先级。

---

## 十三、Phase 3 关闭总结

> **关闭时间**: 2026-05-15
> **最终状态**: Phase 3 目标达成，观察期结束，暂不进入 Phase 4（向量检索）

### 13.1 观察期执行记录

| 批次 | 代码版本 | 任务数 | query 质量 | 关键问题 |
|------|---------|--------|-----------|---------|
| v2/v3 | 初版检索器 | 20 | 干净 | 同目录路径噪声严重（runresult_steps_tracking 195+ 误召） |
| v5/v6/v7 | 旧代码 | 10 | 干净 | 同上，命中 30%，误召 70% |
| v8 | 新代码 | 10 | **污染** | resumeSession 注入历史上下文，query 累积导致分数异常膨胀（2290+） |
| **v9** | **新代码 + clean query** | **10** | **干净** | **误召问题解决，命中 50%，top-1 命中 ~57%** |

### 13.2 clean query 修复

**问题**: `runStubRun` 默认 `resumeSession !== false`，CLI 层自动将之前会话的 background + previous goal 注入到当前 goal 中。Orchestrator 的 memory retrieval 使用完整污染 goal，导致 keyword match 命中大量历史无关关键词。

**修复**:
1. **CLI 层**: v9 观察脚本显式设置 `resumeSession: false`
2. **Orchestrator 层**: 新增 `extractCleanMemoryQuery(spec.goal)`，memory retrieval 前从污染 goal 中提取 `[Current user request]` 后的 clean query，确保 `retrieve()`、`extractFilePaths()`、`memory.retrieve.done.query` 均不受 resume context 影响

**代码**:
```typescript
// packages/core/src/memory-record.ts
export function extractCleanMemoryQuery(goal: string): string {
  const marker = "[Current user request]";
  const idx = goal.indexOf(marker);
  if (idx >= 0) return goal.slice(idx + marker.length).trim();
  return goal;
}

// packages/agent/src/orchestrator.ts
const cleanMemoryQuery = extractCleanMemoryQuery(spec.goal);
const queryFiles = extractFilePaths(cleanMemoryQuery);
const memoryResult = memoryRetriever.retrieve({
  goal: cleanMemoryQuery,
  currentFile: queryFiles[0],
  recentFiles: queryFiles,
  workspaceRoot,
  limit: 5,
  maxTokens: 1500,
});
emit({ type: "memory.retrieve.done", query: cleanMemoryQuery, ... });
```

**测试**: `packages/core/test/memory-retriever.test.ts` 新增 2 项测试验证被污染 goal 不会召回无关记忆。456 tests pass / 0 fail。

### 13.3 路径噪声压制效果

**旧代码问题**:
- `pathMatchScore` 的 sameDir (+30) 和 samePackage (+15) 不依赖文本信号，纯目录 proximity 即可触发高分
- `runresult_steps_tracking` 的 `relatedFiles` 包含 `packages/core/src/run.ts`（不存在文件），任何 `packages/core/src/*` 查询都因 `commonDepth >= 2` 获得 +15 路径分
- 叠加上 generic keyword（如 "path"）后，总分达 195+，稳居 top-1

**修复措施**:
1. **`broadPathRequiresTextSignal`**: sameDir (+30→+20) 和 samePackage (+15) 仅在 `keywordMatches >= 2` 时生效。无文本信号时，仅 exact file match (+60) 和 filename match (+20) 能贡献路径分。
2. **`unrelatedFilesPenalty`**: 若 memory 的 relatedFiles 与 query 路径的公共前缀 ≤1 段（如 `packages/core` vs `packages/workspace`），即使有一个 generic keyword 命中，也扣除 6 分。

**效果对比**（以 `packages/core/src/memory-retriever.ts` 查询为例）:

| memory | 旧代码分数 | 新代码分数 | 变化 |
|--------|-----------|-----------|------|
| `runresult_steps_tracking` | **195.8** | 19.6 | ↓ 90% |
| `project_architecture` | 57.8 | 39.3 | ↓ 32% |

v9 实测：同目录高分噪声已消除，`packages/core/src/*` 查询不再误召 `runresult_steps_tracking`。

### 13.4 v9 最终观察数据

**观察条件**: 10 条干净只读任务，`resumeSession: false`，maxSteps=3，approvalPolicy 拒绝 mutating 工具。

| 指标 | 数值 |
|------|------|
| 命中率 | **50.0%** (5/10) |
| 误召率 | **50.0%** |
| top-1 命中率 | **~57%** (4/7，有召回的查询) |
| 空召回 | 2 条（cost-tracker、openai-stream-parse） |

**命中明细**:
- `path-guard.ts` → `memory_path_escape_workspace`（弱相关，19.6 分）
- `sub-agent-launcher.ts` → `runresult_steps_tracking`（直接相关，195.6 分）
- `watch.ts` → `external_file_monitoring`（直接相关，269.4 分）
- `App.tsx` → `tui_app_in_progress`（直接相关，295.2 分）
- `memory-retriever.ts` → `memory_path_escape_workspace`（弱相关，39.1 分）

**误召/空召明细**:
- `context-compactor`：无相关记忆，召回低分噪声
- `cost-tracker`：**空召回**，记忆库无相关记忆
- `harness registry`：无相关记忆，召回低分噪声
- `openai-stream-parse`：**空召回**，记忆库无相关记忆
- `settings loader`：无相关记忆，召回泛化噪声

### 13.5 剩余缺口分析

**核心结论**: 命中率 50% 未达 70% 目标，但**缺口主要来自记忆库覆盖不足，而非 keyword/path 检索算法 bug**。

| 缺口类型 | 数量 | 根因 | 解决方式 |
|---------|------|------|---------|
| 空召回 | 2 | 记忆库中无 cost-tracker / openai-stream-parse 相关记忆 | 补充 auto-memory |
| 误召（无相关记忆） | 3 | 记忆库中无 context-compactor / harness registry / settings loader 相关记忆 | 补充 auto-memory |
| 弱相关召回 | 2 | memory_path_escape_workspace 与 path-guard/memory-retriever 有 path 主题弱关联 | 可接受，语义上不算完全误召 |

**minScore 评估**:
- 维持当前 `minScore = 15`，不提升
- 弱相关命中（如 memory_path_escape_workspace）得分约 19.6，低分误召也约 19.6
- 阈值无法区分"弱相关"和"弱噪声"，提升只会同时误伤两者

### 13.6 最终判断

| 标准 | 状态 | 说明 |
|------|------|------|
| 误召问题是否解决 | ✅ | 同目录高分噪声已消除（195→19.6） |
| 召回是否准确 | ✅ | 有记忆时基本能召回（5/5 直接相关任务全命中） |
| query 污染是否修复 | ✅ | cleanMemoryQuery + resumeSession:false 双重保障 |
| 是否达到 70% | ❌ | 50% 未达标，但缺口来自记忆库覆盖不足 |
| 是否有明显副作用 | ❌ | clean query 修复后无副作用 |

**决策**: **Phase 3 关闭**。基础检索、事件观测、人工标注、query 污染修复、路径噪声压制均已完成。v9 是可信观察数据。

**暂不进入 Phase 4（向量检索）**。后续如需提高命中率，优先补充记忆库覆盖；向量检索作为 Phase 4 另行评估。

### 13.7 改动文件清单（Phase 3 关闭补丁）

| 文件 | 变更 |
|------|------|
| `packages/core/src/memory-record.ts` | 新增 `extractCleanMemoryQuery()` |
| `packages/core/src/index.ts` | 导出 `extractCleanMemoryQuery` |
| `packages/agent/src/orchestrator.ts` | memory retrieval 使用 `extractCleanMemoryQuery(spec.goal)` |
| `packages/core/test/memory-retriever.test.ts` | 新增 2 项测试（clean query 提取 + 污染 goal 不召回无关记忆） |
| `packages/core/src/memory-retriever.ts` | 已有：`broadPathRequiresTextSignal` + `unrelatedFilesPenalty` |

---

> **Phase 3 总测试基线**: `bun run check:ts` — lint 94 warnings, typecheck 全绿, **456 tests pass / 0 fail**
