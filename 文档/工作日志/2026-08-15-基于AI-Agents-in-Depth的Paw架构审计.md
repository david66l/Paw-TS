# 基于《深入理解 AI Agent》的 Paw 架构审计

日期：2026-08-15

审计对象：`AI-Agents-in-Depth-zh-CN.epub` 与 Paw 当前 `main@cdca8ee`

性质：只读架构诊断；本步没有修改 Agent 行为、评测协议或记忆数据

## 1. 审计范围与方法

本次完整提取并阅读了书中与 Paw 直接相关的章节：

- 第 1 章：ReAct、Harness 五环、Loop 工程、工作流与自主 Agent、护栏；
- 第 2 章：KV/Prompt Cache、流程驱动提示、状态栏、物理时间、分层压缩、上下文隔离；
- 第 3 章：记忆三层评估、轨迹/长期记忆/业务状态、混合检索、治理、隐私与遗忘；
- 第 4–5 章：工具粒度、异步 Agent、Coding Agent 的 Sessionless、故障恢复、搜索/编辑、即时反馈；
- 第 6 章：公开评测、行为指标、统计显著性、消融、特性开关、提示词回归；
- 第 8、10 章：从轨迹持续进化、多 Agent 的适用边界及失败模式。

随后对照了 Paw 的生产代码、进度日志和现有公开 benchmark 产物，重点检查：

- `packages/agent/src/orchestrator.ts`、`lifecycle/*`、`loop-v2/*`、`task-state.ts`；
- `packages/core/src/context/*`、system prompt、AppState；
- `packages/harness/src/registry/*`、shell、安全策略和子 Agent 文件锁；
- `packages/memory/src/runtime/*`、长期记忆的检索、写入、治理和生命周期；
- MemoryAgentBench、SWE compare、official grader 与 Claude 对照产物。

## 2. 总结论

Paw 不是“没有一个像样的 Agent Loop”。它已经具备不少优秀 Coding Agent 的关键部件：分层上下文压缩、冷归档与召回、任务证据账本、验证/验收/完成门控、断点状态、工具副作用策略、并行调度、记忆 Profile/Trial/Gate/Cap、公开 benchmark 与 official grader 接线。

当前真正的问题是：**这些部件尚未收敛成一个默认、简单、可恢复、能由公开实跑证明的统一闭环。** 目前同时存在 legacy convergence、coding-phase、TaskState、Plan、Todo、Acceptance、candidate review、loop-v2 readiness/semantic review/terminal 等多组控制机制；其中一些是安全与事实权威，一些只是行为启发式，但在主循环里仍互相交叠。结果是单元机制很强，真实长任务却可能在控制面、验证环境、产物收集或预算收尾处失败。

书中最适合 Paw 的原则不是“再加一层策略”，而是：

1. 上下文、工具、约束、验证、纠错必须闭环；
2. 状态必须显式、可恢复、靠外部事实更新；
3. 约束只负责不可违反的不变量，行为策略应先通过评测证明；
4. 自我审查只有引入新外部信息才有价值；
5. 每次架构优化都必须能消融、灰度、回滚。

## 3. Paw 已经做对的部分

### 3.1 上下文不是简单截断

Paw 已有 L1 工具结果裁剪、L2 模型压缩、工具全文磁盘归档、`context.recall`、压缩失败熔断、压缩后记忆补召回。关键 TaskState 又独立于自然语言摘要，保留目标、约束、文件、命令、测试、变更 revision 和 final diff 状态。这与书中“工具输出归档、噪声删除、结构化摘要、全量压缩兜底”的分层思想基本一致。

### 3.2 完成不再由模型一句话决定

当前完成路径已经统一到结构化 `CompletionDecision`；验证证据按 mutation revision 失效，测试失败、测试环境失败、external pending 被区分，`ask_user` 无回复不再假完成。loop-v2 进一步把事件、投影状态、候选、review、terminal 与 RunResult shadow 持久化。这部分明显优于简单的 `while (model says done)` ReAct。

### 3.3 记忆治理方向正确

Paw 已有 semantic/episodic/profile/vault_ref、BM25 + vector 混合召回、任务开始/失败/压缩后触发、trial 转正、画像证据门槛与容量、冲突治理、secret scan、效用账本、软失效和 GC。MemoryAgentBench 官方四维均为正增益，说明召回链路不是空壳。

### 3.4 评测纪律正在变得可信

