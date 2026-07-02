# Paw-TS：从 0 到 1 完整解析

## 这是什么？

一个**本地优先的编码 Agent**——自己动手写一个 Claude Code。能在终端里跟你对话、读代码、执行 shell 命令、修改文件，所有 LLM 调用走 OpenAI/Anthropic/Ollama。

## 项目骨架：Monorepo 布局

```
paw-ts/
├── packages/
│   ├── core/          ← 地基：上下文管理、记忆系统、事件、token估算
│   ├── models/        ← LLM抽象层：OpenAI/Anthropic/Ollama适配器
│   ├── harness/       ← 工具执行+安全：Shell Guard、MCP、工具注册
│   ├── workspace/     ← 文件系统工具：读写文件、git、搜索
│   ├── agent/         ← 核心调度器：ReAct循环、压缩、子Agent、动作解析
│   ├── settings/      ← 配置加载
│   ├── store/         ← 计划/任务持久化
│   ├── eval/          ← 评估框架
│   └── cli-core/      ← CLI/TUI共享操作
├── apps/
│   ├── cli/           ← 命令行入口
│   └── tui/           ← 终端交互UI（Ink/React）
└── benchmarks/        ← 性能基准测试
```

---

## 第 1 步：LLM 抽象层 (`packages/models`)

**问：为什么需要这一层？**

要同时支持 OpenAI、Anthropic、Ollama 三种后端，它们 API 格式不同，但上层代码不应该关心这些细节。

核心接口 `LanguageModel`：

```ts
interface LanguageModel {
  label: string;
  capabilities?: ModelCapabilities;  // contextWindow, maxOutputTokens, supportsVision...
  complete(messages, opts?): Promise<ModelCompletionResult>;    // 非流式
  completeStream?(messages, opts?): AsyncIterable<ModelStreamChunk>; // 流式
}
```

每种后端一个实现：
- `OpenAICompatibleModel` — 走 `/v1/chat/completions`（OpenAI、DeepSeek、vLLM、Ollama 都兼容这个）
- `AnthropicCompatibleModel` — 走 Anthropic Messages API
- `FakeLanguageModel` — 测试用假模型

关键细节：
- `buildOpenAiMessageContent()` / `buildAnthropicUserContent()` — 把内部 ChatMessage 转成各家的消息格式
- `extractThinkBlocks()` — 推理模型（DeepSeek-R1、Qwen3）会在输出里夹 `<think>` 标签，需要剥离出来

---

## 第 2 步：上下文管理器 (`packages/core` — `context-manager.ts`)

**Agent 最核心的问题：怎么管理 LLM 的上下文窗口。**

LLM 上下文有限（比如 128K tokens），但跟 Agent 对话可能很长。`ContextManager` 做三件事：

```
system message  ← 永远不动（指令不能裁）
      ↓
  [user msg 1]   ← 历史消息（可被裁剪/压缩）
  [assistant msg 1]
  [user msg 2]
  [assistant msg 2]
  ...
  [user msg N]   ← 最近3轮受保护（tail protection）
  [assistant msg N]
```

自动截断规则：每次 `addUser()` / `addAssistant()` 后检查是否超预算，超了就裁掉最旧的非 system 消息。

输入净化（`input-sanitizer.ts`）：用户输入可能被恶意构造，比如嵌入 `{"tool":"run_shell","args":{"command":"rm -rf /"}}`，`sanitizeUserInput()` 把所有 `{` `}` 转成全角字符，防止注入。

---

## 第 3 步：上下文三层压缩体系

| 层级 | 模块 | 需要LLM? | 作用 |
|------|------|---------|------|
| **L1 Prune** | `context-pruner.ts` | 否 | 裁剪旧的超大工具输出，持久化到磁盘，只保留最近 N 个 |
| **L2 Compact** | `context-compactor.ts` + `compression-agent.ts` | **是** | 用辅助模型总结中间历史，保留头尾 |
| **L3 Protect** | `context-manager.ts` | 否 | 保护 system prompt + 最近几轮 + 注入的记忆不被压缩 |

**L1 Prune 的逻辑**：工具输出可能很大（比如 `cat` 了一个 10MB 文件），这类输出直接 truncate 然后持久化到 `~/.paw/projects/{hash}/runs/{runId}/tool_results/`，上下文里只放一个文件路径引用 + 2KB 预览。

