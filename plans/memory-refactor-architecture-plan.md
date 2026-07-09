# Paw 记忆机制重构架构与升级方案

## 目标

这次重构的目标不是继续给现有检索算法加功能，而是把 Paw 的记忆机制拆成清晰的几层：

```text
TaskState       当前任务短期状态
MemoryStore     长期记忆读写与元数据
MemoryRouter    当前任务需要查哪些记忆
MemoryRetriever 召回、打分、预算选择
ContextBuilder  组装本轮模型真正看到的 Context Package
ContextManager  消息窗口、工具结果裁剪、压缩、token 预算
MemoryWriter    任务结束后决定哪些内容沉淀为长期记忆
```

最终希望 Paw 能稳定回答这些问题：

- 当前任务做到哪一步？
- 哪些用户约束和失败断言不能丢？
- 当前任务需要哪些项目规则、失败经验、任务经历和用户偏好？
- 哪些信息只需要可重新读取，不应该塞进 prompt？
- 任务结束后哪些内容值得长期保存？
- 旧记忆和当前代码冲突时，谁说了算？

## 当前收口状态（2026-07-06）

P0-P8 已完成第一轮落地，当前重点已经从“继续加阶段”转为“收口验证、文档同步、后续产品化”。

已完成：

- P0 Provider boundary：`memory.list/read/save/delete` 统一走 provider，默认 file provider 保持兼容。
- P1 Memory schema：新增 `kind/confidence/status/evidence` 等 Coding Agent 语义字段，并兼容旧记忆。
- P2 TaskState：短期任务状态独立维护，记录目标、约束、读写文件、命令、测试结果和 resume 状态。
- P3 ContextBuilder：模型请求前生成稳定 `[Context Package]`，不再只把检索结果散装塞进 prompt。
- P4 MemoryRouter：按任务类型路由检索，bug fix/refactor/simple script 等任务有不同记忆优先级。
- P5 MemoryWriter：统一长期记忆写入入口，集中处理敏感信息、去重、默认 metadata 和写入门槛。
- P6 JSON Extraction：记忆抽取改为结构化 JSON，非法 JSON 不写入，避免 markdown parser 写脏记忆。
- P7 Code Context：新增轻量代码索引与 `[Relevant Code]`，无索引时可降级。
- P8 Hygiene / Reflection：反思与归档优先使用 `deprecated/superseded/needs-review`，不自动删除高置信用户偏好。

已验证：

```bash
bun run typecheck
bun test packages/memory
bun test packages/workspace
bun test packages/agent
bun test packages/core packages/settings packages/harness packages/models packages/store apps/cli apps/tui
bun run test:ts
```

验证结果：

- TypeScript 全包类型检查通过。
- `bun run test:ts` 结果：622 pass，1 skip，0 fail，1595 expects，83 files。
- `packages/agent` 全量通过：177 pass，1 skip，0 fail。
- `packages/memory` 全量通过：164 pass，0 fail。
- `packages/workspace` 全量通过：115 pass，0 fail。
- 端到端 smoke 通过：`AgentOrchestrator + FakeLanguageModel` 在临时工作区完成 `read_file -> write_file -> final_answer`，并确认 `memory.retrieve.done`、`[Context Package]`、`[Relevant Code]`、`.paw/code-index/repo-map.json` 全部出现。

本轮额外修复：

- stream recovery 写入临时文件后等待关闭并吞掉 late error，避免 `.paw/streams/.../turn-*.tmp` 被清理后触发未处理 `ENOENT`。
- compaction skip reason 文案恢复为测试期望的 `insufficient compression savings (<15%)`。
- reflection consolidation 删除范围收窄为 LLM 明确合并的条目，避免误删同组中受保护的高置信用户偏好。

剩余后续：

