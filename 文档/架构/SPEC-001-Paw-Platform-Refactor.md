# SPEC-001：Paw Coding Agent Platform 渐进式改造规格

> 状态：Active（第 3–7 节约束当前 P0–P2；第 8–12 节为 Future）
> 版本：1.1.1
> 日期：2026-08-16
> 代码基线：`e935feb`（WP1a 已完成；进度日志提交为 `3009665`）
> 上位蓝图：`RFC-002-Paw-Real-World-Agent-Platform.md`
> Loop 契约：`coding-agent-loop-kernel-v2.md`（v2.1）
> 权威决策：`ADR-002-Run-Completion-and-Certification-Authority.md`

## 1. 本规格解决什么

Paw 的长期目标不变：成为能服务真实场景的 coding agent，具备可靠 harness、长任务 loop engineering、受控自进化、自动化任务、飞书/微信等渠道，并尽量插件化。

当前阻碍不是缺少平台功能，而是现有 `AgentOrchestrator` 同时承担模型调用、上下文、记忆、工具、安全、恢复、候选认证和终局，Loop v2 又嵌在旧 `final_answer → VerificationGate → CompletionPolicy` 外壳里。继续直接增加 Gateway、Scheduler 或 Plugin Host，只会扩大双重状态和权威混杂。

因此本规格采用两层语义：

- **Active**：只约束当前 Coding Core 收权和 WP1a；其中“必须”是当前放行条件。
- **Future**：约束长期平台演进的边界，但不阻塞当前 Coding Core，也不授权提前冻结公共插件 API。

RFC-002 是长期方向，不是当前所有模块同时开工的命令。若 Active 范围要扩大，必须先满足上一阶段完成定义并修改本规格版本。

## 2. 代码事实与保留策略

### 2.1 必须保留的资产

- `@paw/models`：多 provider、流式响应、native tool call、重试和熔断。
- `@paw/harness` 与 `@paw/workspace`：工具、MCP、审批、Shell guard、sandbox、effect audit、managed jobs、文件/Git/LSP/code-index。
- `@paw/core`：Run events、SessionStore、AppState、checkpoint、context prune/compact/archive、system prompt。
- `@paw/memory`：MemoryRuntimeV2、Postgres store、outbox、governor、retrieval、lifecycle 和评测。
- `@paw/eval`：SWE/Claude 对比、trace、artifact、memory adversarial。
- CLI、TUI、Desktop 三个入口及现有产品能力。

### 2.2 必须替换的控制中心

`packages/agent/src/orchestrator.ts` 是约 4,600 行的 god object，`PhaseContext` 是 service locator，`TurnFlags` 保存了影响行为的隐式状态。改造只替换 Agent 内部控制中心，不推倒上述资产：

```text
Model / User / Tool / Verifier
            │ facts
            ▼
Append-only Run Journal
            │
            ▼
Pure Control Reducer ── effect intents ──► Thin Runtime
            │                                  │
            └──── canonical ControlState ◄─────┘
                         │
          projections / adapters / UI / memory
```

初期这些是 `@paw/agent` 内部模块，不要求立即拆成 `@paw/kernel`、`@paw/runtime`、`@paw/coding` 三个包。逻辑边界先成立，只有出现独立消费者和稳定接口后才拆包。

## 3. 当前架构不变量

### I1：唯一状态转换者

RunAttempt、Candidate 和 terminal 状态只能由纯 `ControlReducer` 转换。Certification、Verification、Safety、Tool Executor、Model Adapter、Memory 和 UI 都只产事实或消费投影，不能直接写终局。

### I2：provider stop 只是回合边界

普通 `provider.stop` 且无 pending tool 只产生 `turn.boundary`。停止文本保存为 assistant message，不得从 “done / let me / next” 等 prose 猜 candidate。Candidate 只能来自显式、结构化的候选意图并归一化为 `candidate.submitted` fact；首个切片只保留 legacy `final_answer` 的单向适配，native `candidate.submit` 工具等出现第二个真实入口后再引入。

### I3：单一事实流

影响控制行为的事实先追加到 Run Journal，再由 reducer/projector 消费。AppState 是 checkpoint/projection，不是第二事实源；丢失后必须能由 checkpoint + journal 重建。相同 journal 重放必须得到相同 state、effects 和 outcome。

### I4：工具必须完整结算

每个模型工具调用必须得到 `completed | failed | rejected | cancelled`。只读调用可并行；mutation、Shell、未知 effect 和需要审批的调用默认 exclusive；barrier 覆盖 effect settle、journal append 和 projector commit。结果按模型 call order 进入上下文。

