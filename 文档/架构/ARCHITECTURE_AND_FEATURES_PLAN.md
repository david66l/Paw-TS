# Paw-TS 架构与功能设计改进方案

> **目标**: 从架构设计和功能设计两个维度，将 Paw-TS 提升至大厂级 AI Agent 产品标准
> 
> **评估基准**: Claude Code (536K 行)、Cursor Composer、OpenCode Assistants API、Devin
> 
> **前提**: 本方案仅为**文档规划**，任何代码修改需经确认后执行。

---

## 一、架构设计评估与改进

### 1. Agent 编排架构

#### 当前设计

`AgentOrchestrator` 采用 **ReAct + Plan-and-Execute 的混合循环**，核心是一个 `for` 循环驱动的 Turn-based 流水线：

```
用户输入 → 上下文压缩 → 模型调用 → 动作解析 → 工具执行 → 状态保存 → loop
```

**关键特征**:
- 每轮固定为 `model → parse → action → tool` 的线性流程
- 状态通过 `RunTurnContext` mutable 对象在 turn 间传递（使用 `{n:number}` wrapper 实现引用传递）
- 决策逻辑（压缩触发、审批策略、自动继续）全部内联在 `executeTurn()` 中
- 支持 5 种动作类型：`tool_call` | `final_answer` | `ask_user` | `plan_update` | `abort`

#### 大厂标准

| 维度 | Claude Code | OpenCode (Assistants API) | Devin |
|------|------------|--------------------------|-------|
| **编排模式** | ReAct + 隐式 Plan，嵌套 Sub-agents | 显式 Run/Step/Thread 状态机 | Multi-Agent 协作 + 任务调度器 |
| **状态管理** | `Session` 对象严格管理，Checkpoint 自动回滚 | 四级模型：Thread → Run → Step → Tool Call | 状态机 + 事件溯源 |
| **决策解耦** | `PolicyEngine` 分离安全/压缩/审批策略 | 完全解耦：Orchestrator 只调度，具体逻辑在 Step 层 | 中央调度器 + Agent 注册表 |
| **并行度** | 并行工具 + 并行 Sub-agents | 并行 function calls | 多 Agent 并行 + 后台任务 |
| **容错** | 自动重试、截断续传、Checkpoint 回滚 | 内置 retry、step 级别错误处理 | 自我纠错 + 人工接管 |

#### 差距分析

| # | 差距 | 严重度 | 说明 |
|---|------|--------|------|
| 1 | **无显式状态机** | 🔴 高 | 所有分支硬编码在 `executeTurn()` 的 if-else 链中，新增动作类型需修改核心方法 |
| 2 | **决策逻辑过度耦合** | 🔴 高 | 压缩触发、模型调用、工具执行、记忆提取全部挤在一个方法里 |
| 3 | **缺少策略引擎** | 🟡 中 | 审批、自动继续、压缩触发等决策都是内联逻辑，无法通过配置扩展 |
| 4 | **TurnContext 设计粗糙** | 🟡 中 | 使用 mutable wrapper 对象传递引用，TypeScript 类型安全差，状态变更难以追踪 |
| 5 | **无事务边界** | 🟡 中 | 单轮多个工具并行执行，部分失败无法回滚 |

#### 改进方案：Phase Handler + 显式状态机

**目标架构**:

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentOrchestrator                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ StateMachine│  │ PolicyEngine│  │   EventBus          │  │
│  │  (状态管理)  │  │  (策略决策)  │  │   (事件总线)         │  │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘  │
│         │                │                                    │
│  ┌──────▼────────────────▼──────┐                           │
│  │      Phase Runner (调度器)    │                           │
│  └──────┬────────────────┬──────┘                           │
│         │                │                                    │
│    ┌────┴────┐      ┌────┴────┐      ┌────────┐            │
│    │ Model   │      │ Tool    │      │Compress│            │
│    │ Phase   │◄────►│ Phase   │◄────►│ Phase  │            │
│    └────┬────┘      └────┬────┘      └────────┘            │
│         │                │                                    │
│    ┌────┴────┐      ┌────┴────┐                            │
│    │ Plan    │      │ AskUser │      │ FinalAnswer         │
│    │ Phase   │      │ Phase   │      │ Phase               │
│    └─────────┘      └─────────┘      └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**核心改造**:

```typescript
// 1. 显式状态机
interface OrchestratorState {
  readonly type: "idle" | "thinking" | "tool_executing" | "compressing" 
                | "waiting_user" | "completed" | "failed";
  readonly runId: string;
  readonly turn: number;
  readonly context: PhaseContext;
}

// 2. Phase Handler 接口
interface PhaseHandler {
  readonly name: string;
  canHandle(state: OrchestratorState): boolean;
  execute(state: OrchestratorState): Promise<PhaseResult>;
}

// 3. 策略引擎接口
interface PolicyEngine {
  shouldCompact(ctx: PhaseContext): boolean;
  shouldAskApproval(tool: ToolCall): boolean;
  shouldAutoContinue(state: OrchestratorState): boolean;
  selectModel(task: TaskDescription): LanguageModel;
}
```

**收益**:
- 每个 Phase 独立文件、独立测试、独立演进
- 新增动作类型只需新增一个 PhaseHandler，零侵入现有代码
- 策略引擎支持运行时配置和插件扩展
- 状态转移单向可追溯，杜绝 "8 个地方随意 return" 的问题

---

### 2. 上下文管理架构

#### 当前设计

三层渐进式压缩策略：

