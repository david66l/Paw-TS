# 06 修正：cost.update 缺失的真正原因是调用方未注入 costTracker

- 状态：已查明，非 bug（结论反转）
- 日期：2026-08-04

## 原始发现（2026-08-04 上午，基线测量时）

**现象**：`cost.update` 事件从未发出，`run.metrics` 的 totalTokens 恒为 0。
**初步结论**：DeepSeek 流式不返回 usage → 成本统计链路失效。
**影响**：阻塞 cache 命中率量化 → 一度计划做模型层估算兜底。

## 反转（2026-08-04 下午，直连 API 调试）

1. **直连 DeepSeek V4 API 验证**：流式响应**正常返回 usage**，且是嵌在最后一个内容 chunk 里（choices 非空 + finish_reason + usage 同体，非标准 OpenAI 的独立 usage chunk），字段完整：
   ```json
   "usage": {
     "prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9,
     "prompt_tokens_details": { "cached_tokens": 0 },
     "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 5
   }
   ```
2. **解析器验证**：`openai-stream-parse.ts` 的 `parseOpenAiUsageJson` 正确处理（含 `cached_tokens` 提取），`openai-compatible.ts` 消费循环正确（`part.usage !== undefined` → lastUsage）。
3. **orchestrator 验证**：`invokeModelOnce` 流式尾部 `if (usage)` → costTracker.record → emit cost.update，逻辑正确。
4. **真正根因**：`costTracker` 是依赖注入的（`AgentOrchestratorOptions.costTracker`，orchestrator.ts:354 `this.costTracker = opts?.costTracker`）——**基线脚本/调试脚本未注入**，`this.costTracker?.record()` 因 optional chaining 直接 no-op。
5. **注入后实测**：cost.update 正常发出，`cachedPromptTokens=5632/5704`（**缓存命中率 98.7%**），costTracker.snapshot 正常（¥0.000513）。

## 修正结论

- **DeepSeek 流式返回 usage 且含缓存细分**，代码链路（解析 → 记录 → 事件）全部正常
- 生产路径（`createRunOrchestrator`）注入 costTracker，成本统计**没有 bug**
- 独立脚本/测试必须自行注入 costTracker（本次基线脚本已修正）
- **重要副产物**：DeepSeek 缓存命中率极高（二轮起 ~99%）——prompt 前缀稳定性收益显著，P3（前缀稳定）方向获得实测数据支撑

## 修正动作

- [x] 直连 API + 解析器 + orchestrator 三层验证
- [x] 基线脚本注入 costTracker（benchmarks/baseline/run-baseline.ts）
- [x] 重跑基线，使用真实 usage 数据（含 cache 命中率）
- [ ] ~~模型层估算兜底~~（不需要，原结论有误）
- [ ] ~~Provider 能力标记~~（不需要）
