# Multi-Agent 架构分析：基于"需要多个子 Agent"需求的重新评估

> **触发条件**: 用户明确要求多个子 Agent，需确定消息处理、合并、状态管理方案
> **分析目标**: 在 Multi-Agent 需求下重新评估三种编排模式，给出确定性的架构选型

---

## 一、当前子 Agent 实现诊断

### 1.1 现有代码结构

```typescript
// packages/harness/src/context.ts
interface SubAgentResult {
  readonly result: string;        // ← 纯字符串，结构化信息丢失
  readonly stepsTaken: number;    // ← 硬编码为 0（已知 bug）
  readonly status: "completed" | "failed";
}

interface SubAgentLauncher {
  launch(goal: string, maxSteps?: number): Promise<SubAgentResult>;
}
```

```typescript
// packages/agent/src/sub-agent-launcher.ts
class DefaultSubAgentLauncher implements SubAgentLauncher {
  async launch(goal: string, maxSteps?: number): Promise<SubAgentResult> {
    const orch = new AgentOrchestrator({...});  // ← 每次新建实例
    const result = await orch.run({...});        // ← 同步阻塞，无并行
    return {
      result: result.message,    // ← 只返回最终消息，完整历史丢失
      stepsTaken,                // ← 从 loop.tick 事件统计
      status: result.status,
    };
  }
}
```

### 1.2 当前局限性

| 维度 | 现状 | 问题 |
|------|------|------|
| **结果格式** | 纯字符串 `result.message` | 子 Agent 的完整思考过程、工具调用链、中间结果全部丢失 |
| **执行模式** | 同步阻塞 `await launcher.launch()` | 无法并行启动多个子 Agent |
| **消息传递** | 无 | 子 Agent 间无法通信，父 Agent 只能通过 goal 字符串传递信息 |
| **上下文共享** | 无 | 子 Agent 看不到父 Agent 的上下文，需通过 goal 重复描述 |
| **状态可见性** | 不透明 | 父 Agent 无法知道子 Agent 执行到哪一步、用了哪些工具 |
| **Agent 生命周期** | 一次性的 | 每次 `launch` 新建 Orchestrator，无复用、无缓存 |

### 1.3 关键 Bug

`memory/paware_agent_steps_tracking_bug.md` 已记录：`DefaultSubAgentLauncher.stepsTaken` 硬编码为 0，因为 `RunResult` 未暴露 step count。

---

## 二、三种模式在 Multi-Agent 场景下的能力对比

### 2.1 Claude Code — 嵌套 Sub-agents（顺序执行）

```
父 Agent (ReAct 循环)
  │
  ├─► launch("搜索相关文件") ───────► 子 Agent A
  │      │                              │
  │      │ result: "找到 a.ts, b.ts"    │ ReAct 循环
  │      │                              │
  │      ◄──────────────────────────────┘
  │
  ├─► launch("修改 a.ts") ──────────► 子 Agent B
  │      │                              │
  │      │ result: "修改完成"           │ ReAct 循环
  │      │                              │
  │      ◄──────────────────────────────┘
  │
  └─► launch("运行测试") ───────────► 子 Agent C
         │                              │
         │ result: "3/3 通过"           │ ReAct 循环
         │                              │
         ◄──────────────────────────────┘
```

**消息处理**: 父 → 子通过 `goal` 字符串，子 → 父通过 `result` 字符串。无子 Agent 间通信。

**合并策略**: 父 Agent 将每个子 Agent 的 `result` 字符串作为上下文的一部分，自行决定下一步。

**状态管理**: 每个子 Agent 有独立的 `AgentOrchestrator` 实例，状态完全隔离。父 Agent 只能看到最终的 `status` + `result`。

**优点**:
- 实现简单，与当前代码兼容
- 调试容易，每个子 Agent 独立运行
- 父 Agent 完全控制执行顺序

