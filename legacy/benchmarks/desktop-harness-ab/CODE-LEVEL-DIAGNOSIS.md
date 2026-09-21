# Paw 长任务：代码定位与修复方案

本次沿实际桌面入口 `runDesktopNext` → V3 composition → `packages/agent-loop` 检查。没有调用付费模型，没有重新执行上次越界的 shell 命令。已修改的是验证节奏提醒；下面其他机制明确区分为定位结果和待实现方案。

## 旧运行时对照：迁移前先确认已有能力

用户要求修改前检查旧实现。已补查 `packages/agent/src/orchestrator.ts`、`lifecycle/`、`loop-v2/` 和旧 ContextManager；不再把以下功能笼统描述为“仓库没有”。

| 能力 | 旧实现与接线 | 新运行时状态 / 迁移决定 |
| --- | --- | --- |
| 单请求超时 | `orchestrator.ts:655` 默认 120000 ms；构造函数读取 `modelRequestTimeoutMs`；`:3518` 合并请求 timeout 与父 signal；`:3745` 将内部超时分类为可重试错误 | 新 `agent-loop-adapter.ts:52` 只传入父 signal；这是明确的请求级限制迁移缺口。优先迁移超时与用户取消的区分，再加入持久化的总恢复额度 |
| 临近结束时的验证、diff、交付判断 | `lifecycle/convergence.ts` 的 `convergenceGuidance()`、`convergenceEvidenceKey()`、`convergenceWindow()`；`lifecycle/loop-guidance.ts:40` 派生提示，`orchestrator.ts:2678` 真正接到请求 | 优先迁移这些纯判断。用新 Journal 投影出修改版本、新鲜检查、diff 状态和剩余轮数；按证据键去重，映射到新运行时的正常结束协议，不要求旧 final_answer JSON 动作 |
| 强制限制后续工具 | `lifecycle/convergence.ts:137` 的 `convergenceToolBlockReason()` 在 `orchestrator/action-handlers.ts:1708` 调用，但只在 authority.behavior 为 legacy_guarded 时启用 | `loop-authority.ts` 明确让旧 kernel v2 使用 advisory_only。不能把 v1/shadow 的强拦截直接当作新运行时遗漏，迁移必须保留权限与行为分离的决定 |
| 连续修改但未验证的独立计数 | `loop-v2/progress-advisor.ts:86` 遇到 meaningful delta 即清零；`loop-v2/projector.ts:234` 将新 mutation 记为 meaningful。旧版另靠 convergence 做收尾 | 本次新增的轮间验证计数不是重复迁移已有计数；它补上早期可运行部分的反馈。完整收尾仍应复用旧 convergence 的证据模型 |
| 上下文压缩 | 旧 `orchestrator.ts:2100` 调用 `shouldCompactHistory()`；`core/src/context/budget.ts:179` 按历史窗口份额阈值计算 | 所查旧生产触发路径也不是累计重放成本触发。复用已有范围保护与校验能力，成本条件单独评估 |
| shell 隔离 | 旧 `orchestrator.ts:4810` 使用 `resolveShellSandboxConfig()` 和相同 harness 后端 | 桌面 `paw-next-profile.ts:41` 已复用。问题是 fixture 配置关闭且评测自动审批，不是沙箱接线遗失 |

迁移顺序：先复用旧请求超时的取消语义和测试，再迁移 convergence 的版本化证据判断；旧 TaskState 仅作为输入模型参考，不把整个旧 orchestrator 塞进新 loop。可共享的纯判断应提取到双方可依赖的模块，保留旧入口作为适配层。禁止用正文关键字或一次测试通过直接改写最终完成状态。120 秒是旧默认值，不是当前 max 模型已验证的最优阈值，也不是“只思考 120 秒”的专门检测器。

旧实现验证：单独运行 `packages/agent/test/convergence.test.ts`，15 项通过。`model-retry.test.ts` 的内部超时/父取消集成用例本次未正常结束；确认进程命令行属于这次测试后终止了该测试进程，不记为通过，也没有修改无关运行进程。超时能力的定位来自源码与调用链；迁移前须在新模型端口重新验证其取消、恢复和额度语义。