- 把新增机制整理成面向开发者的架构说明，放到 repo docs 或 README 链接中。
- 增加真实项目级 dogfood run，覆盖“读代码索引 -> 修改代码 -> 跑测试 -> 写入长期记忆 -> 下次任务召回”。
- 评估 shell sandbox policy 是否需要给本地 smoke/test 命令提供更明确的 allow 规则；当前全量测试已覆盖 shell 工具，临时 smoke 不依赖 shell 步骤。
- 后续再考虑 SQLite/mem0、graph memory、多 agent 共享记忆协议等 P9+ 能力。

## 当前问题

### 1. 记忆、上下文、检索混在一起

目前 `AgentOrchestrator` 同时负责：

- 创建 `FileProvider`
- 创建 `UnifiedMemoryStore`
- 检索记忆
- 把记忆塞进 system prompt
- 每轮动态注入 turn memory
- run 结束后触发记忆提取
- compact 后抽取 session highlights
- short session memory
- background review

这让记忆系统很难判断边界：一个改动经常同时碰到 orchestrator、retriever、store、prompt。

### 2. 写入通道太多

当前至少有这些写入路径：

- `memory.save` 工具手动保存
- run 完成后的 LLM extraction
- compact 后 `extractSessionHighlightsToAutoMemory`
- short high-value run 的 `maybeGenerateShortSessionMemory`
- `BackgroundReview`
- reflection / consolidation

这些通道的写入标准、字段、去重、预算和开关不一致。

### 3. Provider 接口没有真正统一

代码里已经有 `MemoryProvider` / `FileProvider` / `resolveMemoryProvider()`，但主 orchestrator 仍直接 `new FileProvider()`。

`memory.save` 优先走 provider，`memory.list/read` 仍直接读 `AutoMemoryStore`。这会导致未来加 SQLite/mem0 时读写不一致。

### 4. 记忆类型不够表达 Coding Agent 场景

旧类型只有：

```text
user | feedback | project | reference
```

它无法清晰表达：

- 项目规则
- 用户偏好
- 失败模式
- 任务经历
- 模块摘要
- 调试流程
- 代码符号/测试映射

### 5. Context Builder 缺位

现在检索结果主要通过 `relevantMemories` 注入 system prompt，格式是散装 bullet。

好的 Coding Agent 不应该只是“检索到什么就放什么”，而应该按任务构造固定 Context Package：

```text
[Task]
[Hard Constraints]
[Current State]
[Pinned Context]
[Relevant Memories]
[Relevant Code]
[Tool Results]
[Known Non-Goals]
[Next Step]
```

### 6. System prompt 预算控制有漂移

`trim.ts` 里有 `maxMemoryIndexLines`，但 `getMemorySection()` 实际已经不再截断分片索引。这个参数看起来能省 token，实际不生效。

## 设计原则

1. 先重构边界，再优化算法。
2. 先保留文件存储，不急着上数据库。
3. 保留 `MemoryProvider` 抽象，但让它真的成为唯一读写入口。
4. 长期记忆必须有 `status / confidence / evidence`。
5. TaskState 是短期记忆，不直接写入长期记忆。
6. ContextBuilder 只组装上下文，不直接读写磁盘。
7. Retriever 只返回结构化记录，不拼 prompt。
8. Writer 统一所有写入门槛，不让每条通道自己保存。
9. 先做规则版本，LLM 反思和复杂 graph 放后面。
10. 每个阶段都能独立测试、独立回滚。

## 目标架构

```text
                         ┌────────────────────┐
User Goal / Resume State │ AgentOrchestrator  │
                         └─────────┬──────────┘
                                   │
                         ┌─────────▼──────────┐
                         │ TaskStateManager   │
                         │ short-term memory  │
                         └─────────┬──────────┘
                                   │
                         ┌─────────▼──────────┐
                         │ MemoryRouter       │
                         │ decide sources     │
                         └─────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
      ┌───────▼────────┐   ┌───────▼────────┐   ┌───────▼────────┐
      │ Auto Memory    │   │ Session Memory │   │ Code Index     │
      │ long-term      │   │ recent tasks   │   │ symbols/tests  │
      └───────┬────────┘   └───────┬────────┘   └───────┬────────┘
              │                    │                    │
              └────────────┬───────┴────────────┬───────┘
                           │                    │
                   ┌───────▼────────┐   ┌───────▼────────┐
                   │ MemoryRetriever│   │ CodeRetriever  │
                   │ score/select   │   │ snippets/map   │
                   └───────┬────────┘   └───────┬────────┘
                           │                    │
                           └─────────┬──────────┘
                                     │
                           ┌─────────▼──────────┐
                           │ ContextBuilder     │
                           │ Context Package    │
                           └─────────┬──────────┘
                                     │
                           ┌─────────▼──────────┐
                           │ ContextManager     │
                           │ window/compress    │
                           └────────────────────┘
```

