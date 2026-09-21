# 桌面新运行时：成熟 coding agent 机制迁移与实测

后续日志驱动的有界恢复见 [v9 更新](RUNTIME-V9-RECOVERY.md)。以下保留 v8 当时的实现与实测结果。

日期：2026-09-07。结论：完成了一轮运行时可靠性修复；GLM 复杂任务仍未交付，不能宣称长任务能力或 token 效率已超过 Claude Code。

## 参考与取舍

- [Anthropic 长任务 harness 实践](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)：增量实现、保留进展、按实际产物验证完成。Paw 保留通用 agent 身份，把具体编码流程放在桌面宿主指导中，没有照搬它的多 agent 初始化方案。
- [OpenCode session processor](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts)：工具结果、工作区快照、增量 UI 更新、重复工具检测各有独立职责。借鉴这些边界，没有照搬整个依赖栈或重试政策。
- 迁移旧 Paw 的项目规则发现、工作区影响与收尾语义，沿用新运行时的 canonical Journal、权限和恢复。没有切换回旧 orchestrator。

## 已落地

| 问题 | 实现与边界 |
| --- | --- |
| 单个请求一直思考/无数据 | `packages/models/src/request-supervision.ts`：90 秒无数据、180 秒仅思考无正文/工具、360 秒单请求总时限。主执行器及 V3 子执行器接入；保留 max 与原生输出上限。独立 AbortSignal 和 Promise race，适配器忽略取消也不会把迟到结果执行成工具。不自动重放，未知用量保留未知。 |
| 中断原因丢失 | composition 将三类监督中断的稳定 errorCode 写入 `model.settled`，reducer 保留原因并输出 incomplete。第一轮复杂实测早于此项落地，其原因在 parsed.jsonl，旧 result.json 仍是通用 unknown，未改写历史记录。 |
| 只说将行动也完成 | 默认开启环境审计的桌面：没有工具观察时调用一次 512 输出 token、关闭思考的语义交付审查，区分回答与实际执行；可补两次工作段，仍未交付则 UI incomplete。纯解释可以正常完成，不强制调用文件工具。显式 `environmentAudit:false` 仍关闭这项交付审查，便于隔离执行器实验。 |
| 项目约定/环境缺失 | `project-context.ts`：恢复 PAW.md、.paw/CLAUDE.md、.paw/CLAUDE.local.md，新增根 AGENTS.md。总读取 12 KB、单文件 6 KB，标明截断和来源，拒绝越界链接；提示词描述实际 host/container 环境及指导的权限边界。根规则优先，目录内更具体规则需执行器按需读取。 |
| Shell 改动没有让测试过期 | `workspace-revision.ts` 在 Shell 前后读取 Git 可见文件的有界内容快照；失败命令也记录变化。`core/workspace-effect.ts` 统一解释实际 effect，progress 与 completion 使用它。Git 不可用/超过 2000 文件或 16 MiB/遇到不支持对象时按 unknown，不能证明未改变。范围不覆盖 Git 忽略文件、工作区外副作用；后台任务无完整证据时同样保守失效，未声称已完成全文件系统追踪。 |
| 验证提醒挤掉收尾 | progress v8 分别投影普通提醒与收尾提醒，独立证据去重；剩余预算窗口内可触发，最多两条收尾。上下文按新到旧逐条预算，不再因旧提醒总量过大整批丢掉。尚未保证硬窗口满时必定交付关键提醒。 |
| UI 拖住推理与全文放大 | 最小 loop 的临时展示回调不再 await；同步异常和异步拒绝不污染模型结算。桌面每 50ms 合并增量，完成时发送最终全文；前端兼容旧累计事件。Journal 持久化路径保持严格。1000 个四字符思考片段的单元测试从理论累计 2,002,000 字符降为一次 4000 字符增量及最终汇总；这不是原生窗口 IPC 性能测量。 |
| 补工作段时回放不一致 | `agent-loop/work-segment.ts` 与 `runtime/inbox/start-work-segment.ts` 的配置复制补齐 liveSteering、settleFinalToolBatch 和子执行器预算字段。真实桌面宿主测试覆盖“实时追加输入→审查要求继续→新工作段”，不再丢失控制语义。 |
| 可选记忆阻塞主任务 | 自动 retrieval 与自动 context resolver 各有 2 秒 deadline；前者写 degraded receipt，后者在当前 resolver 实例按 query 缓存空结果，避免每轮重复等待。只限制可选自动注入，不限制用户显式查记忆的工具，也没有改成未跟踪的后台写入。 |

