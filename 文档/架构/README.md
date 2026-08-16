# Paw 新架构文档入口

> 更新时间：2026-08-16
> 当前代码基线：`main@07e92bf` 加未提交 WP1a 工作树

这份索引是新架构文档的唯一入口。架构愿景、当前实施、Loop 状态机、决策记录和实施事实分别归档，避免同一规则在多份文档中各写一版。

## 文档分工

| 文档 | 唯一职责 | 当前地位 |
|---|---|---|
| `RFC-002-Paw-Real-World-Agent-Platform.md` | 长期产品与平台蓝图，说明最终要去哪里 | Proposed，非当前全部开工项 |
| `SPEC-001-Paw-Platform-Refactor.md` | 当前及下一阶段唯一实施路线、完成定义与放行门 | Active；只有 P0–P2 当前生效 |
| `../coding-agent-loop-kernel-v2.md` | Loop v2.1 的事件、状态、reducer、tool settlement、candidate/repair/replay 契约 | Active migration contract |
| `ADR-001-Loop-Authority.md` | Safety、Effect、Evidence、Behavior Advisor 的权限边界 | Accepted；completion 条款被 ADR-002 取代 |
| `ADR-002-Run-Completion-and-Certification-Authority.md` | Natural stop、Candidate、Certification、Reducer 与 legacy terminal 的唯一权威决定 | Accepted |
| `../记忆机制spec-v2/实施进度日志.md` | 已发生的代码、测试、审计、提交事实 | 只记事实，不再定义架构 |

## 冲突处理

如果文档冲突，按以下规则处理：

1. ADR-002 决定 completion/certification/natural-stop 权威；ADR-001 决定 safety/effect/advisor 权威。
2. SPEC-001 决定什么现在生效、按什么顺序实施、怎样验收。
3. Loop v2.1 细化状态机和 replay 契约，但不得违反 ADR；冲突时先修文档再改代码。
4. RFC-002 只描述长期目标，不能越过 SPEC 提前启动 Future 模块。
5. 实施进度日志只记录证据，不能通过“日志里曾写过”改变现行契约。
6. 旧 SPEC、旧 Loop 版本和历史研究只能作为 provenance，不得被实现引用为当前规范。

## 当前冻结结论

- 不推倒整个 Paw；保留 models、harness、workspace、memory、eval 和现有 UI 资产。
- 重写 `@paw/agent` 内部控制中心：append-only journal + pure ControlReducer + thin runtime。
- Provider natural stop 只产生 turn boundary；只有结构化 `candidate.submit` 提出候选。
- Certification 只产事实；ControlReducer 是唯一状态转换者；legacy 只能单向投影。
- `external_pending` 是可恢复非终态；只有 resolved/rejected 后才产生唯一 RunOutcome。
- Repair obligation 是 durable canonical state，无关操作和 prose 不能清除。
- `@paw/protocol` 当前只做 WP1a 极小 compat 解环，不扩张成万能公共包。
- 十道固定题是开发烟测，不是“超过 Claude Code”的公开证据。
- Automation、渠道、插件与自进化按 SPEC Future 阶段推进，不进入当前 Coding Core。

## 接下来唯一顺序

1. 合并 P0 文档契约。
2. 完成并单独提交 WP1a。
3. 实现 journal + pure reducer 的最小垂直切片。
4. 切 natural turn boundary 与 durable repair obligation。
5. 切 explicit candidate、certification facts 和 reducer terminal。
6. 旁路旧 VerificationGate/CompletionPolicy，固定十题持续回归。
7. Coding Core 达标后，再建设统一 TaskRuntime、Automation、reference webhook/飞书。
8. 用真实消费者收敛插件 API，最后建设外部 Evolution Supervisor。

## 文档维护规则

- 新架构需求先改 SPEC 的阶段范围；跨模块不可逆决定新增 ADR。
- 不在 RFC、SPEC 和进度日志三处复制同一详细 schema；只链接权威定义。
- 每个实施切片必须记录基线 commit、改动范围、测试命令/结果、已知风险和下一步。
- 文档中的 `MUST/必须` 只有在明确标为 Active 的范围内阻塞提交；Future 只约束边界。