### I5：repair obligation 是 durable state

Repair obligation 不是 prompt nudge 或内存 flag。首版只支持 `direct_verification` 与 `material_change` 两类，并绑定创建 revision 及必要的 runner/scope；只有匹配且已 committed/settled 的事实能解除。prose、重复 read、无关成功命令不能解除。

### I6：当前 revision 的证据才有效

Mutation revision、execution-environment revision、verification 和 candidate identity 必须关联。源码或执行环境变化后，旧证据按明确规则 stale/superseded，不能覆盖新状态。

### I7：协议层保持极小

`@paw/protocol` 只放跨进程、JSON-safe、版本化 DTO/ID/event envelope。它不得依赖任何 `@paw/*`、Node/Bun、DB 或 provider SDK，也不得承载 Agent 内部 service object。

### I8：model-visible means reproducible

当前 reducer 垂直切片只要求保存稳定的 prompt、model、tool schema 与 adapter 版本引用/hash，使同一事实流可定位到同一调用配置。最终 rendered request、完整 tool schemas、response format 和全部模型参数在 P2 的 Context/Model Adapter 切片补齐；不得为此阻塞第一版 reducer。

### I9：安全权威不下放

Tool Safety/Authority 可以拒绝工具，但不能伪造完成；插件、渠道或模型不得绕过 executor 的 filesystem/network/process/secret/sandbox/approval 决策。

### I10：live run 不热变更

一个 RunAttempt 当前固定 loop authority、model adapter/profile、tool schema、memory mode 与 evaluator/scorer 版本。更新只影响新 attempt。Plugin/skill version lease 属于 Future，不进入当前 ControlState。

## 4. Active Coding Core 契约

### 4.1 最小 ControlState

```ts
interface ControlStateV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status:
    | "running"
    | "awaiting_user"
    | "candidate"
    | "certifying"
    | "repair_required"
    | "completed"
    | "external_pending"
    | "incomplete"
    | "failed"
    | "aborted";
  readonly turn: number;
  readonly consecutiveNoActionStops: number;
  readonly phase: "discover" | "implement" | "verify" | "repair" | "candidate";
  readonly goalHash: string;
  readonly mutationRevision: number;
  readonly environmentRevision: number;
  readonly pendingEffects: readonly string[];
  readonly openRepairObligation?: RepairObligationV1;
  readonly currentVerificationRefs: readonly string[];
  readonly candidate?: CandidateIdentityV1;
  readonly terminal?: RunOutcomeV2;
}
```

Goal/acceptance 原文、假设、证据、diff 和大体积 artifact 通过稳定引用关联，不全部复制进 ControlState。

`external_pending` 是可恢复的非终态：此时 `terminal` 必须为空，可以等待 `external.verification_settled`。只有 `completed | incomplete | failed | aborted` 会产生唯一 `terminal.emitted` 和 `RunOutcomeV2`。

### 4.2 Fact、State 与 Effect

首批输入事实至少包括：

- `turn.started`、`provider.turn_stopped`、`provider.failed`；
- `tool.scheduled`、`tool.settled`、`mutation.committed`；
- `verification.observed`、`candidate.submitted`；
- `readiness.evaluated`、`review.completed`、`external.verification_settled`；
- `user.replied`；
- `budget.reached`、`cancel.requested`。

Reducer 形态固定为纯函数。第一版只返回下一状态与 effect intents，不再把 input facts、decision events 和 ControlState 持久化成三套真相：

```ts
reduce(state: ControlStateV1, fact: ControlFactV1): {
  readonly state: ControlStateV1;
  readonly effects: readonly ControlEffectV1[];
}
```

Runtime 先追加输入 fact，再调用 reducer 并发布 state/checkpoint，最后执行 effects。若 effect 会产生不可逆外部副作用，runtime 必须先把对应 intent/dispatch 事实写入同一 journal；这属于 effect 交付协议，不是第二套 reducer 决策日志。`repair opened/satisfied` 等可由 state transition 重放得到，只能作为 trace/projection。Effect 只表达意图，如 `CallModel`、`ExecuteTools`、`RequestUserInput`、`RequestCertification`、`EmitTerminal`。Runtime 执行后必须把结果作为新 input fact 写回，不得直接改 state。

### 4.3 Candidate 与 Certification

