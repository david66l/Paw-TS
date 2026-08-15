# SPEC-001：Paw Platform Refactor 实施规格

> 状态：Active
> 版本：1.0.0
> 日期：2026-08-16
> 目标：将 Paw 改造为可服务真实场景、可长期执行、可插件化、可自动化、可接入企业渠道、可受控自进化的 coding agent platform，并在相同模型与环境下以公开、可复现实验证明任务能力达到或超过 Claude Code CLI。
> 上位设计：`RFC-002-Paw-Real-World-Agent-Platform.md`
> Loop 契约：`coding-agent-loop-kernel-v2.md`
> 当前实现基线：`d140a24`

## 1. 规格语义

本文中的“必须”是放行条件，“应该”是默认决策，偏离时必须新增 ADR，“可以”是实现选择。任何阶段不得用以下手段宣告完成：只通过 mock、不记录真实 provider/tool 轨迹、改 benchmark 特判、扩大预算掩盖停止错误、只报告总体平均而隐藏单题失败、使用不同模型或不同题目比较 Paw 与 Claude Code。

本规格同时约束：

- 包和依赖方向；
- Run Kernel、Context、Memory、Plugin、Automation、Gateway、Evolution 的接口；
- durable event、状态机与事务语义；
- legacy 迁移和删除条件；
- 测试、benchmark、同模型竞品对比和商业可靠性验收。

## 2. 可证伪的总目标

“超过 Claude Code CLI”不能是主观体验，必须拆成四组指标。

### 2.1 Coding task effectiveness

在同一机器、同一 repo/base commit、同一任务文本、同一 DeepSeek V4 Flash 版本、相同 reasoning 配置、相同外部网络和时间上限下：

- Paw 在冻结的 memory-off 复杂题集上先达到预设绝对通过门槛；
- Paw 与 Claude Code CLI 做 paired comparison，报告 resolved win/loss/tie；
- 主张“超过”至少要求 Paw 的 resolved wins 多于 losses，且不能以显著更高的 invalid patch、未验证完成或 harness failure 换取；
- 报告每题 wall time、model calls、tokens、tool calls、mutation、verification、stop reason 和 official scorer；
- 小样本只形成工程信号，不形成统计性产品宣传。

### 2.2 Long-horizon control

- crash/resume 后 task state、candidate、repair obligation 和 verification matrix 一致；
- 已完成 development unit 保持 regression obligation；
- provider 的普通 natural stop 不会把 discovery prose 伪装成已完成；
- 无新证据循环可诚实 `incomplete/stalled`，不会无限烧 token，也不会错误成功；
- 外部 verifier pending 与本地失败分开表达。

### 2.3 Context and memory advantage

- Context compaction 前后 protected task facts 零丢失；
- Prompt snapshot 能解释每轮模型看到了什么以及为何裁剪；
- MemoryAgentBench 继续报告官方维度，不把内部 SF 夹具混入平均；
- SWE-Exp/真实跨 session 任务报告 memory on − off resolved delta；
- 错误记忆、旧 skill 和 provider 故障不会破坏 memory-off 基线。

### 2.4 Platform reliability

- 自动化 attempt 具备 claim/lease/idempotency/unknown 语义；
- channel delivery 与 agent completion 分离；
- 24h/72h unattended soak 中可恢复 provider、network、worker、gateway 和重启故障；
- 插件不能绕过 filesystem/network/process/secret/channel authority；
- 自进化候选不过 holdout/regression 时不得发布。

## 3. 架构不变量

### I1：单向依赖

目标依赖图：

```text
@paw/protocol
  ↑
@paw/kernel
  ↑
@paw/runtime
  ↑
@paw/coding
  ↑
composition roots / apps / services

@paw/plugin-sdk -> @paw/protocol
provider/plugin implementations -> protocol + plugin-sdk
```

禁止 package cycle。`@paw/protocol` 不得依赖任何 `@paw/*` 包、Node/Bun 特有运行时、数据库或具体 SDK。

