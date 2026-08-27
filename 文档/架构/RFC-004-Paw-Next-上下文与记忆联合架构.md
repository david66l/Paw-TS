# RFC-004：Paw Next 上下文与记忆联合架构

> 状态：Accepted for staged implementation（已授权分切片实施，尚未授权生产切流）
> 日期：2026-08-20
> 面向读者：产品负责人、Paw Runtime/Context/Memory 开发者、评测维护者
> 决策主题：在 canonical journal 是唯一运行事实源的前提下，统一设计工作上下文、任务记忆和跨任务长期记忆
> 上位约束：遵守 RFC-003 的单运行时、简洁 Agent Loop、旧 Orchestrator 冻结原则
> 历史资料：`../记忆机制spec-v2/` 保留为旧 Memory v2 的设计与实施记录，不再单独决定 Paw Next 的注入和运行边界

---

## 0. 先用人话说结论

Paw 需要同时拥有完整历史、短小上下文和长期记忆，但三者不能混成一份不断增长的聊天记录。

- **事实日志（Journal）**记录真实发生了什么，完整、不可被摘要替代；
- **工作上下文（Working Context）**决定模型这一轮看到什么，短小、按需、每轮重建；
- **任务状态/任务笔记（Task State/Task Notes）**记录当前任务做到哪里，属于当前 run 的持久事实；
- **长期记忆（Long-term Memory）**保存跨任务可复用的仓库知识、经验、流程和用户偏好；
- **检索结果（Memory Cards）**只是进入本轮上下文的有来源资料，不是系统指令，也不能覆盖当前代码、测试或 journal 事实。

最重要的边界是：

> **上下文不是事实库，长期记忆不是当前任务状态，摘要也不是原始证据。**

---

## 1. 为什么上下文与记忆必须一起设计

如果只做上下文裁剪，不做记忆，长任务或跨会话任务会逐渐遗忘早期结论；如果只做记忆，不控制上下文，检索出的旧信息会与完整历史一起挤占模型注意力，甚至把过期经验当成当前事实。

这两部分的关系应当是：

```text
Canonical Journal（完整运行事实）
       │
       ├── 当前任务状态归约（当前进度、验证、未决事项）
       │
       ├── Context Need 提取（这一轮需要什么信息）
       │       │
       │       └── Memory Retriever（按需查询长期记忆）
       │                  │
       │                  └── Memory Cards（带来源、版本和适用性）
       │
       └── Context Assembler（在硬预算内组装本轮请求）
                          │
                          └── Model

稳定边界上的 Journal 事实
       └── Memory Writer（候选提取、验证、治理、持久化）
                          └── Memory Store
```

Context 读取 Memory，但不能直接修改 Memory；Memory Writer 读取 Journal，但不能修改 Journal。两者通过版本化数据契约连接，不共享可变聊天历史。

---

## 2. 外部研究与工程证据

### 2.1 长上下文不等于有效上下文

《Lost in the Middle》发现，模型对上下文开头和结尾的信息利用通常更好，对中间信息的利用会明显下降；扩大窗口并不自动改善这种问题。工程结论是：不能把“能放进去”理解为“模型能可靠使用”。

来源：<https://arxiv.org/abs/2307.03172>

Anthropic 将上下文视为有限的注意力预算，建议选择“最小但高信号”的 token 集合，并把即时检索、压缩、结构化笔记和子任务隔离作为长任务的主要手段。

来源：<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

### 2.2 完整历史应留在外部，工作窗口只放当前所需

MemGPT 用操作系统的分层存储解释长程 Agent：小而快的上下文相当于工作内存，大而慢的外部存储按需换入。

来源：<https://arxiv.org/abs/2310.08560>

OpenCode V2 的会话设计也保留完整 durable transcript，只在模型视图中使用已完成的压缩 checkpoint；压缩失败不改变原历史，且完整工具调用与结果不能被拆开。

来源：<https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md>

### 2.3 长期记忆必须支持时间、更新和拒答

LongMemEval 将长期记忆能力拆成信息提取、跨会话推理、时间推理、知识更新和无证据时拒答。其实验表明，整段长历史直接送入模型常明显弱于只提供相关证据；按轮次拆分、扩展检索键和时间感知查询可改善效果。