1. `provider.stop` → `provider.turn_stopped` → reducer 决定继续、等待、incomplete 或处理显式 candidate；不会自动创建 candidate。
2. `candidate.submitted` 只表达模型完成意图，不证明已完成；首版事实由 legacy `final_answer` 单向适配产生。
3. deterministic readiness 产事实：pending effects、open obligation、artifact、current verification、acceptance gap。
4. semantic reviewer 产结构化 finding，不能把测试标绿。
5. external verifier 只产 settled fact。
6. reducer 消费事实并转换到 repair/completed/external_pending/incomplete；进入 `external_pending` 时不生成 terminal。
7. v2 路径 readiness 后调用 legacy `VerificationGate` 的次数必须为 0。
8. 每个 attempt 最多一次 terminal transition；external resolved/rejected 后才可能产生该 transition，重复事件/replay 幂等。

`external.rejected` 统一由 reducer 转成 `incomplete/external_rejected`；不再同时维护 `rejected` 和 `incomplete` 两套终态词汇。

### 4.4 Repair obligation 转换

```ts
type RepairObligationV1 =
  | {
      readonly kind: "direct_verification";
      readonly id: string;
      readonly openedAtSeq: number;
      readonly revision: number;
      readonly runnerFamily: string;
      readonly scope: readonly string[];
    }
  | {
      readonly kind: "material_change";
      readonly id: string;
      readonly openedAtSeq: number;
      readonly afterRevision: number;
      readonly scope?: readonly string[];
    };
```

- 错误动作或无关成功：obligation 保持 open。
- 匹配的直接验证执行但 `code_failed`：可以关闭“需直接验证”，同时打开“需 material repair”。
- 新 mutation 使旧验证 stale；obligation 由 reducer 明确 supersede 或迁移，不能静默消失。
- resume 后 obligation id、revision、scope 和满足状态必须一致。

### 4.5 Context 与 Memory

Context Assembler 是模型输入唯一入口；MemoryAdapter 只能提供候选块。Memory 不拥有当前任务真相，不保存 repair/completion authority。Memory provider 故障必须可降级为 memory-off，并记录 failure class。

Compaction 不得重写 goal、acceptance、当前 revision、open obligation、current verification 或安全约束；大输出存 artifact，summary 只引用。

### 4.6 Journal、Checkpoint 与 legacy

- Journal append 与 reducer transition 有稳定 seq/idempotency key。
- Checkpoint 只缓存 projection；恢复先验证 schema/hash，再重放 journal。
- 未知 Shell/后台副作用不能猜已完成；Active Run 统一进入 `incomplete/side_effect_unknown` 并要求人工 reconciliation。Future Automation Attempt 的 `unknown` 是另一层状态，不混入 RunOutcome。
- `RunOutcomeV2` 是 canonical outcome。
- legacy `RunResult`、TaskState、Plan/Todo 和 UI status 只能从 canonical state 单向投影。
- legacy adapter 失败只影响兼容展示，不能反向改变 outcome。

## 5. WP1a Protocol 解环契约

WP1a 只做小型兼容解环：

- 创建 `@paw/protocol`；
- `core → memory` 消失，manifest 图无环；
- Core 不再 re-export Memory 具体实现；
- Agent 直接依赖 Memory 实现；
- 当前共享结构改名 `LegacyMemoryRecordV1` 与 `LegacyProjectMemoryV1`，标记 `compat/internal`；
- `memory → core` 可暂存，完整 WP1 才负责消除；
- 不把 Run、Plugin、Gateway、DB、filesystem 或 runtime service 类型顺势塞入 protocol。

Dependency gate 必须同时检查：

1. workspace manifest runtime graph 无环；
2. production source import 与 manifest 一致，禁止 barrel/re-export 绕过；
3. `@paw/protocol` 无 `@paw/*`、Node/Bun、DB、SDK import；
4. Core production source 无 `@paw/memory` import；
5. fixtures 能证明每条规则会失败。

完整 WP1 只有在 `memory → core` 也消除后才完成；WP1a 不得被表述为完整 Protocol foundation。

## 6. 测试与证据纪律

### 6.1 Deterministic gate

已有门继续覆盖：R11 验证 plain natural stop 只形成 turn boundary；R17 验证旧 verification 不覆盖新 revision；R19 验证只有 explicit candidate 才进入 readiness。新增门与 Loop v2.1 一一对应：

- R21：wrong action 不清 obligation；
- R22：unrelated successful tool 不清 obligation；
- R23：direct test `code_failed` 关闭 direct-verification obligation，同时打开 material-repair obligation；
- R24：resume 保持 obligation identity/revision/scope/satisfaction；
- R25：duplicate input fact/replay 幂等；
- R26：terminal transition 恰一次；
- R27：v2 readiness 后 legacy VerificationGate/CompletionPolicy terminal 调用均为 0；
- R28：legacy adapter 失败或冲突不能反向改变 outcome；

