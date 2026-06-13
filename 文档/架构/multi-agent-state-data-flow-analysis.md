# Multi-Agent 状态流转与数据流转分析

> **目标**: 审视层次化 Agent Group 方案中状态流转和数据流转的合理性、清晰度
> **方法**: 从当前代码出发，推演重构后的流转路径，发现隐藏问题

---

## 一、当前代码的状态与数据流转（基线）

### 1.1 单 Agent 状态流转

```
run.started
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  for (turn = 0; turn < maxSteps; turn++)                    │
│    │                                                        │
│    ▼                                                        │
│  loop.tick                                                  │
│    │                                                        │
│    ▼                                                        │
│  ┌─────────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │ model.call  │→│ parse    │→│ action dispatch      │   │
│  │             │  │          │  │ - tool_call          │   │
│  │             │  │          │  │ - final_answer       │   │
│  │             │  │          │  │ - ask_user           │   │
│  │             │  │          │  │ - plan_update        │   │
│  │             │  │          │  │ - abort              │   │
│  └─────────────┘  └──────────┘  └──────────────────────┘   │
│    │                                                        │
│    ▼                                                        │
│  ┌─────────────┐                                           │
│  │ tool.execute│ (if action == tool_call)                  │
│  │ - approval  │                                           │
│  │ - checkpoint│                                           │
│  │ - execute   │                                           │
│  └─────────────┘                                           │
│    │                                                        │
│    ▼                                                        │
│  saveState + maybeExtractMemories                           │
│    │                                                        │
│    ▼                                                        │
│  continue / completed / failed                              │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
run.completed / run.failed
```

**当前状态机特征**:
- 状态是隐式的：通过 `executeTurn` 的 if-else 分支体现
- 状态转移是单向的：`running` → `completed/failed`
- 无暂停/恢复机制
- 无子状态（model 阶段内部的状态不可见）

### 1.2 单 Agent 数据流转

```
用户输入 (goal)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ initializeRun()                                             │
│ - 构建 system prompt                                        │
│ - 创建 ContextManager (空)                                  │
│ - 创建 TaskPlanner (空)                                     │
│ - 连接 MCP                                                  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
ContextManager.addUser(goal) ──► 用户消息进入上下文
    │
    ▼
loop:
  ContextManager.buildMessages() ──► 消息列表喂给模型
    │
    ▼
  model.complete(messages) ──► 模型输出 text
    │
    ▼
  ContextManager.addAssistant(text) ──► 助手消息进入上下文
    │
    ▼
  executeTool() ──► ToolRunResult
    │
    ▼
  ContextManager.addToolResults([result]) ──► 工具结果进入上下文
    │
    ▼
  saveState() ──► AppState (messages + plan + todos)
```

**当前数据流特征**:
- ContextManager 是**唯一数据源**：所有消息（system/user/assistant/tool）都在这里
- AppState 是快照：每轮结束后序列化 ContextManager + Planner + TodoStore
- 事件流是只读的：通过 `onEvent` 发射，不影响主数据流

---

## 二、Multi-Agent 引入后的状态流转推演

### 2.1 理想状态流转（设计意图）

```
Parent Agent (Turn N)
    │
    ▼
model.call() ──► 输出多个 run_agent 工具调用
    │
    ▼
AgentGroup.launchAll([
  { goal: "搜索相关文件" },
  { goal: "分析代码结构" },
  { goal: "检查测试覆盖" }
])
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 并行执行区                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Child A     │  │ Child B     │  │ Child C     │         │
│  │ queued ──►  │  │ queued ──►  │  │ queued ──►  │         │
│  │ running ──► │  │ running ──► │  │ running ──► │         │
│  │ completed   │  │ completed   │  │ failed      │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                │                │
│         └────────────────┼────────────────┘                │
│                          │                                  │
│                          ▼                                  │
│                   事件上报给 Parent                         │
│                   (loop.tick, tool.result, ...)            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Promise.all 等待全部完成
    │
    ▼
合并结果 ──► ContextManager.addToolResults([A_result, B_result, C_result])
    │
    ▼
Parent Agent (Turn N+1)
```

### 2.2 实际状态流转（代码推演）

现在用实际代码路径推演，发现问题：