## 新核心模块

### 1. TaskStateManager

位置：

```text
packages/agent/src/task-state.ts
```

职责：

- 维护当前任务的短期状态。
- 从用户输入、计划更新、工具结果、测试输出、文件读写事件里更新状态。
- 生成 `[Current State]`、`[Pinned Context]`、`[Next Step]`。
- 支持 resume。

建议类型：

```typescript
export interface TaskState {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly plan: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesChanged: readonly string[];
  readonly commandsRun: readonly CommandSummary[];
  readonly testResults: readonly TestResultSummary[];
  readonly currentHypothesis?: string;
  readonly rejectedHypotheses: readonly string[];
  readonly pinnedFacts: readonly string[];
  readonly knownNonGoals: readonly string[];
  readonly nextStep?: string;
  readonly updatedAt: number;
}
```

第一版只做规则更新：

- `workspace.read_file` → `filesRead`
- `workspace.write_file/edit/apply_patch` → `filesChanged`
- `workspace.run_shell` → `commandsRun`
- 测试命令输出 → `testResults`
- 用户消息中的“不要/必须/只能/do not/must” → `constraints`
- 工具失败摘要 → `pinnedFacts`

不做：

- LLM 自动推断复杂假设
- 多 agent 状态合并
- 数据库持久化

### 2. MemoryKind

位置：

```text
packages/memory/src/memory-types.ts
```

新记忆类型：

```typescript
export type MemoryKind =
  | "project_rule"
  | "user_preference"
  | "task_episode"
  | "failure_pattern"
  | "module_summary"
  | "procedure"
  | "reference";
```

旧字段 `type: "user" | "feedback" | "project" | "reference"` 暂时保留，新增 `kind`。

兼容映射：

```text
user      -> user_preference
feedback  -> failure_pattern
project   -> project_rule
reference -> reference
```

新增公共元数据：

```typescript
export interface MemoryMetadata {
  readonly kind: MemoryKind;
  readonly confidence: number;
  readonly status: "active" | "deprecated" | "superseded";
  readonly evidence: readonly string[];
  readonly validUntil?: number;
  readonly gitCommit?: string;
  readonly branch?: string;
  readonly symbols?: readonly string[];
  readonly tests?: readonly string[];
  readonly supersedes?: readonly string[];
}
```

### 3. MemoryProvider 统一入口

保留 `MemoryProvider`，但扩展成完整接口：

```typescript
export interface MemoryProvider {
  readonly name: string;
  initialize(workspaceRoot: string): Promise<void>;
  isAvailable(): boolean;
  shutdown(): Promise<void>;

  listMemory(query?: MemoryListQuery): Promise<MemoryRecord[]>;
  readMemory(id: string): Promise<MemoryRecord | null>;
  searchMemory(query: MemorySearchQuery): Promise<MemoryRecord[]>;
  saveMemory(entry: AutoMemoryEntry): Promise<"created" | "updated">;
  deleteMemory(id: string): Promise<void>;

  loadIndex(maxLines?: number): string | null;
  rebuildIndex(): Promise<void>;

  shouldReflect(): boolean;
  consolidate(complete: (system: string, user: string) => Promise<string>): Promise<ReflectionResult>;
}
```

第一阶段只实现 `FileProvider`，不要删 provider 抽象。

原因：

- provider 抽象已经存在，删除后未来再加 SQLite 又要改回去。
- 现在真正的问题不是抽象多，而是没有统一使用。
- 最懒的修法是让现有抽象生效。

