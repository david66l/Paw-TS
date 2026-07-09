# Claude Code 记忆与上下文机制完整分析

## 一、整体架构总览

Claude Code 的记忆/上下文系统分 **五大子系统**，按"离模型最近 → 最远"排列：

```
                    ┌──────────────────────────────────────┐
                    │         Anthropic API (LLM)           │
                    └──────────────────────────────────────┘
                                       ▲
                                       │ 最终拼接内容
        ┌──────────────┬───────────────┼──────────────┬──────────────┐
        │              │               │               │              │
   ┌────┴─────┐ ┌──────┴──────┐ ┌──────┴──────┐ ┌──────┴──────┐ ┌────┴─────┐
   │  System  │ │   User      │ │  Messages   │ │ Attachments │ │  Tools   │
   │  Prompt  │ │   Context   │ │ (conversation│ │ (per-turn   │ │ (schema) │
   │          │ │ (claudeMd)  │ │  history)   │ │ injections) │ │          │
   └────┬─────┘ └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────────┘
        │              │               │               │
        │         ┌────┴─────┐   ┌─────┴──────┐  ┌─────┴──────────┐
        │         │ CLAUDE.md│   │ Compact    │  │ Relevant       │
        │         │ loading  │   │ System     │  │ Memory Recall  │
        │         │ pipeline │   │ (3 modes)  │  │ (query-time)   │
        │         └──────────┘   └────────────┘  └────────────────┘
        │
   ┌────┴──────────┐
   │  Memory       │
   │  Directory    │─────── 记忆文件系统 (~/.claude/projects/<slug>/memory/)
   │  Instructions │─────── 告诉模型怎么读写记忆
   └───────────────┘
```

**核心设计原则：**
- Everything is file-based markdown with YAML frontmatter
- All "intelligence" (extraction, recall, compaction) uses LLM sub-agents via `runForkedAgent`
- Forked agents share the main conversation's prompt cache prefix
- Feature gates (GrowthBook) control almost every behavior, ant-only for many

---

## 二、五大子系统详解

### 2.1 静态上下文注入：CLAUDE.md 加载管道

**入口：** `src/utils/claudemd.ts::getMemoryFiles()` (memoized)
**注入点：** `src/context.ts::getUserContext()` → `claudeMd` 字段 → 作为 `user` context 注入 system prompt

**加载优先级（从低到高，后加载的覆盖前加载的）：**

```
Managed CLAUDE.md         (/etc/claude-code/CLAUDE.md)          ← 策略级
Managed .claude/rules/*.md
User CLAUDE.md            (~/.claude/CLAUDE.md)                  ← 用户级
User .claude/rules/*.md
Project CLAUDE.md         遍历 root→cwd 每一级:                   ← 项目级
                           CLAUDE.md + .claude/CLAUDE.md
                           + .claude/rules/*.md
CLAUDE.local.md           遍历 root→cwd 每一级                     ← 本地项目级(不提交)
AutoMem MEMORY.md         (~/.claude/projects/<hash>/memory/)    ← 自动持久记忆
TeamMem MEMORY.md         (team 目录，需 feature TEAMMEM)
```

**关键细节：**
- `@include` 指令支持：记忆文件内可通过 `@path` 引用外部文件，递归处理，防循环引用
- `<!-- HTML注释 -->` 在加载时自动剥离（用于作者注释，LLM看不到）
- YAML frontmatter 的 `paths:` 字段支持 glob 模式，实现**条件规则**（只在操作匹配路径时注入）
- `MEMORY.md` 有 200 行 / 25KB 截断上限，超过则警告
- 每文件最大 40,000 字符（`MAX_MEMORY_CHARACTER_COUNT`）
- `getMemoryFiles()` 是 memoized 的，compaction 后通过 `resetGetMemoryFilesCache()` 刷新

**输出格式：**
```
Codebase and user instructions are shown below. ...
IMPORTANT: These instructions OVERRIDE any default behavior...

Contents of /Users/.../CLAUDE.md (project instructions, checked into the codebase):

<文件内容>

Contents of ~/.claude/CLAUDE.md (user's private global instructions for all projects):

<文件内容>

Contents of ~/.claude/projects/.../memory/MEMORY.md (user's auto-memory, persists across conversations):

<文件内容>
```

**与 paw 的对比：**
- paw 有 `SessionMemory` + `AutoMemory` 双层概念，Claude Code 的 CLAUDE.md 是静态配置 + 自动记忆的混合体
- paw 用 BM25 + embedding 检索，Claude Code 把 MEMORY.md 全文注入 + query-time 按需召回
- Claude Code 的 Managed/User/Project/Local 四层优先级是 paw 没有的概念
- Claude Code 的 `@include` 和 conditional rules (`paths:` glob) 是 paw 完全没有的

