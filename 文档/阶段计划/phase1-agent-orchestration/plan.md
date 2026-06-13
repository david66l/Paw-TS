# Phase 1 计划：Agent Orchestrator 架构重构（最终确认版 v2）

> **目标**: 将 `orchestrator.ts`（1301 行）拆分为显式状态机 + Phase Handler 模式，并引入 Multi-Agent 支持
> **约束**: 零行为变更，所有现有测试通过
> **时间预估**: 4-5 天
> **状态**: 已整合用户全部反馈（含4条实现细节），等待最终确认后执行

---

## 一、用户反馈与调整（完整版）

### 反馈 1：Parent 状态显式化 ✅ 已采纳

`waiting_children` 和 `merging_results` 成为正式状态，`tool_executing` 只用于普通工具。

### 反馈 2：事件过滤白名单 ✅ 已采纳

只转发 7 种关键事件：`child.started`, `child.phase_changed`, `child.tool_call`, `child.tool_result`, `child.completed`, `child.failed`, `child.cancelled`。

### 反馈 3：只做 batch merge ✅ 已采纳

`Promise.allSettled` → 一次性 merge → parent next turn decides。第一版不做 progressive。

### 反馈 4：SubAgentResult 克制合并 ✅ 已采纳

摘要（status/summary/findings/changedFiles）进 parent context，完整 messages 进 trace（调试用）。

### 反馈 5：并发上限 ✅ 已采纳

`maxChildrenPerTurn: 3`, `maxChildDepth: 1`, `maxChildSteps: 5`。

### 反馈 6：run_agent 路由规则集中化 ✅ 已采纳（新增）

**用户要求**: 不要靠 tool name 字符串散落判断，集中成 `isSubAgentCall(call): boolean`。

**调整**:
```typescript
// 集中判断，不在多个地方散落 "workspace.run_agent"
function isSubAgentCall(call: AgentToolCallAction): boolean {
  return call.tool === "workspace.run_agent";
}

// 在 action dispatch 处统一路由
if (calls.some(isSubAgentCall)) {
  // 所有 run_agent 调用统一进入 waiting_children
  return { type: "waiting_children", childIds: [...] };
}
```

**好处**:
- tool name 只在一处硬编码，后续改名只需改一处
- 不会在 `tool-runner.ts` 和 `action-handlers.ts` 中散落判断逻辑
- 面试时可讲："子 Agent 路由是集中式的，不是字符串匹配散落判断"

### 反馈 7：AbortSignal 级联取消 ✅ 已采纳（新增）

**用户要求**: Parent abort 时必须调用 `agentGroup.cancelAll()`，且 `launchStreaming` 必须把 signal 传入 child orchestrator。

**调整**:
```typescript
// Parent.run() 中
for (let turn = startTurn; turn < maxSteps; turn++) {
  if (signal?.aborted) {
    await agentGroup?.cancelAll();  // ← 显式取消所有子 Agent
    return { status: "failed", message: "Run aborted." };
  }
  // ...
}

// AgentGroup.launchAll() 中
async launchAll(calls, sharedCtx, parentSignal?: AbortSignal): Promise<SubAgentResult[]> {
  const childSignal = parentSignal 
    ? AbortSignal.any([parentSignal, localController.signal])
    : localController.signal;
  
  // 传给每个子 Agent
  await childOrch.run({ ..., abortSignal: childSignal });
}

// AgentGroup.cancelAll() 中
async cancelAll(): Promise<void> {
  this.localController.abort();  // 触发所有子 Agent 的 childSignal
  await Promise.all([...this.children.values()].map(c => c.waitForExit()));
}
```

**关键路径**:
1. 用户按 Ctrl+C → `parentSignal` abort
2. Parent `run()` 检测到 abort → 调用 `agentGroup.cancelAll()`
3. `cancelAll()` 触发 `localController.abort()`
4. `localController` 是所有 childSignal 的源头之一 → 所有子 Agent 同步收到 abort
5. 子 Agent `run()` 循环检测到 `signal.aborted` → 优雅退出
6. `Promise.allSettled` resolve/reject，结果合并时标记为 cancelled