### 4. MemoryRouter

位置：

```text
packages/memory/src/memory-router.ts
```

职责：

- 根据 task profile 和 task state 判断要查哪些 memory kind。
- 给不同 kind 分配预算。
- 输出多个 retrieval request，而不是一个大 query。

建议类型：

```typescript
export interface MemoryRoutePlan {
  readonly taskProfile: TaskProfile;
  readonly routes: readonly MemoryRoute[];
  readonly totalBudgetTokens: number;
}

export interface MemoryRoute {
  readonly kind: MemoryKind;
  readonly query: RetrievalQuery;
  readonly limit: number;
  readonly maxTokens: number;
  readonly required: boolean;
}
```

默认路由：

| TaskProfile | Required | Dynamic |
|-------------|----------|---------|
| `bug_fix` | `project_rule`, `user_preference` | `failure_pattern`, `task_episode`, `module_summary` |
| `refactor_arch` | `project_rule`, `user_preference` | `module_summary`, `task_episode`, `reference` |
| `simple_script` | `user_preference` | `project_rule` |
| `general` | `project_rule`, `user_preference` | `task_episode`, `reference` |

预算建议：

| Kind | Default tokens | Max records |
|------|----------------|-------------|
| `project_rule` | 700 | 5 |
| `user_preference` | 250 | 3 |
| `failure_pattern` | 600 | 4 |
| `task_episode` | 500 | 3 |
| `module_summary` | 700 | 5 |
| `procedure` | 400 | 2 |
| `reference` | 400 | 2 |

### 5. MemoryRetriever

保留现有 keyword + semantic + cascade，但让它支持 router 输出。

边界：

- 输入：`MemoryRoutePlan`
- 输出：按 kind 分组的 `SelectedMemory[]`
- 不拼 prompt
- 不直接读 settings

第一版不改核心打分，只加 kind/status/confidence/evidence 权重：

```text
status=active       x 1.0
status=deprecated   x 0.2
status=superseded   x 0.1
confidence          x (0.5 + confidence / 2)
kind match          + route boost
```

### 6. ContextBuilder

位置：

```text
packages/agent/src/context-builder.ts
```

职责：

- 接收 TaskState、selected memories、code context、tool summaries。
- 生成固定 Context Package。
- 根据预算裁剪各 section。

建议类型：

```typescript
export interface ContextPackageInput {
  readonly taskState: TaskState;
  readonly memories: readonly SelectedMemory[];
  readonly codeContext: readonly CodeContextBlock[];
  readonly toolResults: readonly ToolResultSummary[];
  readonly budget: ContextPackageBudget;
}

export interface ContextPackage {
  readonly text: string;
  readonly sections: readonly ContextSectionStats[];
  readonly pinnedTokens: number;
  readonly totalTokens: number;
}
```

固定输出格式：

```text
[Task]
...

[Hard Constraints]
...

[Current State]
...

[Pinned Context]
...

[Relevant Memories]
...

[Relevant Code]
...

[Tool Results]
...

[Known Non-Goals]
...

[Next Step]
...
```

第一版注入策略：

- run 启动时：作为第一条 user message 加在用户 goal 前。
- 每轮刷新时：替换上一条 `[Context Package]` 系统注入消息，避免无限追加。

不要一开始重写 system prompt。

### 7. MemoryWriter

位置：

```text
packages/memory/src/memory-writer.ts
```

职责：

- 统一所有记忆写入门槛。
- 规范化字段。
- 敏感信息扫描。
- 去重。
- 设置默认 confidence/status/evidence。
- 调 provider.saveMemory。

建议输入：

```typescript
export interface MemoryWriteRequest {
  readonly source: "manual" | "end_of_run" | "compact" | "reflection";
  readonly entry: Partial<AutoMemoryEntry>;
  readonly evidence?: readonly string[];
  readonly requireConfidence?: number;
}
```

保留写入通道：

- `memory.save` manual
- end-of-run extraction
- compact/session highlights