SWE 题目固定、source commit 固定、memory-off、official grader、产物完整性检查、暴露样本永久排除、基础设施错误与代码失败分开，这些都符合书中“可复现环境、客观验证、不要按结果换题”的要求。历史 v7 三个真实候选经 official grader 为 3/3 resolved，证明 Paw 确实能解决复杂公开题，而不只是通过夹具。

## 4. 必须优先处理的真实问题

### P0-A：记忆的“成功/失败”证据接线是断的

这是本次审计发现的最直接能力问题。

`MemoryRuntimeV2.onToolResult()` 用 `toolName + summary` 的正则判断是否运行过测试。但 Paw 的测试通常通过 `workspace.run_shell` 执行，而成功结果摘要只是 `run_shell: exit 0`，真实命令在 `args.command`，当前判断没有读取它。因此大量真实测试不会被识别，最终走 `session_finalize` 的低置信兜底，而不是 verified success。

即使某次摘要碰巧被识别，`trace.tests.failed` 也是粘性的：任意一次早期失败都会永久置为 true，后续“修改后测试通过”不会覆盖。Coding Agent 最有价值的失败→修复→验证成功轨迹，反而可能被送进失败 trial，而不是作为成功经验固化。

这违反书中“持续进化必须从可验证结果学习”的根原则，也使 MemoryAgentBench 的机制成绩不能直接代表真实 Coding Agent 写入效果。

**正确的架构修复**：不要继续扩充测试命令正则。让 Agent 完成控制面把结构化的 `CompletionDecision + RunEvidence + verificationAuthority + mutationRevision` 传给 Memory Runtime；记忆只从同一个权威 verdict 学习。运行中失败可保留为事件，但最终结算看当前 revision 的 authoritative verdict，并显式标记 failure-to-success。

### P0-B：商业场景的记忆多租户隔离不成立

`resolveScope()` 计算了 `userId / repositoryId / workspaceId`，但当前长期记忆写入 PostgreSQL 时，`scope` 只保存 `{repositoryId}`；全文、向量、列表查询也只按 `repositoryId` 过滤。

这意味着两个用户或两个租户只要操作同一个 Git remote，对应的长期记忆就可能进入同一个召回池。它不仅会造成“记忆串味”，更是潜在的数据越权。书中明确要求权限过滤必须下推到检索层，敏感内容不能先召回再由模型过滤。

**正确的架构修复**：定义不可省略的 `MemoryScopeKey(tenantId,userId,workspaceId,repositoryId)`，从 Runtime 一路传入 Store 接口；数据库写入完整 scope，所有 get/query/text/vector/ledger/lifecycle 操作都必须带 scope；建立复合索引或 PostgreSQL RLS；迁移旧数据时 fail closed，并增加跨租户同仓库的红队测试。不能只在最终注入前补一个 JS filter。

### P0-C：生产中仍有多套 Loop 权威，v2 尚未得到真实切权证据

`AgentOrchestrator` 单文件约 4212 行，主循环同时连接 legacy lifecycle/convergence 与 loop-v2。即使显式选择 v2，工具路径仍会经过 `convergenceToolBlockReason()`；而 v2 又有 observation-only progress advisor、readiness、candidate certification 和 semantic review。书中强调“流程优于规则堆砌”，当前这里更像多代控制策略共存。

legacy convergence 中有基于目标关键词、固定调用次数和阶段窗口的硬工具阻断。它解决过真实死循环，但它属于行为策略，不是安全不变量；如果没有消融，很可能把某些模型本来正确的调查路径也挡掉。

当前默认仍是 v1；explicit v2 的 deterministic seam 已通过，但持久化真实复杂样本为 0。冻结的 5 个开发题又被 DeepSeek 402 和 Docker daemon 阻塞。因此现在只能说“v2 机制可运行”，不能说“v2 已比 legacy 更会完成任务”。

**正确的架构方向**：保留 effect/approval/sandbox/verification/acceptance 这类事实与安全权威；把阅读次数、何时编辑、何时收尾等策略统一为可观测 advisor，先做 v1 vs v2 消融。最终只保留一个事件源、一个 projector、一个 completion authority；legacy 行为控制逐项退役，而不是在 v2 外面继续包着。

### P0-D：公开证据仍不足以支持“达到或超过 Claude Code”

现有事实必须分层陈述：