**缺点**:
- **无法并行**：3 个子 Agent 顺序执行，总时间 = t1 + t2 + t3
- **信息丢失**：子 Agent 的中间思考、工具调用链对父 Agent 不可见
- **上下文重复**：每个子 Agent 的 goal 需要重复描述背景信息
- **无法协作**：子 Agent A 的结果无法直接影响子 Agent B 的执行

---

### 2.2 OpenCode (Assistants API) — Thread 共享 + 多 Run

```
Thread (共享消息容器)
  ├─ Message 1: user goal
  ├─ Message 2: assistant thinking
  ├─ Message 3: tool result
  │
  ├─ Run 1 (Agent A) ──► 在 Thread 上执行
  │      │                    │
  │      │ 读取/写入 Thread   │
  │      │                    │
  │      ◄────────────────────┘
  │
  ├─ Run 2 (Agent B) ──► 在 Thread 上执行
  │      │                    │
  │      │ 读取/写入 Thread   │
  │      │ (可以看到 Run 1 的结果)
  │      ◄────────────────────┘
```

**消息处理**: 所有 Agent 共享同一个 Thread（消息列表）。Agent 通过读写 Thread 来通信。

**合并策略**: Thread 本身就是合并后的消息历史，按时间顺序排列。

**状态管理**: Run 有显式状态（queued → in_progress → completed），但 Agent 本身没有独立状态。

**优点**:
- 天然共享上下文，无信息重复
- 状态清晰，可恢复
- 适合 API 服务化

**缺点**:
- **不是真正的 Multi-Agent**：Run 1 和 Run 2 通常是同一个 Assistant，不是不同角色的 Agent
- **冲突风险**：多个 Run 同时读写 Thread 会导致消息混乱
- **无并行调度**：Assistants API 的 Run 是顺序执行的
- **过度结构化**：对于 CLI/TUI 工具，Thread/Run 抽象显得笨重

---

### 2.3 Devin — 并行 Agents + 中央调度器

```
                    ┌─────────────────┐
                    │   调度器 (Scheduler) │
                    │                  │
                    │  - 任务分解       │
                    │  - 资源分配       │
                    │  - 冲突仲裁       │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   ┌─────────┐        ┌─────────┐        ┌─────────┐
   │ Agent A │◄──────►│ Agent B │◄──────►│ Agent C │
   │(搜索)   │ 消息总线 │(修改)   │ 消息总线 │(测试)   │
   └────┬────┘        └────┬────┘        └────┬────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   共享状态存储   │
                    │  (State Store)   │
                    └─────────────────┘
```

**消息处理**: Agent 间通过消息总线（Message Bus）通信，支持 broadcast、point-to-point、pub/sub。

**合并策略**: 调度器收集所有 Agent 的结果，按优先级/时间/相关性合并，生成统一输出。

**状态管理**: 中央状态存储，所有 Agent 可读写。支持事务、乐观锁、版本控制。

**优点**:
- **真正并行**：多个 Agent 同时工作，总时间 ≈ max(t1, t2, t3)
- **专业化分工**：每个 Agent 可以针对特定任务优化
- **容错性**：单个 Agent 失败可重试或替换
- **可扩展**：新增 Agent 类型即可扩展能力

**缺点**:
- **复杂度极高**：消息总线、状态同步、冲突解决是分布式系统难题
- **调试地狱**：并行执行导致调用链复杂，难以复现问题
- **资源消耗**：多个 Agent 同时调用 LLM，token 成本翻倍
- **过度设计**：对于个人编程助手，中央调度器可能是杀鸡用牛刀

---

## 三、推荐方案：层次化 Agent Group（混合模式）

### 3.1 核心决策

基于 Paw-TS 的产品定位（个人编程助手）和用户的明确需求（多个子 Agent + 消息/合并/状态），推荐以下混合方案：

