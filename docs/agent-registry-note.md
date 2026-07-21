# Agent 注册与发现机制

## 新增业务 Agent（三选一）

### 方式一：手工创建（推荐，持久化）

在 `.paw/agents/` 下新建 `<id>.md`，格式如下：

```yaml
---
id: my-agent          # 小写英文+连字符
name: 我的助手         # 显示名
role: 代码审查员        # 短标签
prompt: >             # 系统提示词
  你是一名资深代码审查员……
tools: inherit        # "inherit" 或 "read_file,write_file"
child_policy: read_only  # read_only(默认) / read_write
model: flash          # flash / pro / inherit
emoji: 🔍
description: 审查代码并提供改进建议
---
请帮我审查以下代码……
```

### 方式二：对话中创建

直接让狸花执行：`workspace.create_agent`。

### 方式三：代码调用

`registry.register(spec)` 注册内存实例；`writeAgentFile(input)` 落盘 `.paw/agents/<id>.md`；`registry.reload()` 重新扫描目录使新文件生效。

## 狸花如何发现和选用

1. **注册**：启动时加载 8 个种子 Agent + `.paw/agents/` 下所有 `.md`，解析、校验后注册到 `AgentRegistry`。
2. **花名册**：`AgentRegistry` 将所有 Agent 摘要（id、name、role、emoji、description）构建为 `catalogText`，注入狸花的 system prompt。
3. **调度**：狸花根据任务评估，调用 `workspace.run_agent(agent_id=<id>)` 选定子 Agent。
4. **执行**：`DefaultSubAgentLauncher` → `materializeAgent`（解析 spec、确定 model/tools/runMode）→ 注入 `sharedContext` → 启动 ReAct 循环。
5. **结果**：子 Agent 只返回摘要，父 Agent 整合到对话上下文中。