### 反馈 8：子 Agent 写文件限制 ✅ 已采纳（新增）

**用户要求**: 多个 child 同时改同一个文件会冲突。v1 建议子 Agent 默认只读；需要写文件时，要么只允许一个 child writer，要么由 Parent 执行最终写入。

**调整**:
```typescript
const CHILD_AGENT_POLICIES = {
  default: "read_only",           // 默认只读
  writeMode: "single_writer",     // 只有一个 child 能写
  maxWriteSize: 100_000,          // 单次写入最大 100KB
} as const;

// AgentGroup.launchAll() 中
async launchAll(calls, sharedCtx, signal?): Promise<SubAgentResult[]> {
  // 检查是否有多个子 Agent 同时请求写权限
  const writers = calls.filter(c => c.args?.allowWrite);
  if (writers.length > 1) {
    // 拒绝：v1 只允许一个 writer
    throw new Error("Only one child agent can have write permission per turn");
  }
  
  for (const call of calls) {
    const policy = call.args?.allowWrite ? "read_write" : "read_only";
    // 将 policy 传入子 Agent 的 SharedContext
    const ctxWithPolicy = { ...sharedCtx, childPolicy: policy };
    // ...
  }
}
```

**子 Agent 写文件实现**:
- 子 Agent 的 `workspace.write_file` / `workspace.edit_file` 工具检查 `childPolicy`
- 如果 `childPolicy === "read_only"`，拒绝写入并返回错误
- 如果 `childPolicy === "read_write"`，允许写入（但受 `maxWriteSize` 限制）
- 只有一个子 Agent 能获得 `read_write` 权限

**替代方案（更保守）**:
- 所有子 Agent 都 read_only
- 子 Agent 生成 diff/patch，Parent 在下一轮执行最终写入
- 避免任何并发文件冲突

**推荐**: v1 采用**保守方案**（所有子 Agent read_only，通过 `workspace.write_file` 拒绝写入），等稳定后再放开 single_writer。

### 反馈 9：SharedContext 硬预算 ✅ 已采纳（新增）

**用户要求**: 加 `maxSharedContextTokens: 2000` 和 `maxArtifactBytes: 50_000`，防止 context-summarizer 失控。

**调整**:
```typescript
const SHARED_CONTEXT_BUDGET = {
  maxSharedContextTokens: 2_000,   // SharedContext 总 token 上限
  maxArtifactBytes: 50_000,        // 单个 artifact 大小上限
  maxArtifacts: 10,                // artifact 数量上限
  maxFacts: 20,                    // facts 数量上限
  maxConstraints: 10,              // constraints 数量上限
} as const;

class DefaultContextSummarizer implements ContextSummarizer {
  summarize(ctx, task, agentType): SharedContext {
    // 1. 收集候选内容
    const candidateFacts = extractFacts(ctx);
    const candidateArtifacts = extractArtifacts(ctx);
    
    // 2. 按优先级截断
    const facts = candidateFacts.slice(0, SHARED_CONTEXT_BUDGET.maxFacts);
    const artifacts = truncateArtifacts(
      candidateArtifacts,
      SHARED_CONTEXT_BUDGET.maxArtifacts,
      SHARED_CONTEXT_BUDGET.maxArtifactBytes,
    );
    
    // 3. 构建 SharedContext
    const sharedCtx: SharedContext = {
      role: buildRole(agentType),
      task,
      facts,
      constraints: extractConstraints(ctx).slice(0, SHARED_CONTEXT_BUDGET.maxConstraints),
      artifacts,
      state: extractState(ctx),
      outputFormat: buildOutputFormat(agentType),
    };
    
    // 4. 硬预算检查：如果超了，进一步截断
    const tokens = estimateSharedContextTokens(sharedCtx);
    if (tokens > SHARED_CONTEXT_BUDGET.maxSharedContextTokens) {
      return truncateToBudget(sharedCtx, SHARED_CONTEXT_BUDGET.maxSharedContextTokens);
    }
    
    return sharedCtx;
  }
}
```