| 层面 | 借鉴哪个模式 | 具体采用 |
|------|-------------|----------|
| **产品模式** | Claude Code + Devin | ReAct 循环 + **并行子 Agent** |
| **执行模型** | Claude Code | 每个 Agent 独立 ReAct 循环 |
| **通信机制** | Devin（简化） | 共享上下文 + 事件通知（无消息总线） |
| **状态管理** | OpenCode（简化） | 层次化状态树（父子关联） |
| **调度策略** | Claude Code（父 Agent 调度） | **无中央调度器**，父 Agent 自然协调 |

**为什么不选纯 Devin**：
- 中央调度器对个人工具过度复杂
- 调试难度与收益不成正比
- 面试中解释 Multi-Agent 调度器风险高

**为什么不选纯 Claude Code**：
- 用户明确需要并行子 Agent
- 纯字符串结果无法满足"消息如何处理"的需求

### 3.2 目标架构：AgentGroup

```
┌─────────────────────────────────────────────────────────────┐
│                      AgentGroup                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Parent Agent                          │  │
│  │              (AgentOrchestrator)                       │  │
│  │  - 持有 AgentGroup 引用                                │  │
│  │  - 通过 tool_call 启动子 Agent                         │  │
│  │  - 接收子 Agent 事件通知                               │  │
│  │  - 决定下一步行动                                      │  │
│  └─────────────────────┬─────────────────────────────────┘  │
│                        │ launch / events                     │
│        ┌───────────────┼───────────────┐                    │
│        ▼               ▼               ▼                    │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐              │
│  │ Child A  │   │ Child B  │   │ Child C  │              │
│  │ (搜索)   │   │ (编码)   │   │ (测试)   │              │
│  │ ReAct    │   │ ReAct    │   │ ReAct    │              │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘              │
│       │              │              │                      │
│       └──────────────┼──────────────┘                      │
│                      │                                      │
│                      ▼                                      │
│           ┌─────────────────┐                              │
│           │  SharedContext   │                              │
│           │  (只读快照)      │                              │
│           └─────────────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**:
1. **父 Agent 是自然的协调者**：不需要中央调度器，父 Agent 的 ReAct 循环就是调度逻辑
2. **子 Agent 只读父上下文**：子 Agent 启动时获得父 Agent 上下文的快照，执行期间不实时同步
3. **子 Agent 事件上报**：子 Agent 的关键事件（tool call, completion, error）实时通知父 Agent
4. **结果合并到父上下文**：子 Agent 完成后，其完整消息历史合并到父 Agent 的 tool_result

---

## 四、关键机制设计

### 4.1 消息处理

**问题**: 多个子 Agent 同时运行，父 Agent 如何接收和管理它们的消息？

**方案：事件流 + 消息暂存区**

```typescript
// 子 Agent 的事件实时转发给父 Agent
interface AgentGroupEvent {
  readonly agentId: string;           // 哪个子 Agent 产生的
  readonly parentRunId: string;       // 所属父运行的 ID
  readonly event: RunEvent;           // 原始事件
}

// 父 Agent 的 AgentGroup 订阅所有子 Agent 的事件
class AgentGroup {
  private children = new Map<string, AgentController>();
  private eventBuffer: AgentGroupEvent[] = [];  // 事件暂存区
  
  // 子 Agent 事件上报
  onChildEvent(agentId: string, envelope: RunEventEnvelope): void {
    this.eventBuffer.push({ agentId, parentRunId: this.parentRunId, event: envelope.event });
    // 实时通知父 Agent 的 orchestrator（通过 onEvent 回调）
    this.parentOnEvent?.(envelope);
  }
}
```

**消息类型**: 
- **进度消息**: `loop.tick`, `model.chunk` — 让父 Agent 知道子 Agent 在干活
- **结果消息**: `tool.result`, `run.completed` — 子 Agent 完成具体任务
- **错误消息**: `run.failed`, `mcp.connection_failed` — 需要父 Agent 决策

**为什么不用消息总线**：
- 消息总线（pub/sub）适合 N:N 通信，但 Paw-TS 是 1:N（一个父对多个子）
- 直接回调更简单，无需引入消息队列复杂度

### 4.2 合并策略

**问题**: 多个并行子 Agent 完成后，它们的结果如何合并到父 Agent 的上下文？

**方案：结构化结果 + 批量 tool_results**

```typescript
// 扩展 SubAgentResult，包含完整结构化信息
interface SubAgentResult {
  readonly result: string;                    // 最终输出（给模型看的摘要）
  readonly status: "completed" | "failed";
  readonly stepsTaken: number;
  readonly messages: readonly ChatMessage[];  // ← 完整消息历史
  readonly events: readonly RunEventEnvelope[]; // ← 完整事件流
  readonly artifacts?: SubAgentArtifact[];     // ← 产生的文件/代码
}