## 1. 连续写文件掩盖了缺少验证：已修复提醒缺口

位置：`packages/progress-advisor/src/projector.ts`，`projectProgressAdviceV1()`。

原代码的 `meaningfulTurns` 收集成功写文件、成功委派和通过检查的轮次，然后用 `Math.max(...meaningfulTurns)` 作为基线。每次写文件都把 `gap` 重置为 0。因此即使连续写出多个实现和测试文件、始终没有运行测试，`noProgressKind(gap)` 也不会提示。`packages/harness/src/registry/execution.ts` 中写文件的 `ok: true` 表示文件操作成功，即使随附 syntax diagnostics 有错误也仍是成功写入；不能把这个标记解释为代码正确。

修改：保留原有停滞检测，独立累计最近一次可识别、已结算检查以来发生修改的模型轮次。在 4、8、16 轮形成 `verification_due` 历史锚点，建议验证当前可运行部分；尚不可运行时先完成必要前置项。非代码产物建议直接检查产物，不要求凭空增加测试。一个模型轮次写多个文件只计一次。

失败测试可重置“是否尝试验证”的计数，因为它提供了反馈，但不重置“通过验证”的进度基线。掩盖退出码或结果不确定的检查不能抵消计数。后台检查按启动位置判断覆盖时间，不把启动之后的修改当作已检查。仅使用日志中可用的 inline 结果；未解析的 artifact 引用不作为后台完成证据。

接线：`apps/cli/src/paw-next/composition.ts` 的 `createPawNextV3CacheStableContextV1()` 本来就调用 `projectProgressAdviceTimelineV1()`，把提醒插入对应历史工具轮次后。新分支通过这条现有路径进入桌面请求，无额外模型调用，不修改基础系统提示词、工具列表、max effort 或输出上限。

离线重放 `.runs/2026-09-07-deepseek-budget-diagnosis` 的 231 条 canonical input facts：

| 策略 | 连续实现阶段的验证提醒 |
| --- | --- |
| 原 v5 | 没有；仅在早期只读阶段发出 inspect_gap |
| 新 v6 | 第 277.793、361.679、505.811 秒，对应 4、8、16 轮修改 |

历史运行第一次执行 `npm test` 是第 529.845 秒。重放证明新代码在这个轨迹上能更早提醒，不证明模型收到提醒后一定遵从，也不是新成功率或耗时结果。`progress-replay.json` 保存两版源码哈希；旧版来自修改前 HEAD，仅调整模块导入路径以便离线加载。

## 2. 单次请求长时间思考：执行时限策略缺位，未在本次上线重试

位置：

- `packages/agent-loop/src/agent-loop.ts`，`settleModelCall()`：直接等待 `dependencies.model.execute()`，传入的是外层 signal。
- `packages/models/src/agent-loop-adapter.ts`，`collectStreamCompletion()`：持续收集流，直到有效结束再返回可执行工具。
- `packages/models/src/openai-compatible.ts`，流式 `reader.read()` 循环：接收 reasoning 数据仍是正常传输，不会触发“尚未做出行动”的限制。
- `packages/models/src/thinking-recovery.ts`：90 秒中断等策略来自现有实验包装器；生产桌面没有启用它。前面的实验没有证明它改善完整任务成功率。

这不是把某个 `await` 改成不等待就能修复的问题。工具参数未完整、结果未确认时不能执行。当前缺的是旧 orchestrator 已有、但新模型端口尚未等价迁移的请求级限制，而不是 SSE 解析分支。

具体方案：在模型端口的宿主包装层新增明确版本的 call policy，区分无响应、仅思考、可见回复、工具参数传输；复用 `ModelObservationEvent` 的 bytes/thinking/tool_fragment 事件，不读取思考语义。工具参数已开始传输时保护完整性；只在未产生工具副作用的请求上允许有界恢复。将中断原因、次数、用量未知和剩余额度写入 durable facts，恢复任务不能重置重试额度。总耗时限制与“无行动”限制分开，保留用户 max 和原生输出容量。

