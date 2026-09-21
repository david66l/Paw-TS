# V10：桌面新运行时的辅助调用超时与取消

后续上下文预算修复见 [V11](RUNTIME-V11-CONTEXT-BUDGET.md)；本文保留 V10 当时的版本和验证结果。

2026-09-08。本轮修复辅助调用无限等待和取消后接受迟到结果的问题；没有重新跑真实 GLM/DeepSeek 复杂任务，也不据此宣称复杂任务完成率提高。

## 定位与旧运行时对照

主执行模型已有 `packages/models/src/request-supervision.ts` 的强制等待上限，但以下辅助阶段原先仅使用 `AbortSignal.timeout`。取消信号需要调用方配合，不能强制结束一个未兑现的 Promise。

| 入口 | 已复现的缺口 | 修复后的行为 |
| --- | --- | --- |
| `apps/desktop/agent-host/task-arrangement.ts` | 父任务已取消，仍发出分类请求并接受结果 | 请求前检查取消；45 秒上限；取消及迟到结果不能启动任务；分类请求显式关闭思考 |
| `packages/completion-review/src/reviewer.ts` | 取消后返回的 allow 仍被接受；不响应取消的模型让验收一直等待 | 验收及原有截断重试共用 30 秒期限；超时为 unknown，用户取消为 cancelled |
| `packages/context-compaction/src/checkpoint-distiller.ts` | 证据读取、摘要模型或校验器不返回，压缩无法结束 | 三个阶段共用 45 秒期限；每个异步边界检查取消；迟到摘要不能启动校验或提交 checkpoint |
| `packages/context-compaction/src/model-semantic-verifier.ts` | 独立校验可一直等待或接受取消后的 supported | 独立调用 30 秒期限；不确定结果不会成为 supported |

旧实现对照：`packages/agent/src/orchestrator.ts` 的模型请求超时及压缩调用同样以 `AbortSignal.timeout/any` 为主，未提供可直接迁移的强制等待边界。本轮保留其区分父级取消与请求超时的语义，在 `packages/core/src/operation-deadline.ts` 增加共享期限组件，而非迁移同样存在缺口的等待方式。

## 实现约束

- 一个操作只有一个定时器，完成后清理定时器及取消监听。后续阶段和验收截断重试不会重置期限。
- `Promise.race` 结束本地等待，同时把取消信号传给模型。每阶段开始与返回后均检查期限，迟到结果不会推进下一阶段；迟到 rejection 有处理器。
- 没有新增自动重试。主执行模型的 effort、原生输出额度及 v9 默认关闭的思考恢复保持原有设置。
- 完成验收超时经过现有 controller 写入 `completion.review_settled`，`status=unknown`、`reasonCode=CompletionReviewTimeout`；再次检查同一 candidate 复用该结算，不重复调用模型。
- 压缩超时写入 `context.checkpoint_distillation_settled`，不产生 `context.checkpoint_recorded`，不把未经验证的摘要替换进历史。
- 这是宿主等待上限，不能保证忽略取消的远端请求已停止计费，也不能抢占阻塞 JavaScript 事件循环的同步代码。

## 版本与验证

组合版本：`paw.product-composition.v3.24:auxiliary-hard-deadlines`。
基础 V3 manifest 夹具 hash：`616937c0c6d61f8093eeead4d5eb278dbd721723e26ade3aced246167cd0eff3`。实际配置有自己的 hash；V1/V2 历史固定 hash 保留。验收、压缩、语义校验的策略标识同步升级，避免静默混用新旧策略。

- **126 pass / 0 fail / 702 assertions，13 个文件，67.65 秒**。
- 回归包含不返回的模型、父级取消、迟到成功/失败、共享期限、验收持久结算及压缩不提交。
- 桌面集成覆盖手动压缩、JSON IPC、工具审批、最终工具批次、持久对话恢复、steering、后台作业、默认关闭的思考恢复及完成验收。
- 桌面宿主、core、completion-review、context-compaction TypeScript 检查通过。
- 11 个本轮新增或修改的实现/测试文件通过 Biome 检查；工作区依赖图无环（25 packages / 103 edges），`git diff --check` 通过。

重跑：

```powershell
bun test packages/core/test/operation-deadline.test.ts packages/completion-review/test packages/context-compaction/test apps/desktop/test/taskArrangement.test.ts apps/desktop/test/runtimeHardening.test.ts apps/desktop/test/pawNext.test.ts apps/cli/test/paw-next-product-v3.test.ts packages/models/test/request-supervision.test.ts
```

## 仍需解决的架构问题

- 进度指导在 context planning 之后使用剩余预算插入；预算不足或对应历史被压缩后，指导可能无法进入请求。需要可验证的预算预留与历史锚点降级策略。
- 可选记忆的 terminal writer / organizer / dossier 流程仍处于任务收尾等待路径；需要持久后台队列，不能简单 fire-and-forget。
- 任务级物理请求次数、总成本和阶段耗时尚未统一核算。不能靠给整个长任务加一个任意固定截止时间解决。
- GLM 复杂任务在工具调用前长时间思考的问题，仍需比较实际请求与执行行为。本轮解决的是辅助阶段的可复现控制缺陷，不是该模型行为的完整因果结论。