| 层级 | 触发条件 | 机制 | 成本 |
|------|----------|------|------|
| **Layer 1: Prune** | token > 预算 | 截断旧工具结果（>500行/50KB） | 0 LLM 调用 |
| **Layer 2: Compact** | token > 阈值 | Sub-agent 生成结构化摘要 | 1 LLM 调用 |
| **Layer 3: Auto-compact** | thrashing 检测 | 自动触发 Compactor | 1 LLM 调用 |

**ContextManager**:
- 基于数组的滑动窗口：`history.slice(-maxMessages)`
- 消息优先级评分：`tool_result(100) > user(80) > assistant_with_thinking(60) > assistant(40)`
- Token 估算：`text.length / 4`（中文场景误差 2-3 倍）

#### 大厂标准：Claude Code Context 架构

```
Context Budget (128K/200K)
├── System Prompt (预留 ~8K)
├── User Messages (预留 ~20K)
├── Assistant Messages (动态)
├── Tool Results (动态，优先截断)
├── MemDir Summaries (动态，压缩后注入)
└── Head Protection (前 2-3 条消息永不被截断)
    └── Tail Protection (最近 20% 预算永不被截断)
```

Claude Code 的 `ContextBudget` 为每种消息类型分配独立预算，压缩时按信息熵排序（而非仅按角色）。

#### 差距分析

| # | 差距 | 严重度 |
|---|------|--------|
| 1 | **Token 估算粗糙** | 🔴 高 | `length/4` 与真实 tokenizer 差异 20-30%，导致过早/过晚触发压缩 |
| 2 | **无精确预算分配** | 🟡 中 | 没有为 system/user/assistant/tool 分别预留预算 |
| 3 | **优先级过于简单** | 🟡 中 | 仅基于角色打分，未考虑内容重要性、工具结果相关性、用户显式标记 |
| 4 | **无动态上下文检索** | 🟡 中 | 不支持 RAG 式的动态检索（如只加载与当前任务相关的代码片段） |
| 5 | **MemDir 差距** | 🟡 中 | Claude Code 的树状 `memdir` 系统 vs Paw-TS 的扁平 markdown |

#### 改进方案

**Step 1: 精确 Tokenizer**

```typescript
// packages/models/src/tokenizer.ts
interface Tokenizer {
  count(text: string): number;
  countMessages(messages: ChatMessage[]): number;
}

class TiktokenTokenizer implements Tokenizer {
  // GPT-4/DeepSeek → cl100k_base
  // o1/o3 → o200k_base
  // Claude → 近似 cl100k_base
}

class AnthropicTokenizer implements Tokenizer {
  // 使用 anthropic-tokenizer 或官方计数 API
}
```

**Step 2: Context Budget 分配**

```typescript
interface ContextBudget {
  readonly totalTokens: number;
  readonly systemReserved: number;      // 8K
  readonly userReserved: number;        // 20K
  readonly toolReserved: number;       // 40K
  readonly assistantReserved: number;  // 剩余
  readonly headProtection: number;     // 前 N 条
  readonly tailProtection: number;     // 最近 20%
}
```

**Step 3: 动态上下文检索（Context RAG）**

```typescript
interface ContextRetriever {
  // 基于当前任务描述，动态检索相关代码片段
  retrieve(query: string, workspaceRoot: string): Promise<CodeSnippet[]>;
}

// 实现 1: 基于 Embedding 的语义检索
class EmbeddingContextRetriever implements ContextRetriever {
  // 使用 ollama embedding 或 OpenAI embedding
  // 构建文件级向量索引，支持相似度搜索
}

// 实现 2: 基于 AST 的符号检索
class SymbolContextRetriever implements ContextRetriever {
  // 利用已有的 symbol-search.ts
  // 根据当前编辑位置自动关联相关符号
}

// 实现 3: 基于 Git 的变更检索
class GitContextRetriever implements ContextRetriever {
  // 优先加载最近修改的文件、冲突文件、unstaged 文件
}
```

**Step 4: MemDir 升级**

```
~/.paw/projects/{hash}/
├── memory/
│   ├── index.md              # 记忆索引（自动生成）
│   ├── user/
│   │   ├── preferences.md    # 用户偏好
│   │   └── patterns.md       # 常用模式
│   ├── project/
│   │   ├── architecture.md   # 架构决策
│   │   ├── conventions.md    # 代码规范
│   │   └── dependencies.md   # 关键依赖
│   └── sessions/
│       └── {sessionId}.md    # 会话摘要（树状结构）
└── vectors/
    └── embeddings.sqlite     # 向量索引
```

---

### 3. 记忆系统架构

#### 当前设计

两层记忆：

| 层级 | 存储 | 更新频率 | 内容 |
|------|------|----------|------|
| **Session Memory** | `~/.paw/projects/{hash}/session-memory/{id}.md` | 每次压缩时 | 当前任务/进度/决策/错误 |
| **Auto Memory** | `~/.paw/projects/{hash}/memory/{name}.md` | 每 5 轮 | 跨会话的长期记忆 |

**注入方式**: 在系统提示构建时将记忆的 `name` + `description` 注入，模型通过 `read_file` 主动读取详情。

#### 大厂标准

| 维度 | Mem0 | Zep | Claude Code MemDir |
|------|------|-----|-------------------|
| **分层** | 工作记忆 + 长期记忆 + 实体图 | 会话记忆 + 事实提取 + 用户画像 | MemDir (树状) + 项目规则 |
| **检索** | **向量搜索** + 语义检索 | 向量搜索 + 图遍历 | 文件系统路径 + 模型选择 |
| **提取** | 自动事实提取 + 实体关系 | 自动事实提取 + 摘要 | 模型显式写入 |
| **更新** | 增量更新 + 冲突解决 | 时间衰减 + 重要性评分 | 显式覆盖 |
| **跨会话** | ✅ 完整用户画像 | ✅ 长期用户模型 | ✅ 项目级 + 用户级 |