来源：<https://arxiv.org/abs/2410.10813>

因此 Paw 的记忆条目必须知道：它来自哪里、何时有效、是否已被新事实替代、当前 commit 是否仍适用。只有相似度而没有时间和版本，不足以支撑 coding agent。

### 2.4 Coding Agent 的仓库记忆应来自代码演化

Repository Memory 工作表明，提交历史、关联 issue、模块职责和经常共同变化的区域可以帮助代码定位。

来源：<https://arxiv.org/abs/2510.01003>

近期 FastContext 研究进一步指出，仓库探索会大量消耗 token 并污染 solver 历史；把探索结果收敛为文件路径和行范围等聚焦证据，可以降低主 Agent 的上下文负担。该工作仍是较新的研究结果，数值不作为 Paw 的发布承诺，但“探索证据和求解上下文分离”的方向可采纳。

来源：<https://arxiv.org/abs/2606.14066>

### 2.5 巨型仓库说明不是可靠记忆

一项针对 AGENTS.md 的近期实证研究发现，自动生成或过长的仓库上下文文件通常增加探索和推理成本，整体成功率没有稳定提升；作者建议只保留必要且不能从现有文档直接获得的要求。

来源：<https://arxiv.org/abs/2602.11988>

OpenAI 的 Harness Engineering 经验同样强调“给地图，不给一千页说明书”：短入口文件只指向版本化的架构、计划和质量文档，知识本身留在可检查、可更新的仓库资料中。

来源：<https://openai.com/index/harness-engineering/>

### 2.6 记忆写入不应每轮都调用大模型

较新的 LightMem 将即时、阶段性和长期记忆分层，并把在线检索与离线整合分开；RecMem 只在相似经验重复出现时调用模型做昂贵整合。这些是 2026 年的新论文，仍需更多独立复现，但它们支持一个稳健工程原则：原始事实先廉价持久化，语义整合在稳定边界异步执行，不在每个 turn 阻塞主循环。

来源：<https://aclanthology.org/2026.acl-long.588/>、<https://aclanthology.org/2026.findings-acl.1619/>

---

## 3. Paw 旧上下文机制中应保留的设计

旧 `ContextManager`、`turns.ts`、`policy.ts` 和 `compactor.ts` 虽属于待替换运行时，但其中以下原则经过真实反例和回归测试，应迁移为 Paw Next 的行为契约：

1. system 固定前缀不能被普通历史裁剪；
2. 初始任务目标必须保留；
3. 最新用户输入必须保留；
4. 最新可见工作单元必须保留；
5. assistant action 与其全部工具 observation 必须作为一个原子单元；
6. 保留内容应是一个连续的最新后缀，不能丢掉较新的大单元却塞回更老的小单元；
7. pinned/protected 内容保持原时间顺序，不能被统一搬到摘要前；
8. 受保护集合可超过软目标，但完整请求不得超过模型硬窗口；
9. 压缩摘要应出现在第一个被替换单元的位置，而不是无条件置顶；
10. 最新完整工具轮不能为了硬凑消息数或 token 数而拆开。

这里必须区分两种不同产物：

- **任务检查点（Task Checkpoint / Task Notes）**是当前任务状态证据，进入固定的 host evidence 槽；它可以授权 Context 省略已被完整覆盖的旧单元，但它不是原位置的对话摘要。
- **对话压缩摘要（Conversation Compaction Summary）**才是对旧对话单元的语义替身；未来实现时必须遵守第 9 条，保留在第一个被替换单元的位置，不能借任务检查点已经置顶而宣称这项契约完成。

不迁移以下旧实现：

- `ContextManager.history` 作为第二事实源；
- 用 assistant 边界猜测完整人类会话轮次；
- 用“必须/禁止/不要”等文本正则决定权威生命周期；
- 旧 Orchestrator 的 HostState/control 文本堆叠；
- compactor 的隐藏内存计数器和旁路写盘；
- 按单消息删除、按消息数量硬切或基于不完整字段的 token 估算。