控制器要与“选择下一项有证据依据的工作”策略一起评估。单纯每隔 90 秒取消并重来会重复付费，旧的每次只写约 60 行也增加历史重放开销，均不应直接推广。必要回归：持续思考流能终止、慢工具参数不被截断、取消后没有工具执行、恢复次数跨重启不归零、小任务和纯分析回复不被误伤。

## 3. 通过测试后仍不收尾：完成审查触发时机在 loop 之后

位置：`apps/cli/src/paw-next/composition.ts`，`openNextPawNextV3WorkSegmentV1()` → `projectCompletionReviewCandidateV1()`。先等待工作段结束，再构造候选并审查；没有有效候选正文时也不会构造候选。`canContinue` 与 abort 分支不能提供额外的收尾预算。

因此模型持续产生工具调用时，最终审查尚未进入。上次失败不是 completion reviewer 审查了这些测试却作出错误结论。

具体方案：在轮间、收到新鲜验证结果后增加一次轻量的“剩余要求检查”事件，而不是立即宣布完成。关联检查对应的修改版本、覆盖目标、尚未关闭的要求和失败检查。如果必要要求已有证据，请模型给出最终结果，再走现有审查；仍有缺口则明确下一项。相同证据版本只提醒一次，新修改或失败让旧结论失效。有限任务预算要在开始时预留验证/收尾份额，不能等外层 abort 才启动审查，也不能通过额外循环突破总预算。

这与第 1 项不同：本次修复减少连续未验证写入，但还没有实现“测试通过后自动协调收尾”，更没有把一次 `npm test` 通过等同于完整任务完成。

## 4. 累计上下文开销：压缩策略没有成本触发条件

位置：`packages/context-compaction/src/policy.ts`，`evaluateContextCompactionTriggerV1()` 只看窗口使用比例和是否发生内容省略；`range-planner.ts` 的 `planContextCompactionV1()` 在 `below_trigger` 时直接跳过。

DeepSeek 的此配置中，默认 80% soft input target 约为 49.3 万 estimated input tokens。每次几十万以下的输入可以始终未接近窗口，但多轮回传的累计量已经很高。`openai-compatible.ts` 的消息转换会回传 `reasoning_content`，这符合此前核实的供应商工具协议，不应直接删字段。

具体方案：给 compaction plan 增加独立的 `replay_cost_pressure` 输入与触发原因，读取已知 usage、可压缩稳定范围和近期轮次开销。只有预期减少的后续重放超过生成/校验 checkpoint 的成本时才考虑压缩，并保留冷却期和最大次数。仍使用 `planSemanticCheckpointRangeV1()` 排除活跃/受保护工具轮次，复用现有 checkpoint 证据与语义校验；不能随意破坏工具调用与结果配对。缓存命中、未命中和输出分别计算，不能把所有 input token 当作同价。

这是待评估策略，不是修正一个算术 bug。本次不降低上下文窗口、输出容量或 max 设置。

## 5. shell 越界：未启用隔离，并被评测自动审批

位置与调用链：

1. `packages/agent/src/resolve-shell-sandbox.ts`：`DEFAULT_MODE = "off"`。
2. `apps/desktop/agent-host/paw-next-profile.ts`：配置为 off 时把 `shellSandbox` 设为 null。桌面已接入配置，不是新运行时丢了 sandbox 参数。
3. `packages/harness/src/shell/execute.ts`：`resolveShellCwd()` 只检查起始目录；`resolveShellSpawnTarget()` 在无沙箱时直接启动 `cmd.exe /d /s /c`，命令内的 `cd` 和绝对路径仍可访问宿主文件。
4. `packages/harness/src/shell-guard.ts` / `shell-policy.ts`：命令策略提供 allow/deny/ask，不是文件系统沙箱；使用的 Bash AST 也不能作为 Windows cmd 路径语义的可靠边界。
5. `benchmarks/desktop-harness-ab/tool-wire-probe.ts`：隔离临时工作区没有 sandbox 配置，传入 `settings: {}`，并设置 `resolveToolApproval: async () => true`。普通桌面则调用用户审批回调。