#### 差距分析

| # | 差距 | 严重度 |
|---|------|--------|
| 1 | **无向量检索** | 🔴 高 | 记忆完全依赖文件系统遍历和模型自行选择，无 Embedding 检索 |
| 2 | **无重要性评估** | 🔴 高 | 所有记忆同等权重，无时间衰减、无使用频率追踪 |
| 3 | **提取机制脆弱** | 🟡 中 | 每 5 轮固定频率，可能遗漏或冗余；sub-agent 失败无 fallback |
| 4 | **无实体关系** | 🟡 中 | 记忆之间无关联，无法推理 "用户 A 在项目 B 中的偏好" |
| 5 | **跨项目隔离** | 🟡 中 | `projectHash` 导致不同项目间记忆完全隔离 |
| 6 | **无验证闭环** | 🟡 中 | 无机制验证记忆是否过时 |

#### 改进方案：四层记忆 + 向量检索

```typescript
// 记忆接口设计
interface Memory {
  readonly id: string;
  readonly type: "ephemeral" | "working" | "long_term" | "user_profile";
  readonly content: string;
  readonly embedding?: number[];
  readonly importance: number;        // 0-1，基于信息熵和反馈计算
  readonly createdAt: Date;
  readonly lastAccessed: Date;
  readonly accessCount: number;       // 使用频率
  readonly source: "compression" | "extraction" | "user_explicit" | "feedback";
  readonly tags: string[];
  readonly projectId?: string;
  readonly verified: boolean;         // 是否经过时效性验证
}

interface MemoryStore {
  // 写入
  add(memory: Omit<Memory, "id">): Promise<Memory>;
  
  // 语义检索
  search(query: string, options: SearchOptions): Promise<Memory[]>;
  
  // 基于向量的相似度检索
  searchSimilar(embedding: number[], limit: number): Promise<Memory[]>;
  
  // 重要性衰减
  decay(): Promise<void>;  // 定期降低未使用记忆的重要性
  
  // 验证
  verify(memoryId: string): Promise<boolean>;  // 检查内容是否仍有效
}
```

**存储后端选择**:

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **sqlite-vec** | 零依赖、本地文件、轻量 | 性能一般 | 当前阶段首选 |
| **PGLite** | PostgreSQL 兼容、生态丰富 | 体积较大 | 后续扩展 |
| **Chroma** | 专业向量库、性能优秀 | 需额外进程 | 大规模时 |

**记忆图谱设计**:

```typescript
interface MemoryGraph {
  nodes: Map<string, MemoryNode>;     // 记忆节点
  edges: MemoryEdge[];                // 关系边
}

interface MemoryEdge {
  from: string;        // 记忆 A ID
  to: string;          // 记忆 B ID
  relation: "depends_on" | "contradicts" | "generalizes" | "related_to";
  strength: number;    // 0-1
}

// 示例: "用户偏好 TypeScript" ←generalizes→ "项目使用 Bun"
```

---

### 4. 事件与持久化架构

#### 当前设计

**Event Sourcing（事件溯源）**:
- `FileSystemSessionStore`: JSONL 追加存储每个 `RunEventEnvelope`
- 事件类型覆盖完整生命周期：`run.started` → `loop.tick` → `model.chunk` → `tool.result` → `run.completed`
- 支持 **Replay**（流式回放）和 **分页加载**

**Snapshot（状态快照）**:
- `FileSystemAppStateStore`: 完整 `AppState` 保存为 JSON
- 每轮结束后自动保存，支持断点续跑

**Checkpoint**:
- 文件级快照：mutating tool 执行前备份
- 支持 `/undo` 回滚

#### 大厂标准

| 维度 | 最佳实践 |
|------|----------|
| **单一事实源** | Event Log 是唯一事实源，所有状态通过 projection 生成 |
| **Schema 版本化** | 事件格式携带版本字段，支持向后兼容 |
| **分布式追踪** | 每个 sub-agent、tool call 有 traceId/spanId |
| **数据库后端** | SQLite/PG 替代文件系统，支持查询、索引、聚合 |
| **智能归档** | 长会话完成后归档为摘要，保留关键事件 |

#### 差距分析

| # | 差距 | 严重度 |
|---|------|--------|
| 1 | **无数据库后端** | 🟡 中 | 纯文件系统无法高效查询、索引、聚合 |
| 2 | **Event Schema 无版本** | 🟡 中 | `RunEvent` 无版本字段，未来兼容性风险 |
| 3 | **Snapshot 与 Event Log 不一致** | 🟡 中 | 两个独立存储，可能产生状态不一致 |
| 4 | **无分布式追踪** | 🟡 中 | sub-agent 调用无法形成调用链 |
| 5 | **无压缩/归档** | 🟡 中 | JSONL 随长会话无限增长 |

#### 改进方案：统一事件存储 + Projection 模式