---

## 4. 当前 Paw Memory 的真实结构

当前仓库不是一套单纯 Memory，而是三层历史叠加：

### 4.1 旧 DB Memory v1

`packages/memory/src/db/**` 提供 TaskSession、WorkingMemory、候选、Governance、Memory Store、索引、安全、审计、演化和 Postgres migrations。它能力完整，但平台化较重，且与旧 Agent/Core 类型有较多耦合。

### 4.2 Long-term Memory v2

`packages/memory/src/longterm/**` 提供：

- semantic / episodic / profile / vault_ref 条目；
- Postgres 存储引擎；
- BM25 + embedding 混合召回；
- task_start / action_failed / post_compact / explicit_query 触发检索；
- Distiller、Secret Interceptor、Governor、trial lesson；
- tValid/tInvalid、效用账本、失效和生命周期；
- operation log、why/stats/diff 等可观测性。

这些是可以保留的领域能力。

### 4.3 旧 Agent 运行时接线

`MemoryRuntimeV2` 和旧 Orchestrator 负责：

- `beginTask()` 创建进程内 TaskTrace；
- `onToolResult()` 逐工具收集最多 60 条摘要，并用工具名/命令文本正则判断是否为测试；
- 工具失败时立即检索，生成 memory hint；
- `buildContextSection()` 返回 XML 字符串；
- 旧 ContextAssembler 把相关记忆渲染成 HostState 文本；
- `completeTask()` 把进程内摘要入异步 outbox；
- `saveMemory()` 和用户纠正可直接写 semantic memory；
- v1/v2 两套 runtime 仍可通过配置切换。

这一层属于旧运行时接线，不能迁入 Paw Next。

### 4.4 当前代码取证表

| 位置 | 当前事实 | 对 Paw Next 的影响 |
|---|---|---|
| `packages/memory/src/runtime/index.ts` | `createMemoryRuntime()` 默认 v2，但仍支持参数或环境变量切回 v1 | 迁移完成前可兼容；新生产入口不能继续暴露两套运行时权威 |
| `packages/memory/src/runtime/types.ts` | 门面同时包含 task lifecycle、context section、tool callback、working-memory patch、显式保存和管理查询 | 职责过宽；应拆成只读 MemoryProvider、异步 MemoryWriter 和管理 API |
| `packages/memory/src/runtime/memory-runtime-v2.ts` | `TaskTrace`、run/task map 和工具摘要只保存在进程内 | 崩溃后无法从同一事实前缀重建写入输入，必须改为 journal source range |
| 同文件 `TEST_TOOL_RE` | 通过工具名、命令和摘要文本猜测是否执行测试 | 与 canonical verification authority 冲突，必须删除 |
| 同文件 `buildContextSection()` | 接口收 `tokenBudget/limit`，v2 实现实际使用 Retriever 固定配置 | 调用方以为有预算控制，实际没有端到端约束；新 port 必须验证并兑现预算 |
| 同文件 `onToolResult()` | 工具失败时同步检索并返回字符串注入段 | 检索结果未成为 canonical input fact；新路径必须在 provider boundary 持久化 receipt |
| 同文件 `patchWorkingMemory()` | v2 为兼容接口保留 no-op | 说明 working memory 不应继续挂在长期记忆门面上 |
| 同文件 `completeTask()` | 写入输入是最多 60 条工具摘要与最终消息组成的 ≤4000 字符 digest | 会丢完整参数、工具证据、mutation、verification 和来源顺序；改为 journal/artifact resolver |
| `packages/memory/src/longterm/write/pipeline.ts` | 无 Governor 时为每个草稿生成 `ADD`；无 Distiller 时保存 degraded 条目 | degraded 条目被过滤是合理降级；无 Governor 自动 ADD 不满足新 active-memory 权威，应只 staged |
| 同文件用户纠正路径 | 确认后以 `user_statement/confidence=1.0` 直接写 semantic fact | 用户偏好可这样处理；代码/仓库事实必须保留 asserted 与 verified 的区别 |
| `packages/memory/src/longterm/retrieval/triggered.ts` | 默认注入硬顶 500 tokens，支持混合召回、精排、trial 和失效条目查询 | 能力可复用；最终 card 仍须进入完整 request budget，不能只按内部字符串预算 |
| `packages/agent/src/memory-host-state.ts` | primary/hint/cold resume 被拼成最多 8000 字符的 HostState memory 段 | 已比 durable fake-user message 安全，但仍是旧 Context 文本槽；新 Context 使用 typed cards |
| `packages/agent/src/orchestrator/action-handlers.ts` | 工具批完成后逐调用 `onToolResult()`，把命中保存为下一轮 hint | 属于旧 Orchestrator 控制流；Runtime Tool Executor 不得复制这条旁路 |
| `packages/memory/package.json` | Memory 同时依赖 Core 与 Protocol | 当前图无环但边界仍混合；后续去掉对 Core 的 RunEvent/ChatMessage/工具性实现依赖 |

