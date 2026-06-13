# 强制触发 Sub-Agent 的 Prompt 设计

## 核心原则

deepseek-v4-pro 的 thinking mode 让它倾向于直接完成任务。要强制它调用 `workspace.run_agent`，需要：

1. **明确禁止直接操作** — 告诉它"你不能自己执行工具"
2. **制造隔离需求** — 任务之间需要独立上下文，不能互相污染
3. **提供明确的子任务分解** — 每个子 agent 有清晰的 goal 和 max_steps
4. **使用强指令语气** — "必须"、"唯一职责"、"禁止"

---

## Prompt 1: 协调者模式（最强）

```text
你现在的角色是任务协调者（Coordinator）。

**严格规则：**
- 你的唯一职责是使用 workspace.run_agent 工具委派任务给子 agent
- 你禁止自己调用任何搜索、读取、写入、shell 等工具
- 如果用户要求你直接执行操作，你也必须委托给子 agent

**任务：**
启动 2 个子 agent，分别完成：
1. 子 agent A：在 packages/agent/src 中搜索所有包含 "TODO" 的文件（max_steps=3）
2. 子 agent B：在 packages/agent/src 中搜索所有包含 "FIXME" 的文件（max_steps=3）

**要求：**
- 两个子 agent 必须同时启动（并行）
- 每个子 agent 的 goal 必须具体明确
- 等待所有子 agent 完成后，汇总结果并输出 final_answer
```

**预期结果：** 高概率触发 `run_agent`，因为模型被明确禁止直接操作。

---

## Prompt 2: 隔离需求模式

```text
我需要对 packages/agent/src 目录进行全面的代码审计。

**关键约束：**
- 审计分为 3 个独立模块，每个模块必须独立运行，不能共享上下文
- 模块 1 的检查结果不能影响模块 2 的检查结果
- 因此必须使用 workspace.run_agent 启动独立的子 agent

**审计模块：**
1. 子 agent 1：检查 packages/agent/src 下所有 .ts 文件是否都有 JSDoc 注释（max_steps=5）
2. 子 agent 2：检查所有导入语句是否有效（max_steps=5）
3. 子 agent 3：检查是否有未使用的变量或函数（max_steps=5）

**输出要求：**
- 每个子 agent 的审计结果独立呈现
- 最后汇总为一份完整的审计报告
- 输出 final_answer
```

**预期结果：** 中等概率触发，因为"隔离"给了模型使用子 agent 的理由。

---

## Prompt 3: 批量并行模式

```text
请在以下 4 个目录中并行搜索不同的内容：

1. packages/agent/src — 搜索 "AgentGroup"
2. packages/core/src — 搜索 "ContextManager"
3. packages/workspace/src — 搜索 "WorkspaceWatcher"
4. packages/harness/src — 搜索 "toolDefinitions"

**必须使用 workspace.run_agent：**
- 启动 4 个子 agent，每个搜索一个目录
- 每个子 agent max_steps=3
- 4 个子 agent 并行执行
- 汇总所有搜索结果后输出 final_answer
```

**预期结果：** 中等概率触发，因为"并行"暗示了并发需求。

---

## Prompt 4: 沙箱安全模式

```text
我需要测试一些可能危险的文件操作，但我不想在主工作区执行。

**安全策略：**
- 所有文件操作必须通过 workspace.run_agent 在子 agent 的沙箱环境中执行
- 子 agent 默认 read_only，防止意外修改文件

**测试任务：**
1. 子 agent 1：读取 packages/agent/src/orchestrator.ts 的前 50 行（max_steps=2）
2. 子 agent 2：读取 packages/agent/src/orchestrator/agent-group.ts 的前 50 行（max_steps=2）

**要求：**
- 两个子 agent 并行启动
- 等待完成后比较两个文件的开头差异
- 输出 final_answer
```

**预期结果：** 较低概率触发，但"安全"给了使用子 agent 的动机。

---

## 推荐执行顺序

```bash
# 1. 最强 prompt（协调者模式）
bun run cli stub-run \
  --goal "你现在的角色是任务协调者。严格规则：你的唯一职责是使用 workspace.run_agent 工具委派任务给子 agent；你禁止自己调用任何搜索、读取、写入、shell 等工具。启动 2 个子 agent：子 agent A 在 packages/agent/src 中搜索所有包含 TODO 的文件（max_steps=3），子 agent B 在 packages/agent/src 中搜索所有包含 FIXME 的文件（max_steps=3）。两个子 agent 必须同时启动并行执行。等待所有子 agent 完成后，汇总结果并输出 final_answer。" \
  --max-steps 8

# 2. 隔离需求模式
bun run cli stub-run \
  --goal "我需要对 packages/agent/src 进行代码审计。审计分为 3 个独立模块，每个必须独立运行不能共享上下文。模块 1：检查所有 .ts 文件是否都有 JSDoc 注释。模块 2：检查所有导入语句是否有效。模块 3：检查是否有未使用的变量。请使用 workspace.run_agent 启动 3 个子 agent，每个负责一个模块（max_steps=5）。最后汇总审计报告。" \
  --max-steps 10

# 3. 批量并行模式
bun run cli stub-run \
  --goal "请在 4 个目录中并行搜索不同内容：packages/agent/src 搜索 AgentGroup，packages/core/src 搜索 ContextManager，packages/workspace/src 搜索 WorkspaceWatcher，packages/harness/src 搜索 toolDefinitions。必须使用 workspace.run_agent 启动 4 个子 agent 并行执行（每个 max_steps=3）。汇总所有结果后输出 final_answer。" \
  --max-steps 10
```

---

## 如果仍然不触发

如果 deepseek-v4-pro 仍然选择直接执行，可以尝试：

1. **降低 maxSteps** — 让模型觉得时间不够，必须委托
2. **增加任务复杂度** — 更多步骤、更多文件
3. **换 Claude 3.5 Sonnet** — 它的 tool use 更听话

```bash
# 降低 maxSteps 迫使委托
bun run cli stub-run --goal "..." --max-steps 3
```