```typescript
// 1. Event Schema 版本化
interface RunEventEnvelope {
  readonly v: number;           // Schema 版本，当前为 1
  readonly seq: number;
  readonly ts: number;
  readonly runId: string;
  readonly parentSpanId?: string;  // 分布式追踪
  readonly event: RunEvent;
}

// 2. 统一存储接口
interface EventStore {
  append(event: RunEventEnvelope): Promise<void>;
  replay(runId: string): AsyncIterable<RunEventEnvelope>;
  query(criteria: QueryCriteria): Promise<RunEventEnvelope[]>;
}

// 3. SQLite 实现
class SQLiteEventStore implements EventStore {
  // events 表: id, run_id, seq, ts, v, parent_span_id, type, payload
  // 支持按 run_id、type、time range 查询
  // 支持全文检索（FTS5）
}

// 4. Projection: 从 Event Log 生成状态
class StateProjection {
  project(runId: string): Promise<AppState> {
    // 读取所有事件，按顺序重放，生成当前状态
    // 类似 Redux reducer
  }
}

// 5. 智能归档
class SessionArchiver {
  async archive(runId: string): Promise<void> {
    // 保留: run.started, plan changes, tool calls, errors, run.completed
    // 压缩: model.chunk（文本流）→ 摘要
    // 删除: 中间 thinking 过程
  }
}
```

---

### 5. 工具系统架构

#### 当前设计

**21 个内置工具**通过 `registry.ts` 中的巨型 `if-else` 链分发：

```typescript
if (tool === READ) { ... }
if (tool === WRITE) { ... }
// ... 21 个分支
```

**MCP 集成**: 作为外部工具适配器，通过 stdio transport 连接，工具以 `mcp:<server>/<tool>` 命名空间混入。

#### 差距

| # | 差距 | 严重度 |
|---|------|--------|
| 1 | **硬编码分发** | 🔴 高 | 新增工具需修改 registry.ts 的 4-5 个地方 |
| 2 | **无插件机制** | 🔴 高 | 第三方无法在不修改源码的情况下注册工具 |
| 3 | **无中间件钩子** | 🟡 中 | 工具执行前后没有拦截器/装饰器 |
| 4 | **MCP 仅 stdio** | 🟡 中 | 不支持 SSE transport |
| 5 | **无工具链组合** | 🟡 中 | 无法像 LangChain 那样组合工具序列 |

#### 改进方案：可插拔工具注册表

```typescript
// 1. 工具 Handler 接口
interface ToolHandler<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodSchema<TArgs>;
  readonly requiresApproval: boolean | ((args: TArgs) => boolean);
  
  execute(ctx: ToolContext, args: TArgs): Promise<ToolResult<TResult>>;
}

// 2. 注册表
class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();
  
  register(handler: ToolHandler): void;
  unregister(name: string): void;
  get(name: string): ToolHandler | undefined;
  list(): ToolDefinition[];
  
  // 中间件支持
  use(middleware: ToolMiddleware): void;
}

// 3. 中间件
interface ToolMiddleware {
  before?(ctx: ToolContext, args: unknown): Promise<unknown>;
  after?(ctx: ToolContext, result: ToolResult): Promise<ToolResult>;
}

// 示例中间件
const loggingMiddleware: ToolMiddleware = {
  before: async (ctx, args) => {
    logger.info({ tool: ctx.toolName, args }, "tool executing");
    return args;
  },
  after: async (ctx, result) => {
    logger.info({ tool: ctx.toolName, ok: result.ok }, "tool executed");
    return result;
  },
};

const checkpointMiddleware: ToolMiddleware = {
  before: async (ctx, args) => {
    if (ctx.handler.requiresApproval) {
      await ctx.checkpoint.save();
    }
    return args;
  },
};
```

**内置工具迁移**:

```typescript
// packages/harness/src/tools/read-file.ts
export const readFileTool: ToolHandler = {
  name: "workspace.read_file",
  description: "Read a file from the workspace",
  schema: z.object({
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  requiresApproval: false,
  
  async execute(ctx, args) {
    const content = await fs.readFile(resolvePath(ctx.workspaceRoot, args.path), "utf-8");
    return { ok: true, summary: `Read ${args.path}`, payload: content };
  },
};

// 注册
registry.register(readFileTool);
registry.register(writeFileTool);
// ... 每个工具独立文件
```

---

### 6. 模型适配架构

#### 当前设计

```typescript
interface LanguageModel {
  readonly label: string;
  readonly capabilities?: ModelCapabilities;  // 仅 contextWindow + maxOutputTokens
  complete(messages, options?): Promise<ModelCompletionResult>;
  completeStream?(messages, options?): AsyncIterable<ModelStreamChunk>;
}
```

**能力声明不足**:
- ❌ 是否支持 vision/multimodal
- ❌ 是否支持 native function calling
- ❌ 是否支持 structured output / JSON mode
- ❌ 是否支持 extended thinking
- ❌ 最大工具调用数量

**模型选择**: 静态优先级（Anthropic key → OpenAI key → fake），无动态路由。

**模型 Fallback**: ❌ 完全不支持。

#### 改进方案

```typescript
// 1. 丰富的能力声明
interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly tokenizer: "cl100k" | "o200k" | "anthropic";
  
  // 新增
  readonly supportsVision: boolean;
  readonly supportsNativeFunctionCalling: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsExtendedThinking: boolean;
  readonly maxToolCallsPerTurn: number;
  readonly supportsParallelToolCalls: boolean;
}

// 2. 模型路由器
interface ModelRouter {
  selectModel(task: TaskProfile): LanguageModel;
}

class CapabilityBasedRouter implements ModelRouter {
  selectModel(task: TaskProfile): LanguageModel {
    if (task.requiresVision && !this.primary.capabilities?.supportsVision) {
      return this.visionModel;  // 回退到支持 vision 的模型
    }
    if (task.expectedOutputTokens > 100_000 && this.primary.capabilities?.maxOutputTokens < 100_000) {
      return this.longOutputModel;
    }
    return this.primary;
  }
}

// 3. 模型 Fallback 链
class ResilientModelClient implements LanguageModel {
  constructor(
    private primary: LanguageModel,
    private fallback: LanguageModel,
    private retryPolicy: RetryPolicy,
  ) {}
  
  async complete(messages, options) {
    try {
      return await this.primary.complete(messages, options);
    } catch (err) {
      if (isRetryable(err) && this.retryPolicy.shouldRetry(err)) {
        return await this.retryPolicy.execute(() => this.primary.complete(messages, options));
      }
      // Fallback
      logger.warn({ err }, "primary model failed, falling back");
      return this.fallback.complete(messages, options);
    }
  }
}
```