### I2：唯一事实源

- Run/Task 事实源：append-only event store；
- 正式长期记忆事实源：Memory Store，经 Governor 变更；
- artifact 内容事实源：content-addressed artifact store；
- prompt、UI、summary、status、metrics 都是 projection。

### I3：唯一权威

- Run completion/candidate transition 只能由 Kernel + Coding Certification 决定；
- tool allow/deny 只能由 Authority Pipeline 决定；
- Memory 正式写入只能由 Governor 决定；
- plugin activation 只能由 Plugin Host 决定；
- evolution promotion 只能由 Release Policy 决定。

### I4：model-visible means logged

任何进入模型的 message、context block、tool schema、memory、skill、repair instruction 和 user/channel input 都必须能从 event/artifact refs 重建。任何模型调用必须绑定 immutable `PromptSnapshotId`。

### I5：版本固定

一个 RunAttempt 创建时固定 model profile、kernel version、plugin registry snapshot、tool schema snapshot、context policy、memory policy、skill versions 和 evaluator version。升级只影响新 attempt，不能改变正在运行的上下文。

## 4. `@paw/protocol` 规格

### 4.1 允许内容

- branded scalar IDs；
- JSON-safe wire interfaces 和 closed enums；
- event envelope 与 version fields；
- ports 的输入/输出 DTO；
- schema-independent type guards；
- 不访问 IO 的 deterministic normalization/hash input contracts。

### 4.2 禁止内容

- filesystem、process、network、DB；
- tokenization、prompt rendering、memory ranking；
- provider SDK objects；
- runtime singleton、registry 或 service locator；
- re-export 具体实现。

### 4.3 ID 类型

```ts
declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

type TenantId = Brand<string, "TenantId">;
type ConversationId = Brand<string, "ConversationId">;
type TaskId = Brand<string, "TaskId">;
type RunAttemptId = Brand<string, "RunAttemptId">;
type EventId = Brand<string, "EventId">;
type ArtifactId = Brand<string, "ArtifactId">;
type PromptSnapshotId = Brand<string, "PromptSnapshotId">;
type PluginSnapshotId = Brand<string, "PluginSnapshotId">;
```

解析器只在 wire/DB/config 边界运行；同进程 typed API 不重复验证。

### 4.4 Event envelope

```ts
interface EventEnvelope<TType extends string, TPayload> {
  schemaVersion: number;
  eventId: EventId;
  tenantId: TenantId;
  conversationId?: ConversationId;
  taskId?: TaskId;
  runAttemptId?: RunAttemptId;
  sequence: number;
  occurredAt: string;
  causationId?: EventId;
  correlationId?: string;
  type: TType;
  payload: TPayload;
}
```

同一 RunAttempt 的 sequence 必须单调且 CAS append。未知 required event 使 replay fail loud；明确标记 `ignorable` 的扩展事件可以跳过。

## 5. Run、Task 与 Session 协议

### 5.1 实体

```ts
interface Conversation {
  id: ConversationId;
  tenantId: TenantId;
  channelBinding?: ChannelConversationBinding;
}

interface TaskDefinition {
  id: TaskId;
  conversationId?: ConversationId;
  goal: string;
  acceptance: readonly AcceptanceCriterionSeed[];
  workspace: WorkspaceTarget;
  agentProfile: string;
  policySnapshot: TaskPolicySnapshot;
}

interface RunAttempt {
  id: RunAttemptId;
  taskId: TaskId;
  attempt: number;
  immutableInputHash: string;
  ownerLease?: OwnerLease;
  status: RunAttemptStatus;
}
```

Conversation 负责交互连续性；Task 负责目标与策略；RunAttempt 负责一次真实执行。不得用 conversation ID 充当 workspace、memory scope 或 attempt identity。

### 5.2 RunAttempt 状态

```text
created -> claimed -> running
running -> awaiting_user | candidate | incomplete | failed | aborted
candidate -> certifying -> completed | external_pending | repair_required
repair_required -> running
external_pending -> completed | rejected
claimed/running --owner lost--> unknown
```

