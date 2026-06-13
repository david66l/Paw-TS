# Phase 1 编排模式分析：三种架构对比与推荐

> **分析目标**: 为 Paw-TS 选择最适合的 Agent 编排模式，并据此调整 PHASE1_PLAN

---

## 一、Paw-TS 当前编排模式诊断

### 1.1 从代码分析当前模式

```
用户输入 goal
    ↓
[Turn 1] model.call() → parse → tool_call(list_dir) → execute → loop
    ↓
[Turn 2] model.call() → parse → tool_call(read_file) → execute → loop
    ↓
[Turn 3] model.call() → parse → tool_call(write_file) → execute → loop
    ↓
[Turn 4] model.call() → parse → final_answer → completed
```

**动作类型**（`parse-agent-action.ts` 定义）:
- `tool_call` — 调用工具（read/write/edit/shell/search/...）
- `final_answer` — 任务完成，返回答案
- `ask_user` — 向用户提问，等待回复
- `plan_update` — 动态更新任务计划
- `abort` — 终止运行

**核心特征**:
1. **ReAct 循环**: 每轮固定 `model → observe(tool result) → think → act`
2. **隐式 Plan**: 没有预定义计划，模型自行决定下一步；`plan_update` 只是给模型一个"记笔记"的机制
3. **Sub-agent 作为工具**: `workspace.run_agent` 是一个普通工具，由外部 `SubAgentLauncher` 创建新的 `AgentOrchestrator`
4. **单 Agent 主导**: 主 orchestrator 控制整个运行，子 agent 是被动调用的

### 1.2 当前模式 = Claude Code 的简化版

| 维度 | Paw-TS 当前 | Claude Code |
|------|------------|-------------|
| 外层循环 | ReAct turn-based | ReAct turn-based |
| Plan | 隐式 + plan_update | 隐式 + 内部 TaskPlanner |
| Sub-agent | `run_agent` 工具 | 嵌套 SubAgentLauncher |
| 动作类型 | 5 种 | 更多（含内部动作） |
| 状态管理 | 无显式状态机 | Session 对象管理 |

**结论**: Paw-TS 当前本质上就是 **ReAct + 隐式 Plan** 模式，与 Claude Code 同族。

---

## 二、三种编排模式深度对比

### 2.1 模式一：Claude Code — ReAct + 隐式 Plan + 嵌套 Sub-agents

```
┌─────────────────────────────────────────┐
│  ReAct Loop (主 Agent)                   │
│  model → parse → action → tool → loop   │
│       ↓                                 │
│  [隐式 Plan] 模型自行决定下一步          │
│       ↓                                 │
│  SubAgentLauncher.spawn(task) ─────┐    │
│  (子 Agent 有自己的完整循环)        │    │
│                                    ↓    │
│                              ┌────────┐ │
│                              │ Sub-Agent│
│                              │ (ReAct) │ │
│                              └────┬───┘ │
│                                   │return│
│                                   └────┘ │
└─────────────────────────────────────────┘
```

**核心哲学**: 模型是"导演"，自己决定观察什么、思考什么、做什么。Plan 不是预先制定的剧本，而是模型在运行过程中自然形成的思路。

**优点**:
- **灵活性极高**: 模型可以根据中间结果随时调整策略，不需要预先定义所有步骤
- **对话自然**: 适合开放式任务，用户体验像与工程师对话
- **实现简单**: 核心就是一个循环，没有复杂的状态机或调度器
- **单点可控**: 只有一个主 Agent，调试和可解释性强

**缺点**:
- **可复现性差**: 同样的输入可能产生不同的执行路径（模型决定论问题）
- **可能"走偏"**: 模型可能在某一轮做出次优决策，后续难以纠正
- **长任务效率低**: 复杂任务需要很多轮，没有并行优化
- **Plan 是隐式的**: 无法提前知道模型会做什么，难以做资源预算

**适用场景**:
- 通用编程助手（Claude Code、Cursor Composer）
- 对话式 AI（ChatGPT、Claude）
- 探索性任务（研究、调试、代码审查）