---

### 7. 部署与运行架构

#### 当前状态

| 维度 | 状态 |
|------|------|
| 进程模型 | 单进程单线程（Bun 事件循环） |
| 并发 | 无多 Agent 并行 |
| API 模式 | ❌ 不存在 |
| Web 应用 | ❌ `apps/web/` 完全空壳 |
| 多用户 | ❌ 未设计 |

#### 改进方案

**Phase 1: API 层（解锁产品化）**

```typescript
// apps/web/src/api.ts
interface AgentAPI {
  // 创建运行
  POST /runs { goal, workspace, model? }
  → { runId, status: "running" }
  
  // 流式输出（SSE）
  GET /runs/:runId/stream
  → SSE: model.chunk | tool.result | run.completed
  
  // 发送用户输入（异步）
  POST /runs/:runId/messages { content }
  
  // 审批工具调用
  POST /runs/:runId/approve { toolCallId, approved }
  
  // 查询状态
  GET /runs/:runId
  → { status, turn, messages, plan }
  
  // Undo
  POST /runs/:runId/undo
}
```

**Phase 2: 多 Agent 并发**

```typescript
// Agent Pool
class AgentPool {
  private agents = new Map<string, AgentWorker>();
  
  spawn(task: Task): Promise<AgentWorker>;
  communicate(from: string, to: string, message: string): Promise<void>;
  broadcast(sender: string, message: string): Promise<void>;
}

// Agent Worker（独立进程或 Worker Thread）
class AgentWorker {
  readonly id: string;
  readonly task: Task;
  readonly status: Observable<AgentStatus>;
  readonly events: Observable<RunEvent>;
  
  pause(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
}
```

**Phase 3: 云原生架构（远期）**

```
┌─────────────────────────────────────────────────────┐
│                  Load Balancer                       │
└─────────────┬───────────────────────┬───────────────┘
              │                       │
    ┌─────────▼─────────┐   ┌─────────▼─────────┐
    │   API Gateway     │   │   API Gateway     │
    │   (Hono/Fastify)  │   │   (Hono/Fastify)  │
    └─────────┬─────────┘   └─────────┬─────────┘
              │                       │
    ┌─────────▼───────────────────────▼─────────┐
    │         Message Queue (Redis/Bull)         │
    └─────────┬───────────────────────┬─────────┘
              │                       │
    ┌─────────▼─────────┐   ┌─────────▼─────────┐
    │   Agent Worker    │   │   Agent Worker    │
    │   (Docker/Pod)    │   │   (Docker/Pod)    │
    └───────────────────┘   └───────────────────┘
```

---

### 8. 安全架构

#### 当前设计（两层防护）

| 层级 | 机制 | 问题 |
|------|------|------|
| Prompt 层 | System prompt 告知安全规范 | 可被模型绕过 |
| 工具层 | `checkWorkspacePath` + `shell-guard.ts` 黑名单 | 黑名单策略不完整 |

#### 大厂标准（四层防护）

| 层级 | 机制 | 示例 |
|------|------|------|
| **审计层** | LLM 输出行为审计，检测越狱/提示注入 | 检测模型是否要求删除系统文件 |
| **策略层** | 可配置的安全策略（白名单、RBAC） | 仅允许特定工具、特定路径 |
| **执行层** | 沙箱化执行（容器、seccomp、网络隔离） | Docker / nsjail |
| **恢复层** | Checkpoint 自动回滚 + 操作审计日志 | `/undo` + 完整事件流 |

#### 改进方案

```typescript
// 1. 审计层
interface LLMAuditor {
  auditOutput(output: string): Promise<AuditResult>;
}

class SecurityAuditor implements LLMAuditor {
  async auditOutput(output: string): Promise<AuditResult> {
    // 检测危险模式
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      />\s*\/etc\/passwd/,
      /curl\s+.*\|\s*(sh|bash)/,
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(output)) {
        return { safe: false, reason: "Detected dangerous command pattern" };
      }
    }
    
    return { safe: true };
  }
}

// 2. 策略层（白名单）
interface SecurityPolicy {
  allowedTools: Set<string>;
  allowedPaths: PathMatcher;
  allowedShellCommands: Set<string>;
  maxFileSize: number;
  networkPolicy: "allow" | "block" | "whitelist";
}

// 3. 沙箱执行层
interface Sandbox {
  execute(command: string, options: SandboxOptions): Promise<SandboxResult>;
}

class DockerSandbox implements Sandbox {
  // 使用 Docker 容器执行 shell 命令
  // 只读挂载 workspace
  // 网络隔离（--network none 或自定义 bridge）
  // 资源限制（CPU、内存、超时）
}

class NsjailSandbox implements Sandbox {
  // 使用 nsjail 进行轻量级沙箱化
  // 更轻量，适合 CLI 工具集成
}
```

---

## 二、功能设计评估与改进

### 功能成熟度总览