interface SubAgentArtifact {
  readonly type: "file" | "code" | "test_result" | "search_result";
  readonly path?: string;
  readonly content: string;
  readonly summary: string;
}
```

**合并方式**:

```typescript
// 父 Agent 将并行子 Agent 的结果合并为一批 tool_results
function mergeParallelResults(
  results: SubAgentResult[],
  parentCtxMgr: ContextManager,
): void {
  // 每个子 Agent 的结果作为一个 tool_result
  const toolResults = results.map((r) => ({
    tool: "workspace.run_agent",
    ok: r.status === "completed",
    summary: r.result,
    payload: {
      stepsTaken: r.stepsTaken,
      artifacts: r.artifacts,
    },
  }));
  
  parentCtxMgr.addToolResults(toolResults);
  
  // 可选：将完整消息历史作为附加上下文注入
  for (const r of results) {
    if (r.messages.length > 2) {
      parentCtxMgr.addUser(
        `[Sub-agent execution trace]\n${formatMessagesForParent(r.messages)}`,
      );
    }
  }
}
```

**合并策略选项**（可配置）:

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| **Summary**（默认） | 只合并 `result` 字符串 | 子 Agent 结果独立，父 Agent 只需摘要 |
| **Full History** | 合并完整消息历史 | 子 Agent 的推理过程对父 Agent 有用 |
| **Artifacts Only** | 只合并文件/代码产出 | 子 Agent 是代码生成器 |
| **Progressive** | 实时合并（每轮 turn 合并一次） | 长运行子 Agent，父 Agent 需要中间结果 |

### 4.3 状态管理

**问题**: 父 Agent 和多个子 Agent 的状态如何关联？子 Agent 失败后如何影响父 Agent？

**方案：层次化状态树**

```typescript
// 层次化状态
interface AgentGroupState {
  readonly parentRunId: string;
  readonly parentStatus: "running" | "paused" | "completed" | "failed";
  readonly children: Map<string, ChildAgentState>;
}

interface ChildAgentState {
  readonly agentId: string;
  readonly goal: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly progress: number;           // 0-100，基于 turn/maxSteps
  readonly currentPhase?: string;      // "model" | "tool" | "waiting"
  readonly result?: SubAgentResult;
  readonly error?: string;
}

// 状态转换（子 Agent 级别）
type ChildStateTransition =
  | { from: "queued"; to: "running" }
  | { from: "running"; to: "completed" | "failed" | "cancelled" }
  | { from: "failed"; to: "running" };  // 支持重试