`shell-boundary-probe.ts` 只分析历史命令，结果为 `sandboxMode: off`、`allowed: true`、`requiresApproval: true`。没有重新执行命令。之前的实际越界由“主机执行 + 自动审批”共同放行，不能描述成普通桌面无条件跳过审批。

具体方案：需要严格限制宿主文件范围的无人值守运行，应要求真实执行隔离。仓库已有 `packages/harness/src/sandbox/docker-runner.ts`，可优先复用 Docker/Podman 执行目标；启用后不可用就返回执行错误，不能回退到宿主。只有映射的工作区可写，不能挂载整个用户目录或 Docker socket。Windows 原生命令需要另建并验证受限执行后端；单改默认值会破坏没有容器环境的桌面任务，单加命令字符串黑名单也无法阻止脚本间接访问文件。

后续自动审批的真实模型评测必须先确认隔离后端或停止启动。验收应包括命令内 `cd`、绝对路径、环境变量、脚本间接写入、符号链接及后台子进程的越界测试，明确验证宿主哨兵文件未变。不要在用户目录上重放删除命令来验证。

## 本次代码与验证范围

- 生产修改：progress advisor v6，独立验证计数和对应历史提醒；inline payload 正确解包，未解析 artifact 不冒充完成结果。
- 新增 5 个针对验证计数的单元测试、1 个实际 V3 请求集成测试；更新精确 manifest 版本与独立哈希期望。
- 16 个 progress advisor 测试、18 个 V3 manifest 测试，以及 3 个选定 V3 composition 测试通过。已有只读提醒测试首次触发默认 5 秒时限，单独使用 30 秒时限复核通过。桌面 host 与 progress advisor 类型检查通过。
- policy version 参与 manifest 身份：新任务使用新策略，旧任务不能静默切换恢复规则；没有改写旧 journal。
- 没有修改生产 shell 隔离策略、请求中断策略、自动收尾策略或压缩触发条件；这些已有明确代码落点，仍需实现与针对性验收。

## 桌面链路复测（2026-09-07）

本轮 61 项测试通过，共 543 个断言；桌面 host TypeScript 检查通过。

| 测试范围 | 结果 |
| --- | --- |
| `apps/desktop/test/pawNext.test.ts`、`modelOutputBudget.test.ts`、`readbackReview.test.ts` | 26 通过，163 个断言 |
| `apps/desktop/test/verificationCadence.test.ts` | 1 通过，10 个断言 |
| `packages/progress-advisor/test/progress-advisor.test.ts`、`apps/cli/test/paw-next-product-v3.test.ts` | 34 通过，370 个断言 |

新增桌面集成测试通过 `runDesktopNext` 和实际模型适配器处理固定 SSE 响应，真实执行文件写入与 `npm test`：连续 4 轮修改后，下一次模型请求收到验证提醒；第一次测试失败，修复后再次测试通过，最后进入完成审查并结束。测试同时确认早期没有提前提醒，后续请求没有重复追加同一提醒。模型响应与审查回复均为测试预设，因此该结果证明运行时链路正常，不证明真实模型会主动遵循提醒或完成复杂任务。

其余桌面回归覆盖模型原生输出额度、恢复、上下文维护、审批与取消、子任务控制、后台任务监控及完成审查的实际回读内容。host 类型检查范围为 `agent-host`，不包含测试文件。

真实模型长任务尚未重测：本机 Docker Desktop 启动失败，后端日志报告 `dockerInference` 本地管道监听/清理错误，无法确认执行隔离可用。本轮没有再次启动无隔离、自动审批的真实模型 shell 评测，也没有重置 Docker 配置。请求级时限、验证后的收尾引导及成本驱动压缩仍是待迁移或实现项；不能用本轮测试宣称这些问题已解决。