---

### 2.2 会话记忆：Session Memory 系统

**入口：** `src/services/SessionMemory/sessionMemory.ts::initSessionMemory()`
**存储位置：** `~/.claude/session-memory/<session-id>.md`

**工作流程：**

```
每一轮 LLM 响应后
        │
        ▼
postSamplingHook 触发 extractSessionMemory()
        │
        ├─ Gate: 仅 repl_main_thread（主会话），跳过子 Agent
        ├─ Gate: feature flag tengu_session_memory
        ├─ Gate: 初始化阈值（消息 tokens >= minimumMessageTokensToInit）
        ├─ Gate: 更新阈值（新增 tokens + 新增 tool calls）
        ├─ Gate: 末轮无 tool calls 时也允许（自然断点）
        │
        ▼
创建隔离的 setupContext（不污染主线程 readFileState）
        │
        ▼
读取当前 session memory 文件内容
        │
        ▼
启动 runForkedAgent（共享主会话 prompt cache）
  ├─ 只能 Edit session memory 文件（canUseTool 限制）
  ├─ 任务：分析最近 N 条消息，更新 session memory
  └─ maxTurns: 1（只需一次 Edit）
        │
        ▼
标记 lastSummarizedMessageId（后续 compaction 的参考点）
```

**关键设计：**
- **阈值门控**：init 需要足够上下文（默认 40K tokens），更新间隔受 token 增量 + tool call 数量双重控制
- **coalescing**：如果上一轮提取还在跑，下一轮到来时不会重复提交，而是 stash context，等跑完后再跑一次 trailing extraction
- **forked agent 共享 prompt cache**：提取 agent 复用主线程的 system prompt + tools + messages prefix，大幅降低 token 消耗
- **canUseTool 权限控制**：只允许 Edit session memory 文件，防止提取 agent 修改项目文件

**与 paw 的对比：**
- paw 的 session-summarizer 是压缩触发 + 短 Run 触发两条路径，Claude Code 是持续的增量更新
- paw 的事后提取到 AutoMemory，Claude Code 的 session memory 是独立的 markdown 文件
- Claude Code 的增量更新 + coalescing 比 paw 的"一次性摘要"更精细
- 两者都用 forked agent 模式

---

### 2.3 压缩系统：Context Compaction

Claude Code 有三层压缩机制，从轻到重：

#### 第 0 层：Micro-Compact（工具结果清理）`microCompact.ts`

```
每次 API 请求前
        │
        ▼
microcompactMessages()
        │
        ├─ Time-based trigger：距上次 assitant 消息超过阈值
        │    → 直接用 TIME_BASED_MC_CLEARED_MESSAGE 替换旧 tool_result 内容
        │    → 保留最近 N 个 tool_result
        │
        ├─ Cached MC (ant-only)：利用 API 的 cache_edits 功能
        │    → 不修改本地 message 内容（cache_reference + cache_edits 在 API 层附加）
        │    → 基于 count 阈值触发，保留最近 N 个
        │    → 完全不影响 prompt cache 命中
        │
        └─ Legacy 路径已废弃
```

**关键设计：**
- **time-based MC**：服务器端 prompt cache 过期后（无缓存可保有），主动清理旧 tool_result 以减少下次请求的 prompt size
- **cached MC**：利用 API 的 cache editing 能力，发送 "跳过某几个 cache 行的 tool_result" 指令，无损降低 context 大小
- 两种机制都只清理 COMPACTABLE_TOOLS（read/bash/grep/glob/search/fetch/edit/write），不动其他工具的 result

#### 第 1 层：Session Memory Compaction（实验性）`sessionMemoryCompact.ts`

```
autoCompactIfNeeded()
        │
        ▼
trySessionMemoryCompaction()  ← 优先尝试
        │
        ├─ 检查 feature gate: tengu_sm_compact
        ├─ 等待 session memory 提取完成
        ├─ 检查 session memory 非空（不是模板）
        │
        ▼
用 session memory 作为压缩摘要
  - 保留 lastSummarizedMessageId 之后的最近消息（minTokens ~ minTextBlockMessages）
  - 保留工具调用配对完整性（adjustIndexToPreserveAPIInvariants）
  - 发送 session memory 内容作为 compact summary
  - 运行 session_start hooks 恢复 CLAUDE.md 等内容
```

