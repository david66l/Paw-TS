# paw-ts 上下文压缩与记忆机制设计方案

> 分析日期：2026-05-12
> 参考系统：Claude Code / OpenCode / Hermes

---

## 一、设计哲学：Why paw-ts 需要独特方案

三个参考系统各有取舍：
- **Claude Code**：最完善但最复杂（6层压缩 + 7层记忆），维护成本高
- **OpenCode**：最精简但功能缺失（无记忆系统，压缩只靠2层）
- **Hermes**：可插拔但过度抽象（8种外部记忆插件，对个人工具过重）

**paw-ts 的定位是个人开发助手**，不是团队协作平台，也不是企业级产品。因此核心设计原则是：

> **"够用即可，渐进增强"** —— 先解决80%的问题，再按需扩展。

基于此，paw-ts 的独特设计是：

```
┌─────────────────────────────────────────────────────────────┐
│  核心创新：压缩与记忆一体化（Compress-Memory Unification）    │
│                                                              │
│  传统设计：压缩 → 丢弃信息        记忆 → 持久化信息            │
│  paw-ts  ：压缩时提取的信息 → 直接沉淀为 Session Memory       │
│            （一次计算，两份收益）                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、整体架构

### 2.1 三层渐进式上下文压缩

```
Layer 1: Prune（工具输出修剪）        ← 无 LLM，纯文本处理
    ↓ 不够时
Layer 2: Session Memory（会话记忆压缩） ← Fork 子 Agent，增量结构化提取
    ↓ 不够时
Layer 3: Auto-Compact（全对话总结）     ← Fork 子 Agent，Anchored 增量总结
```

### 2.2 三层文件型记忆

```
第1层：Project Memory    ← .paw/CLAUDE.md（项目级指令，可git提交）
第2层：Auto Memory       ← ~/.paw/projects/{项目}/memory/（自动提取笔记）
第3层：Session Memory    ← ~/.paw/projects/{项目}/session-memory/（会话级上下文）
                              ↑
                         与 Layer 2 压缩共享同一文件
```

### 2.3 与现有系统的对接

```
paw-ts 已有组件              新机制如何接入
─────────────────────────────────────────────────────────
ContextManager              增加 Compressor 接口，替换 maybeTruncate
RunEvents 流                增加 compression.started/done 事件
Orchestrator 主循环         每轮后检查压缩阈值，按需触发
SessionStore                增加 checkpoint 类型：compact-snapshot
Skill 系统                  记忆以 skill 形式注入 system prompt
```

---

## 三、上下文压缩详细设计

### 3.1 Layer 1: Prune — 工具输出修剪

**目标**：不删除对话历史，只精简旧工具结果的详细内容。零 LLM 调用。

**设计来源**：
- OpenCode 的 Prune 层（工具输出替换为占位符）
- Hermes Phase 1（单行摘要 + 去重）
- Claude Code 的 Microcompact（时间/缓存触发）

**触发条件**：每轮查询前自动运行（成本最低）

**规则**：
```typescript
const PRUNE_CONFIG = {
  protectRecentTokens: 20_000,    // 保护最近 20K tokens 的工具输出
  pruneMinimumTokens: 10_000,     // 至少释放 10K 才值得修剪
  maxToolOutputLines: 500,        // 单条工具输出最多保留 500 行
  maxToolOutputBytes: 50_000,     // 单条工具输出最多 50KB
  protectedTools: ['skill'],      // skill 工具永不修剪
};
```

**修剪策略**：
1. 从对话尾部向前遍历，累加 token
2. 超出 `protectRecentTokens` 的旧工具输出：
   - 替换为单行摘要：`<tool_result compacted: read_file(3 files, 247 lines)>`
   - 去重：相同工具+相同参数的重复结果只保留最新一次完整副本
3. 多模态内容（图片等）剥离为文本占位符：`[Attached image/png: screenshot.png]`

**paw-ts 独特优化**：
利用已有的 `classifyShellCommand()` 结果，**读命令的输出更容易被压缩**（保留统计信息即可），**写命令的输出更谨慎**（保留完整内容更久）。

### 3.2 Layer 2: Session Memory — 会话记忆压缩

**目标**：将对话中的关键信息提取为结构化 Markdown，替代被丢弃的原始消息。

**设计来源**：
- Claude Code 的 Session Memory 层（后台持续提取到 markdown）
- Hermes 的压缩前记忆钩子（`on_pre_compress`）

**核心创新：压缩与记忆一体化**

传统设计里，压缩是"丢弃"，记忆是"提取"，两者独立运行。paw-ts 将它们合并：

```
触发压缩
    ↓