```typescript
// Parent Agent 的 executeTurn (Turn N)
const { text, thinking } = await this.invokeModel(...);  // ①
const { actions } = parseAgentActionsFromModelText(text); // ②

// actions 包含 3 个 tool_call，都是 workspace.run_agent
// executeToolCalls 内部：
const results = await Promise.all(
  calls.map(async (call, i) => {
    // ... approval ...
    // ... checkpoint ...
    return executeTool(ctx, call.tool, call.args);  // ③
  })
);

// executeTool 中 run_agent 分支：
const r = await launcher.launch(goal, maxSteps);  // ④ ← 阻塞！
return { ok: r.status === "completed", payload: r, summary: "..." };
```

**问题 1：Parent 的状态卡在 "tool_executing"**

Parent Agent 的 `executeTurn` 在 ④ 处阻塞等待 `launcher.launch()` 完成。在子 Agent 运行的整个过程中（可能 5-10 轮），Parent 的状态一直是 `tool_executing`。

```
Parent Turn N:
  model_calling ──► action_dispatch ──► tool_executing ──┐
                                                            │
                                                            │ (子 Agent 运行 5-10 轮)
                                                            │ Child: model_calling
                                                            │ Child: action_dispatch
                                                            │ Child: tool_executing
                                                            │ Child: ... (循环)
                                                            │
  ◄───────────────────────────────────────────────────────┘
  tool_executing 结束
  continue ──► Turn N+1
```

**这合理吗？**
- ✅ 从外部看，Parent 确实在"等待工具执行"
- ❌ 但从内部看，子 Agent 有自己的完整 ReAct 循环，这个循环对 Parent 是不可见的
- ❌ 如果子 Agent 运行 10 轮（30 秒），Parent 的 TUI 会显示 "tool executing" 30 秒，用户不知道子 Agent 在干什么

**问题 2：事件上报路径不清晰**

我设计的方案中：子 Agent 事件通过 `AgentGroup.onChildEvent()` 实时上报给父 Agent。

但代码中：
```typescript
// DefaultSubAgentLauncher.launch()
const orch = new AgentOrchestrator({
  onEvent: (envelope) => {
    if (envelope.event.type === "loop.tick") {
      stepsTaken = envelope.event.turn;
    }
  },
});
```

当前 `onEvent` 回调是在 `DefaultSubAgentLauncher` 内部设置的，父 Agent 看不到这些事件。

如果要让父 Agent 看到，需要：
```typescript
// 方案 A：AgentGroup 拦截事件
const orch = new AgentOrchestrator({
  onEvent: (envelope) => {
    agentGroup.onChildEvent(agentId, envelope);  // 上报
    // 原逻辑...
  },
});
```

但这里有一个问题：`AgentGroup` 实例需要传给 `DefaultSubAgentLauncher`，而 `DefaultSubAgentLauncher` 是在 `AgentOrchestrator` 构造函数外部创建的。这意味着 `AgentOrchestrator` 需要持有 `AgentGroup` 引用，但 `AgentGroup` 又是在 `executeToolCalls` 执行时动态创建的（因为父 Agent 才知道要启动哪些子 Agent）。

**问题 3：状态层级混乱**

```
Parent Agent (Turn N)
  state = "tool_executing"  ← Parent 级别状态
    │
    ▼
  Child A (Turn 0..M)
    state = "model_calling" / "action_dispatch" / ...  ← Child 级别状态
      │
      ▼
    Child A 内部可能再启动 Grandchild？
      state = ...  ← Grandchild 级别状态
```

三层状态机嵌套，但没有任何关联机制。如果用户问"当前运行到哪一步了"，TUI 只能回答 "Parent: tool_executing"，无法展示 "Child A: reading file X, Child B: searching pattern Y"。

**问题 4：父 Agent 的 AbortSignal 无法传递给子 Agent**

```typescript
// Parent.run()
for (let turn = startTurn; turn < maxSteps; turn++) {
  if (signal?.aborted) {  // ① Parent 检查 abort
    return { status: "failed", message: "Run aborted." };
  }
  const turnResult = await this.executeTurn(turn, turnCtx);
  // ...
}

// 但 executeToolCalls 内部：
return executeTool(ctx, call.tool, call.args);
// executeTool → launcher.launch(goal)
// launcher.launch → orch.run({...})  // ② 没有传 signal！
```