当前组合身份为 `paw.product-composition.v3.21:optional-memory-deadline2000`，V3 golden hash 为 `67d38e5b1979b7444843ba2eb0cf4f2968683a0c0027ee6fe630f38e01fe7bad`。V1/V2 golden hash 回归保持通过；旧 V3 身份不能静默当作本版继续执行。

## GLM 实测

均为桌面 V3、GLM-5.3-Flash、max、主请求原生 128000 输出额度。模型生成的 Shell 只在隔离 Docker 临时工作区执行；未启用 Langfuse，未启动委派执行器，关闭环境审计和记忆以对照此前实验。辅助完成审查保留。

| 项目 | 结果 |
| --- | --- |
| 原队列复杂任务 | 194.921 秒结束，3 次请求；第三次仅思考约 180 秒，由生产监督器结束，0 次写入，独立检查 **0/15**，没有 npm test 产物。 |
| 简单写文件并读回 | **31.261 秒、4 次请求、12065 已报告 token**；正常 completed，内容及换行的 exactBytes 检查通过。 |
| 与之前 Paw 复杂任务比较 | 原先 720.068 秒外层取消、0/15；现在更早结束空转，仍是 0/15。不能把停止更早算成完成率提高。 |
| 费用 | 复杂任务只取得前两次合计 8041 token，第三次用量未知，因此不报告节省比例。 |

证据目录（本机忽略文件）：`.runs/2026-09-07-glm-v8-hardening/` 的 `single-agent-report.json`、`parsed.jsonl`、`protocol.json`；`.runs/2026-09-07-glm-v8-minimal/` 的 `verification.json`、`result.json`、`protocol.json`。实测发生于这一轮修复过程中，后续回放修复/记忆 deadline/原因显示分别由回归覆盖；没有把旧实验结果重新标记为最终组合版本的全链路实测。

## 验证

- 241 项：Agent Loop、模型适配/监督、进度、完成审查、快照、记忆 deadline、工作段恢复、manifest 与审计协议。
- 32 项：桌面宿主 IPC、实时输入、继续执行、停止/审批、后台任务、上下文压缩、交付检查与输出预算。
- 55 项：Shell/工具 registry、观察元数据、模型输出恢复集成。
- 合计 **328 pass / 0 fail，1590 assertions**；桌面前端及宿主 TypeScript 检查通过，`git diff --check` 通过。
- `runtime-architecture-audit.ts` 是 v7 的历史缺陷刻画脚本，其“缺陷必须存在”断言不是本版验收。新预期由上述测试覆盖，不应为让旧刻画脚本通过而恢复缺陷。

## 尚未解决

最主要的缺口仍是：GLM 在读取需求后把完整实现留在思考阶段，未及时转换为工具行动。新增宿主指导不足以解决这次样本。下一项应是带独立尝试身份、费用未知记录和严格次数上限的行动恢复机制，并做成功率对照；不能只降低输出额度、无限重试或把超时响应伪装为成功。

此外，尚未统一路由/压缩/审查/记忆写入的任务级总预算；没有新增持久化的 429/503 退避恢复；关键提醒的硬预算预留与按累计成本触发压缩仍待完成。后台工作区变更覆盖仍是保守 unknown。当前超时阈值是可验证的初始政策，并非已被大样本证明最优。