先执行 Session Memory 提取（Layer 2）
    ↓
将提取的结构化内容写入 session-memory/{sessionId}.md
    ↓
用这段结构化内容 + 受保护的 tail 替代被压缩的原始消息
    ↓
下次新会话启动时，session-memory 文件自动加载为 system prompt 附件
    （跨会话记忆！）
```

**Session Memory 文件格式**（参考 Claude Code 模板，结合 paw-ts 需求简化）：

```markdown
---
session: {sessionId}
project: {projectName}
updatedAt: {timestamp}
---

# Session Memory

## Task
当前正在执行的主任务描述

## Current State
当前进度和状态（进行中/阻塞/完成）

## Files & Functions
已读写的关键文件和函数
- `src/foo.ts:bar()` — 做了什么修改

## Key Decisions
已做出的关键决策
- 使用 X 而不是 Y，因为 Z

## Errors & Fixes
遇到的错误和修复方法

## Relevant Context
用户偏好、环境信息
```

**触发条件**：
```typescript
const SESSION_MEMORY_CONFIG = {
  minMessagesToInit: 5,           // 至少 5 条消息才开始
  minTokensBetweenUpdate: 5_000,  // 两次更新间隔至少 5K tokens
  maxMessagesWithoutUpdate: 10,   // 最多 10 轮消息必须更新一次
};
```

**提取方式**：
- 在 orchestrator 的后台（非阻塞）fork 一个轻量级子 agent
- 子 agent 通过**独立的模型调用**完成，不占用主对话的上下文
- 子 agent 读取当前 session-memory.md + 新增的对话内容
- 增量更新（只修改变化的部分，不重新生成整个文件）
- 使用 `lastSummarizedMessageId` 避免重复处理

### 3.3 Layer 3: Auto-Compact — 全对话总结

**目标**：当 Session Memory 仍不足以控制上下文大小时，对整个对话进行结构化总结。

**设计来源**：
- OpenCode 的 Compaction（简洁优雅，Anchored summaries）
- Hermes Phase 3（结构化模板，辅助模型优先）
- Claude Code 的 Auto-Compact（结构化总结格式最完善）

**触发阈值**（参考三者取中）：
```typescript
const COMPACT_CONFIG = {
  thresholdRatio: 0.70,           // 上下文窗口的 70% 触发
  bufferTokens: 10_000,           // 10K token 缓冲
  maxSummaryTokens: 12_000,       // 总结输出上限
  tailTokenBudget: 0.20,          // tail 保护 20% 窗口
  protectFirstN: 2,               // 保护前 2 条消息（系统提示 + 首轮）
};
```

**边界确定**（参考 Hermes Phase 2）：
1. **Protect Head**：前 N 条消息（系统提示 + 首轮用户-助手交换）
2. **Protect Tail by token**：从尾部向前累加，直到达到 `tailTokenBudget`
3. **永不切割** tool_call/tool_result 对
4. **确保**最新的 user message 始终在 tail 中

**增量总结（Anchored）— 参考 OpenCode**：

```
第一次压缩：
  [Head: 系统提示] + [Summary A] + [Tail: 最近 2 轮]

第二次压缩（上下文又满了）：
  [Head] + [Summary A 的内容 + 新增历史 → 合并为 Summary B] + [Tail]
  