```

**父子状态关联规则**:

| 父状态 | 子状态行为 |
|--------|-----------|
| running | 子 Agent 正常执行 |
| paused | 子 Agent 暂停（保存 checkpoint， resume 时恢复） |
| failed | 所有子 Agent 取消 |
| completed | 所有子 Agent 取消 |

| 子状态变化 | 父 Agent 行为 |
|-----------|--------------|
| 单个失败 | 父 Agent 收到事件，自行决策（重试/忽略/失败） |
| 全部完成 | 父 Agent 继续下一轮 |
| 进度更新 | 父 Agent 可展示进度条（TUI） |

**为什么不用中央状态存储**：
- 父子关系是 1:N，不是 N:N，不需要分布式状态存储
- 每个 Agent 的 `AgentOrchestrator` 已经管理自己的状态
- `AgentGroup` 只是聚合子 Agent 的状态快照

---

## 五、与三种模式的映射

| 机制 | 当前 Paw-TS | Claude Code | OpenCode | Devin | **推荐方案** |
|------|------------|-------------|----------|-------|-------------|
| **子 Agent 启动** | 同步 `launch()` | 同步 `spawn()` | `Run.create()` | 调度器分配 | **并行 `launchAll()`** |
| **结果格式** | 纯字符串 | 纯字符串 | Thread 消息 | 结构化状态 | **结构化 `SubAgentResult`** |
| **消息传递** | 无 | 无 | Thread 读写 | 消息总线 | **事件回调 + 暂存区** |
| **合并策略** | 字符串拼接 | 字符串拼接 | 时间顺序 | 调度器聚合 | **批量 tool_results + 可配置策略** |
| **状态可见性** | 不透明 | 不透明 | Run 状态 | 全局状态 | **层次化状态树** |
| **调度器** | 无 | 无 | 无 | 中央调度器 | **父 Agent 自然调度（无中央调度器）** |

---

## 六、对 PHASE1_PLAN 的调整

### 6.1 原 PHASE1_PLAN 的局限

原计划在 Multi-Agent 方面只做了简单提及：
- "Sub-agent 保持为工具调用"
- 无并行启动设计
- 无结构化结果设计
- 无状态共享设计

### 6.2 必须引入的新组件

| 组件 | 文件 | 职责 | 行数预估 |
|------|------|------|----------|
| `AgentGroup` | `orchestrator/agent-group.ts` | 管理父子 Agent 关系、事件转发、状态聚合 | ~150 |
| `ParallelLauncher` | `agent/parallel-launcher.ts` | 并行启动多个子 Agent，`Promise.all` 管理 | ~80 |
| 扩展 `SubAgentResult` | `harness/context.ts` | 增加 messages/events/artifacts 字段 | ~20 |
| 扩展 `SubAgentLauncher` | `harness/context.ts` | 增加 `launchAll()` 方法 | ~10 |
| `ChildAgentState` | `orchestrator/types.ts` | 子 Agent 状态定义 | ~30 |

### 6.3 调整后的文件拆分

```
packages/agent/src/
  orchestrator.ts              # 主入口：~180 行
  orchestrator/
    types.ts                   # TurnState + TurnFlags + PhaseContext + ChildAgentState
    action-handlers.ts         # 各 action handler（含 run_agent 的并行启动）
    tool-runner.ts             # 统一工具执行 + finalizeToolExecution
    agent-group.ts             # AgentGroup：父子关系 + 事件转发 + 状态聚合
```

### 6.4 `executeTurn` 中 Multi-Agent 相关改动

原 `executeTurn` 中 `run_agent` 作为普通 tool_call 处理（通过 `executeToolCalls`）。

调整后：
1. `run_agent` tool_call 被 `tool-runner.ts` 捕获
2. 如果 `args.agents` 是数组（多个子 Agent），调用 `ParallelLauncher.launchAll()`
3. `ParallelLauncher` 为每个 goal 创建子 Agent，并行执行
4. 子 Agent 的事件通过 `AgentGroup.onChildEvent()` 实时上报父 Agent
5. 所有子 Agent 完成后，`AgentGroup` 按策略合并结果
6. 合并后的结果通过 `finalizeToolExecution` 进入父 Agent 上下文

### 6.5 与状态机的关系

状态机仍然只管理**单次 turn 内**的状态转换：

```
model_calling → action_dispatch → tool_executing
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │  AgentGroup 介入    │
                              │  - 并行启动子 Agent │
                              │  - 收集事件        │
                              │  - 等待全部完成    │
                              └─────────────────────┘
                                         │
                                         ▼
                              continue / completed