这张表描述的是当前代码事实，不表示所有行为都是 bug。许多设计是在旧运行时约束下合理工作的兼容方案；迁移目标是消除重复权威和不可重放旁路，而不是否定已经投入的 Store/Retrieval/Governance 实现。

---

## 5. 当前实现中值得保留和必须改造的部分

| 当前能力 | 结论 | 原因与目标改法 |
|---|---|---|
| Memory Store 是正式记忆权威 | 保留 | 索引只是派生物；Context 不直接改库 |
| 写入经过候选、密钥检查、验证和治理 | 保留并收紧 | Writer 改为消费 canonical journal，不接收旧 Orchestrator 拼出的轨迹摘要 |
| semantic / episodic / profile / procedural 分层 | 保留 | 补齐 commit/path/symbol/version 和 typed source refs |
| tValid/tInvalid 软失效 | 保留并扩展 | 时间戳之外增加 validFromCommit、supersedes、workspace/branch 适用范围 |
| 混合检索与精排 | 保留为可选能力 | Runtime 只依赖窄 MemoryProvider port，不依赖 Postgres/LLM 实现 |
| 固定注入预算 | 保留 | 必须进入完整模型请求预算，调用方给出的 budget/limit 不得被忽略 |
| XML memory hint | 替换 | 改为 typed MemoryCard，最后由 Context Assembler 统一渲染 |
| action_failed 后追加宿主提示 | 删除 | 在下一个安全 provider boundary 产生 durable retrieval receipt，不伪造用户消息 |
| 进程内 TaskTrace | 删除 | 从 journal 的 seq 区间重建，崩溃后结果一致 |
| 用工具名正则判断测试 | 删除 | 读取 canonical verification facts/outcome，不解析工具 prose |
| `patchWorkingMemory()` no-op | 删除兼容接口 | 当前任务状态由 reducer/journal 管理，不假装 Memory 拥有 working state |
| 用户即真相并直接写项目事实 | 拆分 | 用户偏好/明确规则可保存为 asserted profile；关于代码行为的陈述仍需 current source 验证 |
| Governor 不可用时自动 ADD | 收紧 | 可保存为未验证候选，但不能直接进入自动注入池 |
| 检索失败静默返回空 | 调整 | 主任务可继续，但必须产生可观测 failure fact；不能让复现时不知道本轮是否 memory-off |
| v1/v2 runtime 开关 | 迁移后删除 | Paw Next 最终只保留一个 Memory adapter 和一个 Store authority |
| Postgres 实现 | 暂时保留 | 作为存储引擎，不进入 Agent Loop；是否增加轻量本地后端由真实安装与延迟数据决定 |

---

## 6. 目标状态模型

### 6.1 四种状态必须分开

| 状态 | 回答的问题 | 唯一权威 |
|---|---|---|
| Run Journal | 真实发生了什么 | canonical Session journal |
| Task State / Task Notes | 当前任务做到哪里、还有什么未解决 | 对 journal 的确定性归约/版本化 checkpoint |
| Working Context | 下一次模型调用具体看到什么 | 已持久化输入事实 + memory receipt 的纯投影 |
| Long-term Memory | 哪些跨任务知识值得复用 | Memory Store + Governor |