关键：不重新从头总结，而是把新历史合并进之前的总结
```

**总结模板**（综合三者优点，针对 paw-ts 优化）：

```markdown
## Active Task
当前正在执行的任务

## Goal
任务目标

## Progress
  - ✅ 已完成
  - 🔄 进行中
  - ⛔ 阻塞

## Key Decisions
已做出的关键决策及理由

## Relevant Files
涉及的关键文件及修改

## Errors & Fixes
遇到的错误和解决方法

## Next Steps
下一步计划

## Pending Questions
待确认的问题
```

**总结生成方式**：

与 Layer 2 一样，Layer 3 的总结**不占用主对话的模型调用**，而是：

1. **Fork 子 Agent**：在 orchestrator 中启动一个独立的压缩任务
2. **独立模型调用**：子 agent 发起独立的 API 请求（使用与主对话相同的模型配置，如 Claude Sonnet）
3. **Prompt 构造**：将 head 部分的完整消息 + 当前总结（如有）+ 总结模板指令传入
4. **结果注入**：子 agent 返回结构化总结后，主流程将其插入上下文，替换被压缩的历史

**为什么不复用主模型的一次调用？**
- 压缩需要读取整个对话历史（可能 50K+ tokens），让主模型在同一轮对话中"边聊边压缩"会导致响应质量下降
- 独立调用不阻塞用户交互：主对话可以继续，压缩在后台完成
- 失败隔离：压缩失败不会影响主对话

**后期优化（Hermes 思路）**：可配置一个更便宜的模型专门做压缩（如 Haiku 做压缩，Sonnet 做对话），降低 API 成本。

**Anti-Thrashing & 失败处理**（参考 Claude Code + Hermes）：
1. 连续两次压缩节省 < 15% tokens → 跳过（无效压缩）
2. 连续 3 次失败 → 熔断，不再尝试自动压缩
3. LLM 总结失败 → 插入 fallback marker（保留关键上下文）
4. 上下文长度错误 → 逐级降级探测窗口大小

### 3.4 与 paw-ts RunEvents 的集成

```typescript
// 新增事件类型
interface RunEvents {
  // ... 现有事件 ...
  
  'compression.prune.started': { freedTokens: number };
  'compression.session_memory.updated': { file: string; tokensAdded: number };
  'compression.auto_compact.started': { beforeTokens: number };
  'compression.auto_compact.done': { afterTokens: number; summaryTokens: number };
  'compression.skipped': { reason: string };
}
```

TUI 显示：
- 压缩进行时显示轻量提示：`Compacting context (+3K → -12K tokens)`
- 压缩完成后显示结果：`Context compressed: 45K → 18K tokens`

---

## 四、记忆机制详细设计

### 4.1 第1层：Project Memory（项目级）

**文件位置**：
- `.paw/CLAUDE.md` — 项目级指令，可 git 提交
- `.paw/CLAUDE.local.md` — 本地私有，不提交 git

**设计来源**：Claude Code 的 Project/Local memory 层

**内容**：开发者手动编写，告诉 AI 项目特定的规则：
```markdown
# Project Rules

- 使用 bun 而不是 npm
- 测试必须连接真实数据库，不要 mock
- 所有 API 端点必须验证输入
```

**加载时机**：
```
启动时
  ↓
扫描 .paw/CLAUDE.md 和 .paw/CLAUDE.local.md
  ↓
合并注入 system prompt（作为 skill 的一部分）
```

**与 Skill 系统对接**：
Project Memory 本质上就是一个内置 skill。paw-ts 的 Skill 系统已经支持从磁盘加载 SKILL.md 并注入上下文。我们可以复用这个机制：

```typescript
// 在 Skill 系统的扫描逻辑中增加：
const MEMORY_PATHS = ['.paw/CLAUDE.md', '.paw/CLAUDE.local.md'];
// 将其内容作为隐式 skill 注入 system prompt
```

### 4.2 第2层：Auto Memory（自动提取记忆）

**文件位置**：`~/.paw/projects/{项目路径哈希}/memory/`

```
~/.paw/projects/{hash}/
  ├── MEMORY.md          ← 索引文件
  ├── user_role.md       ← 用户角色/偏好
  ├── feedback_testing.md ← 用户纠正/指导
  ├── project_state.md   ← 项目状态/决策
  └── reference_linear.md ← 外部资源指针