延后：

- BackgroundReview
- short session LLM
- large-scale consolidation

## Context Package 预算

以模型上下文预算中的 history/system 可用部分为基础，Context Package 第一版控制在 2k-4k tokens。

默认分配：

```text
Task / Constraints       10%
Current State            20%
Pinned Context           20%
Relevant Memories        25%
Relevant Code            20%
Tool Results / Next Step 5%
```

任务差异：

| Task | 提升预算 |
|------|----------|
| bug fix | Pinned Context, Tool Results, Failure Memory |
| refactor | Project Rule, Module Summary, Code Context |
| review | Diff, Project Rule, Failure Pattern |
| simple script | Task, Constraints, User Preference |

## 升级路线

### P0: 边界收束

目标：不改变行为，只统一入口。

改动：

- orchestrator 使用 `resolveMemoryProvider()`。
- `memory.list/read/save/delete` 全部走 provider。
- `MemoryProvider` 增加 `listMemory/readMemory/rebuildIndex`。
- `FileProvider` 实现完整接口。
- 修复或移除无效的 `maxMemoryIndexLines`。

验收：

- 现有 memory tests 通过。
- `memory.list/read/save` 对同一个 provider 生效。
- 默认配置仍是 file provider。
- 不删除任何现有功能。

### P1: Schema 扩展

目标：让记忆能表达 Coding Agent 需要的类型和可信度。

改动：

- 新增 `memory-types.ts`。
- `AutoMemoryEntry` 增加 `kind/confidence/status/evidence/...`。
- `MemoryRecord` 映射新字段。
- YAML frontmatter 读写新字段。
- 旧记忆默认兼容。

默认值：

```text
kind       从旧 type 映射
confidence 0.7
status     active
evidence   []
```

验收：

- 旧 memory 文件能正常读取。
- 新字段能 round-trip。
- 不强制迁移旧文件。

### P2: TaskStateManager

目标：显式维护短期任务状态。

改动：

- 新增 `packages/agent/src/task-state.ts`。
- orchestrator 初始化 TaskState。
- tool runner / action handler 将工具结果摘要传给 TaskState。
- resume state 保存 TaskState。
- 生成 `formatTaskStateForContext()`。

验收：

- 一个 run 中读文件、改文件、跑测试后 TaskState 能反映这些事实。
- resume 后 TaskState 不丢。
- 不进入长期 memory。

### P3: ContextBuilder 第一版

目标：固定本轮上下文格式。

改动：

- 新增 `context-builder.ts`。
- run 启动时生成 Context Package。
- 每轮刷新时更新 Context Package。
- 初期只放 TaskState + retrieved memories，不接 code index。

验收：

- model request 前有稳定 `[Context Package]`。
- 不无限追加重复 context。
- token 预算可测量。

### P4: MemoryRouter

目标：从“单 query 检索”升级为“按任务路由检索”。

改动：

- 新增 `memory-router.ts`。
- task profile 决定 wanted kinds 和预算。
- `retrieveMemories()` 支持 route plan 或新增 `retrieveRoutedMemories()`。
- ContextBuilder 使用分组后的 memories。

验收：

- bug fix 任务优先召回 `failure_pattern`。
- refactor 任务优先召回 `project_rule/module_summary`。
- simple script 不塞大量历史任务。

### P5: MemoryWriter 统一写入

目标：所有写入通道走同一个门。

改动：

- 新增 `memory-writer.ts`。
- `memory.save` 调 MemoryWriter。
- end-of-run extraction 调 MemoryWriter。
- compact highlights 调 MemoryWriter。
- 写入时做 confidence/status/evidence 默认填充。

验收：

- 敏感信息扫描仍生效。
- upsert 去重仍生效。
- 每条新记忆都有 kind/confidence/status。

### P6: JSON Extraction

目标：把 LLM extraction 从 markdown parser 换成结构化 JSON。

改动：

- 改写 `memory-extraction-agent.ts` prompt。
- 输出数组：