Task Notes 可以在当前 run 中长期存在，但它仍不是跨任务 Memory；Compaction Summary 可以帮助恢复当前任务，但不能自动成为 repository truth。

### 6.2 长期记忆类型

Paw Next 使用以下逻辑分类，不要求第一步就更换当前数据库表：

1. **Semantic Repository Memory**：模块职责、依赖关系、配置和架构事实；
2. **Episodic Task Memory**：某类问题如何定位、什么尝试失败、怎样修正；
3. **Procedural Memory**：多次验证有效的测试、审查和修复流程；
4. **Profile/Policy Memory**：用户偏好和仓库额外约束；
5. **Trial Memory**：尚未验证、只能作为弱参考的候选经验；
6. **Secret Reference**：只保存凭证在哪里，不保存凭证值。

---

## 7. 新的读取路径：Memory 如何进入 Context

### 7.1 分成三步，不把 I/O 塞进纯投影器

```text
Journal snapshot
  → ContextNeedExtractor（纯函数）
      goal / latest input / errors / paths / symbols / diff / commit
  → MemoryProvider.retrieve（I/O，可关闭、可降级）
  → memory.retrieval_settled（持久化本轮实际采用的 cards/hash/policy）
  → ContextAssembler（纯函数）
  → ModelRequest
```

这样可以同时满足：

- 重放时不依赖“现在数据库里是什么”；
- 相同 journal prefix 能重建相同请求；
- Memory 不可用时 Agent Loop 仍可运行；
- Context Projector 不依赖 Postgres、embedding 或 reranker；
- 同一次 provider attempt 使用固定的检索结果，不因后台记忆更新漂移。

### 7.2 检索触发点

不在每轮无条件检索。只在下列事件发生后，为下一个 provider boundary 产生检索需求：

- 新任务或目标发生实质变化；
- 新的可行动错误签名出现；
- 新文件/符号/测试范围成为当前工作集；
- 完成一次 context checkpoint/compaction；
- 用户显式查询记忆；
- 当前 revision 第一次进入候选验证或恢复阶段。

同一 `queryIdentity + mutationRevision + memoryPolicyVersion` 只结算一次；重复读文件和重复失败不能反复注入同一记忆。

### 7.3 Memory Card 契约

进入 Context 的不是任意字符串，而是类似下面的只读卡片：

```ts
interface MemoryCardV1 {
  id: string;
  revision: number;
  kind: "semantic" | "episodic" | "procedural" | "profile" | "trial";
  statement: string;
  applicability: "applicable" | "reference" | "trial";
  scope: {
    repositoryId: string;
    branch?: string;
    validFromCommit?: string;
    validToCommit?: string;
  };
  sources: readonly MemorySourceRefV1[];
  confidence: number;
  contentHash: string;
}
```

`sources` 必须能解引用到 journal seq、artifact、commit、path/symbol 或受版本控制的文档。没有可验证来源的模型总结最多是 trial/reference，不能标为 applicable。

### 7.4 冲突优先级

当记忆与当前证据冲突时，按以下顺序处理：

1. 当前 run 的工具、测试、workspace 和 journal 事实；
2. 当前 commit 的代码和受版本控制文档；
3. 当前 scope 下仍有效、来源可验证的长期记忆；
4. agent inferred、历史失败教训和 trial；
5. 无来源自由文本。

Memory Card 必须明确告诉模型：它是证据资料，没有指令权威、权限权威或 completion 权威。

### 7.5 在完整请求中的位置与预算

模型请求建议按以下顺序组装：

1. 固定 system 与工具契约；
2. 当前目标和硬约束；
3. 少量 Memory Cards；
4. 当前任务 checkpoint/notes（固定 host evidence 槽，不冒充原位置对话）；
5. 连续的最新原子时间线；
6. 最新用户输入/最新完整工具轮形成注意力尾部。

Memory 有独立软配额，但最终必须参与完整请求计量。配额不能绕过：

```text
hardInputLimit = modelContextWindow - reservedOutputTokens
softTarget = hardInputLimit - estimationMargin
```