如果用户在 Parent Agent 运行子 Agent 时按 Ctrl+C：
- ① 处只在每轮开始时检查，而 Parent 当前卡在 `executeToolCalls` 的 `Promise.all`
- ② 子 Agent 的 `orch.run()` 没有收到 `AbortSignal`，会继续运行直到完成
- 结果：Parent 说"aborted"，但子 Agent 还在后台跑

---

## 三、Multi-Agent 引入后的数据流转推演

### 3.1 理想数据流转（设计意图）

```
Parent ContextManager (messages: [system, user, assistant, tool_results...])
    │
    ▼ 快照
SharedContext ──► 子 Agent A, B, C 各获得一份只读副本
    │
    ▼
Child A ContextManager ──► 独立运行 ──► SubAgentResult
Child B ContextManager ──► 独立运行 ──► SubAgentResult
Child C ContextManager ──► 独立运行 ──► SubAgentResult
    │
    ▼
合并 ──► Parent ContextManager.addToolResults([A, B, C])
```

### 3.2 实际数据流转（代码推演）

**问题 5：SharedContext 快照是什么？**

我提到"子 Agent 启动时获得父上下文的快照"，但没有定义快照的具体内容：
- 是 Parent 的完整 `buildMessages()` 列表？
- 是最近 N 条消息？
- 是过滤后的消息（去掉 tool_result 细节）？

如果传完整消息列表：
- 子 Agent 的 system prompt 可能与父 Agent 不同（父 Agent 有 tool_catalog，子 Agent 也需要）
- 消息列表可能很长（>100K tokens），传给子 Agent 会浪费上下文

如果传简化版：
- 子 Agent 可能缺少关键上下文（如父 Agent 已经读取的文件内容）
- 需要设计"上下文压缩算法"来决定传什么

**问题 6：子 Agent 事件涌入父 Agent 事件流**

我设计子 Agent 事件通过 `parentOnEvent` 实时上报。推演一下数据量：

假设 3 个子 Agent，每个运行 5 轮，每轮平均产生 8 个事件（loop.tick, model.request, model.chunk×2, model.done, tool.call, tool.result, saveState）：
- 总事件数：3 × 5 × 8 = 120 个事件
- 这些事件都通过 `parentOnEvent` 发射
- 如果 `sessionStore` 启用了，120 个事件写入 JSONL
- TUI 收到 120 个事件，scrollback 被淹没

```typescript
// Parent Agent 的 onEvent
onEvent: (envelope) => {
  events.push(envelope);           // ① 内存增长
  sessionStore?.saveEvent(...);    // ② IO 压力
  renderToTUI(envelope);           // ③ UI 刷新压力
}
```

**问题 7：合并时机模糊**

子 Agent A 在第 3 轮完成了，子 Agent B 还在第 1 轮。父 Agent 能利用 A 的结果吗？

当前设计：所有子 Agent 完成后才合并（`Promise.all`）。这意味着：
- A 完成后等待 B，A 的结果无法立即影响 Parent 的决策
- 如果 B 运行 10 轮，A 的结果被浪费了 10 轮的等待时间

替代方案：每轮合并？
- 子 Agent A 每轮结束后把结果推给 Parent
- Parent 的 ContextManager 实时更新
- 但 Parent 卡在 `Promise.all`，无法开始新一轮

**问题 8：子 Agent 修改的文件对父 Agent 不可见**

子 Agent A 执行了 `write_file`，修改了 `config.json`。但父 Agent 的 `WorkspaceWatcher` 只在每轮开始时检查外部修改：

```typescript
// executeTurn 开头
const staleFiles = (this.watcher?.takeExternallyModified() ?? []);
if (staleFiles.length > 0) {
  ctxMgr.addUser(`Note: the following file(s) were modified externally...`);
}
```

子 Agent 运行期间修改的文件，父 Agent 不会收到 stale notice，直到下一轮开始。如果子 Agent 和父 Agent 在同一轮内交替执行，文件修改通知会混乱。

---

## 四、核心问题总结

