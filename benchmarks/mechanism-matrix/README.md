# Mechanism Matrix — 按任务选机制的对照实验协议

回答一个问题：**什么任务需要什么机制**，而不是把所有增强机制始终打开。
依据：LongHorizon-Harness（§3.3：同一机制在不同基准上 token 可 −24% 或 ×2.3–3.6）、
The Complexity Trap（屏蔽 vs 摘要）、The Danger of Overthinking、AI Agents That Matter（联合评估准确率与成本）。

## 本次已落地的机制开关

所有开关都在 `RunFreshPawNextTaskOptionsV1`（`packages/paw-next/src/composition.ts`），不进 durable 身份，与既有 telemetry 同级：

| 开关 | 取值 | 默认 | 对应论文 | 效果 |
|---|---|---|---|---|
| `thinkingRecovery` | `false` 或 `{ policyVersion, noActionMs, maxRecoveries }` | 开（540s / 2 次） | Danger of Overthinking | thinking-only 生成中止后，携带"增量执行"指令重试一次；配额耗尽诚实失败。低于 supervisor 的 600s reasoning-only 线，校准自 desktop-harness-ab V15（合法 high 首 tool 片段 108–164s；max 停滞 >360s） |
| `onThinkingRecoveryEvent` | 回调 | — | — | 中断/重试/耗尽事件遥测；中断请求 usage 恒标 unknown，不许记为免费 |
| `contextCompaction` | `"full" \| "mask-only"` | `"full"` | Complexity Trap | `mask-only` 关掉 LLM checkpoint 蒸馏，只留 output-recall 屏蔽 + 硬预算 omission |
| `outputMasking` | `boolean` | `true` | Complexity Trap | `false` 摘掉大输出存根投影器（与 `compactMutationReceipts` 互斥，组合会在构造时抛错） |
| `completionReviewGate` | `"default" \| "tight"` | `"default"` | LongHorizon §3.3 | `tight` 只在显式要求 / 项目路径 / ≥3 变更 / 验证失败证据时触发审查模型调用；"改了源码没跑验证"不再单独触发 |
| `phaseEffort` | `false` 或 `{ policyVersion, planningEffort, executionEffort, planningCalls }` | **关**（opt-in） | V15 后续 | 前 `planningCalls` 个带工具主循环调用用 `planningEffort`（默认 max），其余用 `executionEffort`（默认 high）；每请求 effort 进入 journal 请求快照，重放精确复现。预设 `PAW_NEXT_PHASE_EFFORT_POLICY_V1 = max×1 → high` |

新工具（模型可调用，CAT 思路）：`context_compact`（provider 名）——模型在一个模块完成或一轮排错结束后主动请求压缩；结算进入 journal，下一个安全边界把 skip 决策提升为 `user_requested` 蒸馏（`honorContextCompactRequestV1`）。请求被新 checkpoint 消费后不会重复触发；无稳定区间时保持 skip。

迭代评测：`bun run benchmarks/longrun-harness/run.ts --preset todo-mini --reveal-batch 3`——需求分批揭示，全部通过且全量 E2E 无回归才解锁下一批；回归的需求翻回 open 优先返工；报告含 `checkpoints[]` 与 `regressionEvents`。

## 实验 1：thinking-recovery（P0，先跑）

**运行器已就绪**（2026-09-11 首轮已跑）：
```bash
bun run benchmarks/mechanism-matrix/exp1-rescue-ab.ts --arm off|on --task queue|workflow   --effort max|high --wall-ms 1200000 --calls 48 --max-steps 48 --label <批次名>
bun run benchmarks/mechanism-matrix/summarize.ts --label <批次名>   # 汇总对比表
```
首轮发现已修复：V3 options 白名单吞旋钮（机制矩阵控制面在桌面路径曾整体失效）、supervisor 600s 窗口继承（rescue 重试只剩 60s 生存期）。停滞分布观察：max effort 长思考集中在 ~500–600s 带，部分自愈、部分需救援。

- **Arm A**：`thinkingRecovery: false`（现状基线）；**Arm B**：默认 540s/2。同一任务集 ≥3 遍。
- **任务集**：desktop-harness-ab 的 durable scheduler 任务（Paw 28/34 那道）+ 三方协议任务；GLM-5.3-Flash max 与 high 各跑一组。
- **指标**（每组、分开记）：独立检查通过数；端到端耗时；总 token（输入/输出/缓存读分开）；`thinking_recovery` 遥测事件数与"救回的请求数"；因 stall 耗尽的 run 数。
- **判定**：B 相对 A 完成率不降且 stall 耗尽显著减少 → 保留默认开；完成率下降或救援重试本身大增消耗 → 降为 opt-in 并重校准 noActionMs。
- **注意**：单任务单样本不构成结论（沿用 desktop-harness-ab 自己的纪律）。

## 实验 2：压缩 2×2 因子（Complexity Trap）

四臂（同任务集，各 ≥3 遍）：

| 臂 | `outputMasking` | `contextCompaction` | 论文对应 |
|---|---|---|---|
| hybrid | true | full | Paw 现状默认 |
| mask-only | true | mask-only | 屏蔽旧环境输出 |
| summarize-only | false | full | 模型摘要 |
| baseline | false | mask-only | 只剩硬预算 omission |

