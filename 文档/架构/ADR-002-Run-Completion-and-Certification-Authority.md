# ADR-002：Run Completion 与 Certification 单一权威

- 状态：Accepted
- 日期：2026-08-16
- 适用版本：`paw-loop-kernel-v2.1` 及后续
- 取代范围：取代 ADR-001 中“CompletionPolicy 是唯一终局权威”及 explicit-v2 仍由现有 CompletionPolicy 映射终局的条款

## 背景

Paw 当前存在三种相互冲突的完成语义：旧 `CompletionPolicy` 汇总并生成 `RunResult`；Loop v2 的 Candidate Certification 可直接进入 terminal；平台 SPEC 又要求 Kernel reducer 拥有状态转换权。自然停止还会在当前代码中被转换为候选，导致 provider 协议、候选意图、认证事实和公共结果互相代替。

这不是命名问题。只要多个组件能写 terminal，resume、replay、external verification、legacy UI 和未来 automation worker 就可能观察到不同结果。

## 决策

### 1. ControlReducer 是唯一状态转换者

`ControlReducer` 是纯函数，只消费已经进入 Run Journal 的版本化 input fact，并产生新的 canonical `ControlState`、可审计 `decisionEvents` 与 effect intents。只有它可以转换 RunAttempt、Candidate、repair obligation 和 terminal 状态。Decision events 由 runtime 追加但不回馈成新输入；replay 必须重算并核对，避免产生第二个写入者。

```text
producer / executor ── fact ──► Run Journal ──► ControlReducer
                                                │
                                                ├─ canonical state
                                                └─ effect intents
```

Runtime 执行 effect 后必须把 settled 结果追加成新 fact；不得绕过 reducer 直接修改 canonical state。

### 2. Certification 只产事实

| 组件 | 可以做什么 | 明确禁止 |
|---|---|---|
| Provider adapter | 产 turn stopped / failed fact | natural stop 创建 candidate 或 terminal |
| Candidate adapter | 将结构化 `candidate.submit` 产成 fact | 宣告完成 |
| Readiness evaluator | 产 pending effect、artifact、verification、acceptance gap facts | 写 terminal |
| Semantic reviewer | 产结构化 finding | 伪造测试通过或 terminal |
| External verifier | 产 pending/resolved/rejected fact | 直接改 RunResult |
| Safety / Tool executor | 产 approved/rejected/settled/mutation facts | 以工具成功代表任务完成 |
| Memory / Context / UI | 提供候选输入或消费投影 | 成为任务真相或反写状态 |
| ControlReducer | 消费事实，产生 state/effects/outcome | 执行 I/O 或从 prose 猜事实 |

Certification 是事实生产流水线，不是第二个状态机。`certified` 只表示一组绑定 candidate/revision 的事实满足规则。Reducer 可以进入非终态 `external_pending` 等待外部事实；只有 `completed`、`incomplete`、`failed` 或 `aborted` 产生唯一 terminal outcome。

### 3. Natural stop 是 turn boundary

Provider 返回普通 stop 且没有 pending tool 时：保存 assistant message，追加 `provider.turn_stopped`。它不隐式创建 candidate。Reducer 可根据预算、open obligation、用户等待和最近进展发出 `CallModel`、`RequestUserInput` 或有界 `EmitIncomplete`。

Candidate 只能由结构化 `candidate.submit` 提出。迁移期 legacy `final_answer` 只能单向适配成这个控制动作，不能保留特殊完成权威。

### 4. Repair obligation 是 canonical durable state

Readiness/certification gap 由 reducer 打开 `RepairObligationV1`。只有匹配 revision、scope、runner 和满足谓词的 settled fact 可以解除。Prose、无关操作、重复只读结果和错误 runner 不构成修复。Resume/replay 必须保持 obligation identity 与状态。

### 5. Legacy 只能单向投影

Canonical `RunOutcomeV2`、ControlState 和 journal facts 可以投影为旧 `RunResult`、TaskState、Plan/Todo 和 UI status。旧 `CompletionPolicy` 在迁移期只能作为 projection/compat renderer，不能接收自己的事实源，也不能把结果反写 reducer。

```text
canonical state ──► RunOutcomeV2 ──► legacy RunResult / UI / telemetry
       ▲                                      │
       └────────────── 禁止反写 ──────────────┘
```

`external.rejected` 的 canonical 映射统一为 `executionStatus=incomplete`、`reasonCode=external_rejected`，同时保留正交字段 `externalVerification=rejected`。

### 6. Journal 是权威输入边界

凡是会改变 reducer 决策的模型响应、tool settlement、mutation、verification、review、external result、budget、cancel 和 user reply，必须先追加到同一 Run Journal。Checkpoint/AppState 只是可丢弃 projection。相同 journal 重放必须得到相同 state、effects 与 terminal outcome；矛盾记录必须判 corruption，不能猜测修复。

## 迁移规则

1. 先 characterization 当前 natural-stop、candidate、Certification、VerificationGate 和 CompletionPolicy 调用图。
2. 引入 journal schema、纯 reducer 和 shadow replay，不改变 v1 行为。
3. explicit-v2 将 natural stop 切为 turn boundary。
4. 引入 durable repair obligation，并用错误动作/无关成功/resume/revision 夹具验证。
5. 接入 explicit `candidate.submit` 与 deterministic readiness facts；legacy `final_answer` 在此处单向映射为该动作。
6. 将 semantic review、external verification 改成 fact producer。
7. Reducer 生成唯一 `RunOutcomeV2`；legacy 单向投影。
8. v2 readiness 后旧 `VerificationGate` 调用必须为 0；旧 CompletionPolicy 的 terminal 写入必须为 0。
9. 删除旧权威前保留显式 feature flag 与至少一个发布周期的回退证据。

## 验证条件

- natural stop 不创建 candidate；
- explicit candidate 才调用 readiness/certification；
- certification producer 无 terminal 写权限；
- wrong action 和 unrelated successful tool 不解除 obligation；
- replay/resume 的 state/effect/outcome hash 一致；
- 每个 attempt terminal transition 恰一次，重复 fact 幂等；
- external rejection 只有一个 canonical outcome；
- legacy adapter 故障不能改变 canonical outcome；
- v2 路径旧 VerificationGate/CompletionPolicy terminal 调用次数为 0。

## 影响

短期会增加 journal fact 与兼容投影代码，并要求重写一部分旧测试；收益是完成语义、恢复语义、自动化重试和多入口展示拥有同一事实基础。该 ADR 不要求立刻拆新 npm 包，也不授权提前实现 Gateway、Plugin Host、Automation 或 Evolution。