| # | 问题 | 严重度 | 根因 |
|---|------|--------|------|
| 1 | Parent 状态卡在 "tool_executing" 数秒到数十秒 | 🔴 高 | `Promise.all` 阻塞，子 Agent 内部状态不可见 |
| 2 | 事件上报路径未打通（AgentGroup ↔ Launcher ↔ Orchestrator） | 🔴 高 | 组件间引用关系未设计清楚 |
| 3 | 三层状态机嵌套无关联机制 | 🔴 高 | 缺乏状态层级协议 |
| 4 | AbortSignal 无法传递给子 Agent | 🔴 高 | `launcher.launch()` 签名未包含 signal |
| 5 | SharedContext 快照内容未定义 | 🟡 中 | 缺乏上下文继承策略 |
| 6 | 子 Agent 事件淹没父 Agent 事件流 | 🟡 中 | 无事件过滤/采样机制 |
| 7 | 合并时机模糊（全部完成 vs 每轮） | 🟡 中 | 缺乏渐进式合并策略 |
| 8 | 子 Agent 文件修改对父 Agent 不可见 | 🟡 中 | WorkspaceWatcher 检查时机固定 |

---

## 五、解决方案

### 5.1 问题 1 & 3：状态层级可视化

**方案：引入 `AgentRunState` 层次化状态**

```typescript
// 状态层级（树形结构）
interface AgentRunState {
  readonly runId: string;
  readonly agentType: "parent" | "child";
  readonly phase: ParentPhase | ChildPhase;
  readonly children?: AgentRunState[];  // 子 Agent 状态树
  readonly progress: number;            // 0-100
  readonly currentTask?: string;        // 人类可读描述
}

type ParentPhase = 
  | "model_calling"
  | "action_dispatch"
  | "tool_executing"
  | "waiting_children"   // ← 新增：等待子 Agent 完成
  | "merging_results";   // ← 新增：合并子 Agent 结果

type ChildPhase =
  | "queued"
  | "model_calling"
  | "action_dispatch"
  | "tool_executing"
  | "completed"
  | "failed";
```

**TUI 展示**：
```
Parent: waiting_children (3/3 running)
  ├─ Child-A: tool_executing (reading package.json)
  ├─ Child-B: model_calling (thinking...)
  └─ Child-C: completed
```

### 5.2 问题 2：事件上报路径

**方案：重构 SubAgentLauncher 接口**

```typescript
interface SubAgentLauncher {
  // 原同步接口（保留兼容）
  launch(goal: string, maxSteps?: number): Promise<SubAgentResult>;
  
  // 新增异步接口（支持事件上报）
  launchStreaming(
    goal: string,
    options: {
      maxSteps?: number;
      signal?: AbortSignal;
      parentRunId: string;
      agentId: string;
      onEvent: (envelope: RunEventEnvelope) => void;  // ← 实时回调
      sharedContext?: SharedContext;
    }
  ): Promise<SubAgentResult>;
}
```

**引用关系**：
```
AgentOrchestrator
  └── AgentGroup (新增)
        ├── parentOnEvent (来自 AgentOrchestrator)
        └── children: Map<string, ChildController>
              └── each ChildController
                    └── AgentOrchestrator (子)
                          └── onEvent ──► AgentGroup.onChildEvent()
```

### 5.3 问题 4：AbortSignal 传递

**方案：信号级联**

```typescript
// Parent.run()
const parentSignal = spec.abortSignal;

// AgentGroup.launchAll() 内部
const childSignal = parentSignal 
  ? AbortSignal.any([parentSignal, localAbort.signal])
  : localAbort.signal;

// 传给子 Agent
await childOrch.run({
  ...,
  abortSignal: childSignal,  // ← 级联传递
});
```

当 Parent 被 abort：
1. `parentSignal` 触发
2. `childSignal`（`AbortSignal.any`）自动触发
3. 所有子 Agent 的 `run()` 循环检测到 `signal.aborted`，优雅退出
4. `Promise.all`  reject，`executeToolCalls` 捕获异常返回失败结果

### 5.4 问题 5：SharedContext 快照策略

**方案：分层上下文继承**

```typescript
interface SharedContext {
  // 系统层（必须传递）
  readonly workspaceRoot: string;
  readonly systemPromptBase: string;  // 不含动态部分
  
  // 历史层（可选传递）
  readonly recentMessages: ChatMessage[];  // 最近 N 条（默认 10）
  
  // 状态层（可选传递）
  readonly planSnapshot?: PlanSnapshot;
  readonly todoSnapshot?: TodoItem[];
  readonly sessionMemorySnapshot?: string;
  
  // 产出层（子 Agent 产出后回填）
  artifacts: AgentArtifact[];
}
```