```

**设计来源**：Claude Code 的 Auto-memory 层

**四种记忆类型**：
| 类型 | 存储内容 | 示例 |
|------|----------|------|
| `user` | 用户角色、偏好、知识背景 | "用户是后端工程师，主要用 Go 和 Python" |
| `feedback` | 用户的纠正和指导 | "不要用 mock 测试数据库" |
| `project` | 项目状态、决策、约束 | "周四冻结代码，移动端发版" |
| `reference` | 外部资源指针 | "bug 在 Linear 项目 INGEST 中跟踪" |

**文件格式**：
```markdown
---
name: 测试策略
escription: 禁止使用 mock 数据库
type: feedback
---

不要用 mock 测试数据库。上季度 mock 测试通过了但生产迁移失败。

**Why:** mock 和真实数据库的行为差异掩盖了迁移脚本的问题

**How to apply:** 所有集成测试必须连接真实数据库实例
```

**索引文件 MEMORY.md**：
```markdown
- [用户角色](user_role.md) — 后端工程师，Go/Python
- [测试策略](feedback_testing.md) — 禁止 mock 数据库
- [发布冻结](project_release.md) — 5月15日移动端发版
```

**提取流程**：
```
每轮对话结束后
  ↓
后台触发【记忆提取 Agent】（非阻塞，轻量级）
  ↓
分析最近 N 条消息
  ↓
如果本轮主 Agent 已写过记忆 → 跳过（避免重复）
  ↓
判断信息类型（user/feedback/project/reference）
  ↓
写入对应 .md 文件 + 更新 MEMORY.md 索引
```

**用户命令**：
| 命令 | 作用 |
|------|------|
| `/memory` | 打开编辑器浏览所有记忆文件 |
| `/remember` | 让 AI 审查 auto-memory，提议提升到 Project Memory |

### 4.3 第3层：Session Memory（会话级）

**文件位置**：`~/.paw/projects/{hash}/session-memory/{sessionId}.md`

**设计来源**：Claude Code Session Memory + Hermes 内置 MEMORY.md

**核心创新：与上下文压缩 Layer 2 共享同一文件**

```
【压缩时】
对话增长 → 触发 Session Memory 提取
    ↓
将关键信息写入 session-memory/{sessionId}.md
    ↓
用该文件内容替代被压缩的原始消息

【新会话启动时】
发现存在 session-memory/{sessionId}.md（从 checkpoint 恢复）
    ↓
将其加载为 system prompt 的 "Previous Session Context" 附件
    ↓
AI 知道之前做了什么

【新会话（无恢复）】
检查 ~/.paw/projects/{hash}/session-memory/ 目录
    ↓
读取最近的 session memory 文件
    ↓
注入 system prompt 作为 "Recent Session Summary"
```

**这实现了"免费"的跨会话记忆**：不需要额外的记忆提取逻辑，压缩时已经做了信息提取，只是复用这份提取结果。

### 4.4 记忆召回

**启动时加载**（参考 Claude Code）：
```
1. 加载 .paw/CLAUDE.md（项目指令）
2. 加载 ~/.paw/projects/{hash}/memory/MEMORY.md（索引）
3. 如果有恢复的 session → 加载对应 session-memory.md
```

**查询时召回**（简化版，后期可升级为语义搜索）：
```
用户输入新消息
  ↓
关键词匹配：从 MEMORY.md 索引中筛选相关记忆文件
  ↓
读取最多 3 个相关记忆文件（上限 200 行 / 4KB）
  ↓
以 <system-reminder> 形式注入当前上下文
```

**Freshness 追踪**：每条记忆记录修改时间。超过 7 天未更新的记忆带提示：`"此记忆已 N 天未更新，请核实后再引用"`。

---

## 五、压缩与记忆的协同设计

### 5.1 协同流程

```
对话进行...
    ↓