R29/R30（native `candidate.submit` 的 mixed-batch/barrier 语义）保留为 Future 测试，等第二个真实 candidate 入口出现后再激活，当前 reducer 切片不得为它预建工具协议。

测试必须断言 state、fact、effect、调用次数、顺序和 outcome，不能只断言 prompt 文案。

### 6.2 开发十题

现有固定十道 memory-off 复杂题只用于开发烟测和回归定位：

- 不因失败换题；
- 报 official resolved、false completion、invalid artifact、crash、token、调用数和时延；
- 题集 identity 使用 `PAW_FRESH_QUALIFICATION_RULE`（`paw-fresh-qualification-v15`）；绝对门槛使用 `packages/eval/src/swe-compare/qualification.ts` 的 `PAW_QUALIFICATION_GATE`（10 个完整样本、official resolved ≥ 7、integrity violation = 0、invalid artifact = 0）；
- P2 资格运行必须从完成代码切换后的 clean commit 重新生成同一规则 manifest，并把 manifest hash/source commit 写入结果；不得在看到成绩后修改 gate；
- 达到上述绝对门槛前，不启动平台扩张；
- 十题结果不得用于公开宣称“超过 Claude Code”。

### 6.3 正式 Claude Code 比较

正式比较必须预注册并冻结：

- 更大的公共题集和样本量/效应假设；
- 精确模型 revision、endpoint、adapter 代码/hash、全部生成参数；
- Claude CLI 版本、可执行文件 hash、flags、settings/system config；
- base image digest、repo commit、题面、egress、CPU/RAM、timeout、scorer；
- `harness-isolated`（memory-off、同资源）与 `product-default` 两条赛道；
- 每题多次独立运行，按 task/provider time block 随机化顺序；
- timeout、crash、provider failure、invalid patch 按 ITT 进入分母；
- primary endpoint 为 official resolved；资源与 false completion 为安全门；
- task-clustered paired bootstrap 或匹配二项/McNemar 置信区间。

公开“超过”要求 paired resolved delta 的 95% CI 下界大于 0，且 invalid/crash/false-completion 不超过预注册劣化界。wins > losses 但 CI 跨 0 只能称工程信号。

## 7. 当前生效工作包

### P0：文档权威收敛

产出：SPEC-001 v1.1、Loop v2.1、ADR-002。

完成条件：natural stop、completion authority、external rejection、WP1a 名称和执行顺序在全部现行文档中一致；ADR-002 明确 supersede ADR-001 的旧终局条款。

### P1：完成并提交 WP1a

按第 5 节收口 compat DTO 和更强 dependency gates，跑 protocol/core/memory/agent typecheck、cycle/import gates 和受影响 tests。单独提交，不混入 Loop 行为修改。

### P2：Coding Core authority cutover

按垂直切片推进：

1. journal schema + pure reducer + replay；
2. natural turn boundary；
3. durable repair obligation；
4. legacy `final_answer` 单向归一化为 `candidate.submitted` + readiness facts；
5. certification facts + reducer terminal；
6. legacy one-way projection；
7. 旁路旧 VerificationGate/CompletionPolicy；
8. 固定十题反复验证，不换题；
9. 第二个真实 candidate 入口出现后，再设计 native `candidate.submit` 与 mixed-batch barrier。

完成条件：第 6.1 节全绿；同 journal replay hash 一致；v2 调用旧终局 Gate 为 0；false completed=0；invalid artifact=0；固定十题达到预注册绝对门槛。

## 8. Future：统一 Task Runtime

P2 达标后，提供单一 `TaskRuntime`，让 CLI/TUI/Desktop/Eval 使用相同 task/run/session/resume/approval/event contract。Desktop 不再调用 `runStubRun()` 并解析文本；CLI 提供正式 `paw run`；`stub-run` 降为测试兼容层。

先实现单进程、单 worker、单 durable store。只有观测证明吞吐或并发不足，才引入多 worker、lease/CAS、Postgres event store 和 object store。

## 9. Future：Automation 与渠道

Automation 是 Runtime 之外的 control plane：

```text
Trigger → durable Attempt → Worker → TaskRuntime → Delivery
```