`unknown` 表示无法证明副作用是否完成，默认禁止自动重跑。只有 TaskDefinition 显式声明幂等且 RetryPolicy 允许，scheduler 才能创建新 attempt。

## 6. Run Kernel 规格

### 6.1 Port

```ts
interface RunKernelPorts {
  events: EventAppendPort;
  model: ModelPort;
  context: ContextBuildPort;
  tools: ToolSchedulePort;
  control: ControlStatePort;
  clock: ClockPort;
}
```

Kernel 不接收 MemoryRuntime、MCPClient、filesystem、UI、channel 或 DB handle。

### 6.2 单步算法

1. 从 durable inbox claim 一个 input；
2. append `turn.started`；
3. Context Port 生成 PromptSnapshot；
4. append `model.requested`，调用 Model Port；
5. 持久化 stream/final response；
6. 若含工具调用，全部进入 scheduler；
7. 每个调用必须得到 completed/failed/rejected/cancelled result；
8. result 按模型 call order 进入 history；
9. projector 更新 progress/task state；
10. provider stop 且无 pending tool 时形成 turn boundary；只有明确 candidate action/readiness 才进入 candidate；
11. terminal transition 先落事件，再向订阅者发布。

### 6.3 Tool settlement

- 截断 tool arguments 不执行，返回模型可见 structured error；
- unknown tool、schema invalid、permission denied 都必须结算；
- parallel 调用可以并发执行，结果按原 call order commit；
- mutation/unknown effect 默认 exclusive；
- batch 中一个拒绝不能让其他调用静默消失；
- `afterTool` 不能把失败改写成成功，也不能绕过 authority。

### 6.4 Completion authority cutover

切换完成后：

- provider natural stop 是 turn boundary，不自动合成 legacy `final_answer`；
- Candidate Readiness 是 deterministic gate；
- semantic reviewer 只负责语义发现，不拥有 tool authority；
- v2 readiness 后不再调用 legacy VerificationGate；
- `RunOutcomeV2` 是唯一终局 DTO；
- legacy RunResult 只允许由 adapter 从 v2 outcome 投影，不能反向影响 v2。

## 7. Durable Task State 规格

Working Decision State 必须包含：goal、criteria、task graph、ready frontier、hypotheses、evidence、invariants、change surface、mutation revision、verification matrix、regression obligations、risks、repair obligation 和 candidate。

Host 独占写入：tool facts、file mutation、test result、diff、external result、cost。模型只能通过 versioned decision proposal 提议 hypothesis、plan 和 next action，不能把 criterion 或 test 自行标绿。

Repair Obligation 至少绑定：

```ts
interface RepairObligation {
  id: string;
  createdAtRevision: number;
  gapCode: string;
  expectedAction:
    | { kind: "direct_verification"; runnerFamily: string; scope: readonly string[] }
    | { kind: "material_mutation"; affectedCriteria: readonly string[] }
    | { kind: "evidence"; evidenceKind: string; target: string };
  status: "open" | "satisfied" | "superseded";
  satisfiedByEventId?: EventId;
}
```

纯 prose、重复 read、无关成功命令不能关闭 obligation。

## 8. Context Plane 规格

### 8.1 ContextBlock

每个 block 必须有 id、kind、sourceRef、authority、content/artifactRef、estimatedTokens、priority、protected、freshness/scope。Block content 不能混入未标来源的多域文本。

### 8.2 PromptSnapshot

```ts
interface PromptSnapshot {
  id: PromptSnapshotId;
  runAttemptId: RunAttemptId;
  sequence: number;
  modelProfileHash: string;
  contextPolicyVersion: string;
  blocks: readonly {
    id: string;
    contentHash: string;
    sourceRef: string;
    includedTokens: number;
    disposition: "included" | "trimmed" | "archived" | "dropped";
    reason?: string;
  }[];
  toolSchemaHash: string;
  totalEstimatedTokens: number;
}
```

### 8.3 组装顺序