**关键设计：**
- 零额外 LLM 调用——复用 session memory 系统已经提取的内容
- 保留工具配对完整性：如果保留的消息中有 tool_result，必须同时保留前面的 tool_use
- 门槛检查：压缩后 tokens 如果还超阈值就 fallback 到传统压缩

#### 第 2 层：完整 Compaction（LLM 摘要）`compact.ts`

```
compactConversation()
        │
        ├─ 执行 preCompact hooks
        ├─ 用 runForkedAgent 或 streaming API 调用 LLM 生成摘要
        │   ├─ 优先用 forked agent（共享 prompt cache）
        │   └─ 失败则 fallback 到 streaming
        │
        ├─ 如果摘要请求本身 PTL（prompt too long）→ 截断旧消息重试（最多 3 次）
        │
        ▼
生成 CompactionResult:
  - boundaryMarker：压缩边界标记（含 pre/post token count）
  - summaryMessages：用户不可见的压缩摘要
  - attachments：恢复最近读过的文件、plans、skills、agents
  - hookResults：session_start hooks 注入的新 CLAUDE.md 等
```

**压缩后恢复的关键内容（attachments）：**
| 恢复项 | 预算 | 说明 |
|--------|------|------|
| 最近读取的文件 | 5 个 / 50K tokens | 避免重读，每文件截断到 5K tokens |
| 当前 Plan | 无限制 | 保持 plan mode 状态 |
| 已调用的 Skills | 5 个 / 25K tokens | 每 skill 截断到 5K tokens |
| 异步 Agent 状态 | 无限制 | 避免重复启动 |
| Deferred tools delta | 差异计算 | 只注入新增的 |
| Agent listing delta | 差异计算 | 只注入变化 |
| MCP instructions delta | 差异计算 | 只注入变化 |

**自动压缩触发条件（`autoCompact.ts`）：**
```
tokenCount >= contextWindow - 20K(reserved) - 13K(buffer)
且 querySource != session_memory, compact, marble_origami
且 autoCompactEnabled
且 circuit breaker 未触发（连续失败 ≤ 3 次）
且 REACTIVE_COMPACT 模式未激活
且 CONTEXT_COLLAPSE 模式未激活
```

**与 paw 的对比：**
- paw 只有一种 compact（触发 LLM 摘要），Claude Code 有三层渐进式压缩
- paw 的微压缩（MicroCompact）概念完全不存在——paw 没有工具结果这种大块可清理内容
- Claude Code 的 session memory compaction 与 paw 的"压缩时跳到 auto memory"逻辑思路类似，但 Claude Code 实现的更独立
- Claude Code 的压缩后恢复机制（plan/skill/agent/file 重新注入）远复杂于 paw

---

### 2.4 自动提取：extractMemories 系统

**入口：** `src/services/extractMemories/extractMemories.ts::executeExtractMemories()`
**存储位置：** `~/.claude/projects/<hash>/memory/*.md` + `MEMORY.md`
**触发方式：** 每轮 LLM 响应后通过 `handleStopHooks` 调用

**工作流程：**

```
主 Agent 完成一轮响应（无 tool calls）
        │
        ▼
executeExtractMemories()
        │
        ├─ Gate: 仅主 Agent（非子 Agent）
        ├─ Gate: feature flag tengu_passport_quail
        ├─ Gate: auto memory enabled
        ├─ Gate: 非 remote 模式
        │
        ├─ Coalescing: 如果上一轮还在跑 → stash context → trailing run
        │
        ├─ Throttle: 每 N 轮跑一次（tengu_bramble_lintel, 默认 1）
        │
        ├─ 互斥检查: 如果主 Agent 已经自己写了 memory 文件 → 跳过
        │
        ▼
runForkedAgent()（共享主线程 prompt cache）
  ├─ canUseTool: 只允许 Read/Grep/Glob + read-only Bash + Edit/Write 到 memory 目录
  ├─ maxTurns: 5
  ├─ pre-inject 现有 MEMORY.md manifest
  ├─ prompt: 分析最近 N 条消息 → 提取 user/feedback/project/reference 记忆
  └─ 写入 memory 目录 + 更新 MEMORY.md index
```

**四种记忆类型（与 paw 对比）：**

| 类型 | 含义 | Paw 对应 |
|------|------|----------|
| `user` | 用户角色、偏好、知识 | user → user_preference |
| `feedback` | 用户纠正 + 确认的行为指导 | feedback → failure_pattern |
| `project` | 进行中的工作、决策、截止日期 | project → project_rule |
| `reference` | 外部系统指针（Linear, Slack, Grafana） | reference → reference |