- attempt 必须先落盘再 dispatch；
- `unknown` 表示无法证明副作用，不默认自动重跑；
- 周期任务显式选择 `pinned(version)` 或 `track_release_channel(stable|canary)`；每次 attempt 保存解析后的不可变版本；
- delivery 与 coding completion 分事务，发送失败只重试 delivery；
- cron-run 不得递归创建无界 cron；
- 先 reference webhook，再飞书，再企业微信/微信。

平台 verifier 负责校验原始 bytes/signature 并产 `VerifiedInboundEnvelope`；Gateway 只执行“未验证不得准入”、auth、幂等、canonical actor/conversation mapping 和 routing，不实现各平台私有密码学。

## 10. Future：插件化

先以普通 TypeScript port 验证真实消费者：`ModelAdapter`、`ToolProvider`、`MemoryAdapter`，之后增加 `ChannelVerifier`、`ChannelAdapter`、`TriggerProvider`、`DeliveryAdapter`、`Evaluator`。至少有两个真实实现后才冻结 public Plugin SDK。

插件必须有：

- 版本化 manifest/API；
- capabilities/permissions；
- `activate() → disposer`；
- run snapshot 的 acquire/release lease/ref-count；
- draining 状态；最后 lease 释放后才能 dispose/uninstall；
- timeout/crash/isolation/secret/sandbox contract tests。

插件只能提供能力，不能获得 mutable Runtime 或 reducer 写权限。MCP 是 ToolProvider transport，不等于完整插件系统。

## 11. Future：受控自进化

自进化必须运行在 Paw 主 Run 之外：

```text
verified trajectories / feedback
  → candidate
  → redaction + provenance + license checks
  → train/development replay
  → untouched holdout
  → staged diff / PR
  → approval
  → canary release
  → stable or rollback
```

复用现有 Memory governor、trace/eval 和程序记忆，不复制第二套 skill/evolution store。Hermes 式“任务后提炼 skill”可采用，但商业默认不允许 live agent 直接改生产 skill/prompt/core 并立即加载。

风险级别：

- E0：事实/profile memory，经 Governor；
- E1：skill/SOP，staged + replay + approval；
- E2：tool description/prompt/context 参数，离线 holdout + canary；
- E3：plugin/tool code，只生成 PR 并完整测试；
- E4：kernel/authority/security，永不自动部署。

Evolution 规格还必须定义 tenant opt-out、保留期、许可来源、删除传播、污染审计、版本固定和回滚。没有冻结 eval、artifact 和回滚点的自修改路径一律禁止。

## 12. Future：商业化与多租户

多租户只在单机真实服务稳定后引入。tenant/project/user scope 必须从入口传播到 task、run、workspace、memory、artifact、secret、plugin 和 telemetry；禁止子系统重新猜 scope。目标包含 24h/72h soak、单 owner、重复事件幂等、secret 不进 prompt/memory/普通 event、越权 fail-closed 和完整 audit chain。

## 13. 推荐参考与明确不照搬

- DeepSeek Harness：借 durable event、capability seam 和 model-visible logging；不照搬 “everything is plugin” 的包规模。
- Pi：借小 loop、顺序 tool settlement 和 pure reducer vocabulary；不把未完成的新 Harness API 当成熟实现。
- OpenHands：借 automation sidecar/API 边界；不把 UI client 当 Agent core。
- OpenCode：借 provider/tool adapter 经验；不采用 arbitrary mutable hooks 作为 authority。
- Hermes：借 skills、cron、跨渠道会话和运行外 self-evolution；不采用默认自由写 skill 或 Gateway 会话拥有宿主全权限的边界。
- EvoAgent：借 candidate、validation、holdout、fingerprint、activation/rollback gate；不照搬其窄任务指标。

## 14. 冻结的下一步

严格顺序如下：

1. 合并本次 P0 文档契约；
2. 收口并提交 WP1a；
3. 在 `@paw/agent` 内实现 journal + pure ControlReducer 的最小 vertical slice；
4. 让 provider stop 只形成 turn boundary；
5. 持久化 repair obligation，并用 adversarial fixtures 证明无关动作不能清除；
6. Candidate/Certification 只产事实，由 reducer 唯一终结；
7. 旁路旧 VerificationGate/CompletionPolicy，legacy 单向投影；
8. 固定十题达到绝对门槛；
9. 再建设统一 TaskRuntime、Automation、reference webhook/飞书；
10. 以真实消费者收敛 Plugin Host；
11. 最后建设外部 Evolution Supervisor 和多租户商业化。

任何阶段都不得用增加 prompt nudge、扩大 token/step 预算、换失败题、benchmark 特判或提前搭建大平台来代替当前阶段的可证伪完成条件。