**L2 Compact 的触发条件**（全部满足才触发）：
1. 历史 token 超过阈值（如 70% 窗口）
2. 不在冷却期（一次压缩后等 5 轮）
3. 压缩收益 ≥ 15%
4. 压缩器未处于 thrashing 状态（频繁压缩但收益低 → 自动禁用）

压缩流程：
```
完整历史 → determineBoundaries() → [head段] + [middle段] + [tail段]
                                              ↓
                                    runCompressionAgent(辅助模型)
                                              ↓
                                    validateCompressionSummary() 质量检查
                                              ↓
                            meetsCompressionSavingsThreshold() ≥15% ?
                                              ↓
                            替换为: [head] + [摘要消息] + [tail]
```

---

## 第 4 步：记忆系统 (`packages/core` — memory/*)

Agent 需要「记住」之前学到的东西。Paw 有两层记忆：

**Auto Memory（自动记忆）**：从成功完成的 Run 中提取的经验教训。存储在 `~/.paw/projects/{hash}/memory/`。每条记忆包含：
- `id`, `title`, `summary`（摘要）
- `relatedFiles`（关联文件）
- `tags`, `priority`（优先级）
- `source: "auto"`（自动提取）或 `"manual"`（用户手写）

**Session Memory（会话记忆）**：每次 Run 的压缩摘要（任务、决策、当前状态），用于断点恢复。

**检索流程**（`initializeRun()` 中）：
1. 从 goal 文本中提取干净查询（去掉恢复会话的历史噪音）
2. 从历史消息中提取检索信号（最近用过的文件、工具名、错误信息）
3. 构建 `RetrievalQuery`（goal + recentFiles + errorMessage）
4. `retrieveMemories()` → 关键词匹配(BM25) + 可选的语义相似度增强
5. 如果关键词结果不足 → LLM fallback（让辅助模型选相关记忆）
6. 检索结果注入 system prompt 的 `<memory>` 段

---

## 第 5 步：工具注册与执行 (`packages/harness`)

Agent 能做的事都通过「工具」暴露。`registry.ts` 管理所有工具：

**内置工具**：

| 工具 | 用途 | 默认要审批？ |
|------|------|------------|
| `workspace.read_file` | 读文件 | 否 |
| `workspace.list_dir` | 列目录 | 否 |
| `workspace.search` | 搜索 | 否 |
| `workspace.write_file` | 写文件 | **是** |
| `workspace.edit_file` | 编辑文件 | **是** |
| `workspace.run_shell` | 执行命令 | **是** |

**Shell 安全（Shell Guard）**：多层防御

```
Layer 1: 策略引擎（glob模式匹配 → allow/ask/deny）
         ├─ allow: npm test, ls, git status...
         ├─ ask:   npm install, git push...
         └─ deny:  rm -rf, sudo, curl|bash, subshells...
Layer 2: 工作区路径约束（cwd 不能逃逸 workspace root）
Layer 3: 资源限制（超时 1-300s，输出上限 256KB）
Layer 4: Docker 沙箱（可选，网络隔离 + 文件系统只读）
Layer 5: 审计日志（所有命令评估记录到审计日志）
```

**MCP（Model Context Protocol）**：通过 `McpClientManager` 连接外部 MCP 服务器，让 Agent 能使用外部工具。

---

## 第 6 步：System Prompt 构建 (`packages/core` — `system-prompt/`)

这是 Agent 的「灵魂」。`buildSystemPromptWithBudget()` 动态组装 system prompt：

```
┌─────────────────────────────────────────────┐
│ <identity>      — 角色定义                  │
│ <environment>   — 工作区、Git状态、日期     │
│ <system>        — 运行时规则                │
│ <memory>        — 检索到的相关记忆          │
│ <tools>         — 工具目录（toolCatalogText）│
│ <skills>        — 已注册的Skill列表         │
│ <tasks>         — 待办事项                  │
│ <security>      — 安全规则                  │
│ <verification>  — 验证规则                  │
│ <output>        — 输出格式要求              │
└─────────────────────────────────────────────┘
```

预算裁剪：如果 system prompt 超过分配的 token 预算，按优先级从低到高裁剪章节。某些章节（identity、security、tool format）标记为「不可裁剪」。