---

### 2.2 模式二：OpenCode (Assistants API) — 显式 Run/Step/Thread 状态机

```
┌─────────────────────────────────────────┐
│  Thread (消息容器)                        │
│  ┌─────────────────────────────────────┐│
│  │ Run 1 (状态机驱动)                   ││
│  │  ┌─────┐  ┌─────┐  ┌─────┐        ││
│  │  │Step1│→│Step2│→│Step3│        ││
│  │  │model│  │tool │  │model│        ││
│  │  └──┬──┘  └─────┘  └─────┘        ││
│  │     │ queued / in_progress /       ││
│  │     │ completed / failed /         ││
│  │     │ cancelled / expired          ││
│  │     ↓                              ││
│  │  状态机严格管理生命周期             ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

**核心哲学**: 运行是一个有严格状态定义的过程，每个 Step 的状态转换是显式、可追踪、可恢复的。

**优点**:
- **状态清晰**: 任何时刻都知道运行处于什么状态（queued → in_progress → completed）
- **可恢复**: 运行中断后可以从任意 Step 恢复
- **可观测**: 每个 Step 的输入输出都是结构化的，便于审计和调试
- **适合 API**: Thread/Run/Step 天然映射到 REST API 资源

**缺点**:
- **灵活性受限**: 状态转换是预定义的，难以支持动态分支
- **过度结构化**: 对于对话式交互，严格的状态机可能显得笨重
- **实现复杂**: 需要维护状态持久化、并发控制、超时处理

**适用场景**:
- API 服务（OpenAI Assistants API）
- 需要持久化和恢复的后台任务
- 多用户共享上下文的协作场景

---

### 2.3 模式三：Devin — Multi-Agent 协作 + 任务调度器

```
┌─────────────────────────────────────────┐
│         中央调度器 (Scheduler)            │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│  │Agent│ │Agent│ │Agent│ │Agent│       │
│  │  A  │ │  B  │ │  C  │ │  D  │       │
│  │Plan │ │Code │ │Test │ │Doc  │       │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘       │
│     │       │       │       │           │
│     └───────┴───┬───┴───────┘           │
│                 ↓                       │
│            消息总线 (共享状态)            │
│                 ↓                       │
│            结果聚合器                   │
└─────────────────────────────────────────┘
```

**核心哲学**: 复杂任务应该分解给多个专业化 Agent 并行执行，通过中央调度器协调。

**优点**:
- **并行效率**: 多个 Agent 同时工作，显著缩短复杂任务时间
- **专业化**: 每个 Agent 可以针对特定任务优化（规划、编码、测试、文档）
- **容错性**: 单个 Agent 失败不影响其他 Agent
- **可扩展**: 新增 Agent 类型即可扩展能力

**缺点**:
- **复杂度极高**: Agent 间通信、状态同步、冲突解决是 NP-hard 问题
- **调试困难**: 并行执行导致调用链复杂，难以追踪问题根因
- **资源消耗**: 多个 Agent 同时运行 LLM 调用，token 成本翻倍
- **协调开销**: Agent 间通信和等待可能抵消并行收益

**适用场景**:
- 复杂工程项目（Devin、SWE-agent）
- 需要多角色协作的任务（设计 + 实现 + 测试）
- 有足够预算和基础设施的团队

---

## 三、推荐决策

### 3.1 决策矩阵

| 评估维度 | Claude Code (ReAct+隐式Plan) | OpenCode (Run/Step) | Devin (Multi-Agent) |
|----------|------------------------------|---------------------|---------------------|
| **与 Paw-TS 当前架构匹配度** | ⭐⭐⭐⭐⭐ 同族 | ⭐⭐⭐ 需大幅改动 | ⭐⭐ 完全不同 |
| **产品定位契合度**（个人编程助手） | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| **实现复杂度** | ⭐⭐⭐⭐⭐ 低 | ⭐⭐⭐ 中 | ⭐⭐ 高 |
| **可扩展性** | ⭐⭐⭐ 中 | ⭐⭐⭐⭐ 高 | ⭐⭐⭐⭐⭐ 极高 |
| **面试可解释性** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| **测试覆盖难度** | ⭐⭐⭐⭐ 低 | ⭐⭐⭐⭐ 中 | ⭐⭐ 高 |

### 3.2 核心推荐

**产品模式: Claude Code 的 ReAct + 隐式 Plan**

理由:
1. Paw-TS 当前已经是这个模式，保持同族演进成本最低
2. 个人编程助手的核心场景是"对话式完成任务"，ReAct 最自然
3. 面试中解释 ReAct 循环比解释 Multi-Agent 调度器更容易获得认可
4. 隐式 Plan 让模型保持灵活性，不会因为 rigid plan 而卡住

**架构实现: 借鉴 OpenCode 的显式状态机（单次 Turn 内）**

理由:
1. 当前 `executeTurn` 的 348 行 if-else 链是代码层面的问题，不是产品模式的问题
2. 引入状态机解决的是**实现耦合**，不是替换**产品语义**
3. 状态机只管理单次 turn 内部：`model_calling → action_dispatch → [tool_executing | user_waiting | plan_updating | completed | failed]`
4. 外层仍然是 ReAct 循环：`for (turn = 0; turn < maxSteps; turn++)`

**Devin 的 Multi-Agent: 远期扩展，不在 Phase 1**

理由:
1. 当前 `run_agent` 已经是 Multi-Agent 的雏形，但使用频率低
2. Multi-Agent 调度器是 P2/P3 级别功能，不是架构地基
3. Phase 1 的目标是"消除技术债务"，不是"增加新能力"

---

## 四、对 PHASE1_PLAN 的调整

### 4.1 原计划回顾

原 PHASE1_PLAN 设计的状态机：
```typescript
type TurnState =
  | { type: "model_calling" }
  | { type: "action_dispatch"; actions: AgentAction[]; text: string }
  | { type: "tool_executing"; calls: AgentToolCallAction[] }
  | { type: "user_waiting"; question: string }
  | { type: "plan_updating"; items: unknown[] }
  | { type: "completed"; message: string }
  | { type: "failed"; message: string }
  | { type: "continue" };