**继承规则**：
- 子 Agent 的 system prompt = 父 Agent system prompt（工具列表相同）
- 子 Agent 的初始上下文 = `recentMessages` + `goal`
- 子 Agent 不继承父 Agent 的完整消息历史（避免 token 爆炸）

### 5.5 问题 6：事件过滤

**方案：事件路由 + 采样**

```typescript
// AgentGroup 事件路由
class AgentGroup {
  private onChildEvent(agentId: string, envelope: RunEventEnvelope): void {
    const event = envelope.event;
    
    // 1. 状态更新（内部使用，高频）
    this.updateChildState(agentId, event);
    
    // 2. 重要事件才上报给 Parent（低频）
    if (shouldForwardToParent(event)) {
      this.parentOnEvent?.(this.wrapChildEvent(agentId, envelope));
    }
  }
}

function shouldForwardToParent(event: RunEvent): boolean {
  switch (event.type) {
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "tool.result":           // 工具结果（子 Agent 干了什么）
    case "compression.auto_compact.done":  // 压缩完成
      return true;
    case "loop.tick":
    case "model.chunk":
    case "model.request":
      return false;               // 太频繁，不上报
    default:
      return false;
  }
}
```

**事件量估算**：
- 过滤前：3 子 × 5 轮 × 8 事件 = 120
- 过滤后：3 子 × (1 started + 3 tool.result + 1 completed) = ~15
- 减少 87%

### 5.6 问题 7：渐进式合并

**方案：支持两种模式**

```typescript
interface ParallelLaunchOptions {
  readonly mergeStrategy: "batch" | "progressive";
}

// batch（默认）：全部完成后统一合并
// 适用：子任务独立，结果之间无依赖

// progressive：每轮合并
// 适用：子任务有依赖，或父 Agent 需要中间结果做决策
```

**progressive 模式实现**：
```typescript
// Child Agent 每轮结束后，把当前上下文推给 AgentGroup
class AgentGroup {
  async onChildTurnComplete(agentId: string, turnContext: ChildTurnContext): Promise<void> {
    if (this.options.mergeStrategy === "progressive") {
      // 将子 Agent 的当前结果作为 "partial_result" 注入父上下文
      this.parentCtxMgr.addUser(
        `[Sub-agent ${agentId} progress (turn ${turnContext.turn})]\n${turnContext.summary}`
      );
    }
  }
}
```

### 5.7 问题 8：文件修改可见性

**方案：子 Agent 文件修改实时通知**

```typescript
// Child Agent 的 WorkspaceWatcher 独立运行
// 子 Agent 修改文件后，通过事件通知父 Agent

// 在 executeTool → write_file 后
ctx.emit({
  type: "tool.result",
  tool: "workspace.write_file",
  ok: true,
  summary: `Wrote ${path}`,
  detail: { path, size },
});

// AgentGroup 捕获 write_file 事件，通知父 Agent 的 Watcher
this.parentWatcher?.markExternallyModified(path);
```

---

## 六、调整后的架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Parent Agent                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  ReAct Loop (状态机)                                                   │  │
│  │  for (turn = 0; turn < maxSteps; turn++) {                            │  │
│  │    state = "model_calling"  ──►  "action_dispatch"  ──►  "waiting_children" │  │
│  │                                                                         │  │
│  │    "waiting_children" 时：                                              │  │
│  │    - AgentGroup.launchAll() 并行启动子 Agent                            │  │
│  │    - 接收子 Agent 事件（过滤后）                                        │  │
│  │    - 显示子 Agent 状态树                                                │  │
│  │    - Promise.all 等待全部完成                                           │  │
│  │    - state = "merging_results"                                          │  │
│  │    - ContextManager.addToolResults()                                    │  │
│  │    - state = "continue"                                                 │  │
│  │  }                                                                      │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                              │
│                              ▼ launchAll({goals}, {mergeStrategy, signal})  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         AgentGroup                                     │  │
│  │  - 创建子 Agent 控制器                                                 │  │
│  │  - 设置事件路由（过滤 → 父 Agent）                                     │  │
│  │  - 设置 AbortSignal 级联                                              │  │
│  │  - 管理 SharedContext 快照                                             │  │
│  │                                                                        │  │
│  │  children: Map<string, ChildController>                                │  │
│  │    ├─ child-1: {status, progress, currentPhase, result}               │  │
│  │    ├─ child-2: {status, progress, currentPhase, result}               │  │
│  │    └─ child-3: {status, progress, currentPhase, result}               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│        │           │           │                                             │
│        ▼           ▼           ▼                                             │
│   ┌────────┐  ┌────────┐  ┌────────┐                                        │
│   │Child-1 │  │Child-2 │  │Child-3 │                                        │
│   │ReAct   │  │ReAct   │  │ReAct   │                                        │
│   │Loop    │  │Loop    │  │Loop    │                                        │
│   │        │  │        │  │        │                                        │
│   │Events ──┼──┼──┼───►│  AgentGroup.onChildEvent()                        │
│   └────────┘  └────────┘  └────────┘                                        │
│        │           │           │                                             │
│        └───────────┼───────────┘                                             │
│                    ▼                                                         │
│          ┌─────────────────┐                                                │
│          │  SharedContext   │                                                │
│          │  (只读快照)       │                                                │
│          └─────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 七、验证清单（状态与数据流转）