**截断策略**（优先级从低到高）:
1. 截断 `artifacts`（按相关性，保留 critical，丢弃 reference）
2. 截断 `facts`（保留最近的，丢弃最旧的）
3. 截断 `parentConclusions`（保留 high confidence，丢弃 low confidence）
4. 截断 `constraints`（保留硬性约束，丢弃建议性约束）
5. 最后截断 `task` 描述（保留核心动词和名词）

---

## 二、现状诊断

### 2.1 `orchestrator.ts` 结构分析

| 区域 | 行数 | 职责 | 问题 |
|------|------|------|------|
| 导入 + 类型定义 | 1-96 | `RunTurnContext`（16 字段） | data clump |
| 构造函数 | 204-226 | 选项赋值 | — |
| 辅助方法 | 228-508 | `resolveUserMentions`, `saveState`, `normalizeToolCalls`, `invokeModelOnce`, `invokeModel`, `callModelWithRetry` | 方法过长 |
| `initializeRun` | 509-712 | 运行初始化 | 204 行 |
| `terminateRun` | 713-727 | 运行终止 | — |
| **`executeTurn`** | **729-1077** | **核心方法** | **348 行 if-else 链** |
| `run` | 1078-1178 | 主循环 | 80 行 |
| `maybeExtractMemories` | 1180-1216 | 记忆提取 | 使用 `console.error` |
| `executeToolCalls` | 1218-1300 | 工具审批 + 并行执行 | 83 行 |

### 2.2 核心问题

- 分支 A（并行工具）和 B7（单工具）的后处理逻辑**几乎完全相同**
- 新增 action 类型需修改 `executeTurn` 核心方法
- 状态通过 mutable wrapper（`{n:number}`, `{v:boolean}`）隐式传播
- `run_agent` 与普通工具混在同一分支，无显式 Multi-Agent 状态

---

## 三、目标架构

### 3.1 编排模式

**产品模式**: Claude Code 的 **ReAct + 隐式 Plan**
**架构实现**: OpenCode 风格的 **单次 Turn 内显式状态机**
**Multi-Agent**: **层次化 Agent Group**（父协调 + 并行子 Agent + batch merge）

### 3.2 状态机（10 种状态）

```
model_calling
    ↓
action_dispatch ──► 解析出 action(s)
    ↓
┌─────────────────────────────────────────────────────┐
│ 路由到具体 Handler                                    │
│                                                      │
│ 普通工具 ──► tool_executing ──► continue             │
│                                                      │
│ run_agent ──► waiting_children ──► merging_results   │
│               (显示子 Agent 状态树)                     │
│               (Promise.allSettled)                    │
│               (batch merge 一次)                       │
│               ──► continue                            │
│                                                      │
│ ask_user ──► user_waiting ──► continue               │
│                                                      │
│ plan_update ──► plan_updating ──► continue           │
│                                                      │
│ final_answer ──► completed                           │
│ abort ──► failed                                     │
└─────────────────────────────────────────────────────┘
```

### 3.3 文件拆分

```
packages/agent/src/
  orchestrator.ts              # 主入口：~180 行
  orchestrator/
    types.ts                   # TurnState(10), TurnFlags, PhaseContext, ChildAgentState
    action-handlers.ts         # 各 action handler（< 300 行）
    tool-runner.ts             # 统一工具执行 + finalizeToolExecution（< 200 行）
    agent-group.ts             # AgentGroup + ChildController + 并发限制（< 250 行）
    context-summarizer.ts      # ContextSummarizer + SharedContext 生成（< 150 行）
```

### 3.4 目标文件大小

| 文件 | 当前 | 目标 |
|------|------|------|
| `orchestrator.ts` | 1301 | **< 200** |
| `orchestrator/types.ts` | — | **~150** |
| `orchestrator/action-handlers.ts` | — | **~280** |
| `orchestrator/tool-runner.ts` | — | **~150** |
| `orchestrator/agent-group.ts` | — | **~220** |
| `orchestrator/context-summarizer.ts` | — | **~120** |
| **总计** | **1301** | **~1120** |