Layer 1 Prune（每轮前）
  → 清理旧工具输出，无需记忆操作
    ↓
对话继续增长...
    ↓
Layer 2 Session Memory（触发阈值）
  → 提取关键信息 → 写入 session-memory.md
  → 同时更新 ContextManager：用 session memory 摘要替代被压缩的历史
    ↓
仍然不够？
    ↓
Layer 3 Auto-Compact（最终手段）
  → 生成结构化总结
  → 将总结内容追加到 session-memory.md（避免信息丢失）
  → 用总结替代被压缩的历史
    ↓
新会话启动（从 checkpoint 恢复）
  → 加载 session-memory.md 作为 Previous Session Context
  → AI 直接继承上一会话的压缩/记忆成果
```

### 5.2 信息流向

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  原始对话     │────▶│  Layer 2/3 压缩  │────▶│ Session      │
│  历史消息     │     │  （提取关键信息） │     │ Memory .md   │
└──────────────┘     └─────────────────┘     └──────┬───────┘
        │                                           │
        │（被替代）                                  │（新会话加载）
        ▼                                           ▼
┌──────────────┐                           ┌──────────────┐
│ 精简上下文    │                           │ System Prompt │
│（Summary +   │                           │ + Session    │
│  Tail）       │                           │ Memory 附件   │
└──────────────┘                           └──────────────┘
        ▲                                           │
        │                                           │（同时）
        │     ┌─────────────────┐                   │
        └─────│ Auto Memory     │◀──────────────────┘
              │（user/feedback/  │
              │ project/reference）│
              └─────────────────┘
```

### 5.3 与 paw-ts 现有架构的对接点

| 现有组件 | 对接方式 |
|----------|----------|
| **ContextManager** | 增加 `Compressor` 接口，替换 `maybeTruncate()`。Compressor 内部按 Layer 1→2→3 递进触发 |
| **Orchestrator** | 每轮结束后检查 token 估算，触发 Session Memory 更新；主循环支持从 checkpoint 恢复时加载 session-memory |
| **RunEvents** | 新增 `compression.*` 系列事件，TUI 可显示压缩状态 |
| **SessionStore** | checkpoint 保存时额外保存 session-memory.md 路径；恢复时自动加载 |
| **Skill 系统** | Project Memory (`.paw/CLAUDE.md`) 作为隐式 skill 注入 |
| **Tool Registry** | `run_shell` 的分类结果影响 Prune 策略（读命令更易压缩） |

---

## 六、关键设计决策

### 6.1 为什么选择「压缩与记忆一体化」？

| 传统分离设计 | paw-ts 一体化设计 |
|-------------|-------------------|
| 压缩：丢弃信息，生成 summary | 压缩：提取信息，生成 summary + 写入文件 |
| 记忆：独立提取 Agent 分析对话 | 记忆：复用压缩时的提取结果 |
| 两份 LLM 调用成本 | 一份 LLM 调用，两份收益 |
| 压缩和记忆可能不一致 | 压缩和记忆天然一致 |

**代价**：session-memory.md 会包含一些仅对当前会话有用的临时信息（不像 auto-memory 那样精炼）。但相比节省的 LLM 调用成本和实现复杂度，这是可接受的 trade-off。

### 6.2 为什么记忆召回先用关键词匹配而非语义搜索？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 关键词匹配（初期） | 零依赖、零延迟、实现简单 | 精度有限 |
| 语义搜索（后期） | 精度高，能理解查询意图 | 需要 embedding 模型/服务，增加复杂度 |

**决策**：先实现关键词匹配（按文件名和 frontmatter 的 name/description 匹配）。后期如需升级，可在 `~/.paw/` 下增加 SQLite + embedding 缓存。

### 6.3 为什么 Session Memory 不是"冻结快照"？