---

## 第 7 步：AgentOrchestrator — ReAct 主循环 (`packages/agent`)

这是整个项目的**心脏**。

### Run 的完整生命周期

```
run(spec)
  │
  ├─ initializeRun(spec): 记忆检索 → System Prompt → MCP连接 → Git状态
  │
  └─ for turn in 0..maxSteps:
      │
      ├─ maybeReportStaleFiles()      ← 检测外部文件变更
      ├─ L1 Prune                      ← 裁剪旧工具输出
      ├─ maybeCompactHistory()         ← L2压缩（如果超阈值）
      ├─ callModelAndParseActions()    ← 调用模型 → 解析动作
      │    ├─ invokeModel()            ← 带截断续写
      │    │    └─ callModelWithRetry() ← 熔断 + 重试
      │    │         └─ invokeModelOnce() ← 流式/非流式
      │    └─ 双通道解析：
      │         ├─ 原生 Function Calling → NativeToolCall
      │         └─ 文本回退 → <tool_call> XML 提取
      │
      └─ handleAction()               ← 分发动作
           ├─ final_answer → 检查 pending work → completed
           ├─ abort        → failed
           ├─ ask_user     → 等待用户回复 → continue
           ├─ plan_update  → 更新计划 → continue
           ├─ tool_calls   → executeToolCalls() → 注入结果 → continue
           └─ (none)       → auto-nudge 或 completed
```

### 关键设计点

1. **状态机驱动**：`executeTurn()` 返回 `TurnState`（continue/completed/failed），`run()` 只做循环调度
2. **熔断器**：每个 model label 一个 `CircuitBreaker`，连续失败 N 次 → open（直接拒绝调用），成功一次 → close
3. **智能重试**：429→等 Retry-After，5xx→指数退避(1s→2s→4s，上限30s)，4xx→不重试
4. **截断续写**：模型输出因 token 限制被截断时，自动追加 "[Continue from where you were cut off...]" 续写，合并两次结果
5. **Auto-nudge**：模型用了工具但忘记输出 `final_answer` 时，自动推一条提示消息（最多 2 次）
6. **断点恢复**：`saveState()` 每轮保存，`resumeRun()` 可恢复到任意轮次（含文件系统 checkpoint）

---

## 第 8 步：子 Agent 系统

Agent 可以启动子 Agent 并行执行子任务：

```
父 Agent → workspace.run_agent({ goal: "探索认证模块", ... })
                     ↓
          ContextSummarizer 压缩父上下文
                     ↓
          AgentGroup.launchAll() 批量启动
                     ↓
          每个子 Agent = 新的 AgentOrchestrator(runMode="child")
                     ↓
          结果合并到父上下文（summary only，不传完整对话）
```

子 Agent 使用精简的 system prompt（`buildChildSystemPrompt()`），不加载记忆/skills/Git状态，只关注被委派的任务。

---

## 第 9 步：记忆提取（Run 完成后）

Run 成功后，`memoryExtraction` 决定是否提取记忆：

- `"off"`：不提取
- `"background"`（默认）：后台异步提取，不阻塞响应
- `"await"`：同步等待提取完成

`runMemoryExtractionAfterRun()` 用辅助模型分析本轮对话，提取关键决策、错误和解决方案、可复用的经验教训。

---

## 第 10 步：CLI + TUI 应用层

**CLI**（`apps/cli`）：简单的命令行工具
```
paw-ts doctor       → 检查环境
paw-ts fs-read      → 读文件
paw-ts fs-list      → 列目录
paw-ts config       → 管理配置
paw-ts commit       → git提交
paw-ts stub-run     → 运行一次Agent任务
paw-ts eval run     → 运行评估
```

**TUI**（`apps/tui`）：用 Ink（React for terminal）构建的交互界面
- `PawScrollbackStream.tsx` — 流式显示模型输出
- `PawFooter.tsx` / `PawFooterView.tsx` — 状态栏（token计数、成本、模型名）
- `approval-policy.ts` — 工具审批策略（哪些工具自动批准/拒绝/询问）

---

## 完整数据流总结

