# 最新桌面运行时的隔离复测（2026-09-07）

后续修复见 [RUNTIME-V7-REPAIR.md](RUNTIME-V7-REPAIR.md)。更正：本次运行使用的 v6 证据判断只覆盖分号尾随命令，管道漏判在后续 v7 修复中才补齐；下文保留本次原始测量结果。

## 环境与范围

- 入口：`runDesktopNext`，当前 Paw Next V3 composition 和 progress advisor v6。
- 模型：DeepSeek V4 Flash，main 请求 `reasoning_effort=max`、原生 `max_tokens=384000`；没有启用实验性 thinking recovery。
- 任务：完整 persistent job queue、持久化、CLI、自建测试与 README，保持原始接口要求；追加 Linux 容器的客观执行环境说明。
- 单 agent，关闭 memory 与 environment auditors，保留完成审查。
- 预算：12 分钟、40 次调用、32 步；禁用累计 reported token 截止，保留用量记录。缓存命中输入不能当作未缓存输入成本。
- 证据目录：`.runs/2026-09-07-deepseek-v6-docker`，保存 protocol、源码快照、请求、原始 SSE、解析与工具事件。

历史任务在 Windows 宿主上执行；本轮 shell 在 Linux/Node 24 容器中执行。环境不同且各只有一个样本，不能据此给出严格 A/B 提速、节省 token 或成功率结论。

## 隔离验证

复用旧运行时已有、桌面已接入的 `packages/harness/src/sandbox/docker-runner.ts` 与 `shell/execute.ts`，没有新建另一套生产 shell 后端。修复仅涉及 benchmark 的配置、预检与评分入口。

- 现有 Docker 引擎已恢复，未重置容器、镜像和数据卷。
- `docker-preflight.ts` 使用真实 shell 后端验证：工作区写入、宿主哨兵不可见且不变、只读根目录、符号链接越界阻止、容器临时目录、无 Docker socket 挂载、缺失镜像禁止回退、超时后清理容器。
- `packages/harness/test/sandbox-docker.test.ts`：9 项通过、27 个断言。
- 容器评分校准：固定 `npm test` 用例 1 项通过；没有实现的队列项目独立验收为 0/15。首次校准捕获输出遇到 Windows 默认 GBK 解码错误，显式指定 UTF-8 后重跑通过。
- 模型任务与评分使用同一内容 ID 镜像；shell 只挂载临时工作区，断网、只读容器根目录、可写 `/tmp`；独立验收只读挂载提交工作区和验收脚本。
- `tool-wire-probe.ts` 现在必须显式 `--docker`，预检失败即停止；`single-agent-report.py` 拒绝没有隔离预检的运行，生成代码不会再由这个评分入口在宿主机执行。

## 结果

本轮没有完成任务。583.579 秒后达到 32 次模型轮次预算，返回 `ok=false`、`status=incomplete`、`model-turn-budget-exhausted`。没有进入最终完成审查（`acceptance=not_required`）；事件名 `run.completed` 只表示运行结束，不能当作任务完成。

| 指标 | 本轮结果 |
| --- | --- |
| 物理请求 | 32；均有返回 usage，无未知用量请求 |
| 首次成功写入 | 262.319 秒 |
| 第三次请求耗时 | 241.773 秒，先持续思考，再返回工具 |
| 首次验证提醒 | 278.491 秒，第 8 次请求，4 轮修改 |
| 后续验证提醒 | 333.359 秒 / 8 轮修改；504.647 秒 / 16 轮修改 |
| 首次测试调用 | 335.3 秒，`node --test test/queue.test.js 2>&1 \| tail -20` |
| 独立验收 | 14/15；README 缺失，其他 14 个有限验收项通过 |
| 项目声明的 `npm test` | 失败：`node --test test/` 报 `Cannot find module '/workspace/test'` |
| 直接指定测试文件的附加诊断 | 14/16；不是替代 `npm test` 的通过结果 |
| 累计 reported tokens | 1,771,007：输入 1,715,970，输出 55,037 |
| 输入细分 | 缓存命中 1,691,520，缓存未命中 24,450 |

10 次实际执行的 shell 结果均携带 strict / network deny / 固定镜像 ID 的 sandbox 信息。第 11 次 shell 调用在派发前被预算控制取消。11 次请求的命令中有 9 次带输出管道，反复 `tail`、`grep`、`sed` 筛选输出；管道末尾的退出 0 不等于测试通过，筛选还导致一次输出为空。模型没有执行项目声明的 `npm test`。附加诊断中的两个失败用例都在尚未 `dequeue()` 的 pending job 上直接 `complete()`，违反原任务的状态转换要求；没有修改模型交付物来美化得分。

此前 Windows/v5 诊断用时 726.083 秒，独立验收 15/15、自建测试 50/50，但同样未完成收尾。本轮首次测试较早出现，却没有获得更好的完整交付结果。不能把更早触及轮次上限解释为提速，也不能由单样本断言提醒导致了提前测试。

## 具体代码落点与旧运行时对照

1. **长思考仍存在。** `packages/models/src/agent-loop-adapter.ts` 的 `execute()` 只传递外层 signal，`collectStreamCompletion()` 等待整次请求结束。旧 `packages/agent/src/orchestrator.ts` 已有 `modelRequestTimeoutMs`、请求级 `AbortSignal.timeout()`、超时与用户取消区分。下一步应迁移请求级有界控制及其 durable 预算语义，不能盲目套用 90 秒重复请求实验或降低用户 max。
2. **验证提醒接通，但没有解决无效验证。** `packages/progress-advisor/src/projector.ts` 的 `verification_due` 已真实进入请求；`packages/completion-review/src/evidence-projector.ts` 会将不可信 shell 控制流归为 indeterminate。旧 `packages/agent/src/lifecycle/convergence.ts:257` 的 `convergenceGuidance()` 已有 `untrusted_exit_status` 分支，明确要求移除显示管道、直接运行验证，并根据新鲜证据收尾；这是可迁移的既有实现，而非重新发明提示词。应保持证据版本去重和有界修复，避免每轮重复提醒。
3. **最后一个付费回复的工具被预算拦截。** `packages/agent-loop/src/interactive-control.ts:242` 在已结算模型数达到 `maxModelTurns` 且包含工具时直接返回 incomplete；`packages/agent-loop/src/agent-loop.ts` 的 `authorizeObservedCalls()` 随后取消工具。现有 reducer 测试明确固定了这个语义，不是单独改一个比较符就能安全迁移。旧 orchestrator 按 `turn < maxSteps` 运行，并有基于 `convergenceWindow()` 的临近预算指导。下一步应明确“禁止下一次模型调用”和“允许已获准轮次的工具完成”两个边界，并版本化验证取消、审批、恢复与总预算，提前预留验证/最终答复，而非扩大总预算掩盖问题。

详细原始结论见本次运行目录中的 `single-agent-report.json`、`own-tests-explicit-file.json`、`runtime-observations.json`。本轮只修改隔离评测基础设施，没有上线新的请求超时、收尾控制或预算 reducer 语义。