---

## 四、核心接口设计

### 4.1 TurnState

```typescript
type TurnState =
  | { readonly type: "model_calling" }
  | { readonly type: "action_dispatch"; readonly actions: AgentAction[]; readonly text: string; readonly thinking?: string }
  | { readonly type: "tool_executing"; readonly calls: AgentToolCallAction[]; readonly text: string; readonly thinking?: string }
  | { readonly type: "waiting_children"; readonly childIds: string[]; readonly text: string; readonly thinking?: string }
  | { readonly type: "merging_results"; readonly results: SubAgentResult[]; readonly text: string; readonly thinking?: string }
  | { readonly type: "user_waiting"; readonly question: string; readonly text: string; readonly thinking?: string }
  | { readonly type: "plan_updating"; readonly items: readonly unknown[]; readonly text: string; readonly thinking?: string }
  | { readonly type: "completed"; readonly message: string }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "continue"; readonly nextFlags: TurnFlags };
```

### 4.2 TurnFlags

```typescript
interface TurnFlags {
  readonly autoContinueNudges: number;
  readonly lastTurnHadToolCall: boolean;
  readonly hasEverUsedTools: boolean;
}
```

### 4.3 PhaseContext

```typescript
interface PhaseContext {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly turn: number;
  readonly maxSteps: number;
  readonly signal?: AbortSignal;
  readonly model: LanguageModel;
  readonly mcp?: McpClientManager;
  readonly toolDefs: readonly ToolDefinition[];
  readonly toolNameMap: Map<string, string>;
  readonly ctxMgr: ContextManager;
  readonly planner: TaskPlanner;
  readonly emit: (event: RunEvent) => void;
  readonly checkpointSeq: { n: number };
  readonly specGoal: string;
}
```

### 4.4 常量定义（集中配置）

```typescript
// packages/agent/src/orchestrator/constants.ts

/** Multi-Agent 并发限制 */
export const MULTI_AGENT_LIMITS = {
  maxChildrenPerTurn: 3,
  maxChildDepth: 1,
  maxChildSteps: 5,
} as const;

/** 子 Agent 文件访问策略 */
export const CHILD_AGENT_POLICIES = {
  default: "read_only" as const,
  maxWriteSize: 100_000,
} as const;

/** SharedContext 硬预算 */
export const SHARED_CONTEXT_BUDGET = {
  maxSharedContextTokens: 2_000,
  maxArtifactBytes: 50_000,
  maxArtifacts: 10,
  maxFacts: 20,
  maxConstraints: 10,
} as const;

/** 子 Agent 事件白名单（只转发这些事件到 Parent） */
export const PARENT_FORWARD_EVENTS = new Set([
  "child.started",
  "child.phase_changed",
  "child.tool_call",
  "child.tool_result",
  "child.completed",
  "child.failed",
  "child.cancelled",
]);

/** run_agent 工具名（集中定义，避免字符串散落） */
export const SUB_AGENT_TOOL_NAME = "workspace.run_agent" as const;

/** 判断是否为子 Agent 调用 */
export function isSubAgentCall(call: AgentToolCallAction): boolean {
  return call.tool === SUB_AGENT_TOOL_NAME;
}
```

### 4.5 AgentGroup

```typescript
interface AgentGroupOptions {
  readonly parentRunId: string;
  readonly parentOnEvent: (envelope: RunEventEnvelope) => void;
  readonly parentCtxMgr: ContextManager;
  readonly parentWatcher?: WorkspaceWatcher;
  readonly launcher: SubAgentLauncher;
  readonly depth: number;
}

class AgentGroup {
  private readonly localController = new AbortController();
  private children = new Map<string, ChildController>();
  private eventBuffer: AgentGroupEvent[] = [];
  
  async launchAll(
    calls: AgentToolCallAction[],
    sharedCtx: SharedContext,
    parentSignal?: AbortSignal,
  ): Promise<SubAgentResult[]>;
  
  async cancelAll(): Promise<void>;
  onChildEvent(agentId: string, envelope: RunEventEnvelope): void;
  getStateTree(): AgentRunState;
}
```

