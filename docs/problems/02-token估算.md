# 02 Token 估算口径不统一（4 套数字）

- 状态：调研完成，待实施
- 日期：2026-08-04

## 问题

**现象**：同一段文本在系统内被算出多个不同的 token 数，L1/L2/L3 压缩与驱逐决策建立在互相矛盾的数字上，触发时机不可预期——有时该清没清（超窗），有时不该清清了（白烧摘要钱）。

**根因**（四处口径不一致）：
1. 主路径：`ContextManager` 用 cl100k_base（tiktoken，`context/manager.ts:84`）
2. L1 prune 释放量：chars/4 启发式（`context/pruner.ts:152`）
3. memory 侧：ascii/4 + 非ASCII/1.5 启发式（`memory-runtime.ts:94-98`、`contextBuilder.ts:43-47`）
4. budget 截断：chars/4（`context/budget.ts:140`）

另有：L2 压缩阈值双口径——`budget.ts:112` 是 `historyBudget×0.7−10k`，`compactor.ts:88` 是 `contextWindow×0.7−10k`，相差近 2 倍。无 API usage 回填校准。所有模型共用同一估算器（Qwen 的 tokenizer 与 cl100k 差异大）。

**风险**：chars/4 对中文**低估**（中文 1 字实际 1-2 token，>0.25 token/字），低估 → 预算判断偏乐观 → 超窗风险。

## 调研

arxiv 无专门论文（属工程实践），综合 litellm / Claude Code / OpenHands 实际做法：

| 层级 | 做法 | 误差 | 成本 |
|------|------|------|------|
| 精确 | 模型自有 tokenizer（Qwen tokenizer、OpenAI/DeepSeek 官方 registry） | ~0% | 最贵 |
| 近似 | cl100k_base（js-tiktoken），事实标准 | 英文/代码 <10%，中文大 | 便宜 |
| 启发式 | chars÷4 | 15-30%，中文会低估 | 免费 |

**业界四点最佳实践**：
1. **按模型选估算器**：模型注册表声明 tokenizer 类型（qwen/cl100k/o200k/chars4），不全局一个
2. **API usage 回填校准**：每次调用返回真实 prompt_tokens（本项目 `costTracker.record` 已拿到）→ 维护"估算 vs 真实"比率动态校准，几轮后误差收敛 <5%
3. **估算方向保守（宁可高估）**：低估 → 超窗（灾难）；高估 → 多压缩一次（可恢复）。默认系数 ×1.1 + reserve 5% → 12%
4. **全系统一个口径**：所有决策走同一估算器接口

## 结论

- 最合理方案 = 模型感知的注册表估算器 + usage 回填校准 + 保守系数。这是"免费的精确"：本地估算保证零延迟，真实 usage 校准保证精度。
- 口径统一是上下文管理可预测性的前提（见日志 01）。

## 解决方案

1. `TokenEstimator` 加注册表：qwen → Qwen tokenizer（或 o200k）；deepseek/openai → cl100k；anthropic → cl100k×1.1（无公开 tokenizer，业界惯例）；其他 → chars/4×1.1 保守系数
2. 新增 `CalibratedEstimator` 包装层：消费 `costTracker` 已有的 usage 数据，回填校准系数
3. 统一口径：`pruner.ts`、`budget.ts`、`memory-runtime.ts`、`contextBuilder.ts` 全部改为注入同一个 estimator（ContextManager 已有实例）
4. 修正 L2 阈值双口径：统一为 budget 口径
5. reserve 5% → 12%（低估保护）

工作量：注册表 1h + 校准层 2h + 统一口径 3-4h。

## 状态

- [x] 调研完成
- [ ] 估算器注册表
- [ ] usage 回填校准层
- [ ] 统一口径（pruner/budget/memory）
- [ ] 阈值双口径修正 + reserve 调整