Hermes 采用冻结快照设计（会话期间系统提示词不变，有利于 prefix cache）。但 paw-ts 目前没有多模型支持，也没有 prefix cache 优化的强需求。

**决策**：Session Memory 可以在会话中动态更新（新压缩完成后立即注入），让 AI 立即看到更新后的上下文。这比节省少量 token 更有价值。

### 6.4 Token 估算策略

paw-ts 目前没有精确的 token 计数器。参考三个系统的策略：

| 系统 | 策略 |
|------|------|
| Claude Code | API 精确计数 + 启发式估算 |
| OpenCode | `length / 4` 启发式 |
| Hermes | `length / 4` + 图片固定 1500 |

**paw-ts 决策**：
- 初期使用 `length / 4` 启发式（与 FakeModel 一致）
- 图片固定 1000 tokens/张
- 工具 schema 计入上下文（参考 Hermes）
- 后期接入 tiktoken 做精确计数

### 6.5 为什么压缩和记忆都要 Fork 子 Agent，而不是让主模型自己处理？

这是最容易误解的设计点。Claude Code、OpenCode、Hermes 三者虽然实现方式不同，但有一个共同点：**压缩/记忆提取都是在主对话之外的独立调用**。

| 方案 | 做法 | 问题 |
|------|------|------|
| **让主模型自己压缩** | 在主对话的 system prompt 里加一条"请顺便总结历史" | 自指悖论：模型要边生成回复边总结自己，质量极差 |
| **压缩作为工具调用** | 让主模型调用一个 `compact_context` 工具 | 模型需要理解何时该压缩（增加认知负担），且一次调用可能不足以处理大量历史 |
| **Fork 子 Agent（推荐）** | 独立调用模型，专门输入历史+模板，输出总结 | 职责分离，质量高，失败可重试，不阻塞主对话 |

**Claude Code 的 Fork Subagent**：
- 压缩时 fork 一个独立 agent，传入完整对话 + summary prompt
- 该 agent 复用主对话的 prompt cache，不重新构建整个 prompt
- 压缩完成后，主对话继续，无感知

**OpenCode 的 Compaction Agent**：
- 独立进程运行，将 head 消息发送给专用 agent
- 返回的总结直接替换被压缩部分

**Hermes 的 Auxiliary Model**：
- 优先用更便宜的模型（如 Haiku）做压缩
- 独立调用，失败时回退主模型

**paw-ts 的选择**：
- Layer 2（Session Memory）和 Layer 3（Auto-Compact）都用 **Fork 子 Agent + 独立模型调用**
- 使用与主对话相同的模型配置（如都用 Sonnet），不区分"主/辅助"模型（简化配置）
- 压缩 agent 的调用通过 paw-ts 已有的 `subAgentLauncher` 机制实现

---

## 七、实施路线图

### Phase 1: 基础压缩（P0）

**目标**：解决上下文溢出的紧急问题

1. **Prune 层实现**
   - 修改 `ContextManager`，在 `maybeTruncate()` 之前先执行 Prune
   - 实现工具输出行数/字节截断、单行摘要替换
   - 复用 `classifyShellCommand()` 结果优化策略

2. **Token 估算**
   - 实现简单的 `estimateTokens(text)`：`text.length / 4`
   - 上下文窗口阈值检查

3. **RunEvents 扩展**
   - 新增 `compression.prune.*` 事件
   - TUI 显示压缩状态

**预期收益**：长对话中工具输出不再撑爆上下文，Release Ready。

### Phase 2: 结构化压缩（P1）

**目标**：长对话的语义保留

1. **Session Memory 文件系统**
   - 创建 `~/.paw/projects/{hash}/session-memory/` 目录结构
   - 实现 Markdown 读写 + frontmatter 解析

2. **Session Memory 提取**
   - 在 Orchestrator 中增加后台提取 Agent
   - 实现增量更新逻辑
   - 与 ContextManager 集成：用 session memory 替代被压缩历史