```json
{
  "memories": [
    {
      "kind": "failure_pattern",
      "title": "...",
      "summary": "...",
      "content": "...",
      "confidence": 0.86,
      "evidence": ["tool: go test ./...", "failed assertion ..."],
      "relatedFiles": [],
      "errorSignatures": [],
      "ttlDays": 180
    }
  ]
}
```

- JSON parse 失败则返回空，不写脏记忆。

验收：

- extraction tests 覆盖 valid JSON、invalid JSON、敏感信息拒绝。
- no-memory 输出不会写空文件。

### P7: Code Context 轻量索引

目标：先做轻量 Codebase Semantic Memory，不做 graph DB。

新增缓存：

```text
.paw/code-index/repo-map.json
.paw/code-index/symbols.json
.paw/code-index/test-map.json
```

来源：

- `rg --files`
- LSP symbols
- 文件名/test 名启发式
- package/module path

ContextBuilder 用它填 `[Relevant Code]`。

验收：

- 给定文件名/函数名/测试名，能返回相关文件和符号摘要。
- 没有索引时自动降级到现有 `discoverContext`。

### P8: Hygiene / Forgetting / Reflection 第二版

目标：基于新 schema 做记忆维护。

改动：

- reflection 只处理 metadata，不碰 user preference 的硬删除。
- `deprecated/superseded` 优先于删除。
- 低 confidence + 过期 + 低命中才归档。
- conflict 只标记 `needs-review`，不自动解决。

验收：

- 反思不会删除高置信用户偏好。
- superseded 记忆不会被正常检索优先返回。
- archive index 正常。

## 每阶段测试策略

### 单测

- `packages/memory/test/memory-record.test.ts`
- `packages/memory/test/unified-memory-store.test.ts`
- `packages/memory/test/memory-retriever.test.ts`
- 新增：
  - `memory-types.test.ts`
  - `memory-router.test.ts`
  - `memory-writer.test.ts`
  - `task-state.test.ts`
  - `context-builder.test.ts`

### 集成测试

- run 启动 → retrieve → Context Package 注入
- tool result → TaskState 更新 → 下一轮 Context Package 刷新
- run 完成 → MemoryWriter 写入 → 下次 run 检索到

### 回归测试

每阶段至少跑：

```bash
bun test packages/memory
bun test packages/agent
bun run typecheck:memory
bun run typecheck:agent
```

涉及 core prompt 时加：

```bash
bun test packages/core
bun run typecheck:core
```

## 迁移策略

### 旧记忆文件

不做一次性迁移脚本。读取时动态兼容：

```text
missing kind       -> from legacy type
missing confidence -> 0.7
missing status     -> active
missing evidence   -> []
```

保存/更新时写入新字段。

### 旧 session memory

保持 `SessionMemoryStore` 格式不变。它属于短期/近期任务池，不急着换 schema。

### settings

第一阶段不删旧字段，只标记 deprecated。

后续保留核心字段：

```text
memory_retrieval
memory_embedding_model
paid_memory_extraction
max_extractions_per_run
session_pool_size
memory_provider
memory_extraction_min_tokens
```

暂缓删除：

```text
background_review_interval
disable_session_highlight_extraction
```

原因：删除配置会影响现有用户；等功能真正替代后再移除。

## 暂不做

- SQLite/mem0 provider
- 完整 graph database
- HRR 重排重写
- 多 agent 共享 memory protocol
- 自动大规模删除记忆
- LLM 主动修改所有记忆
- 复杂 learned memory policy

这些等 ContextBuilder 和 Writer 稳定后再评估。

## 第一轮最小 PR

第一轮只做 P0，最多加一点 P1 的类型定义。

范围：

- provider 统一
- `memory.list/read/save` 统一走 provider
- `MemoryProvider` 补 list/read/rebuildIndex
- `FileProvider` 实现完整接口
- 修 `maxMemoryIndexLines`
- 不改检索算法
- 不改 extraction prompt
- 不删功能

完成后再做 P1/P2。

这条路线比直接大删更稳：先把所有线收进同一个接口，再逐步换内部结构。
