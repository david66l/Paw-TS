# 桌面新运行时：有界行动恢复

后续更新见 [v10 辅助调用超时修复](RUNTIME-V10-AUXILIARY-DEADLINES.md)。本文保留 v9 当时的版本和实测结果。

日期：2026-09-08。延续 [v8 修复](RUNTIME-V8-HARDENING.md)，本轮增加日志驱动的行动恢复。GLM 实测恢复一次后仍为 **0/15**，因此最终实现默认关闭自动恢复，仅保留显式实验选项。

## 实现

- 显式开启时，V3 主执行器冻结 `recoverReasoningTimeout:true`。仅当已结算请求为 `unknown`、错误码为 `ModelReasoningWithoutActionTimeout`，且没有正文/工具时，允许继续一次。普通桌面保持关闭；宿主实验入口为 `experimentalReasoningRecovery:true`，探针参数为 `--journal-recovery`，不能与适配层的 `--thinking-recovery` 同时使用。
- `interactive-control.ts` 从整个 run 的 canonical `model.settled` 事实计数。同一 run 至多恢复一次；新工作段、重新进入对话和宿主重新加载不会重置额度。V1/V2 及未开启此项的子执行器保持原行为。
- 恢复请求经过正常循环，具有新的 `modelCallId` 和 dispatch/settlement；消耗原有段内和任务总回合预算。原请求仍是 unknown，没有伪造响应、工具结果或 token 用量。
- composition 依据持久事实加入小步执行指导，保留整个原任务。指导优先占用剩余上下文预算；容量不足时停止，不无提示重复同一请求。未降低模型 effort 或原生输出额度。
- 网络静默、请求总超时、取消、权限阻止、效果未知不会因此自动重试。第二次思考超时停止。没有在模型适配层增加隐藏重放。
- 两处工作段验证配置复制同步保留该标志，避免回放状态漂移。

最终组合版本为 `paw.product-composition.v3.23:journal-reasoning-recovery-opt-in`。基础 V3 manifest 测试夹具 hash 为 `8688d40ecd8398dc04f9be0b6ce71d7b7dc16ef994a8d7880d90bab8f8ef98a8`；启用恢复的实际配置另有其 hash。旧 V3 组合不能静默按新语义恢复。真实模型样本使用本轮中间版本 v3.22（恢复开启），结果未重新标记为默认关闭后的新版本。

## 验证

- **176 pass / 0 fail，1028 assertions，12 个文件**：Agent Loop、监督器、工作段事务、V3 manifest、桌面宿主与回放。
- 桌面集成使用真实监督器的短 deadline：首个请求超时后写入文件成功；第二次连续超时停止；再次进入同一 run 后额度仍不恢复。
- 旧 manifest V1/V2 固定 hash 保持通过；桌面宿主与前端 TypeScript 检查、`git diff --check` 通过。
- 默认关闭的桌面测试断言：发生思考超时后只调用一次模型，不自动续跑。

## 真实 GLM 样本

Docker 通过用户正常桌面启动后恢复可用，镜像、容器、卷清单一致且隔离预检通过，详见 [Docker 修复记录](DOCKER-WINDOWS-REPAIR.md)。随后运行原队列任务，单执行器、GLM-5.3-Flash max、128000 输出额度，记忆与环境审计关闭、辅助完成审查保留。

| 项目 | 结果 |
| --- | --- |
| 耗时 / 请求 | 378.283 秒 / 4 次物理请求 |
| 自动恢复 | 一次，第 4 个请求包含源于 journal seq 29 的执行指导 |
| 中断 | model-3 与 model-4 均为 `ModelReasoningWithoutActionTimeout`；分别产生 30056、31274 思考字符，正文与工具均为零 |
| 交付 | 零次成功文件写入、独立检查 **0/15**、无 npm test 产物、状态 incomplete |
| 用量 | 已报告 8737 token；两个中断请求用量未知，不能报告总 token 或节省比例 |
| 决策 | 该样本恢复指导未改善执行，默认关闭自动恢复，保留有界实验能力 |

证据目录：`.runs/2026-09-08-glm-v9-journal-recovery/`，含 `single-agent-report.json`、`recovery-journal-evidence.json`、`request-4.json`、`parsed.jsonl` 和冻结的源文件。报告器补充了生产恢复指导的去重计数；报告记录自身 SHA256。独立功能验证使用该实验冻结的 verifier 文件。

v8 同任务为 194.921 秒、3 次请求、0/15；本轮增加一次尝试但仍未完成。单样本不能推断总体成功率，也不能将有界停止当作复杂任务能力提升。

## 边界

这项机制保证恢复有证据、有次数限制，不保证模型恢复后一定调用工具或完成复杂任务。一次恢复可能增加时间与费用；中断请求的用量仍未知。尚未统一辅助审查、压缩等环节的全任务物理请求/费用预算。历史适配层 `thinking-recovery.ts` 仍只是显式实验选项，本版默认链路不使用它。