| 功能领域 | Paw-TS | Claude Code | 差距 |
|----------|--------|------------|------|
| 模型适配 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 小 |
| 工具系统 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 中 |
| 上下文管理 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 中 |
| 交互体验 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 大 |
| 多模态 | ⭐ | ⭐⭐⭐⭐⭐ | **致命** |
| IDE 集成 | ⭐ | ⭐⭐⭐⭐⭐ | **大** |
| 代码理解 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 小 |
| 记忆系统 | ⭐⭐⭐ | ⭐⭐⭐⭐ | 中 |
| 自我纠错 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 中 |
| 命令系统 | ⭐⭐ | ⭐⭐⭐⭐⭐ | 大 |

---

### P0 — 阻碍生产使用的致命缺失

#### 1. 图像输入未实际上传

**问题**: `Attachment` 接口已定义完整，但 `OpenAICompatibleModel` 和 `AnthropicCompatibleModel` 构建 `messagesPayload` 时**完全忽略了 `attachments` 字段**。

**影响**: 多模态能力有名无实，用户无法让 Agent 查看截图、UI 设计稿、报错图片。

**实现方案**:

```typescript
// OpenAI Vision API 格式
function attachmentsToContent(attachments: Attachment[]): ChatCompletionContentPart[] {
  return attachments.map(att => {
    if (att.type === "image") {
      return {
        type: "image_url",
        image_url: {
          url: `data:${att.mimeType};base64,${att.content}`,
          detail: "high",
        },
      };
    }
    return { type: "text", text: att.content };
  });
}

// 在 messagesPayload 构建中
if (message.attachments?.length) {
  content = [
    { type: "text", text: message.content },
    ...attachmentsToContent(message.attachments),
  ];
}
```

#### 2. Ollama 有配置无实现

**问题**: `settings.schema.ts` 有 `ollama_host` 字段，但 `packages/models/src/` 中无 `OllamaModel` 类。

**实现方案**: Ollama API 兼容 OpenAI `/chat/completions`，可直接复用 `OpenAICompatibleModel`：

```typescript
class OllamaModel extends OpenAICompatibleModel {
  constructor(baseUrl: string, modelName: string) {
    super({
      apiKey: "ollama",  // Ollama 不需要 apiKey
      baseUrl: `${baseUrl}/v1`,
      model: modelName,
    });
  }
}
```

#### 3. 无 Yolo Mode 一键切换

**问题**: `approvalPolicy` 可配置，但 TUI 没有一键切换 Auto/Normal/Strict 的交互。

**实现方案**:

```typescript
// settings.schema.ts
const ApprovalMode = z.enum(["yolo", "normal", "strict"]);

// TUI 添加 /mode 命令
// Normal: read 免审批，write/edit/shell 需审批
// Yolo: 全部免审批（适合信任环境）
// Strict: 全部需审批（适合高风险操作）
```

---

### P1 — 显著影响体验的功能缺失

#### 4. IDE Bridge（双向通信）

**问题**: Claude Code 可与 VS Code/JetBrains 双向通信（文件定位、diff 应用、行号跳转）。Paw-TS 完全孤立。

**实现方案**:

```typescript
// WebSocket Bridge
interface IDEBridge {
  // Agent → IDE
  revealFile(path: string, line?: number, column?: number): Promise<void>;
  showDiff(original: string, modified: string, path: string): Promise<void>;
  applyEdit(path: string, edits: TextEdit[]): Promise<void>;
  
  // IDE → Agent
  onFileChange(handler: (path: string) => void): void;
  onBreakpoint(handler: (path: string, line: number) => void): void;
}

// 工具暴露
// workspace.bridge_reveal_file { path, line }
// workspace.bridge_show_diff { path, original, modified }
```

**VS Code 扩展架构**:

```
VS Code Extension
├── WebSocket Client ←→ Paw Agent Server
├── Tree View: Agent Sessions
├── Webview: Diff Preview
└── Commands: 
    ├── Paw: Start Agent
    ├── Paw: Show Diff
    └── Paw: Jump to File
```

#### 5. Chrome / 浏览器集成

**问题**: 无法做前端调试、截图验证、端到端测试。

**实现方案**: 集成 Playwright：

```typescript
// 新工具
// browser.open { url }
// browser.screenshot { selector?, fullPage? }
// browser.click { selector }
// browser.type { selector, text }
// browser.evaluate { script }
// browser.assert { selector, state: "visible"|"hidden" }
```

#### 6. Embedding 语义搜索

**问题**: 大项目中关键词搜索（grep）召回率低。无法基于语义找到相关代码。

**实现方案**:

```typescript
// 1. 索引构建（后台或按需）
class CodeIndex {
  async build(workspaceRoot: string): Promise<void> {
    const files = await glob(`${workspaceRoot}/**/*.{ts,tsx,js,jsx}`);
    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      const embedding = await embed(content.slice(0, 8000));
      await this.store.index(file, embedding, { content });
    }
  }
}

// 2. 语义检索
class SemanticSearchTool implements ToolHandler {
  name = "workspace.semantic_search";
  
  async execute(ctx, args: { query: string; limit?: number }) {
    const queryEmbedding = await embed(args.query);
    const results = await codeIndex.search(queryEmbedding, args.limit ?? 5);
    return { ok: true, payload: results };
  }
}
```

**Embedding 选型**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| Ollama local embedding | 零成本、离线可用、隐私 | 质量一般 |
| OpenAI text-embedding-3-small | 质量高、便宜 | 需网络、API 成本 |
| Voyage AI | 代码专用 embedding | 需注册、成本较高 |

#### 7. Plan 自动调度器

**问题**: `TaskPlanner` 有 `depends_on` 字段，但 orchestrator 不会按依赖图自动调度，完全依赖模型自行决定下一步。

