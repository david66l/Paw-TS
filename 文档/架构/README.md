# Paw 新架构文档入口

> 更新时间：2026-08-21
> 当前代码基线：`main@07e92bf` 加 Paw Next 阶段 1/2、阶段 3 Context/Session/持久 Inbox、Fresh 与已知运行身份的受控产品组合入口、跨进程 fenced FileRunSession、租约心跳、生命周期修复、Agent Loop 启动归约、工具副作用检查点 canonical 分配与物理隔离、一次性零写分类/单候选启动扫描、严格工作区产品 Profile/Resolver、显式 CLI 一次性恢复命令，以及 Durable JSON Payload Store、canonical binding 投影与 location-aware Session CAS 地基的未提交工作树

这份索引是新架构文档的唯一入口。架构愿景、当前实施、Loop 状态机、决策记录和实施事实分别归档，避免同一规则在多份文档中各写一版。

## 文档分工

| 文档 | 唯一职责 | 当前地位 |
|---|---|---|
| `RFC-003-Paw-Next-单运行时与Agent-Loop-Engineering.md` | Coding Agent 核心重构方向：Pi 式简洁内循环、OpenCode 式可靠输入交付、产品级工具/权限、Paw 安全底座、外层策略与 benchmark 外移 | Accepted for staged implementation；阶段 1/2 已完成，阶段 3 地基和 Fresh/Existing 受控产品接线已落地，尚未授权生产切换 |
| `RFC-004-Paw-Next-上下文与记忆联合架构.md` | 统一说明 Journal、工作上下文、任务笔记与长期记忆如何分工；冻结 Memory 进入新 Runtime 的读取、写入、版本和迁移边界 | Accepted for staged implementation；Context M0 第 1–4 项、任务检查点地基和崩溃安全蒸馏事务已落地，自动范围选择、位置保持型对话压缩与 Memory M1 尚未开始，不改变当前生产入口 |
| `Paw-Next-Memory-Plugin-实施日志.md` | 记录 Memory M1 插件接入、冻结配置、Journal receipt、验证与剩余边界 | Active implementation record；2026-08-24 已完成 root-only 只读插件接线 |
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

Coding Agent 核心运行时的目标边界现在以 RFC-003 为准；RFC-002 继续负责渠道、自动化、长期记忆和平台化等更外围的长期蓝图。RFC-003 的分阶段实施授权不等于生产切流授权；旧 Orchestrator 在新链路达到恢复、上下文和端到端门槛前仍是生产入口。

## 当前冻结结论

- 不推倒整个 Paw；保留 models、harness、workspace、memory、eval 和现有 UI 资产。
- 冻结并最终替换旧 `@paw/agent` 控制中心；新 journal、纯归约器和轻量 Runtime 不得塞回旧 Orchestrator。
- 旧生产入口在切流前继续遵守 ADR-002：Provider natural stop 只产生 turn boundary，candidate/certification、`external_pending` 和 repair obligation 仍按旧 canonical state 归约；这只是迁移期旧路径约束，不能搬进 Paw Next。
- Paw Next 的通用 Agent Loop 不认识 candidate/certification。模型 natural stop 必须经过通用 ControlReducer；交互配置可以据可见输出决定完成或等待用户，空白输出不能自然完成。以后迁入自主策略时仍只能向同一个 ControlReducer 提交事实。
- `@paw/protocol` 承载唯一 canonical run journal；不承载模型、工具实现、评测或业务策略。
- `@paw/agent-loop` 只保留模型—工具内循环与六个窄端口；`@paw/runtime` 负责把模型、Harness、权限和会话能力装配成目标运行底座，完成门禁后再替换旧生产 Orchestrator。
- Journal、Task State、Working Context 与 Long-term Memory 是四种不同状态；Memory 只能通过 Context Assembler 的 typed card 槽进入模型，不能覆盖当前 workspace、测试或运行事实。
- Runtime 核心注册表默认包含读文件、编辑文件、写文件、前台命令和 run-owned 后台 Job（start/list/read/wait/kill）；Job 复用 Harness 进程管理并由 Runtime 统一清理。Job 现作为内置 Runtime Extension 接入：启动和结算写入通用 `runtime.activity_*` journal 事实，Context 将其投影为独立宿主证据，控制包装在活动未结束时阻止完成，结算落盘后 coordinator 自动唤醒同一 run。跨重启只从 journal 恢复事实、状态和 ID 高水位，不重新接管旧 PID；崩溃前未结算的 Job 会补记为 `unknown/interrupted`。Paw Next 产品组合另显式安装三个版本化的本地 Runtime 工具插件：`paw.workspace-inspection.v2` 提供 `list_dir/search/glob/git_status/git_diff/git_log`，`paw.workspace-mutation.v1` 提供有大小、目标数、路径、写权限和副作用检查点约束的 `apply_patch`，`paw.code-intelligence.v1` 提供有界的 `symbol_search/lsp`；LSP 语言服务器按文件类型从本机 PATH 启动，每次请求有硬超时并在调用结束后回收进程。插件只声明 schema、校验和分类，执行继续经过同一 Harness 权限、资源锁、事务与 journal，插件身份和工具清单进入 `registryHash`。Agent Loop 本身仍不知道 Job 或工具插件，MCP、外部插件平台、子 Agent 与 benchmark 规则暂不进入新 Runtime。
- 十道固定题是开发烟测，不是“超过 Claude Code”的公开证据。
- Automation、渠道、插件与自进化按 SPEC Future 阶段推进，不进入当前 Coding Core。

