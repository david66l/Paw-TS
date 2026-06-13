# Paw-TS 核心能力测试报告

**测试时间**: 2026-05-14  
**测试范围**: Agent 工作流、记忆机制、上下文压缩  
**总测试数**: 75 (agent 包全量) + 393 (其他包) = 468  pass  
**失败数**: 1 (core 包 CostTracker 已知问题)

---

## 一、Agent 工作流测试

**测试文件**: `packages/agent/test/capabilities-integration.test.ts`  
**测试数**: 6  |  **通过率**: 100%

### 1.1 多轮对话工作流
- **场景**: list_dir → read_file → write_file → final_answer
- **验证点**:
  - 4 轮循环正确执行（3 个工具 + 1 个最终回答）
  - 每个工具的事件流完整（tool.call → tool.result）
  - 文件系统实际写入成功
- **状态**: ✅ PASS

### 1.2 并行工具调用
- **场景**: 单轮同时读取两个文件
- **验证点**:
  - 单轮发出 2 个 tool.call
  - 2 个 tool.result 在同一轮返回
  - 总轮数 = 2（执行轮 + 回答轮）
- **状态**: ✅ PASS

### 1.3 Plan 计划系统
- **场景**: plan_update → final_answer
- **验证点**:
  - plan.updated 事件正确发射
  - 下一轮用户消息中嵌入 plan snapshot JSON
  - snapshot 包含完整 plan 数据
- **状态**: ✅ PASS

### 1.4 工具审批流
- **场景**: approvalPolicy + resolveToolApproval 控制 write_file / run_shell
- **验证点**:
  - deny 时工具不执行，返回 "denied" 错误
  - approve 时工具正常执行
  - 文件系统状态与审批结果一致
- **状态**: ✅ PASS (2 tests)

### 1.5 中断信号
- **场景**: AbortController 在 tool.result 后中断
- **验证点**:
  - run 状态变为 "failed"
  - 消息为 "Run aborted."
- **状态**: ✅ PASS

---

## 二、记忆机制测试

**测试数**: 7  |  **通过率**: 100%

### 2.1 Session Memory（会话记忆）
- **存储位置**: `~/.paw/projects/{hash}/session-memory/{runId}.md`
- **验证点**:
  - YAML frontmatter + Markdown body 格式正确
  - save/load 往返保持所有字段
  - loadLatest 按 mtime 返回最新文件
  - 文件包含标准章节：Task, Current State, Files & Functions, Key Decisions, Errors & Fixes, Relevant Context
- **状态**: ✅ PASS (2 tests)

### 2.2 Auto Memory（自动记忆）
- **存储位置**: `~/.paw/projects/{hash}/memory/{name}.md`
- **验证点**:
  - YAML frontmatter 包含 name, description, type
  - save/load/list/delete 完整 CRUD
  - buildIndex 生成 MEMORY.md 索引表
  - 四种类型均支持：user, feedback, project, reference
- **状态**: ✅ PASS (2 tests)

### 2.3 记忆提取 Agent
- **验证点**:
  - `extractMemories` 通过 mock launcher 正确解析 markdown 格式的记忆条目
  - "No memories to extract." 返回空数组
  - `runCompressionAgent` 将 markdown summary 转换为结构化 SessionMemory
  - Key Decisions、Errors & Fixes、Files & Functions 均正确提取
- **状态**: ✅ PASS (3 tests)

---

## 三、上下文压缩测试

**测试数**: 9  |  **通过率**: 100%

### 3.1 ContextCompactor（Layer 2/3 压缩器）
- **触发阈值**: `contextWindow * 0.70 - 10_000` ≈ 79,600 tokens (128K 窗口)
- **验证点**:
  - 小消息不触发压缩 (shouldCompact = false)
  - 大消息正确触发压缩 (shouldCompact = true)
  - Head 保护前 2 条消息
  - Tail 保护尾部 20% token 预算
  - 增量摘要 prompt 正确构建（anchored 模式）
  - Anti-thrashing: 连续节省 < 15% 时跳过
  - 熔断机制: 连续 3 次失败禁用自动压缩
  - reset() 可清除熔断状态
- **状态**: ✅ PASS (5 tests)

### 3.2 pruneToolResults（Layer 1 修剪器）
- **策略**:
  - Phase A: 单条工具输出超 500 行 / 50KB 截断
  - Phase B: 超出尾部 100K tokens 的旧工具结果替换为 `<compacted: ...>`
- **验证点**:
  - 600 行输出正确截断到 500 行，标记剩余行数
  - 大量旧工具结果被 compact 为占位符
  - 受保护工具（skill, web_fetch, web_search, todo_write）不被截断
- **状态**: ✅ PASS (3 tests)

### 3.3 完整压缩流水线
- **场景**: 50 个大工具结果消息触发 Layer 1 + Layer 2/3 联合压缩
- **验证点**:
  - prune 触发 Phase B compact
  - compactor 阈值检查通过 (shouldCompact = true)
  - Head/Tail 边界保护有效
  - 摘要 prompt 正确生成
- **状态**: ✅ PASS

---

## 四、现有单元测试回归

| 包 | 测试数 | 状态 |
|---|---|---|
| packages/agent | 53 → 75 | ✅ 全绿 |
| packages/core | 54 | ⚠️ 1 fail (CostTracker) |
| packages/settings | — | ✅ 全绿 |
| packages/workspace | — | ✅ 全绿 |
| packages/harness | — | ✅ 全绿 |
| packages/models | — | ✅ 全绿 |
| packages/store | — | ✅ 全绿 |
| packages/cli-core | — | ✅ 全绿 |
| apps/cli | 2 | ✅ 全绿 |
| apps/tui | 5 | ✅ 全绿 |

---

## 五、关键发现与建议

### 5.1 已验证的核心设计
1. **三层渐进式压缩**: Layer 1 (Prune) → Layer 2/3 (Compactor) 工作正常
2. **压缩-记忆一体化**: 压缩 Agent 同时生成 SessionMemory，设计有效
3. **并行工具执行**: 单轮多工具调用正确执行
4. **Plan 快照注入**: 计划状态自动嵌入后续消息
5. **工具审批网关**: approvalPolicy + resolveToolApproval 双重控制可靠

### 5.2 轻微问题
- **CostTracker 测试失败**: `packages/core/test/cost-tracker.test.ts` 中 `summary returns human-readable string` 断言失败，不影响功能
- **Workspace 链接**: bun install 后 workspace 包未自动链接到根目录 node_modules，需手动 `bun link`（已在 cli/tui 中处理）

### 5.3 未覆盖但设计存在的功能
- 实际 LLM 调用（测试使用 FakeLanguageModel）
- MCP 服务器集成
- 文件系统 watcher 的实时外部修改检测
- 跨会话 checkpoint 恢复
- 流式响应的完整端到端测试

---

## 六、运行方式

```bash
cd paw-ts/packages/agent
bun test test/capabilities-integration.test.ts   # 仅集成测试
bun test test/                                    # agent 包全量
```