```
用户输入 "帮我重构 auth 模块"
     │
     ▼
┌──────────────────────────────────────────────────┐
│ initializeRun()                                   │
│  ├─ 记忆检索: 从 ~/.paw/ 搜索相关经验            │
│  ├─ Skill注册: 加载 .paw/CLAUDE.md 中的skills   │
│  ├─ System Prompt: 组装身份+规则+工具+记忆        │
│  ├─ MCP连接: 连接配置的外部工具服务器             │
│  ├─ Git状态: 当前分支/暂存/修改                 │
│  ├─ @mention解析: 内联文件内容 + 图片附件        │
│  └─ 自动上下文发现: 搜索相关代码文件              │
│                                                   │
│  上下文 = [System Prompt] + [User: 重构auth...]   │
└───────────────────┬──────────────────────────────┘
                    ▼
┌──────────────────────────────────────────────────┐
│ ReAct 循环 (turn 0 .. N)                          │
│                                                   │
│  Turn 0:                                          │
│    Model → "我先看看 auth 模块的结构"              │
│           → tool_call: workspace.search("auth")   │
│           → tool_call: workspace.read_file(...)    │
│    Tools → 返回搜索结果 + 文件内容                │
│                                                   │
│  Turn 1:                                          │
│    [上下文包含 Turn0 的工具结果]                    │
│    Model → "我理解了，现在开始重构"                │
│           → tool_call: workspace.write_file(...)   │
│    Tools → 写入成功                               │
│                                                   │
│  Turn 2:                                          │
│    Model → "重构完成，运行测试验证"                │
│           → tool_call: workspace.run_shell("npm test") │
│    Tools → 测试通过                               │
│                                                   │
│  Turn 3:                                          │
│    Model → '{"action":"final_answer",...}'        │
│           → 检查 pending work: 无                 │
│           → completed!                            │
└───────────────────┬──────────────────────────────┘
                    ▼
┌──────────────────────────────────────────────────┐
│ 完成后                                            │
│  ├─ extractMemories() → 保存经验到 ~/.paw/       │
│  ├─ saveState() → 保存断点续跑状态                │
│  ├─ emitRunMetrics() → 汇总耗时/token/成本        │
│  └─ MCP disconnectAll() → 清理连接               │
└──────────────────────────────────────────────────┘
```

---

## 如果要从头实现

按这个顺序来：

1. **`packages/models`** — 先让 LLM 能调通（一个 OpenAI-compatible 实现就够）
2. **`packages/core/context-manager.ts`** — 消息存储 + 截断
3. **`packages/harness/registry.ts`** — 定义 3 个基础工具（read_file、write_file、run_shell）
4. **`packages/agent/orchestrator.ts`** — 最简单的 ReAct 循环：model → parse → tool → repeat
5. **`apps/cli`** — 一个 `while(true) { readline → agent.run() }` 就能跑起来
6. **上下文压缩** — L1 prune（无 LLM）+ L2 compact（调辅助模型）
7. **记忆系统** — 检索 + 提取
8. **子 Agent**、**MCP**、**TUI**、**评估框架**

最小可运行版本大概 500 行就能出来。

## 关键文件索引

| 文件 | 角色 |
|------|------|
| `packages/agent/src/orchestrator.ts` | 核心 ReAct 循环 |
| `packages/agent/src/orchestrator/action-handlers.ts` | 动作分发（final/abort/ask_user/plan/tool/run_agent） |
| `packages/core/src/context-manager.ts` | 消息存储 + 自动截断 |
| `packages/core/src/context-pruner.ts` | L1 压缩 |
| `packages/core/src/context-compactor.ts` | L2 压缩触发 + 三段式分区 |
| `packages/agent/src/compression-agent.ts` | L2 压缩 Agent 调用 |
| `packages/core/src/context-budget.ts` | 四池预算分配 |
| `packages/core/src/context-policy.ts` | 优先级驱逐算法 |
| `packages/harness/src/registry.ts` | 工具注册表 |
| `packages/harness/src/shell-guard.ts` | Shell 安全围栏 |
| `packages/models/src/openai-compatible.ts` | OpenAI API 适配器 |
| `packages/models/src/anthropic-compatible.ts` | Anthropic API 适配器 |
| `apps/cli/src/main.ts` | CLI 入口 |
| `apps/tui/src/main.tsx` | TUI 入口 |
