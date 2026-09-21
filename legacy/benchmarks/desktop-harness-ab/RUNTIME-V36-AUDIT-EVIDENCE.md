# V36：审查证据归属与一次受限纠错

## 结果

此前两次真实审查虽然输出 complete，但引用了自己没有读取的文件，最终被宿主拒绝。本轮给审查器提供自己拥有的读取证据，并在同一个 child 中允许一次报告纠错。

本轮真实 GLM-5.3-Flash high 审查返回 **completed / verified**。宿主确认同一 child 的成功读取覆盖报告引用，独立测试 **34/34**、产物自带测试 **55/55**。本次没有触发报告纠错，也没有重新请求主执行器。

这是一次审查成功样本，不是从空白完成复杂任务的成绩，也不能证明成本或速度优于 Claude Code。

## 实现

- `apps/cli/src/paw-next/audit-evidence.ts` 从审查 child 的 canonical `tool.call_observed` 和成功 `tool.settled` 投影读取清单，包含路径、调用 ID、请求范围。执行器证据包中的文件名、目录列表、grep、失败读取和执行器回忆不算独立读取。上下文清单不进行额外文件 I/O，最多保留 64 条；请求范围不等同于完整文件覆盖。
- `composition.ts` 在专用审查上下文末尾加入该清单。新 child 的系统提示明确区分执行器历史和自己的读取，系统提示哈希及 child runConfig 固定这项策略。
- 报告格式或文件引用不合格时，宿主通过已有 durable inbox / work segment 机制追加一次反馈，保留同一个 child session/run 和之前的上下文、读取事实。不会另起审查 child，也不会把报告自身的问题交给主执行器修代码。
- child 最多两个工作段，**总计仍为 12 个逻辑模型回合**；纠错共用外层原有 **240 秒**审查定时器，任务总截止和用户取消仍优先。反馈入队和推进均有 canonical 事实；同一 child 已消费纠错后不能再次补充机会。
- 纠错只允许补读、修正错误引用或诚实说明缺口；宿主不会自动删除不合法引用、改写验收标准或把模型声明转换为通过。最终文件指纹、稳定性、浏览器/视觉证明和单一 child journal 绑定仍由原审查器验证。
- 实际有依据的 `completed/block` 仍会反馈给主执行器修复；纠错再次不合格、预算耗尽、超时仍保持 unverified。
- 新标准桌面对话默认启用 `environmentAuditEvidenceRepair`，要求 `environmentAuditSinglePass`。它进入桌面记录、profile/task options 和 manifest 的独立版本标识。旧会话不补加标识，恢复时不能通过当前选项切换身份；不新增 UI 按钮、数据库或常驻服务。

复用的是仓库已有的 durable inbox、工作段控制、canonical 上下文和审查证据校验，没有另建一套隐藏重试循环。

## 回归验证

**81 项通过、0 失败**：审查及 V3 身份测试 49 项，执行预算、旧输出回看恢复、读回证据、运行时、交付清单及审查控制器兼容测试 32 项。CLI 共享运行时、桌面前端及宿主 TypeScript 检查通过。

新增生产桌面集成测试覆盖：

1. 初始报告引用未读文件，收到反馈后实际读取并通过；完成后的恢复不新增模型请求，也不切回旧策略。
2. 再次提交同样错误的报告，只有一次纠错，主执行器不重跑。
3. 补读后明确报告缺陷，结果不会成为 verified，缺陷继续进入原有修复流程。
4. 纠错前后的两个文件读取同时进入最终证明。
5. 纠错后连续读取到总计第 12 回合即停，不重置总回合预算。
6. 纠错过程中超时，只有一个审查定时器，验收不通过。

负面路径使用脚本模型驱动真实桌面宿主、工具和日志，不是对真实模型缺陷检出率的统计评估。

命令：

```sh
bun test apps/desktop/test/environmentAudit.test.ts apps/cli/test/paw-next-environment-audit.test.ts apps/cli/test/paw-next-product-v3.test.ts
bun test apps/desktop/test/executionBudget.test.ts apps/desktop/test/legacyRecallRecovery.test.ts apps/desktop/test/readbackReview.test.ts apps/desktop/test/runtimeHardening.test.ts apps/cli/test/paw-next-delivery-ledger.test.ts packages/completion-review/test/retry.test.ts
# 分别在 apps/cli 和 apps/desktop 下执行
bun run typecheck
```

## 真实审查实验

记录：`.runs/2026-09-09-v36-live-audit`。

使用与 V35 相同的 `audit-live-probe.ts` 方法：回放 V34 后续实验中 21 次主执行决策，仍通过真实桌面新运行时和 Docker 工具执行；只允许独立审查访问真实模型。原模型设置、根工具定义和回放响应哈希均校验。最终十份产物与 V34 后续实验逐文件哈希相同，没有人工修补。72 份冻结源码与实测结束时工作树逐项匹配。

| 指标 | 本轮结果 |
| --- | --- |
| 模型 | GLM-5.3-Flash high |
| 新增物理模型请求 | 7，全部为同一审查 child |
| 主执行决策回放 | 21，历史用量不计入新消耗 |
| 总实验墙钟 | 239.632 秒，包含主执行回放、真实工具及审查 |
| 审查模型请求耗时合计 | 129.336 秒，不含工具和调度 |
| 新增输入 / 输出 tokens | 146,016 / 4,149 |
| 新增总 tokens | 150,165；无用量未知请求 |
| 输入缓存命中 / 未命中 | 75,904 / 70,112 |
| 报告纠错 / 被拦截的额外根请求 | 0 / 0 |
| 独立功能验收 / 自带测试 | 34/34 / 55/55 |
| 最终宿主审查 | environment_verified，integrity=clean |

审查独立读取了 package.json、三个实现模块、REQUIREMENTS.md、四个测试文件及 README.md；宿主证明引用同一个 child journal。原始数据、分阶段消耗、冻结源码、十份交付物、审查终态事实及文件校验摘要均保留在实验目录。测试已结束，没有遗留 Paw shell 测试容器。

本轮 150,165 tokens 高于 V35 两个失败审查样本各自的 59,430 和 136,087，不能宣称更省 token。观察到的改善是本次真实审查读取了必要文件并取得有效验收；单次结果不能确定成功率，也没有现场触发纠错。下一阶段应使用小、中、复杂任务的重复试验和真实缺陷样本，分别度量质量、误放行率、首个有效动作、完成时间和成功任务成本，再决定是否继续压缩上下文或减少审查开销。