## 接下来唯一顺序

1. RFC 阶段 1 已完成：canonical journal 与简洁 Agent Loop 骨架。
2. RFC 阶段 2 已完成：真实模型、真实工具、权限、沙箱与副作用恢复适配。
3. 继续 RFC 阶段 3：journal 纯投影、工具结果回灌、完整请求 token 预算、整组裁剪、durable Session 原子批次、有来源的 typed task checkpoint、稳定边界的 crash-safe claim/settled、可验证 snapshot + tail，以及 accepted/promoted 持久 Inbox 已完成地基。单进程内 coordinator 已按 canonical workspace + session 合并 wake 并阻止跨 run 并发。当前 snapshot 证明恢复等价但尚无性能加速承诺；任务检查点只授权省略合格旧单元，自动范围选择和保留原位置的对话压缩摘要仍是后续独立切片。
4. 同一 Runtime 已通过非 benchmark 的受控 Fresh 入口跑通读文件、编辑文件、运行测试和模型收尾，并新增“调用方明确给出 workspace/session/run 与原始产品配置”的 Existing 程序入口。Existing 在同一跨进程 lease 与心跳范围内，按“身份/config → 全历史 decision replay → inline payload/权限/allocation 门禁 → fenced repair → 重读并重复全部门禁 → 权限与检查点高水位恢复 → 唯一 Agent Loop”执行。启动侧现在还具备严格零写的 Session authority 发现、committed-prefix 读取、共用产品分类器和一次性单候选 scanner：同 Session 多个可执行 run 会歧义失败，损坏/配置未知只隔离所属 Session；每次调用按稳定顺序最多执行一个候选，并把发现时的 head 与完整 inventoryHash 带入租约后重新核对。terminal/pending/不兼容前缀不抢租，busy/stale/failure 不转跑后续候选。真实双 Bun 进程回归已证明同一候选只有一个模型执行者，discovery、repair、model dispatch 和 terminal 后的进程退出也不会重复模型或结算。严格工作区 Profile/Resolver 现可从 canonical bootstrap 的 `configHash` 精确选择完整显式产品配置；它不读取 cwd/env、不自动探测 provider、不回退 Fake，并以 `{profileId,revision}` 和无明文但敏感的 credential fingerprint 绑定配置身份。密钥轮换会改变 hash，缺少匹配旧 revision/旧凭据时安全阻断。CLI main 现仅为显式 `paw-next --startup-scan --root <absolute-workspace>` 动态加载这条一次性链路，输出无原始异常/凭据的版本化报告；旧 help、默认入口与 Orchestrator 不变。Runtime 现另有独立、位置绑定的 Durable JSON Payload Store 原语、只从完整 canonical prefix 推导真实 envelope seq/origin/owner 的纯投影器，以及在最终位置完成“先验全量验证→prepare→冻结重验→fenced CAS”的无状态 Session decorator；source 与 materializer 的 canonical workspace/session/run 必须一致，且 decorator 不维护第二 journal 或 origin 索引。Runtime 同时已落地只对一个 exact prefix 有效的 issued `VerifiedCanonicalPayloadIndexV1`：它 exact 绑定 canonical workspace/session/run、tail、prefix digest 和总读取预算，按 canonical binding 去重验证/计费，lookup 必须提供精确 carrier location/owner 与原 payload；它不持久化、不跨 tail 缓存、不从 artifact 目录推权威。Cursor 与 Recovery 现已通过 provider-neutral ModelResponse evidence 消费这份 exact-prefix 证据；JournalContext、Task Checkpoint 蒸馏恢复和最终 assistant text 也已按 exact snapshot + carrier location 消费同一证据，artifact 不得回退 payload-only resolver。Runtime 还已冻结唯一 file-payload aggregate policy，exact 绑定 codec、store 单件上限、全前缀读取预算、canonical binding、location-aware Session 与 materializer 版本。CLI 内现已有完全独立的 Manifest V2 身份构造/哈希 API 与严格 Profile V2。新 catalog 只在显式 V1/V2 sources 上建立全局唯一 declared-configHash 索引，精确命中后才读 named workspace credential、构造单一版本并重算 manifest hash，不回退/猜测。V2 resolution 保留完整冻结 payload policy 和 Manifest V2，但它同时含真实 model/API key，只能作为进程内敏感对象，绝不得序列化进 scanner/report。Composition/scanner/main 仍未导入 catalog 或选择 V2，因此产品链仍是 inline-only。它也不是常驻或默认自动恢复，不接 TUI/Desktop/API；终局后的 pending/new-work 输入、旧格式在线迁移、profile authoring、snapshot v2、真实 provider/工具及断电 E2E 仍须后续实施。旧 Orchestrator 继续只读对照，尚未切流。
> 2026-08-21 状态更正：上项末尾“Composition/scanner/main 仍未选择 V2、产品链仍是 inline-only”已经过期。当前显式 V2 Fresh/Existing 已使用 file-payload，programmatic catalog scanner 已按 V1/V2 exact configHash 路由；CLI main 在保留旧 V1 gate 的同时，新增隐藏、显式、一次性 V2-only `paw-next --startup-scan-v2 --root <absolute-workspace>`。旧 help/default/Orchestrator 仍不切流，只有默认与旧 V1 产品链继续 inline-only。V2 resolution 仍含真实 model/API key，只能在受信进程内传递，禁止序列化；当前也仍无 live provider smoke、默认切流/daemon、TUI/Desktop/API、显式离线迁移或断电 E2E。Recovery snapshot v2 现已以 Session authority 事件线性化，但仅作 canonical prefix cache，原始 journal refs 仍须全部存在且逐字节哈希匹配。
> 2026-08-21 BW-B1 状态更正：显式离线 legacy seam 现已落地，但范围故意仅限旧 Core unversioned JSONL + AppState 的严格只读证据导出。两份来源即使配对也只是 `paired_unbound`；bundle 固定 `continuable:false`，不收集 sidecar、不升级 V1/V2/V3 身份、不生成可执行 journal。早期 FileSession 无冻结 parser 时不猜版本。真实 provider、强杀/断电与默认切流仍未完成。
> 同日 BV-A 状态：Protocol/Agent Loop 已新增同一 journal 内的 canonical work-segment marker 与唯一 interactive reducer v2；旧段终局不再必然污染新段，且 turn/call/checkpoint 仍保持全 run 单调。该能力目前只是协议/reducer 地基，尚无产品级持租约开段入口，也未接现有 V1/V2 Profile/Manifest/scanner/CLI；因此旧产品仍继续报告 blocked_pending/blocked_unconsumed，不会自动消费 terminal 后输入。
> 同日 BV-B1 状态：Agent Loop 已新增 exact-prefix 纯开段 planner，Runtime 已新增调用方持租约下的单次 expected-tail CAS 事务；它只绑定 exact FIFO queue input，冲突后重读同一 input，并通过真实 LocationAware/FileSession seam 证明 accepted artifact attachment 在 promotion 中复用同 ref/binding、零二次 prepare。该原语尚未接产品身份、composition、Existing/scanner/CLI；Context/Inbox/final/checkpoint 的 segment 消费语义仍在 BV-B2，旧 V1/V2 产品行为不变。
> 同日 BV-B2 状态：Runtime 已用一个非持久的 latest-segment boundary 纯投影收口 Inbox、latest assistant、JournalContext 与 checkpoint stable frontier。Context 仍保留全历史且 marker 不成正文；新段无模型时 final 不回退；pre/post-marker pending steer 按 accepted 顺序清账，queue 仍只由显式开段事务处理；checkpoint/run_rule/turn/call/effect high-water 继续全 run。该能力尚未接新的严格产品身份与 composition/scanner/CLI，旧 V1/V2 行为不变。
> 同日 BV-C1 状态：CLI 内已新增完全独立的 Manifest/Profile V3 与三代 aggregate catalog identity，固定 interactive reducer v2、work-segment policy v1、段/总模型预算和完整 file-payload policy；V1/V2 known hash 与 API 不变，三代只按全局唯一 configHash exact resolve。V3 尚未接 composition/scanner/main，不能据此宣称 segment-capable 产品已运行。
> 同日 BV-C2a 状态：V3 已新增受控 Fresh/Existing 程序入口，从 attempt 起真实使用 reducer/state v2 与 file payload，并在 repair 前后重建 exact evidence、重跑全部门禁。已持久化 marker 的活动段可在后续 queue backlog 存在时优先恢复，backlog 不会被自动 promoted；当前段 terminal 后 pending 仍阻断。V3 尚未接显式 new-work、scanner/startup CLI/main，旧 V1/V2 语义不变。
> 同日 BV-C2b 状态：V3 已新增 known-run 显式 new-work 程序入口，在一次 fenced scope 内完成 strict request、全门/repair、exact FIFO queue accept、原子 marker/promotion 与单段 Loop。附件外置后的同 ID 重试由 Runtime exact evidence 做逻辑幂等，预算/FIFO/steer/旧段冲突都在 accept 前拒；普通 pending 仍不是授权，scanner/main 尚未接 V3 或自动开段。
> 同日 BV-C3a 状态：现有唯一 programmatic catalog scanner 已扩展为 V1/V2/V3 exact 路由，并新增双锚 discovered V3 Existing。V3 terminal/pending/unconsumed/no-marker continue 严格只读；只有 durable marker 活动段或 open lifecycle repair 是候选。发现 evidence 不跨 lease/tail，候选只携 resolution 与 head/inventory 锚；scanner/main 仍无 accept/start/new-work，且尚未提供 V3 startup CLI。
> 同日 BV-C3b-A 状态：CLI main 新增独立、隐藏、显式、一次性 V3-only `paw-next --startup-scan-v3 --root <absolute-workspace>`。它只构造 V3 catalog 并调用一次唯一 scanner，报告不含 workspace/path/raw error/resolution；terminal pending 仍只读，不具有 accept/start 能力。旧 V1/V2 gate、help/default 不变，显式 V3 new-work CLI 仍未实现。
> 同日 BV-C3b-B 状态：CLI main 另增独立、隐藏、显式、一次性 V3 known-run new-work gate。Workspace/session/run/input/caller 身份严格来自 argv，正文只从限长 byte stdin 的 exact `{content}` 读取；V3 committed bootstrap/configHash exact resolve 后只调用一次既有产品入口。报告不含 root/caller/body/assistant/state/credential/model/raw error；无 scanner、附件/file input、后台重试或默认切流。
> 2026-08-24 Memory M1 状态更正：Paw Next V3 现可通过可选 `@paw/memory-plugin` 在 root composition 接入现有 Memory v2 只读召回；task/work-segment query、成功/降级/失败/关闭 receipt 与实际 cards 都进入 canonical Journal，Context 只从 settled receipt 注入低权限 typed evidence。Runtime/Agent Loop 源码未导入 Memory，child 不继承，自动写入与 M2 生命周期仍未启用。详见 `Paw-Next-Memory-Plugin-实施日志.md`。

5. 通过兼容、恢复与真实 Coding 任务门禁后切生产流量，再删除 v1/v2 旧运行时。
6. Coding Core 达标后，再建设 Automation、渠道、插件和外部 Evolution Supervisor。

## 文档维护规则

- 新架构需求先改 SPEC 的阶段范围；跨模块不可逆决定新增 ADR。
- 不在 RFC、SPEC 和进度日志三处复制同一详细 schema；只链接权威定义。
- 每个实施切片必须记录基线 commit、改动范围、测试命令/结果、已知风险和下一步。
- 文档中的 `MUST/必须` 只有在明确标为 Active 的范围内阻塞提交；Future 只约束边界。