**关键设计决策：**
- **无 embedding / 无 BM25**：不做语义检索。MEMORY.md 全文注入 context，query-time 用 Sonnet 从 manifest 选文件
- **主 Agent 可以自己写记忆**：system prompt 中有完整的记忆写入说明。如果主 Agent 写了，extraction agent 跳过（互斥）
- **零额外 LLM 调用**的假象：extraction agent 共享 prompt cache，cache hit 时几乎免费
- **cue-based gate**：只在"自然断点"提取（末轮无 tool calls 时）

**与 paw 的对比：**
- paw 用 BM25 + embedding + HRR + LLM 级联检索，Claude Code 直接全文注入 MEMORY.md
- paw 用 18 维打分 + cosine similarity，Claude Code 用 Sonnet 直接选文件（findRelevantMemories）
- paw 的 extractSessionHighlightsToAutoMemory 是压缩时触发，Claude Code 的 extractMemories 是每轮触发
- 两者都用记忆目录 + YAML frontmatter + MEMORY.md 索引，文件格式基本一致

---

### 2.5 Query-time 记忆召回：findRelevantMemories

**入口：** `src/memdir/findRelevantMemories.ts::findRelevantMemories()`
**触发：** 每轮 query 时通过 `src/utils/attachments.ts` 的 `createRelevantMemoriesAttachment()` 调用

**工作流程：**

```
用户发送 query
        │
        ▼
scanMemoryFiles(memoryDir)
  ├─ 扫描所有 .md 文件（排除 MEMORY.md）
  ├─ 读取 frontmatter (name, description, type)
  └─ 按 mtime 排序，取前 200 个
        │
        ▼
Sonnet sideQuery (小模型，256 max_tokens，JSON output)
  ├─ Prompt: "Query: <user query>\nAvailable memories:\n<manifest>"
  ├─ 输出: { selected_memories: [<filename>, ...] }
  └─ 最多选 5 个
        │
        ▼
readMemoriesForSurfacing（读取选中文件）
  ├─ 截断：MAX_MEMORY_LINES / MAX_MEMORY_BYTES
  └─ 注入为 <system-reminder> 类型的 attachment
```

**关键设计：**
- **Sonnet 做选择器**：最大的创新点——用 LLM 而非 embedding/keyword 做 recall。理由是记忆文件的 frontmatter 描述足够语义丰富
- **去重**：`alreadySurfaced` 集合跟踪已经注入过的文件，避免重复；compaction 后重置（attachment 消失）
- **session-total 节流**：通过 `totalBytes` 限制整会话的召回总字节数
- **agent 隔离**：@agent 提及时只搜索 agent 自己的 memory 目录

**与 paw 的对比：**

| 维度 | Claude Code | Paw |
|------|-------------|-----|
| 检索方式 | LLM (Sonnet) 从 manifest 选文件 | BM25 + embedding cosine + HRR 融合 |
| 索引 | MEMORY.md (文本行) | 分片 index (MEMORY-{n}.md, 180/shard) |
| 候选集 | 200 上限，按 mtime 排序 | 900 上限（5 shards × 180） |
| 语义匹配 | 靠 Sonnet 理解 query→manifest | 靠 embedding 余弦相似度 |
| Token 消耗 | ~256 output tokens per recall | 0（纯本地） |
| 延迟 | Sonnet API call (~100ms) | 本地计算（~1ms） |
| 质量 | 高（LLM 理解语义） | 中（关键词 + 向量） |

---

## 三、Context Builder（上下文组装）

### 3.1 System Prompt 组成

```
System Prompt =
  <base prompt>                              # constants/prompts.ts
  + memory section (loadMemoryPrompt)        # memdir/memdir.ts
  + env_info (git status, platform, date)    # context.ts
  + language section
  + mcp_instructions
  + output_style
  + ... (其他 10+ sections)
```

每个 section 由 `systemPromptSection(name, factory)` 管理，自动 memoized + cache key 追踪。

### 3.2 User Context 组成

```
User Context =                                # context.ts::getUserContext()
  claudeMd                                    # 所有 CLAUDE.md/MEMORY.md 拼接文本
  + currentDate                               # Today's date is YYYY-MM-DD
```

### 3.3 Per-turn Attachments

```
每轮动态注入的 Attachments:
  ├─ relevant_memories            ← findRelevantMemories 的召回结果
  ├─ plan_file_reference          ← plan 模式（如果 in plan mode）
  ├─ invoked_skills               ← 本轮调用的 skills 内容
  ├─ task_status                  ← 异步 agent 状态更新
  ├─ deferred_tools_delta         ← 新增的 deferred tools
  ├─ agent_listing_delta          ← 新增的 agent 类型
  ├─ mcp_instructions_delta       ← 新增的 MCP 工具
  └─ date_change                  ← 日期变更提醒
```