3. **Auto-Compact 层**
   - 实现 Fork 子 Agent 进行全对话总结（独立模型调用）
   - Anchored 增量总结（合并新历史到旧总结）
   - Head/Tail 保护策略
   - 结构化总结模板

4. **Anti-Thrashing**
   - 连续节省 < 15% 跳过
   - 3 次失败熔断

**预期收益**：1 小时以上的长对话也能保持上下文连贯。

### Phase 3: 跨会话记忆（P1）

**目标**：AI 记住用户和项目

1. **Project Memory**
   - 支持 `.paw/CLAUDE.md` 和 `.paw/CLAUDE.local.md`
   - 与 Skill 系统对接，作为隐式 skill 注入

2. **Auto Memory**
   - 实现后台记忆提取 Agent（Fork 子 Agent，独立模型调用）
   - 四种类型（user/feedback/project/reference）
   - `MEMORY.md` 索引管理

3. **记忆召回**
   - 启动时加载相关记忆
   - 查询时关键词匹配注入

4. **用户命令**
   - `/memory` 命令浏览/编辑记忆
   - `/remember` 命令审查和提升记忆

**预期收益**：新开会话时 AI 知道项目规则、用户偏好、之前的决策。

### Phase 4: 高级优化（P2）

**目标**：性能和质量进一步提升

1. **精确 Token 计数**：接入 tiktoken
2. **语义记忆搜索**：SQLite + embedding
3. **Auto-Dream**：夜间自动整理记忆（去重、合并、过期清理）
4. **Context Collapse**：实验性精细分段总结（参考 Claude Code Layer 6）

---

## 八、与参考系统的对比总结

| 维度 | Claude Code | OpenCode | Hermes | **paw-ts（本方案）** |
|------|-------------|----------|--------|----------------------|
| **压缩层数** | 6 层 | 2 层 | 4 阶段 | **3 层（精简够用）** |
| **压缩触发** | context - 13K | context - 20K | context × 50% | **context × 70%** |
| **总结方式** | Fork subagent | Compaction agent | Auxiliary model | **Fork 子 Agent（独立调用，后期可加 auxiliary）** |
| **增量更新** | Session Memory | Anchored summaries | Iterative updates | **Session Memory + Anchored** |
| **记忆类型** | 7 层文件型 | 无 | 2 层 + 8 插件 | **3 层文件型** |
| **跨会话** | ✅ 自动 + 手动 | ❌ | ✅ 内置 + 插件 | **✅ 自动（压缩沉淀）+ 手动** |
| **团队共享** | ✅ Team memory | ❌ | ❌ | **❌（个人工具，暂不需要）** |
| **核心创新** | 最完善 | 最精简 | 可插拔 | **压缩-记忆一体化** |

---

## 九、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Session Memory 文件过大 | 加载慢、上下文膨胀 | 限制单文件 4KB，超过时触发整理 |
| 压缩导致信息丢失 | AI 忘记关键细节 | Head/Tail 保护 + 增量更新 + 用户可配置阈值 |
| 记忆注入过多 | 干扰当前任务 | 限制注入记忆数量（最多 3 条）， freshness 过滤 |
| 后台 Agent 失败 | 压缩/记忆不更新 | 主流程不依赖后台 Agent，失败时静默跳过 |
| Prompt injection 污染记忆 | 安全问题 | 扫描写入内容中的异常模式，用户确认敏感记忆 |

---

## 十、最小可运行原型（MVP 范围）

如果只能做最少的工作让系统"跑起来"，MVP 包含：

1. **Prune 层**：工具输出截断到 500 行/50KB（50 行代码）
2. **Session Memory 文件**：对话超过 20 轮时，fork Agent 生成一段摘要写入 `~/.paw/session-memory/latest.md`（200 行代码）
3. **Project Memory**：启动时读取 `.paw/CLAUDE.md` 注入 system prompt（50 行代码）

总计约 300 行代码，即可实现：
- ✅ 长对话不因工具输出而溢出
- ✅ 跨会话继承上一会话摘要
- ✅ 项目规则持久化