受保护单元可超过 softTarget，但完整请求不得超过 hardInputLimit。若超限，先减少 Memory Cards，再裁旧非保护时间线，再做 task checkpoint；不能拆最新工具轮，也不能靠截断 raw tool arguments 伪造合法协议。

---

## 8. 新的写入路径：Journal 如何形成 Memory

### 8.1 Writer 只消费稳定事实

Memory Writer 不再接收 `onToolResult()` 拼出的摘要数组，而是消费：

- `sourceFromSeq/sourceThroughSeq`；
- 当前目标和 repository/commit scope；
- canonical tool/model settlements；
- mutation captures；
- verification facts 和最终 outcome；
- 用户明确声明的偏好/约束；
- 已引用 memory cards 及其后续效用。

Writer 必须能从 journal/artifact resolver 重新读取原证据，而不是相信最终回复中的自我总结。

### 8.2 写入触发点

- 当前 revision 获得权威验证；
- 一个假设被明确证实或推翻；
- 任务完成、失败或被用户纠正；
- 同类经验在多个 task 中重复；
- repo commit/issue 形成稳定演化证据；
- 用户显式要求保存偏好或规则。

普通 read/search/tool success 不自动调用 LLM 蒸馏。

### 8.3 两阶段写入

```text
Journal stable boundary
  → deterministic candidate extraction
  → memory.candidate_staged（持久候选，带来源与幂等键）
  → 异步 Distiller（可选）
  → Secret/Schema/Source/Commit validation
  → Governor（ADD / UPDATE / INVALIDATE / NOOP）
  → Memory Store
  → memory.write_settled
```

幂等键至少绑定：

```text
repositoryId + runId + sourceThroughSeq + writerPolicyVersion
```

崩溃后只能恢复或标记 interrupted，不能重复调用 Distiller/Governor 并产生第二份语义不同的记忆。

### 8.4 用户声明的特殊处理

“我喜欢中文文档”可以直接成为 profile assertion；“这个函数一定线程安全”不能因为用户说了就成为 verified repository fact。

用户显式保存应写成：

- `authority = user_asserted`；
- `kind = profile/policy` 或 `semantic assertion`；
- 代码事实在当前 source 验证前不得升级为 `agent_verified`；
- 用户可查看、撤销、修改和禁止自动注入。

### 8.5 更新与失效

长期记忆不能简单覆盖旧值。每项应补足：

- `schemaVersion`；
- `revision`；
- `validFromCommit/validToCommit`；
- `supersedes/supersededBy`；
- `sourceRefs`；
- `writerPolicyVersion/governorPolicyVersion`；
- `status = active | stale | contradicted | archived | trial`。

切换 commit、分支或 worktree 时，检索器先做 scope/版本过滤。无法确认仍适用的旧条目降为 reference，而不是悄悄当作当前事实。

---

## 9. Task Notes、Compaction 与长期记忆的关系

### 9.1 Task Notes

Task Notes 保存当前任务的：

- 已确认事实；
- 当前假设；
- 已排除方向；
- 修改过的文件；
- 验证结果；
- 未解决项；
- 下一步判别动作；
- 每项对应的 source seq。

它们属于 run journal/checkpoint，不进入 Memory Store 的正式检索池。

### 9.2 Compaction

压缩顺序固定为：

1. 外置旧的大工具结果，只留 hash/ref/有界预览；
2. 裁剪不受保护的旧原子单元；
3. 仍超软预算时生成结构化 task checkpoint；
4. checkpoint 只替换模型视图，不删除 journal；
5. checkpoint 必须引用覆盖的 seq 范围和 evidence hashes。

### 9.3 何时晋升为长期记忆

Task Notes 或 Compaction Summary 不能直接成为长期记忆。只有在稳定验证、跨任务重复、用户明确确认或 repo 演化证据支持后，Memory Writer 才创建候选。

---

## 10. 包与依赖边界

### 10.1 `@paw/agent-loop`

- 不知道 Memory 存在；
- 只通过 Context port 获得 `ModelRequestV1`；
- 不进行检索、蒸馏、治理或 token 裁剪。

### 10.2 `@paw/runtime/context`