### 3.4 分层的 Token 预算

Claude Code 没有像 paw 的 MemoryRouter 那样显式的 per-kind token budget。它的预算机制是：

| 预算项 | 限制 | 位置 |
|--------|------|------|
| CLAUDE.md 每文件 | 40,000 字符 | MAX_MEMORY_CHARACTER_COUNT |
| MEMORY.md 索引 | 200 行 / 25,000 字节 | MAX_ENTRYPOINT_LINES/BYTES |
| 召回记忆内容 | MAX_MEMORY_LINES / MAX_MEMORY_BYTES | memorySurfacingLimits |
| 压缩后恢复文件 | 5 文件 / 50K tokens | POST_COMPACT_TOKEN_BUDGET |
| 压缩后恢复 skills | 5 skills / 25K tokens | POST_COMPACT_SKILLS_TOKEN_BUDGET |
| Session memory compact | min 10K / max 40K tokens | SessionMemoryCompactConfig |

---

## 四、记忆文件格式

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary>
metadata:
  type: user | feedback | project | reference
---

<markdown body>

- user: 角色、偏好、知识
- feedback: **Why:** + **How to apply:**
- project: 事实/决策 + **Why:** + **How to apply:**
- reference: 外部资源指针
```

---

## 五、关键设计模式提炼

### 5.1 Forked Agent Pattern
所有需要 LLM 的子任务（extraction, session memory, compaction）都用 `runForkedAgent`——fork 当前会话，共享 prompt cache prefix，在自己的 sandbox 里执行。

### 5.2 Feature Gate Everywhere
几乎所有行为都由 GrowthBook feature flags 控制，ant-only。这使得 A/B testing 和渐进式 rollout 非常方便。

### 5.3 Memoized Everything
`getMemoryFiles()`, `getUserContext()`, `getSystemContext()`, `getGitStatus()` 全都 memoized。compaction 后通过显式的 cache reset 刷新。

### 5.4 Coalescing + Trailing Run
extraction 和 session memory 都有 coalescing 模式：如果上一轮还在跑，stash context → 跑完后自动 trailing run。

### 5.5 三层压缩渐进式
MicroCompact → SessionMemoryCompact → Full Compact，从最轻到最重依次尝试。

### 5.6 LLM as Selector
记忆召回不靠 BM25/embedding，直接用 Sonnet 从 file manifest 中选最相关的 5 个文件。这是 Claude Code 与 paw 最大的架构差异。

---

## 六、Paw 可供借鉴的设计

| Claude Code 设计 | Paw 可应用场景 |
|-----------------|---------------|
| Managed/User/Project/Local 四层优先级 | paw 目前只有 flat 的 4 种记忆类型，无加载优先级 |
| `@include` 指令 | 让记忆文件引用外部文档/配置 |
| Conditional rules (`paths:` glob) | 按操作文件路径动态注入相关规则 |
| Session memory compaction（零 LLM 调用） | paw 的 session-summarizer 可复用 session memory 而非重新调 LLM |
| MicroCompact（清理旧 tool_result） | paw 如果引入 tool result 大块内容可借鉴 |
| Forked agent 共享 prompt cache | paw 的 runForkedAgent 已有类似机制 |
| LLM as memory selector (findRelevantMemories) | paw 可对比 BM25+embedding 与 LLM-select 的性价比 |
| 三层压缩渐进式 | paw 只有单层 compact |
| Coalescing + trailing run | paw extraction 目前无并发控制 |

---

## 七、Paw 有但 Claude Code 没有的设计

| Paw 设计 | 说明 |
|----------|------|
| BM25 + embedding + HRR 融合检索 | Claude Code 不做 embedding 检索 |
| 18 维打分系统 | Claude Code 靠 LLM 直接选 |
| 分片索引 (MEMORY-{n}.md) | Claude Code 只有单个 MEMORY.md |
| AutoMemory + SessionMemory 双存储 | Claude Code 是 CLAUDE.md + auto-memory + session-memory 三存储 |
| 记忆合并/归档 (consolidation) | Claude Code 没有（依赖 nightly /dream 做整理） |
| 矛盾检测 stub | Claude Code 没有 |
| MemoryRouter (per-task-type kind routing) | Claude Code 的 memory recall 不区分 task type |
| Per-kind token budgets | Claude Code 没有显式 kind 预算 |