### 4.6 SharedContext（结构化摘要）

```typescript
interface SharedContext {
  readonly role: string;
  readonly task: string;
  readonly facts: readonly string[];
  readonly constraints: readonly string[];
  readonly artifacts: readonly ContextArtifact[];
  readonly state: {
    readonly completed: readonly string[];
    readonly pending: readonly string[];
    readonly risks?: readonly string[];
  };
  readonly outputFormat: string;
  readonly parentConclusions?: readonly { conclusion: string; confidence: "high" | "medium" | "low" }[];
  readonly childPolicy?: "read_only" | "read_write";  // ← v1 默认 read_only
}
```

### 4.7 SubAgentResult（克制版）

```typescript
interface SubAgentResult {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly findings?: string[];
  readonly changedFiles?: string[];
  readonly testsRun?: { name: string; passed: boolean }[];
  readonly errors?: string[];
  readonly artifacts?: SubAgentArtifact[];
  readonly trace?: {
    readonly messages: readonly ChatMessage[];
    readonly events: readonly RunEventEnvelope[];
    readonly stepsTaken: number;
  };
}
```

### 4.8 扩展的 SubAgentLauncher

```typescript
interface SubAgentLauncher {
  launch(goal: string, maxSteps?: number): Promise<SubAgentResult>;
  
  launchStreaming(options: {
    goal: string;
    maxSteps?: number;
    signal?: AbortSignal;
    parentRunId: string;
    agentId: string;
    onEvent: (envelope: RunEventEnvelope) => void;
    sharedContext?: SharedContext;
  }): Promise<SubAgentResult>;
}
```

---

## 五、迁移步骤

### Step 1: 创建 `orchestrator/constants.ts`
- `MULTI_AGENT_LIMITS`
- `CHILD_AGENT_POLICIES`
- `SHARED_CONTEXT_BUDGET`
- `PARENT_FORWARD_EVENTS`
- `SUB_AGENT_TOOL_NAME`
- `isSubAgentCall()`

### Step 2: 创建 `orchestrator/types.ts`
- TurnState（10 种状态）
- TurnFlags
- PhaseContext
- ChildAgentState, AgentRunState

### Step 3: 创建 `orchestrator/context-summarizer.ts`
- `ContextSummarizer` 接口
- `DefaultContextSummarizer`
- 硬预算检查（maxSharedContextTokens: 2000）
- artifact 截断（maxArtifactBytes: 50_000）

### Step 4: 创建 `orchestrator/agent-group.ts`
- `AgentGroup` 类
- `ChildController` 类
- 事件路由（7 种白名单事件）
- 状态树聚合
- `Promise.allSettled` 并行启动
- `AbortSignal` 级联（`localController` + `cancelAll()`）
- 并发限制检查
- **子 Agent 写文件限制**（默认 read_only）

### Step 5: 创建 `orchestrator/tool-runner.ts`
- 提取 `executeToolCalls`
- `finalizeToolExecution`（统一后处理）
- 区分普通工具和 `run_agent`

### Step 6: 创建 `orchestrator/action-handlers.ts`
- `handleNoAction()`
- `handleFinalAnswer()`
- `handleAbort()`
- `handleAskUser()`
- `handlePlanUpdate()`
- `handleToolCall()`（普通工具）
- `handleParallelToolCalls()`（普通工具并行）
- `handleRunAgent()`（调用 AgentGroup.launchAll）
- **使用 `isSubAgentCall()` 集中路由**

### Step 7: 重构 `orchestrator.ts`
- 保留 `AgentOrchestrator` 类名和公共 API
- `executeTurn` 替换为状态机调度
- `run()` 中：abort 时调用 `agentGroup?.cancelAll()`
- `run()` 中使用函数式 TurnFlags 更新
- 保留未改动方法

### Step 8: 更新 `SubAgentLauncher`
- `packages/harness/src/context.ts`：扩展 `SubAgentLauncher` + `SubAgentResult`
- `packages/agent/src/sub-agent-launcher.ts`：实现 `launchStreaming`