1. system identity 与 immutable security/authority；
2. user/repository instructions；
3. durable task state 与 open obligations；
4. selected skills；
5. retrieved memories；
6. relevant conversation/tool evidence；
7. advisor hints。

低 authority block 不能覆盖高 authority block。冲突必须保留来源并由 Context Policy 明确排序。

### 8.4 压缩

- compaction 输出是 cache/projection；
- goal、原始用户约束、criteria、open obligation、current revision、verification facts 只能引用权威 state，不由摘要改写；
- archive stub 必须可寻址；
- compaction 失败退化为 prune/archive，不得使 Task 事实丢失；
- resume 时 prompt snapshot 可重建。

## 9. Memory Plane 规格

### 9.1 MemoryProvider port

```ts
interface MemoryProvider {
  retrieve(request: MemoryRetrieveRequest): Promise<MemoryInjectionPackage>;
  proposeWrite(request: MemoryWriteProposal): Promise<MemoryProposalReceipt>;
  recordOutcome(request: MemoryOutcome): Promise<void>;
  health(): Promise<MemoryProviderHealth>;
}
```

Runtime 只依赖 port。MemoryRuntimeV2 继续是默认生产 provider。

### 9.2 读取

检索结果必须包含 id、revision、kind、scope、source、content hash、applicability、rank evidence 和 token estimate。Context Builder 决定是否注入；Memory Provider 不直接改 message history。

### 9.3 写入

- foreground loop 只投递 proposal，不等待蒸馏；
- verified success、用户明确陈述和受治理纠正可进入正式候选；
- failed task 只能形成 trial lesson；
- secret interception 在 proposal 和 commit 两处运行；
- Governor 统一决定 ADD/UPDATE/INVALIDATE/NOOP；
- provider 故障不使 coding task 失败，但必须发 health/operation event。

### 9.4 程序记忆

Skill 是版本化 procedure artifact，不是普通 fact。自动 skill 的发布链固定为 candidate → guard → replay/critic → staged diff → approval/promotion → registry。当前 run 固定 skill version；utility ledger 决定后续 retain/revise/deprecate，但不能静默删除用户手写 skill。

## 10. Plugin SDK 规格

### 10.1 Manifest

manifest 必须声明 id、version、apiVersion、runtime isolation、contributions、permissions、config schema。未经声明的 contribution/permission 在 executor 处拒绝。

### 10.2 Contribution types

首版只允许 model_provider、tool_provider、runtime_backend、context_provider、memory_provider、channel_adapter、trigger_provider、evaluator、delivery_renderer。

### 10.3 Lifecycle

- activation 返回 disposer；
- registration 归 plugin scope 所有；
- unload 后 registry 不得残留；
- registry rebuild 从 clean state 按确定顺序重放 contributions；
- 一个 run 固定 PluginSnapshotId；
- hook timeout/error policy 明确；
- 禁止暴露任意 mutable orchestrator/context 对象。

### 10.4 Isolation

built-in trusted plugin 可以 in-process；第三方 filesystem/network/process/secrets 插件默认 worker/external。MCP 仅是 tool provider transport，仍受 Paw executor authority 和审计约束。

## 11. Automation 规格

TaskDefinition 必须包含 trigger、input template、workspace、agent/plugin snapshot、concurrency、idempotency、approval、timeout、retry、delivery、success criteria。

Scheduler 只创建/claim attempt；Worker 运行 agent；Executor 执行副作用；Delivery Worker 发送结果。执行状态与发送状态分别持久化。

重复 cron tick/webhook 使用 idempotency key 去重。Attempt 在 dispatch 前进入 claimed。Owner 丢失且无法证明终局时进入 unknown，默认不重跑。

## 12. Gateway 与 Channel Adapter 规格

Channel adapter 只负责平台事件与统一 envelope 转换。Gateway 负责签名、auth、pairing/allowlist、idempotency、conversation/thread mapping、attachment、typing/streaming 和 outbound retry。