```

状态机本身不需要知道 Multi-Agent 的细节，它只看到 `tool_executing` Phase 执行时间变长了（因为内部是并行的）。

---

## 七、验证策略

### 7.1 新增测试场景

| 场景 | 验证目标 |
|------|----------|
| 并行搜索 | 启动 3 个子 Agent 并行 grep，结果在 1 个 turn 内合并 |
| 失败重试 | 子 Agent A 失败，父 Agent 决定重试或忽略 |
| 进度可见 | TUI 显示每个子 Agent 的进度 |
| 上下文继承 | 子 Agent 能看到父 Agent 的部分上下文 |
| 事件顺序 | 并行子 Agent 的事件按时间顺序到达父 Agent |

### 7.2 行为一致性检查

- [ ] 单个子 Agent（不并行）的行为与重构前完全一致
- [ ] 父 Agent 的 `run()` 返回格式不变
- [ ] 子 Agent 失败不导致父 Agent 崩溃
- [ ] 所有原有 468 个测试通过

---

## 八、面试话术（Multi-Agent 设计）

### 开场（30 秒）

> "Paw-TS 的 Multi-Agent 设计是层次化的：一个父 Agent 协调多个子 Agent，没有中央调度器。父 Agent 的 ReAct 循环本身就是调度逻辑——它决定何时启动子 Agent、如何解释它们的结果。"

### 为什么不用 Devin 的中央调度器

> "中央调度器适合 N:N 的复杂协作，但 Paw-TS 是 1:N 的父子结构。引入调度器会增加消息总线、状态同步、冲突仲裁等复杂度，对个人编程助手来说是过度设计。父 Agent 自然就是协调者。"

### 消息处理

> "子 Agent 的事件通过回调实时上报给父 Agent，暂存在一个事件缓冲区。父 Agent 可以选择实时响应（如展示进度）或等全部完成后再处理。子 Agent 间不直接通信，避免分布式一致性问题。"

### 合并策略

> "合并是可配置的。默认策略是 Summary——只把子 Agent 的结果字符串作为 tool_result 合并。如果父 Agent 需要了解子 Agent 的推理过程，可以切换为 Full History 策略，把完整消息历史注入上下文。"

### 状态管理

> "状态是层次化的。每个子 Agent 有自己的 ReAct 状态，AgentGroup 聚合它们的状态快照。父 Agent 可以查询'子 Agent A 执行到哪一步了'，但子 Agent 的内部状态对父 Agent 是只读的。"

---

## 九、结论

### 最终推荐

| 维度 | 决策 |
|------|------|
| **核心模式** | **层次化 Agent Group**：父 Agent 协调 + 子 Agent 并行执行 |
| **借鉴 Claude Code** | 每个 Agent 独立的 ReAct 循环；父 Agent 自然调度 |
| **借鉴 Devin** | 并行子 Agent；结构化结果；事件上报 |
| **借鉴 OpenCode** | 层次化状态定义（但不引入 Thread/Run API） |
| **不借鉴** | Devin 的中央调度器、消息总线、全局状态存储 |

### PHASE1_PLAN 调整总结

| 原计划 | 调整后 |
|--------|--------|
| 4 个文件 | **5 个文件**（新增 `agent-group.ts`） |
| SubAgentResult 纯字符串 | **结构化**（messages + events + artifacts） |
| SubAgentLauncher 单 `launch()` | **增加 `launchAll()`** 并行启动 |
| 无 Agent 间通信 | **事件回调 + 暂存区** |
| 无状态聚合 | **AgentGroupState + ChildAgentState** |
| 状态机只管理单次 turn | **不变**，Multi-Agent 细节封装在 AgentGroup 内 |

**代码层面改动估算**:
- 新增代码：~400 行（AgentGroup + ParallelLauncher + 类型扩展）
- 修改代码：~100 行（executeToolCalls 中 run_agent 的特殊处理）
- 总时间：在原 Phase 1 基础上增加 **2-3 天**

---

> **最后更新**: 2026-05-14
> 
> **状态**: 分析完成，等待用户确认 Multi-Agent 架构方案后更新 PHASE1_PLAN
