# ADR-001：Agent Loop 单一权威边界

- 状态：Accepted，按 `v1 → v2-shadow → explicit-v2` 渐进迁移
- 日期：2026-08-15
- 代码契约：`packages/agent/src/loop-authority.ts`

## 背景

Paw 同时存在 effect/approval/sandbox、TaskState、Acceptance、Plan、Todo、legacy convergence、coding phase、candidate reviewer、loop-v2 readiness/review/terminal 等机制。它们有的代表安全不变量，有的代表宿主观测事实，有的只是让模型少走弯路的经验策略。此前这些机制都可能在 `action-handlers` 中拒绝工具或结束任务，形成多套事实来源和多套终局权威。

这种重叠对长任务尤其危险：一次合理的额外阅读可能被固定次数策略拒绝；模型忘记更新 Plan/Todo 时，当前版本已验证的实现仍可能被判 incomplete；重复失败启发式可能在新证据出现前抢先终止。单元策略各自合理，不等于叠加后的 Agent Loop 合理。

## 决策

Loop 中每类判断只有一个权限域：

| 权限域 | 唯一职责 | 可以拒绝工具 | 可以决定终局 |
|---|---|---:|---:|
| Safety policy | 用户授权、effect policy、approval、sandbox、文件锁等不可违反约束 | 是 | 只能把真实拒绝写成证据，不能伪造成功 |
| Effect executor | 执行工具并结算真实结果/副作用 | 仅执行既有 safety 决策 | 否 |
| Evidence projector | 从宿主事件投影 mutation、test、acceptance、artifact 等事实 | 否 | 否 |
| Behavior advisor | 重复调用、调查过久、建议编辑/验证/收尾 | 否 | 否 |
| Semantic reviewer | 对绑定当前 candidate/diff/evidence 的语义风险作 veto/feedback | 否 | 只能拒绝候选，不能证明测试通过 |
| Completion policy | 汇总当前 evidence、acceptance、verification、review 与 lifecycle terminal | 否 | 是，唯一终局权威 |

`Plan`、`Todo` 是工作组织投影，不是完成事实；`Acceptance` 是由用户/仓库/外部验收来源建立、并绑定当前 revision 证据的事实门。两者不得混同。maxSteps、用户中断和 runtime failure 属于宿主 lifecycle terminal，不属于行为 advisor。

## 版本迁移规则

1. `v1` 保持 legacy behavior guard 与 Plan/Todo completion veto，作为可回滚基线。
2. `v2-shadow` 必须保持与 v1 相同行为，否则无法做同轨迹消融；它只观察和持久化 v2 事实。
3. `explicit-v2` 使用 `advisory_only + projection_only`：
   - legacy convergence 不得返回 `E_LOOP_POLICY`；
   - coding phase 不得拒绝阅读或因两次“违规”强停；
   - idle fuse 可生成恢复建议和计数，但不得提前终止；
   - 模型维护的 Plan/Todo 即使陈旧，也不得否决由事实门认证的 completion；同时不得为了让 UI 好看而把 model-authored pending plan 自动涂绿；
   - safety/effect/approval、Acceptance、当前 revision Verification、candidate readiness/semantic review 和 maxSteps 继续 fail closed。
4. explicit-v2 的终局仍由现有 `CompletionPolicy` 映射公共 `RunResult`。loop-v2 terminal/cutover artifact 是严格证据和迁移对照，不允许另一组件从自然语言重新计算终局。

代码中的版本化 `LoopAuthorityPolicyV1` 是上述表格的机器可检查入口。生产分支只能根据该策略启停 legacy 行为控制，不能再散落 `kernel === v2` 的例外补丁。

## 被否决的方案

- **一次性删除全部 legacy 逻辑**：会失去可回滚基线，也无法判断真实能力变化来自哪一项。
- **继续给 convergence/coding phase 加关键词和次数例外**：会扩大样本拟合，并没有解决“行为建议拥有硬权威”的根因。
- **把 Plan/Todo/Acceptance 全部视为同一种待办**：Plan/Todo 可由模型遗漏或陈旧，Acceptance 必须由可信来源和当前证据更新，权威等级不同。
- **让 semantic reviewer 直接宣告 verified**：同模型、无工具 review 没有新的机械事实，不能替代测试或 official grader。

## 验证与退出条件

当前 characterization 必须同时证明：

1. v1/v2-shadow 行为不变；
2. explicit-v2 在 edit 后的普通 read 不被 legacy convergence 拒绝；
3. explicit-v2 的 model-authored pending plan 不阻断只读完成，也不被自动标绿；
4. 既有 convergence、CompletionPolicy、explicit-v2 ordered tool commit 回归全绿。

后续 StatusSnapshot/TaskGraph/durable waiting 都必须服从本 ADR：新增状态只投影事实或提供建议，不能悄悄成为第二套 completion authority。冻结开发题和公开 benchmark 恢复后，必须分别统计 legacy tool-block 次数、无增量轮次、resolved、token 和时间；只有 explicit-v2 没有能力回退才逐项删除 v1 guard。