接入顺序固定：reference webhook → 飞书/Lark → 企业微信 WeCom → 可替换微信 bridge。个人微信非官方协议不得成为 core 依赖或商业默认 SLA。

任务完成和消息发送分别落事件：`run.completed` 不因 `delivery.failed` 回滚；delivery retry 不创建新 coding attempt。

## 13. Evolution Supervisor 规格

### 13.1 数据与候选

输入轨迹先做 secret/PII redaction、失败分类、repo/time split。每次 experiment 固定 dataset version、baseline artifact、target component、hypothesis、metric 和 budget。

### 13.2 发布级别

- E0 memory/profile：Governor；
- E1 skill：staged + replay/test；
- E2 tool description/prompt/context policy：offline train/dev/holdout + canary；
- E3 plugin/tool code：PR + full tests + benchmark + human review；
- E4 kernel/security/authority：只生成 PR，永不自动 deploy。

### 13.3 Promotion

候选必须通过 component constraints、deterministic replay、目标任务 eval、固定 holdout、关键回归、成本上限和安全检查。发布只影响新 run。监控触发阈值后原子回滚到已知版本。

## 14. 存储、事务与恢复

本地默认 SQLite event store + artifact directory；商业部署 Postgres + object store。Memory 可继续独立 Postgres，但共享 tenant/project/run IDs。

Tool side effect 无法与 DB append 做全局事务，因此使用 intent/settlement：先落 `tool.call.accepted`，执行后落唯一 settlement；恢复时未 settlement 的调用进入 reconciliation，不得盲目重执行 mutation。

所有 projector 带 schema version。升级失败不修改原始 log。Checkpoint 是加速缓存，删除后必须能从 event replay 恢复。

## 15. 安全与多租户

- tenant、project、workspace、conversation、task、run scope 从入口显式传播；
- secret 只通过引用解析，禁止进入 prompt snapshot、memory content 和普通 event payload；
- tool/plugin/channel/evolution 使用同一 capability decision vocabulary；
- sandbox enforcement 在 executor，不依赖 prompt 或 UI 隐藏；
- audit 能关联 user/channel input → task → run → model request → tool side effect → artifact/delivery；
- benchmark gold、外部测试和未授权路径继续 fail-closed。

## 16. 迁移工作包

### WP0：规格与基线

产出 RFC/SPEC、dependency/authority matrix、关键 deterministic trajectories。完成条件：文档与 current code 差异明确，后续每个 work package 有删除条件。

### WP1：Protocol foundation

1. 创建 `@paw/protocol`；
2. 先移动 Core 与 Memory 共享的纯类型；
3. Core 移除对具体 Memory 的 dependency/re-export；
4. Agent 直接依赖 Memory 实现；
5. 增加 workspace dependency-cycle gate；
6. 保持兼容 type re-export，但不得兼容具体实现 re-export；
7. typecheck + core/memory/agent 定向 tests。

完成条件：workspace `@paw/*` 依赖图无环；Core production code 无 `@paw/memory` import；行为不变。

### WP2：Kernel authority cutover

实现 natural turn boundary、durable repair obligation、v2-only readiness/terminal、legacy result adapter，删除双 VerificationGate 权威。完成条件见 ADR-001 与 loop v2 deterministic/resume trajectories。

### WP3：Context/Memory contract migration

引入 ContextBlock/PromptSnapshot/MemoryProvider adapter；先包住现有实现，再逐步去除直接 message injection。完成条件：model-visible logged、compaction invariants、memory fail-open、on/off attribution。

### WP4：Durable Task Runtime

引入 Conversation/Task/RunAttempt、event store port、SQLite/Postgres implementations、lease/reconciliation；CLI/TUI/Desktop 逐步客户端化。

### WP5：Plugin Host

内部能力先迁移到 contribution API，再开放 project/user plugins；第三方隔离和 permission tests 同步完成。

### WP6：Automation 与 Gateway

先 attempt ledger/scheduler/worker/delivery，再 reference channel、飞书、企业微信。

### WP7：Evolution