```

### 4.2 需要调整的地方

**原计划方向正确，但需要明确边界：**

1. **状态机只管理单次 turn 内部**，不管理跨 turn 的 ReAct 循环
   - `run()` 方法保持 `for` 循环不变
   - `executeTurn` 被拆分为状态机驱动的 Phase Handler
   - ✅ 原计划已体现这一点，需显式声明

2. **不引入 Thread/Run/Step 的 API 抽象层**
   - 原计划中没有 Thread/Run 概念，这很好
   - 需要明确说明：Paw-TS 不是 API 服务，不需要 Assistants API 的资源模型

3. **Sub-agent 保持为工具，不是一等公民**
   - `workspace.run_agent` 继续作为普通 tool_call
   - 不引入 Agent Pool 或 Agent Registry
   - Multi-Agent 调度器是 Phase 3+ 的考虑

4. **Plan 保持隐式，模型自行决定执行顺序**
   - `plan_update` 只是给模型"记笔记"的能力
   - 不引入 `PlanExecutor` 自动调度（这是 P1 功能改进，不是 Phase 1 架构重构）

### 4.3 调整后的架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentOrchestrator.run()                   │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  ReAct Loop (保留不变)                                   ││
│  │  for (let turn = startTurn; turn < maxSteps; turn++) {  ││
│  │    const state = await executeTurn(turn, ctx, flags);   ││
│  │    if (state.type === "continue") continue;             ││
│  │    return { status: state.type, message: state.message };││
│  │  }                                                      ││
│  └─────────────────────────────────────────────────────────┘│
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  executeTurn → Phase Handler 调度器（新增）              ││
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              ││
│  │  │  Model   │→ │  Parse   │→ │ Dispatch │              ││
│  │  │  Phase   │  │  Phase   │  │  Phase   │              ││
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘              ││
│  │       │             │             │                     ││
│  │       ↓             ↓      ┌──────┴──────┐             ││
│  │  [stale files]  [actions]  │ 路由到 Handler │           ││
│  │  [prune]              ┌────┴───┬───┬───┬──┴──┐         ││
│  │  [compact]            ↓       ↓   ↓   ↓     ↓         ││
│  │                    tool    final ask plan  abort       ││
│  │                   _call   _answer _user _update         ││
│  │                       ↓                                ││
│  │              ┌────────┴────────┐                      ││
│  │              │ ToolRunner (统一)│                      ││
│  │              │ 并行/单工具复用  │                      ││
│  │              └─────────────────┘                      ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 4.4 具体调整项

| 原计划 | 调整后 | 原因 |
|--------|--------|------|
| `TurnFlags` 函数式更新 | 保持 | ✅ 正确，消除 mutable wrapper |
| `PhaseContext` 替代 `RunTurnContext` | 保持 | ✅ 正确，解耦数据传递 |
| `finalizeToolExecution` 统一后处理 | 保持 | ✅ 正确，消除重复逻辑 |
| Action Handler 接口 | 保持 | ✅ 正确，开闭原则 |
| — | **明确声明**: 状态机只管理单次 turn 内 | 避免误解为替换 ReAct 循环 |
| — | **明确声明**: 不引入 Thread/Run/Step API | 保持 CLI/TUI 工具定位 |
| — | **明确声明**: Sub-agent 保持为工具 | 不在 Phase 1 引入 Agent Pool |
| `PlanExecutor` 自动调度 | **移出 Phase 1** | 这是功能改进（P1），不是架构重构 |

---

## 五、面试话术（为什么选 ReAct + 状态机）

### 开场（30 秒）

> "Paw-TS 的编排架构是 ReAct + 隐式 Plan，这是一个经过验证的模式——Claude Code、Cursor Composer 都在用。核心是一个 turn-based 循环：模型观察工具结果，思考下一步，然后行动。"

### 为什么不用 Multi-Agent（Devin 模式）

> "Multi-Agent 适合复杂工程项目，但引入了大量协调开销。对于个人编程助手，单个 Agent 的决策链更短、调试更简单。Devin 的 SWE-bench 成绩很好，但它的定位是'替代初级工程师'，而 Paw-TS 的定位是'辅助工程师'。"

### 为什么引入状态机（OpenCode 借鉴）

> "虽然产品模式是 ReAct，但实现上我借鉴了 OpenCode Assistants API 的状态机思想——不是替换 ReAct，而是在单次 turn 内用显式状态管理替代 if-else 面条代码。这样每个 action handler 独立可测试，新增 action 类型零侵入。"

### 为什么 Plan 是隐式的

> "显式 Plan（如 PDDL）适合确定性环境，但编程任务高度动态——模型可能在第 3 轮发现第 1 轮的假设是错的。隐式 Plan 让模型自行调整，plan_update 只是给它一个'记笔记'的工具。"

---

## 六、结论

### 推荐组合

**产品模式**: Claude Code 的 **ReAct + 隐式 Plan**（保持不变）
**架构实现**: 借鉴 OpenCode 的 **单次 Turn 内显式状态机**（引入 Phase Handler）
**远期扩展**: Devin 的 **Multi-Agent 调度器**（P3+ 可选）

### PHASE1_PLAN 是否需要更新

**原计划方向正确，只需补充边界声明**：
1. 状态机只管理单次 turn 内部，不替换外层 ReAct 循环
2. 不引入 Thread/Run/Step API 抽象
3. Sub-agent 保持为工具调用
4. `PlanExecutor` 自动调度移出 Phase 1（归入功能改进）

**代码层面的改动不变**：
- 文件拆分方案不变
- 接口设计不变
- 迁移步骤不变
- 验证标准不变

---

> **最后更新**: 2026-05-14
> 
> **状态**: 分析完成，PHASE1_PLAN 方向确认正确，需微调边界声明