- 读取 canonical Session snapshot；
- 提取 ContextNeed；
- 接收已结算 Memory Cards；
- 构建完整请求、计量和原子裁剪；
- 不依赖 Postgres、embedding、Memory Governor 或旧 Agent。

### 10.3 `@paw/memory`

- 保留 Store、Retriever、Writer、Governor、生命周期和可观测性；
- 最终停止依赖旧 `@paw/core` RunEvent/ChatMessage 控制类型；
- 不 import Agent Loop、Runtime 或旧 Orchestrator；
- 通过结构化 adapter 实现 Runtime 需要的窄能力。

### 10.4 Composition Root

- 创建具体 Memory Store/Provider；
- 注入 Runtime；
- 决定 memory on/off、后端和模型；
- 记录 provider/policy/store 版本；
- Memory 故障时保持 Agent Loop 可运行，但把本轮标为可观测 degraded。

不为 Memory 新建第二个 Runtime、第二条事件总线或独立终局状态机。

---

## 11. 迁移路线

### M0：先完成 Context 硬地基

1. 完整请求 token 计量；
2. timeline 原子单元；
3. protected union + 连续最新后缀；
4. soft target / hard limit；
5. deterministic task checkpoint 地基；后续另做保留原位置的 conversation compaction summary；
6. durable Session + checkpoint/tail replay。

Memory 在 M0 不进入新 Context，避免同时迁移两个事实边界。

> 2026-08-21 实施状态：M0 的第 1–4 项与第 5 项的任务检查点地基已落地：完整请求计量、原子时间线、protected union、连续后缀、软/硬预算，以及有 source seq/hash 的 typed task checkpoint 生成、同 Session CAS 持久化和 Context 有界省略闭环。稳定边界蒸馏已有 canonical claim/settled 和 at-most-once 恢复事务；在跨进程 coordinator/lease 尚未落地前，claim 后崩溃会安全地禁用该 run 的后续 checkpoint 蒸馏，而不是由不明所有者重复调用或伪造结算。自动预算触发、旧中段范围选择、产品 composition root 及“保留原位置”的 conversation compaction summary 尚未实现；第 6 项已有 durable canonical Session、原子批次、CAS、全 journal 严格恢复和可验证的 snapshot + tail 等价恢复地基。当前 snapshot 仍读取/hash raw prefix 并完整扫描 Protocol，只证明正确性，不宣称已有恢复性能加速；产品接线和跨进程执行权仍未完成。Memory 仍未进入新 Context。

### M1：定义窄 MemoryProvider 与 MemoryCard

1. Runtime 内定义 provider-neutral port；
2. 为当前 Memory v2 写只读 adapter；
3. 只接 task_start/goal_change 显式检索；
4. 检索结果持久化为 receipt；
5. Context 以固定预算注入 typed cards；
6. 完成 memory-off/on 的同请求重放测试。

### M2：把写路径改为 Journal Consumer

1. 新增 journal→candidate 纯提取器；
2. 用 canonical verification/outcome 替代工具名正则；
3. 删除进程内 TaskTrace；
4. staging/claim/settled 全部 durable；
5. 旧 `onToolResult/patchWorkingMemory/retrievePostCompact` 退出新 Runtime。

### M3：版本与失效

1. typed source refs；
2. commit/branch/worktree 适用范围；
3. supersession/contradiction；
4. stale-memory harm 指标；
5. repo docs/commit/issue 索引。

### M4：经验巩固与程序记忆

1. 重复经验检测；
2. episodic→semantic/procedural 候选；
3. replay/dry-run/critic 验证；
4. 版本化发布、回滚和效用账本；
5. 不在活跃 run 中热替换 skill/policy。

### M5：删除旧接线

在新入口通过 crash/replay、on/off、stale-memory 和真实 coding 任务门禁后，删除：

- `MemoryRuntimeImpl` v1 回滚路径；
- 旧 Orchestrator 的 `_memoryContextSection/_memoryLatestHint`；
- memory hint/cold resume legacy projection；
- `patchWorkingMemory()` 兼容 no-op；
- 工具名正则测试判断；
- 动态 memory user-message 注入。