### Step 9: 更新导出
- `packages/agent/src/index.ts`
- `packages/harness/src/index.ts`

---

## 六、验证计划

### 6.1 测试覆盖

| 测试文件 | 用例数 | 验证目标 |
|----------|--------|----------|
| `packages/agent/test/orchestrator.test.ts` | 8 | 核心行为 |
| `packages/agent/test/capabilities-integration.test.ts` | 5 | 集成测试 |

### 6.2 新增测试场景

| 场景 | 验证目标 |
|------|----------|
| 并行子 Agent 启动 | 3 个子 Agent 同时运行，batch merge 正确 |
| 子 Agent 写文件被拒绝 | read_only 策略下 write_file 返回错误 |
| AbortSignal 级联 | Parent abort → 所有子 Agent 同步取消 |
| 事件过滤 | 120 个原始事件 → 15 个上报事件 |
| SharedContext 预算 | >2000 tokens 时自动截断 |
| 并发限制 | 第 4 个子 Agent 启动被拒绝 |

### 6.3 验证清单

- [ ] `bun run test:ts` — 468 个测试全部通过
- [ ] `bun run typecheck` — 0 编译错误
- [ ] `bun run lint` — 0 error
- [ ] `orchestrator.ts` 行数 < 200
- [ ] `executeTurn` 方法不存在
- [ ] 单个子 Agent 行为与重构前一致
- [ ] 并行子 Agent 正确启动、batch merge
- [ ] AbortSignal 级联工作（parent abort → child cancel）
- [ ] 事件过滤减少 >80%
- [ ] 并发限制生效（>3 被拒绝，depth>1 被拒绝）
- [ ] 子 Agent 默认 read_only，write_file 被拒绝
- [ ] SharedContext 默认大小 1-2K tokens，超限时截断

---

## 七、风险与回退

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 状态机引入 bug | 中 | 高 | 全部测试通过前不合并；保留备份 |
| Multi-Agent 事件顺序 | 中 | 中 | 集成测试覆盖并行场景 |
| ContextSummarizer 质量 | 中 | 中 | 可配置开关，默认关闭时回退到简单 goal |
| 文件拆分循环依赖 | 低 | 中 | `madge` 检测 |

**回退**: 保留 `orchestrator.ts.bak`，测试不通过时回退。

---

## 八、执行检查清单

### 执行前
- [ ] 用户最终确认此计划
- [ ] 备份 `orchestrator.ts` → `orchestrator.ts.bak`
- [ ] 基线测试通过

### 执行中
- [ ] Step 1: `orchestrator/constants.ts`
- [ ] Step 2: `orchestrator/types.ts`
- [ ] Step 3: `orchestrator/context-summarizer.ts`
- [ ] Step 4: `orchestrator/agent-group.ts`
- [ ] Step 5: `orchestrator/tool-runner.ts`
- [ ] Step 6: `orchestrator/action-handlers.ts`
- [ ] Step 7: 重构 `orchestrator.ts`
- [ ] Step 8: 更新 `SubAgentLauncher`
- [ ] Step 9: 更新导出

### 执行后
- [ ] 全部测试通过
- [ ] typecheck 0 错误
- [ ] lint 0 error
- [ ] 文件行数检查
- [ ] 更新本文档状态
- [ ] 删除备份

---

> **最后更新**: 2026-05-14
> 
> **已整合全部用户反馈（9 条）**:
> 1. ✅ Parent 状态显式化
> 2. ✅ 事件过滤白名单
> 3. ✅ 只做 batch merge
> 4. ✅ SubAgentResult 克制合并
> 5. ✅ 并发上限
> 6. ✅ **run_agent 路由集中化**（`isSubAgentCall()`）
> 7. ✅ **AbortSignal 级联取消**（`agentGroup.cancelAll()`）
> 8. ✅ **子 Agent 写文件限制**（默认 read_only）
> 9. ✅ **SharedContext 硬预算**（maxSharedContextTokens: 2000, maxArtifactBytes: 50_000）
> 
> **状态**: 等待最终确认后执行