先接现有 auto skill 计划，再做 tool description/prompt experiments；core evolution 最后。

### WP8：Legacy deletion

删除条件满足后移除 `@paw/core` compatibility re-exports、legacy TaskState completion owner、orchestrator memory/context direct wiring 和旧 AppState truth。不得按文件年龄批量删除。

## 17. 测试与放行矩阵

| 层 | 必须测试 |
|---|---|
| Protocol | typecheck、JSON round-trip、schema/version compatibility、dependency cycle |
| Kernel | deterministic trajectories、tool ordering、terminal、abort、resume、repair obligation |
| Context | prompt snapshot、budget exact edge、protected facts、compaction/replay、provider failure |
| Memory | store/governor/outbox/retrieval/lifecycle、MemoryAgentBench、on/off attribution |
| Plugin | load/unload/reload、snapshot pinning、permission denial、timeout/isolation |
| Automation | duplicate trigger、claim race、worker death、unknown、idempotent retry、cancel |
| Gateway | auth/signature、idempotency、thread mapping、attachment、delivery retry |
| Evolution | split leakage、candidate constraints、holdout、regression reject、canary rollback |
| Product | fixed complex tasks、SWE-bench、LoopsBench、Terminal-Bench、Claude paired comparison |

CI 全量失败可以按用户要求不阻塞下一研究步骤，但任何与当前改动相关的失败必须定位并记录，不能把它当无关 CI 忽略。每次提交列出实际运行命令和未运行项。

## 18. Claude Code 对比协议

1. 先冻结 Paw 自身的 10 道全新 memory-off 复杂题；开发期间不更换失败题。
2. Paw 达到绝对完成门槛后冻结 source commit、config、model endpoint/version、reasoning、timeout、network 和 scorer。
3. Claude Code CLI 使用同一 DeepSeek V4 Flash endpoint/version；若 provider 协议能力不同，记录 adapter 差异，不暗中更换模型。
4. 两臂从相同 base image/commit 启动，互不共享工作目录、历史或记忆。
5. 使用 official tests/scorer；Paw 内部 completed 不算 resolved。
6. 报每题 paired outcome、失败分类和资源，不只报平均。
7. 调优只使用 exposed development traces；最终 holdout 一次性运行。
8. 若 Paw 落后，先用轨迹定位 harness/kernel/context/tool 问题，提出可证伪架构假设，再改动；禁止 task-specific patch。

## 19. WP1 第一切片的精确范围

本次开始实施的切片只做：

- 新建 `packages/protocol`；
- 将 `MemoryRecord` 与 `ProjectMemory` 的纯 contract 移入 protocol，Memory 包 re-export 同一类型；
- Core system prompt 改依赖 protocol 类型；
- Agent 的 `SessionMemoryStore/loadProjectMemory/SessionMemory` 改为直接从 `@paw/memory` 导入；
- Core 移除 Memory 具体实现 re-export 与 `@paw/memory` dependency；
- 新增 workspace dependency cycle 检查脚本并接入一个显式命令；
- 更新 root typecheck 以包含 protocol；
- 不移动 Memory 当前使用的 Core token/fs/run-event utilities，不改变 runtime 行为。

本切片完成时 `memory -> core` 暂时仍存在，但 `core -> memory` 已消失，因此 package cycle 被打断。后续切片再按职责把 RunEvent 移到 protocol、token 能力移到 port、fs/threat/path 工具移到 runtime/util；不能把有 IO 的实现塞进 protocol 只为追求一次性“零依赖”。

## 20. 完成定义

SPEC 的实现完成不等于所有文件改名，而是：目标不变量在代码、测试、运行轨迹和部署中同时成立；旧权威与兼容层按删除条件消失；Paw 在固定公共和真实任务上先独立可靠，再在同一 DeepSeek V4 Flash 下对 Claude Code CLI 取得可复现的 paired 优势；记忆、企业渠道、自动化和受控自进化在长时间运行中不牺牲正确性、安全和可恢复性。