- **任务集**：longrun-harness todo-mini（长历史，压缩收益应最大）+ 一个短任务集（预期：短任务上蒸馏纯开销——LongHorizon 在 WeaveBench/OSWorld 上 token 翻倍的教训）。
- **指标**：完成率；总 token；**每次 resolve 的平均轮数**（Complexity Trap 的"轨迹拉长效应"：摘要充当继续干的强化信号，+13–15% 轮次——验证 Paw 的 checkpoint 是否也有此效应）；蒸馏请求的缓存命中率（摘要调用不可缓存复用是论文指出的隐性成本）；`context_compaction` cost phase 单独拆账；compact 工具被模型调用的次数与时机；checkpoint 质量门拒绝率。
- **第五臂（Complexity Trap 的正确 hybrid 形态，已实现旋钮）**：
  `outputMaskingThresholdChars: 4000`（存根阈值 12K→4K，头/尾预览同比缩放，进插件身份）+ `contextCompactionTriggerRatioBasisPoints: 9200`（蒸馏触发 80%→92%）。论文结论：masking 常开 + summary 最后手段（比 masking 再省 7%、比 summary 省 11%、+2.6pp），而朴素混合（摘要早触发）反而更差。可再加一个激进臂 `2000` 阈值对照。
- **run 级诊断（所有臂共用，零模型调用）**：跑完后对 journal 前缀调 `projectRunDiagnosticsV1(snapshot)`（`@paw/progress-advisor`）：
  - `maxConsecutiveStallTurns`（连续"有工具活动但无变更/无通过验证"的最大轮数——analysis-paralysis 代理指标，Overthinking 论文）
  - `exactRepeatCalls`（背靠背重复调用数）
  - `adviceEvents`（live 循环实际注入的各建议次数——no_progress/exact_repeat/hypothesis_stale 等）
  - `modelTurns / textOnlyTurns / toolCallsSettled / failedToolCalls / mutationCalls / verificationPassed|Failed`（A7 轮数画像：每次 resolve 的轮数变化即"轨迹拉长效应"）
  - `completionReviewsClaimed|Blocked / checkpointsRecorded`（各机制的触发频次与开销核算）
- **判定**：寻找"任务长度 → 最优臂"的分界，而不是全局唯一最优。短任务若 mask-only ≈ hybrid 完成率且 token 更低，默认值就该按任务长度切换。

## 实验 3：completion-review 开销核算（LongHorizon §3.3）

- **Arm A** `completionReviewGate: "default"` vs **Arm B** `"tight"`，同任务集 ≥3 遍。
- **指标**：审查模型调用次数与 token；被 block 后的修复段数量；最终完成率；返工总 token（审查拦下的问题若在验收时才暴露，其修复成本计入 A 的隐性收益）。
- **判定**：B 的（审查节省 − 返工增加）> 0 时考虑收紧默认；否则保持 default——近 always-on 的审计只有在减少的返工大于自身开销时才值得。

## 实验 4：迭代需求（SlopCodeBench 思路）

`--reveal-batch 3` 跑 todo-mini，记录：每检查点通过率、`regressionEvents`（旧需求被新需求破坏——论文观察到的迭代退化）、每批 sessions/耗时/token。
对照臂：`--reveal-batch 0`（全量给定，现状）。同一项目连续加需求，比一次性"写出一个项目"更能暴露长期执行能力。

## 实验 5：按阶段选 effort（V15 建议，opt-in）

V15 的直接结论："The next useful product experiment is an explicit, recorded policy for selecting effort by execution phase, evaluated against fixed-effort controls on full tasks."

- **三臂**：固定 max（现状 profile）/ 固定 high / `phaseEffort`（`PAW_NEXT_PHASE_EFFORT_POLICY_V1`：max×1 规划 → high 执行）。
- **任务集**：与实验 1 相同（scheduler 任务 + 三方协议任务），GLM-5.3-Flash，各 ≥3 遍。
- **指标**：完成率；stall 次数（结合 thinking-recovery 遥测）；总 token 与耗时（max 的思考 token 显著更多，high 未必更慢——V15 high 样本 136–186s 完成而 max 360s 未动）。
- **组合臂**（可选第四臂）：`phaseEffort` + thinking-recovery 同时开——规划期 max 卡住时救援重试仍用 max；若观察到该组合救援成功率低，考虑"救援发生即降档"的联动（未实现，属下一步）。
- **判定**：phase 臂完成率 ≥ 固定 max 且 token 显著低于固定 max → 默认开启候选；任何一臂完成率明显受损 → 保持 opt-in 并记录。
- **警示（Overthinking 论文 arXiv 2502.08235）**：o1 低 effort 的 overthinking 分反而比高 effort 高 35%——"低 effort 更省"不是普适假设，不同模型的失败模式不同（GLM max 卡死不行动 ≠ o1 low 行动质量差）。三臂必须都跑，禁止预设 phase 赢。

## 测量纪律（AI Agents That Matter）

1. 联合报告完成率 + 端到端耗时 + 全部模型调用成本；失败尝试计入。
2. 总 token / 缓存 token / 实际费用分别展示；中断请求 usage 标 unknown。
3. 每臂 ≥3 遍，报告均值与波动；不挑单次最好成绩。
4. 不同机制臂的任务集、凭据、模型版本保持一致；机制组合记入 run 报告。
5. 论文数字（−24%、×2.3 等）是特定配置结果，不作为 Paw 的预期幅度。