### 状态流转验证

- [ ] Parent 启动子 Agent 后，状态从 "tool_executing" 变为 "waiting_children"
- [ ] TUI 能展示子 Agent 状态树（3 个子 Agent 各自的状态）
- [ ] 子 Agent 完成后，Parent 状态变为 "merging_results"
- [ ] 合并完成后，Parent 状态变为 "continue"
- [ ] Parent abort 时，所有子 Agent 同步 abort
- [ ] 单个子 Agent fail 时，Parent 不自动 fail（由 Parent 决策）

### 数据流转验证

- [ ] 子 Agent 启动时获得 SharedContext 快照（含最近消息）
- [ ] 子 Agent 事件经过过滤后上报给 Parent（事件量减少 >80%）
- [ ] 子 Agent 的 `write_file` 操作通知 Parent 的 Watcher
- [ ] 所有子 Agent 完成后，结果按策略合并到 Parent 上下文
- [ ] batch 模式下，结果在全部完成后统一合并
- [ ] progressive 模式下，子 Agent 每轮结果实时注入 Parent 上下文

---

## 八、结论

### 原方案的问题

层次化 Agent Group 的方向正确，但**状态流转和数据流转存在 8 个具体问题**：
1. Parent 状态阻塞在 "tool_executing"，子 Agent 内部状态不可见
2. 事件上报路径未打通（组件引用关系混乱）
3. 三层状态机嵌套无层级协议
4. AbortSignal 无法级联
5. SharedContext 快照未定义
6. 子 Agent 事件会淹没 Parent 事件流
7. 合并时机模糊
8. 子 Agent 文件修改对 Parent 不可见

### 修正后的方案

| 机制 | 原方案 | 修正后 |
|------|--------|--------|
| **Parent 等待子 Agent 状态** | "tool_executing"（模糊） | **"waiting_children"**（明确） |
| **事件上报** | 全部上报 | **过滤后上报**（只报 started/completed/failed/tool_result） |
| **AbortSignal** | 不传递 | **级联传递**（`AbortSignal.any`） |
| **SharedContext** | 未定义 | **分层快照**（system + recentMessages + plan） |
| **合并策略** | 全部完成后 | **batch（默认）+ progressive（可选）** |
| **文件修改可见** | 不可见 | **子 Agent write_file 实时通知 Parent Watcher** |

### 对 PHASE1_PLAN 的影响

| 原 PHASE1_PLAN | 修正后 |
|---------------|--------|
| 5 个文件 | **6 个文件**（新增 `agent-group.ts`，`types.ts` 扩展） |
| 状态机 6 种状态 | **状态机 8 种状态**（新增 waiting_children, merging_results） |
| `SubAgentLauncher` 单方法 | **双方法**（`launch` + `launchStreaming`） |
| 事件流单向只读 | **事件流双向过滤**（子 → 父需过滤） |
| ~400 行新增代码 | **~550 行新增代码**（解决 8 个问题） |
| 2-3 天 | **3-4 天** |

---

> **最后更新**: 2026-05-14
> 
> **状态**: 状态流转与数据流分析完成，发现 8 个问题并给出解决方案，等待用户确认