**实现方案**:

```typescript
class PlanExecutor {
  private plan: Plan;
  
  nextExecutable(): PlanItem | null {
    // 拓扑排序：找到所有依赖已完成的 item
    const completed = new Set(this.plan.items.filter(i => i.status === "done").map(i => i.id));
    const executable = this.plan.items.filter(
      item => item.status === "pending" && item.depends_on?.every(dep => completed.has(dep))
    );
    return executable[0] ?? null;
  }
  
  async executePlan(orchestrator: AgentOrchestrator): Promise<void> {
    while (true) {
      const next = this.nextExecutable();
      if (!next) break;
      
      // 将下一个任务注入为系统提示
      await orchestrator.run({ 
        message: `Execute plan item: ${next.description}`,
        planContext: this.plan,
      });
      
      next.status = "done";
    }
  }
}
```

#### 8. TUI 体验增强

| 功能 | 优先级 | 实现方案 |
|------|--------|----------|
| **Vim Mode** | P1 | 在 textarea 中集成 `vim-keybindings` 库 |
| **Thinking Panel** | P1 | 独立可折叠的 thinking 区域（Claude Code 风格） |
| **快捷键系统** | P1 | 可配置的键位绑定，支持 `.paw/keybindings.json` |
| **Command Palette** | P1 | `/` 唤起命令面板，支持模糊搜索 |
| **Diff Preview** | P1 | 文件修改前在 TUI 中展示 side-by-side diff |
| **Progress Timeline** | P2 | 左侧显示任务时间线，可点击跳转 |
| **Notification Toast** | P2 | 非阻塞通知（如 "Compression completed"） |

#### 9. 丰富的 Slash 命令系统

当前仅 12 个命令，Claude Code 有 102 个。

**优先补充**:

| 命令 | 功能 |
|------|------|
| `/commit` | 生成并执行 git commit |
| `/test` | 运行测试并分析失败 |
| `/lint` | 运行 linter 并自动修复 |
| `/model` | 切换当前模型 |
| `/compact` | 手动触发上下文压缩 |
| `/memory` | 查看/管理当前记忆 |
| `/undo` | 回滚到上一个 checkpoint |
| `/redo` | 重做被回滚的操作 |
| `/export` | 导出当前会话为 markdown |
| `/diff` | 查看 workspace 所有变更 |

---

### P2 — 长期竞争力

#### 10. Feature Flags（功能开关）

```typescript
// settings.local.json
{
  "features": {
    "semantic_search": true,
    "browser_integration": false,
    "auto_fix_lint": true,
    "parallel_sub_agents": false
  }
}
```

**为什么**: 支持 A/B 测试、灰度发布、快速回滚。

#### 11. Plugin 系统

```typescript
// 插件 manifest
interface PluginManifest {
  name: string;
  version: string;
  tools?: ToolHandler[];
  middlewares?: ToolMiddleware[];
  models?: LanguageModel[];
  commands?: SlashCommand[];
}

// 加载方式
// 1. 本地目录: ~/.paw/plugins/
// 2. npm 包: @paw/plugin-*
// 3. 远程 URL: https://registry.paw.dev/plugins/*.json
```

#### 12. Voice Input

集成 Whisper API 或浏览器 Web Speech API：

```typescript
// 新工具
// voice.record { duration? }
// voice.transcribe { audio }
```

---

## 三、实施路线图

### Phase 1: 架构地基（Week 1-2）

目标: 消除架构债务，建立可扩展的骨架。

- [ ] **Orchestrator 状态机重构**: 拆分为 Phase Handler 模式
- [ ] **工具注册表重构**: `if-else` → 可插拔注册表 + 中间件
- [ ] **精确 Tokenizer**: 替换 `length/4`，接入 tiktoken
- [ ] **模型 Fallback**: 实现 ResilientModelClient

### Phase 2: 核心功能补齐（Week 3-4）

目标: 消除 P0 致命缺失。

- [ ] **图像输入**: 修复 `attachments` 在模型层的上传
- [ ] **Ollama 支持**: 实现 `OllamaModel` 类
- [ ] **Yolo Mode**: `approval: "yolo"` + `/mode` 命令
- [ ] **IDE Bridge**: VS Code 扩展 + WebSocket 通信
- [ ] **Plan 自动调度**: `PlanExecutor` 拓扑排序执行

### Phase 3: 体验提升（Week 5-6）

目标: 从"能跑"进入"好用"。

- [ ] **语义搜索**: 本地 Embedding + CodeIndex
- [ ] **TUI Vim Mode + Thinking Panel**
- [ ] **浏览器集成**: Playwright 工具集
- [ ] **丰富命令**: `/commit`, `/test`, `/lint`, `/model` 等
- [ ] **Diff Preview**: TUI 中 side-by-side diff

### Phase 4: 智能化增强（Week 7-8）

目标: 接近 Claude Code 的核心体验。

- [ ] **记忆向量化**: sqlite-vec + 语义检索
- [ ] **自我纠错**: Tool 失败后自动调整策略重试
- [ ] **上下文 RAG**: 动态检索相关代码片段
- [ ] **Feature Flags**: 可配置功能开关

### Phase 5: 生态建设（Week 9-10）

目标: 建立扩展性和可维护性。

- [ ] **Plugin 系统**: manifest + 加载器
- [ ] **API 服务器**: `apps/web/` HTTP API + SSE
- [ ] **安全沙箱**: Docker / nsjail 集成
- [ ] **OpenTelemetry**: 分布式追踪

---

## 四、关键决策记录（ADR 草案）

### ADR-001: Phase Handler 模式

