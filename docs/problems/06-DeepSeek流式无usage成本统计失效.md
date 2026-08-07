# 06 DeepSeek 流式不返回 usage：成本统计链路失效

- 状态：已确认，待修复
- 日期：2026-08-04
- 发现途径：上下文管理基线测量（benchmarks/baseline/run-baseline.ts）

## 问题

**现象**：`cost.update` 事件从未发出，`run.metrics` 的 totalTokens 恒为 0，costTracker 无任何记录——**整个 token 统计/成本追踪链路在 DeepSeek 流式下完全失效**。

**根因**：`openai-compatible.ts:229` 已正确发送 `stream_options: { include_usage: true }`，但 DeepSeek V4 API 的流式响应不返回 usage 块（或参数未生效）→ 流式路径 `chunk.type === "done"` 时 `chunk.usage` 为 undefined → orchestrator（orchestrator.ts:1857 附近）跳过 `cost.update` 发射 → 下游 costTracker / RunEvaluator / 成本展示全部拿不到数据。

**影响面**：
- 成本追踪（costTracker.snapshot）在 DeepSeek 上恒 0，TUI/桌面端的成本显示无意义
- `run.metrics` 的 totalTokens / estimatedCost 恒 0（run-evaluator 依赖 cost.update 累加）
- prompt cache 命中率无法测量（cachedPromptTokens 字段存在但永远是 undefined）——**这直接阻塞了方案 05 P3（前缀稳定）的量化验证**
- 非流式路径正常（DeepSeek 非流式返回 usage），只有流式路径失效

## 验证方式

基线脚本实测：3 个端到端任务全部 completed，事件流里 `model.request=3-4`、`model.done=3-4`，但 `cost.update=0`。已确认 `include_usage` 参数正确发送（openai-compatible.ts:229）。

## 解决方案

1. **模型层兜底估算**（首选，1-2 小时）：流式路径 usage 缺失时，用本地估算器（`estimateMessageTokens`，与 ContextManager 同一估算器）计算 prompt/completion，填充 usage 后照常发射 cost.update——成本统计立即恢复
2. **Provider 能力标记**：模型注册表增加 `supportsStreamUsage?: boolean`；DeepSeek 流式标记为 false，走估算路径；OpenAI/Anthropic 流式标记为 true，走 API usage
3. **校准**（衔接问题 02 的 usage 回填）：估算路径下，每次非流式调用（或偶尔的流式 usage 返回）拿到真实 usage 后校准估算系数

## 状态

- [x] 问题确认（实测复现）
- [ ] 模型层估算兜底
- [ ] Provider 能力标记
- [ ] 校准衔接（问题 02）
