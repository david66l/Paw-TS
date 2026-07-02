# A.2 Session ↔ Auto Memory 双向联动 + 跨会话 Boost

## 整体数据流

```
┌──────────────────────────────────────────────────────────────┐
│                     Run 完成后                                 │
│                                                              │
│  maybeExtractMemoriesAfterRun()  ← 已有，不改                  │
│       │                                                      │
│       ▼                                                      │
│  [A.2.1 NEW] 若 auto-compact 成功生成过 sessionMemory:         │
│     extractDecisionsAsAutoMemories(sessionMemory)             │
│     → upsert 到 AutoMemoryStore                               │
│     → 计算 embedding（复用 A.1 的 EmbeddingCache）             │
│                                                              │
│  [A.2.3 NEW] 若 短对话 + 高价值 + 无已有 sessionMemory:         │
│     generateShortSessionSummary()                             │
│     → 调 auxiliaryModel 一次                                  │
│     → 保存到 SessionMemoryStore                               │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                     下次 Run 启动                              │
│                                                              │
│  retrieveMemories()  ← 已有，不改                              │
│       │                                                      │
│       ▼                                                      │
│  [A.2.2 NEW] KeywordMemoryRetriever.score() 新增:             │
│     if source==="session" AND 跨会话信号命中:                   │
│       fileOverlap → +10% boost                                │
│       errorMatch  → +15% boost                                │
│       toolOverlap → +5% boost                                 │
│       cap: total +20%                                         │
└──────────────────────────────────────────────────────────────┘
```

## 子任务边界

### A.2.1: Session → Auto 决策/错误提取

**触发条件:**
- auto-compact 成功（`meetsCompressionSavingsThreshold` 通过）
- sessionMemory 中有 keyDecisions 或 errorsAndFixes

**做什么:**
- 每个 keyDecision → 一条 `type: "project"` auto memory
- 每个 errorAndFix → 一条 `type: "project"` auto memory
- name 用 content hash 前 12 位（稳定去重）
- upsert 到 AutoMemoryStore
- 有 embedding 配置时计算 embedding

**不做什么:**
- 不做额外 LLM 调用（复用压缩产物）
- 不创建 session-level "综合摘要"（那是记忆反思 B.2 的事）
- 不处理 currentState/task（信息熵太低）

### A.2.2: 跨会话 Boost

**触发条件:**
- `m.source === "session"` 
- 且任一信号命中

**信号:**
| 信号 | 条件 | boost |
|------|------|-------|
| fileOverlap | m.relatedFiles ∩ query.recentFiles ≠ ∅ | ×1.10 |
| errorMatch | query.errorMessage 与 m.relatedErrors 任一匹配 | ×1.15 |
| toolOverlap | m.tags ∩ query.recentToolNames ≠ ∅ | ×1.05 |

组合上限 ×1.20，避免跨会话主导排序。

**不做什么:**
- 不修改 auto memory 的 scoring
- 不添加新的 LLM 调用

### A.2.3: 短对话强制 Session Memory

**触发条件（三个同时满足）:**
1. 短对话：turn < 6（压缩大概率没触发过）
2. 高价值：goal 匹配 `/fix|bug|refactor|debug|修复|重构|调试|报错|错误/`
3. 无已有：sessionMemoryStore.load(runId) === null（压缩没产出过）

**做什么:**
- 调 auxiliaryModel 一次（复用 `completeAuxiliaryTask`）
- 生成简化 SessionMemory（task + currentState + errorsAndFixes，无 deep decisions）
- 保存到 SessionMemoryStore

**不做什么:**
- 不做完整 structured extraction（留给 B.1）
- 不生成 keyDecisions（短对话通常没有深层架构决策）
- 不阻塞 run 完成（background/await 模式，同 memoryExtraction）

## 文件改动

| 文件 | 改动 |
|------|------|
| `packages/agent/src/orchestrator/session-summarizer.ts` | NEW: A.2.1 + A.2.3 的提取/总结逻辑 |
| `packages/agent/src/orchestrator.ts` | 在压缩成功路径加 A.2.1 调用；在 run 完成后加 A.2.3 调用 |
| `packages/core/src/memory-retriever.ts` | score() 新增跨会话 boost 维度 |
| `packages/core/src/memory-record.ts` | 新增 `computeCrossSessionSignals()` helper |
| `packages/agent/test/orchestrator-memory.test.ts` | NEW: 集成测试 |

## 验证

```bash
bun test packages/core/test/memory-recall-semantic.test.ts  # 回归语义召回
bun test packages/core/test/memory-retriever.test.ts        # 回归关键词检索
bun test packages/agent/test/                               # 回归 orchestrator
```