**状态**: 提议

**上下文**: Orchestrator 当前是 1301 行的面条代码，所有逻辑硬编码在 `executeTurn()` 中。

**决策**: 引入显式状态机 + Phase Handler 接口，每个 Phase 独立可测试。

**后果**:
- ✅ 新增动作类型零侵入
- ✅ 状态转移可追溯
- ❌ 短期内增加文件数量和认知负担

### ADR-002: 工具注册表模式

**状态**: 提议

**上下文**: `registry.ts` 的 `if-else` 链阻止第三方工具注册。

**决策**: 将每个工具封装为独立的 `ToolHandler`，通过 `ToolRegistry` 注册，支持中间件链。

**后果**:
- ✅ 插件化扩展
- ✅ 中间件支持（日志、审计、Checkpoint）
- ❌ 迁移 21 个内置工具需要一次性改动

### ADR-003: 本地 Embedding vs 云端

**状态**: 提议

**上下文**: 语义搜索需要 Embedding，但项目坚持本地优先。

**决策**: 优先使用 Ollama 本地 embedding，fallback 到 OpenAI embedding（用户可选）。

**后果**:
- ✅ 隐私保护
- ✅ 零网络成本
- ❌ 本地 embedding 质量可能不如云端

### ADR-004: 单体 API 还是微服务

**状态**: 提议

**上下文**: `apps/web/` 空壳，需要决定是否引入服务端架构。

**决策**: Phase 1 采用单体 API（Hono/Fastify 内嵌在 `apps/web`），Phase 2 根据需求决定是否拆分。

**后果**:
- ✅ 快速落地
- ✅ 与现有代码共享内存状态
- ❌ 单进程无法水平扩展

---

## 五、参考架构

### Claude Code 架构（推测，基于代码量分析）

```
Claude Code (536K 行)
├── CLI/TUI (144 组件 + 3 screens)
├── Agent Core
│   ├── PolicyEngine (安全/压缩/审批策略)
│   ├── ContextManager (精确 tokenizer + MemDir)
│   ├── TaskPlanner (依赖图 + 子任务调度)
│   └── SubAgentLauncher (并行 sub-agents)
├── Tool System (43 工具)
│   ├── Built-in Tools
│   ├── MCP Client (3,349 行)
│   └── MCP Server (2,466 行 + auth)
├── Model Layer
│   ├── OpenAI / Anthropic / Bedrock
│   └── Model Router (动态选择)
├── IDE Bridge
│   ├── VS Code Extension
│   └── JetBrains Plugin
├── Context & Memory
│   ├── Context Compactor
│   ├── MemDir (树状记忆)
│   └── Session Store (SQLite)
└── Infrastructure
    ├── Telemetry (OpenTelemetry)
    ├── Feature Flags
    └── Auto-updater
```

### Paw-TS 目标架构（改进后）

```
Paw-TS (目标)
├── apps/
│   ├── cli/          # 命令行入口
│   ├── tui/          # 终端 UI (SolidJS + @opentui)
│   └── web/          # HTTP API 服务器 (Hono)
├── packages/
│   ├── core/         # 领域模型 + 事件系统 + 记忆
│   ├── agent/        # Agent 编排 (Phase Handler + 状态机)
│   ├── harness/      # 工具注册表 + 中间件 + MCP
│   ├── models/       # LanguageModel 接口 + 多模型适配
│   ├── workspace/    # 文件系统 + Git + LSP + 搜索
│   ├── settings/     # 配置管理
│   └── store/        # 计划存储
├── plugins/          # 第三方扩展 (远期)
└── docs/
    ├── ARCHITECTURE.md
    ├── adr/            # 架构决策记录
    └── INTERVIEW_QA.md
```

---

## 六、总结

### 当前优势（不应丢弃）

1. **上下文压缩三层架构** — 已达到业界中上水平
2. **AST 符号搜索 + LSP 客户端** — 在 ~5,800 行代码中实现了代码理解能力
3. **MCP Client 完整支持** — 不重复造轮子
4. **并行工具调用** — 全链路支持
5. **Checkpoint/Undo 系统** — 文件级快照 + 自动恢复
6. **事件驱动架构** — `RunEvent` 为可观测性提供了优秀基础

### 核心瓶颈

1. **Orchestrator 紧耦合** — 状态机缺失是最严重的架构债务
2. **多模态有名无实** — `attachments` 字段被忽略是 P0 致命伤
3. **记忆系统无向量检索** — 语义缺失导致"失忆"体验
4. **TUI 体验差距** — 功能可用但缺少开发者刚需（Vim、diff、thinking panel）
5. **无 IDE 集成** — 孤立运行，无法融入开发者工作流

### 务实的追赶路径

**第一阶段（架构）**: Phase Handler + 工具注册表 → 消除技术债务
**第二阶段（核心）**: 图像上传 + Ollama + Yolo + IDE Bridge → 消除 P0
**第三阶段（体验）**: Vim + 语义搜索 + Plan 调度 + 丰富命令 → 进入"好用"阶段
**第四阶段（智能）**: 记忆向量 + 自我纠错 + RAG → 接近 Claude Code 核心体验

> **总体评价**: Paw-TS 在核心 Agent 架构上已具备大厂骨架的雏形，但在**产品化细节**上与 Claude Code 仍有 10-20× 的差距。优先完成架构重构和 P0 功能补齐后，项目可从"面试可用的精品骨架"升级为"开发者日常可用的工具"。

---

> **最后更新**: 2026-05-14
> 
> **下一步**: 请项目负责人审阅各 Phase 的优先级和范围，确认后按阶段推进。