- MemoryAgentBench 证明四类记忆问答/机制有正增益，但不是 Coding Agent 端到端能力；
- SWE v7 的 3/3 official resolved 证明 Paw 能解决复杂任务，但不是冻结十题的完整总体分数；
- 新 loop-v2 目前没有真实模型样本；
- 唯一 Claude 诊断题出现 `patchChars=0 / patch_collection_failed / integrity=false`，不能作为公平输赢；
- coding memory-on vs memory-off 的同题 official paired result 尚未完成。

因此目前不能对外宣称超过 Claude Code。下一阶段必须同时报告 resolved、配对 win/loss/tie、token/时间、无效产物和基础设施错误，且两边使用同一 DeepSeek V4 Flash、同题、同 source、同 official grader。

## 5. 长任务能力的主要优化点

### P1-A：模型看不到完整的“物理状态栏”

Paw 的 `[Current State]` 已包含 goal、constraints、acceptance、files、commands、tests、plan、revision、diff 和 next step，这是强项。但它没有稳定展示：

- 当前 turn/maxSteps 与已用墙钟时间；
- 上一个工具真实耗时、超时/卡死信号；
- 各工具调用/失败/重复计数；
- 当前工作目录、OS/Shell/Python/Node 环境指纹；
- 正在运行的后台任务及恢复方式；
- 当前节奏状态：继续调查、改变假设、验证、收尾。

`loop.tick` 只发给 UI；max-step/convergence 提示在特定阈值才注入。书中的实验结论是“只有时间读数不够，还要告诉模型如何据此改变策略”。

建议新增由 host 确定性生成的 `StatusSnapshot`，作为轨迹末尾 user-role 元信息；包含读数和简短策略，不进入 system prompt。先用开关记录 time-to-first-edit、无增量轮数、重复调用、验证延迟，再决定是否改变模型行为。

### P1-B：Sessionless 只恢复了对话，没有恢复执行环境

`AppState` 保存 goal、messages、plan、todos、TaskState 和 outcome；`workspace.run_shell` 每次都是新进程。当前没有持久终端的 cwd/env、后台进程登记、端口、依赖环境和重建配方。

`ask_user` 有 resolver 时直接阻塞当前 Promise；没有 resolver 时结束为 `user_input_required`。`resumeRun()` 又没有“提交用户回复”参数，所以等待用户不是可持久化的一等状态。

建议把运行状态扩展为 `running | waiting_user | waiting_approval | waiting_tool | paused | terminal`，用 append-only inbox 接收后续事件；为 shell 引入显式 ProcessRegistry，持久化 cwd、允许保留的 env、后台任务和重建命令。恢复时先验证/重建环境，再让模型继续，不能仅恢复消息。

### P1-C：编辑后没有便宜的即时诊断

当前 `edit_file` 成功后只返回文本变更统计，语法、类型、lint 或 LSP diagnostics 需模型下一轮主动运行。书中建议把低成本即时反馈附在编辑结果上，像 IDE 红线一样在错误引入时立刻暴露。

建议增加语言感知、非阻塞、严格限时的 `PostEditDiagnostics`：优先语法解析/已有 LSP/单文件 typecheck，结果作为同一 tool result 的 host observation。它不能替代最终测试，也不能自动跑全仓昂贵套件。

### P1-D：Plan、Todo、Acceptance、Hypothesis 需要统一投影

Paw 目前有 bootstrap Plan、模型 plan_update、TodoStore、Acceptance ledger、TaskState hypothesis，以及 v2 projector。它们分别有价值，但模型需要同时维护多个“还差什么”的列表；bootstrap plan revision=0 又不会阻止完成，实际只是 UI 兜底。

建议把它们收敛为一个持久 `TaskGraph`：节点类型为 goal/acceptance/work-item/hypothesis/evidence/blocker，状态变化只追加事件；Plan、Todo、状态栏和完成门都是这个图的派生视图。这样压缩、恢复、子 Agent 合并和最终报告不会各自维护一份真相。

### P1-E：工具总量尚可，但仍缺少按需发现

当前默认一次发送 22 个工具的原生 schema，同时 system prompt 里再列一次文本目录。稳定排序对 Prompt Cache 友好，但功能增加后会产生重复 token 与选错工具风险。Skill 机制存在，但 system prompt 主要指导用户显式输入 `/skill`，主动发现能力仍弱。

建议保留 8–12 个稳定核心工具，把低频 MCP、业务工具和 Skill 通过 `tool_search/capability_search` 按需加载；工具集合变化只追加版本化 capability event。此项必须以工具选择正确率和 cache hit 消融决定，不能仅为“架构漂亮”重写。