---

## 12. 必测不变量

### 12.1 Context

1. 相同 journal prefix + memory receipt + config 生成逐字相同请求；
2. 工具调用与全部结果始终整组保留或整组删除；
3. 最新大单元放不下时不能回填更老小单元形成时间洞；
4. protected union 成本只计一次；
5. plain assistant、reasoning passback、附件、tool schema、raw args、结果状态都计入完整请求；
6. 等于 hard limit 可通过，超过一个 token 失败关闭；
7. resolver 在固定前缀已超限时零调用；
8. Memory Cards 不能产生 system/user/tool 角色注入。

### 12.2 Memory Read

1. repository/scope/commit 不匹配不注入；
2. 当前代码与记忆冲突时，当前代码优先并把旧记忆降级/失效；
3. 检索结果必须带 id/revision/hash/source refs；
4. 相同 query identity 不重复检索；
5. receipt 落盘后崩溃，恢复不重新调用 reranker；
6. memory-off 与检索故障不阻断 loop，但有明确 degraded fact；
7. 注入预算参与完整请求预算，不能双重截断后失真。

### 12.3 Memory Write

1. 未验证成功不能生成 verified repository memory；
2. 失败经验只能进入 trial，后续验证后才转正；
3. 用户偏好可 asserted，代码事实不能由用户声明直接升级为 verified；
4. 相同 journal source range 崩溃恢复不重复 distill/govern；
5. secret/schema/source/hash/commit 任一校验失败都不能进入 active pool；
6. Governor 不可用时只保存 staged/unverified，不得自动 ADD 到注入池；
7. UPDATE 保留旧版本与 supersession；
8. 当前 task notes/summary 不自动进入长期库。

---

## 13. 评测方法

不能只测“有没有召回”，必须同时测收益和伤害：

- coding task resolved rate；
- 定位 recall@k 与首次命中修改文件的步数；
- token/task、model calls/task、wall time；
- stale memory 注入率与 stale-memory harm rate；
- 冲突更新准确率；
- 无证据拒答率；
- crash replay 后的 prompt/hash 等价；
- memory on/off 配对差值；
- retrieval-only、summary-only、full-context 和 no-memory 消融；
- 按时间切分 commit/issue，防止未来信息泄漏。

MemoryAgentBench 可以继续测通用记忆能力，但不能替代真实 coding task 的 on/off 因果；SWE 类评测也不能把 benchmark 专用 hint 写入生产 Memory。

---

## 14. 本 RFC 冻结的决定

1. Journal 是唯一运行事实源；Memory 不复制一份运行真相。
2. Context 每轮从 journal/receipt 纯投影，不维护第二聊天历史。
3. Task Notes、Compaction Summary、Long-term Memory 是三种不同产物。
4. Memory 只通过 Context Assembler 的 typed card 槽进入模型。
5. 每次实际注入的 cards/revision/hash/policy 必须可重放。
6. 当前 workspace/code/test 永远高于历史记忆。
7. 记忆写入只在稳定边界异步进行，不阻塞每个 Agent turn。
8. 未验证/无来源内容不能自动成为 active repository memory。
9. 保留旧 Memory 的 Store/Retrieval/Governance 能力，替换旧 Orchestrator 接线。
10. 先完成 Context M0，再开始 Memory M1；两者最终在 Runtime Context boundary 汇合。

---

## 15. 尚未决定的问题

以下问题需要真实数据后再决定，不在本 RFC 中提前平台化：

- Postgres 是否阻碍本地 Coding Agent 安装，是否需要 SQLite/file 后端；
- embedding/reranker 的具体模型；
- Memory Card 默认 token 比例；
- 何时值得用 LLM 做 compaction/consolidation；
- 跨仓库 procedural memory 是否安全；
- 多设备同步和隐私策略；
- 自动生成 AGENTS.md/仓库文档是否能在 Paw 的任务分布上产生正收益。

在有两个真实消费者之前，不冻结通用 Plugin Memory API；在没有 on/off、时间切分和 stale-harm 数据之前，不宣称长期记忆提高 Coding Agent 成功率。