### P1-F：独立 reviewer 不能替代外部验证

Paw 的 semantic reviewer 有独立上下文、看严格 candidate/diff/host ledger，这是有价值的偏差隔离；但通常仍是同一个基础模型，且没有工具。书中引用的研究结论是：没有新外部信息的自我审查，常常只是“再想一遍”。

因此 reviewer 应只判断机械检查无法覆盖的语义 acceptance，不应成为测试通过的替代权威。先执行编译、测试、静态分析、渲染或 official grader，把新观测交给 reviewer；可机械验证的事实继续由 host 判定。

### P1-G：外部内容只有提示级防注入，没有数据流级隔离

Paw 会净化用户伪造的工具标记，system prompt 也提醒警惕 external tool result；shell sandbox、effect policy 和审批门控是强项。但 web/repo/tool 输出尚无统一 provenance/taint 标签，也没有“来自不可信内容的指令不能提升能力”的数据流规则。

商业场景应给每个 context block 标注来源与信任等级；外部内容只能作为 data/evidence，不能修改系统策略、审批或工具权限。高风险动作的参数必须绑定用户或 trusted policy 的独立授权，而不是由被检索内容触发。

## 6. 多 Agent 的判断

Paw 已有子 Agent 上下文隔离、结构化返回、并行调度和文件级锁，这与书中“隔离优于压缩”一致。但 system prompt 用“阅读约 5 个文件、修改 3 个文件后复核”等经验阈值指导模型，尚未证明多 Agent 真正引入了单 Agent 不具备的新信息。

后续应只在以下情况启用多 Agent：并行获得独立外部观测、不同工具/权限、独立执行环境，或能显著隔离噪声。子 Agent 的结论必须作为 claim + evidence 返回；同模型无工具复述不算 reviewer。文件锁只能阻止同文件丢失更新，跨文件 API/编号等语义冲突仍需在合并后做全局验证。

## 7. 推荐实施顺序与退出条件

### Step A：先修两条确定性契约，不碰行为策略

1. `MemoryOutcomeContract`：记忆结算直接消费权威完成/验证证据，覆盖失败→修复→最终通过、harness failure、external pending；
2. `MemoryScopeKey`：完整 tenant/user/workspace/repository 下推到存储和检索，补迁移与跨租户红队测试。

退出条件：不依赖模型/Docker 的单元与 PostgreSQL 集成测试全部通过；不能再由命令正则决定长期记忆是否“成功”。

### Step B：收敛 Loop 控制面

先写 ADR，列出每个控制组件的唯一权限：安全 deny、effect rollback、evidence projection、behavior advice、completion authority。将 `StatusSnapshot/TaskGraph/waiting state` 接入 v2；legacy convergence 做逐项影子/消融，不一次性大改。

退出条件：同一事件回放得到唯一状态；恢复前后状态等价；不存在 v1/v2 两套组件都能独立宣告完成或阻断普通调查。

### Step C：增加即时反馈和按需工具发现

PostEditDiagnostics 与 capability search 都先做特性开关，记录成本、cache hit、time-to-first-fix、误阻断率。

退出条件：在冻结开发集上产生可重复正增益，且不降低 resolved 或显著增加无效产物。

### Step D：完成公开证据闭环

外部条件恢复后，按已经冻结的 5 个 explicit-v2 memory-off 开发题顺序实跑；协议问题稳定后另冻全新 10 题，做 Paw memory-off/on 配对；最后同一模型、同题、同预算、同 official grader 对比 Claude Code CLI。

对外结束标准不是“某个夹具全绿”，而是：

- 固定公开题集有可复现 official resolved；
- Paw 不低于 Claude Code 的配对结果，并报告统计区间、token、时间与失败类型；
- memory-on 相对 off 有稳定增益或至少无显著回退；
- 0 无效 patch、0 完整性违规、0 跨租户召回；
- 长任务可中断、等待用户、恢复并继续验证；
- 所有关键架构开关可回滚。

## 8. 下一步建议

下一步不应继续给 convergence 增加新的关键词或次数补丁。优先实现 `MemoryOutcomeContract`，因为它是本次审计中证据最明确、影响“从真实成功中学习”且可以完全确定性验证的一条断链；随后立刻做 `MemoryScopeKey`，把商业数据隔离补成发布前硬门槛。两步完成后，再进入 Loop 控制面 ADR 与消融。
