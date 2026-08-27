# Paw Next Memory Plugin 实施日志

## 2026-08-24 — Memory M1 只读接入

### 范围

- 新增独立工作区包 `@paw/memory-plugin`；`@paw/runtime` 与 `@paw/agent-loop` 源码零改动。
- 只在 Paw Next V3 root composition 安装；child runtime 不继承长期记忆。
- 复用 `@paw/memory` v2 的 Postgres store 与 `hybridRecall()`，不调用旧 `TriggeredRetriever`，因此不写 hit ledger、不扣 trial 次数、不触发旧 Orchestrator hook。
- 仅实现 RFC-004 Memory M1 读取路径；自动写入、失效、Governor 与 trial 生命周期继续留在 M2。

### 冻结配置

V3 profile 可选增加：

```json
{
  "memory": {
    "policyVersion": "paw.next-memory-plugin.v1",
    "mode": "read_only",
    "providerVersion": "paw.memory-v2-readonly-provider.v1",
    "scope": {
      "tenantId": "local",
      "userId": "local",
      "workspaceId": "workspace-id",
      "repositoryId": "repository-id"
    },
    "maxCards": 3,
    "maxInjectedTokens": 512
  }
}
```

- `scope` 四元组必须显式提供并进入冻结 task options；manifest 只保存 20 字符 scope fingerprint，不暴露原始 tenant/user/workspace 标识。
- `mode: "off"` 仍安装插件并写一条 `disabled` receipt，便于审计关闭态；省略 `memory` 字段则完全不安装插件，保持旧 V3 行为和已有 manifest hash。
- manifest 固定 `authority: "untrusted_evidence_only"` 与 `writePolicy: "disabled"`。

### 数据流与日志

1. Agent Loop 报告安全边界。
2. 插件从 canonical snapshot 纯推导当前 task/work-segment query identity。
3. 同一 query 已有 receipt 时不再访问 provider；恢复后仍由 Journal 去重。
4. provider 只读召回、做 repository scope 密封并返回 typed cards。
5. 插件把实际采用的 cards 写成唯一 `memory.retrieval_settled` input fact；失败和关闭也写稳定 reason code，不写原始异常文本。
6. Context decorator 只消费当前 query 的 settled receipt，并把 cards 作为一个 host-maintained `memory_cards` section 渲染。Card schema 不含 role，额外字段会被协议拒绝；card 字符串没有指令、权限或 completion 权威。

完整请求预算以实际 V3 build 与原始 plan 的 token 差额计算；超限时先从尾部减少 cards，必要时注入零张，但 receipt 仍持久化该次已结算结果。插件故障不会阻塞 canonical inbox 或 Agent Loop。

### 验证证据

- `bun test packages/memory-plugin packages/core/test/model-request.test.ts packages/protocol/test/run-journal.test.ts apps/cli/test/paw-next-product-v3.test.ts`：44 pass（其中插件专项 5 pass）。
- `bun test apps/cli/test/paw-next-composition-v2.test.ts --test-name-pattern "installs the root memory plugin"`：1 pass。
- `bun run typecheck:memory-plugin`、`bun run typecheck:protocol`、`bun run typecheck:core`：通过。
- 仅 CLI production source 的临时 TypeScript 检查：通过。
- `bun run check:deps`：24 packages / 92 edges，无循环，WP1a 边界通过。
- 全量 CLI typecheck 当前仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断；该文件不属于本切片，未修改。

### 已知边界与下一步

- 当前生产适配器依赖现有 Memory v2 Postgres 配置；DB 不可用时只产生 `failed` receipt，主循环继续。
- 当前 M1 只召回 episodic/profile，未启用 semantic/trial，也没有 reranker 副作用。
- 下一切片应做真实 Postgres scope 隔离烟测、memory-on 的 Fresh → crash → Existing 回放，以及 receipt/card 可观测指标；通过后再讨论 M2 显式写入工具，不能恢复旧 `onToolResult()` 自动写路径。

## 2026-08-24 — 检索缓存与 AMB 首轮接入

### 缓存边界

- 缓存实现仍位于 `@paw/memory-plugin` provider decorator；未修改 `@paw/runtime` 或 `@paw/agent-loop`。
- key 固定包含：原始查询文本的 SHA-256、journal content hash、trigger、完整 scope fingerprint、provider/cache policy version、`maxCards`、`maxInjectedTokens` 与 store revision token；不以 task/query id 阻止跨任务复用。
- Postgres revision token 只允许 scoped engine，覆盖 `memory_items` 的 count/version/max-updated-at 与 `memory_embeddings` 的 count/index-revision；写入、更新、失效、删除、重建 embedding 后旧 key 均不可再命中。
- 仅缓存 `completed`；`degraded`、revision 查询失败和异常都旁路。进程级 LRU 默认 512 项、TTL 5 分钟；durable journal receipt 继续承担同 run/resume 的 exactly-once 去重。
- 事件 schema `paw.memory-retrieval-cache-event.v1` 记录 hit/miss/store/expired/bypass、哈希、scope fingerprint、card count 与耗时；不记录查询正文或底层异常。V3 提供 caller-owned `onMemoryCacheEvent`，回调失败不影响检索。

### AMB 适配

- 固定 Vectorize AMB commit `62364d7ead2dc1a7225d6daf4ae23f303b925b40`；git 传输连续失败后通过 GitHub API + codeload 获取同一 HEAD 的必要源码、配置和 PersonaMem 32k 公布数据，`upstream/` 不入产品 git。
- `benchmarks/amb/paw_provider.py` 实现 AMB 的 prepare/ingest/retrieve/cleanup 契约；JSONL bridge 调用 Paw 真实 Postgres hybrid provider。上游包不打补丁，由 wrapper 在进程内注册 `paw`。
- adapter 标签固定为 `paw / m1-retrieval-only`：AMB 文档只在 benchmark scope 内确定性分块并映射为 episodic 条目。本轮不声称覆盖 Paw 后续自动写入/蒸馏机制。
- 操作日志写 `logs/amb/paw-memory-bridge*.jsonl`，结果写 `benchmarks/amb/runs/`；两者均被 gitignore。日志只含查询/user 哈希，不含正文。
- 本机使用隔离容器 `paw-amb-postgres`（127.0.0.1:54329，`paw_memory_test`）并执行 34 个 Paw migrations；未接触占用 5432 的其他项目数据库。

### 验证证据

- memory plugin 专项：7 pass；定向 V2/V3 composition + manifest + memory plugin 回归：89 pass / 0 fail。
- `bunx tsc --noEmit -p packages/memory-plugin/tsconfig.json`、`bunx tsc --noEmit -p packages/memory/tsconfig.json`、`bunx tsc --noEmit -p benchmarks/amb/tsconfig.json`：通过。
- Python adapter `py_compile`：通过。
- PersonaMem 32k provider smoke：5 documents / 36 chunks；首次 3 cards、gold document hit=true；第二次同查询 cache hit；重写一份文档后同查询 miss + store。最终统计 hits=1, misses=2, stores=2, bypasses=0。
- 官方 AMB CLI preflight 可列出 dataset/mode，memory provider 仅 `paw`。Windows 完整 `uv sync` 的上游 Hindsight→uvloop 兼容问题通过 Paw-only package registry 与不安装 Hindsight/uvloop 规避，270 个其余锁定依赖安装完成。
- 正式 `personamem/32k + rag + query-limit=20` 命令已启动到官方入口，但因环境未设置 `GEMINI_API_KEY` 被官方 CLI 在运行前拒绝，故当前没有 AMB accuracy，不能把 provider smoke 当作榜单分数。

## 2026-08-24 — AMB DeepSeek Flash 端到端首轮

### 模型适配

- 新增 `DeepSeekFlashLLM`，从 Paw 本地 `deepseekv4flash` credential slot 读取 `deepseek-v4-flash`、base URL 与密钥；密钥只注入子进程环境，不进入命令行、结果或 JSONL。
- Paw wrapper 在进程内把 AMB answer/judge registry 指向 DeepSeek，并替换上游无条件 Gemini key preflight；dataset、runner、RAG prompt 和 PersonaMem MCQ exact-letter scoring 未修改。
- 请求保持 Paw 当前模型配置的 thinking enabled + reasoning effort max；结构化回答使用 JSON object，并校验必需字段。
- JSONL 新增 `llm_settlement`：只记录 model id、prompt hash、状态、耗时与 token usage，不记录 prompt、answer 或异常正文。

### 结果

- 1-query preflight：1/1 correct，检索 77 ms，官方 AMB 结果成功落盘。
- 20-query run：`personamem / 32k / paw / rag / deepseek:deepseek-v4-flash`，14/20 correct，accuracy 70.0%。这是 first-20 本地结果，不是完整 589-query 榜单成绩。
- 入库 195 documents / 1276 deterministic chunks，ingestion 9.809 s。
- retrieval：20/20 completed，平均 54.02 ms，中位 50.55 ms，最大 78.0 ms；平均 context 2434.4 tokens。
- LLM：20/20 success，无 retry；prompt 60,401 tokens，completion 18,478 tokens，总计 78,879 tokens。
- 分类：shared facts 4/4，preference-aligned recommendations 4/4，new ideas 2/6，update reasons 1/3，full preference evolution 3/3。
- cache：20 miss / 20 store / 0 hit，因为该切片 20 个 query hash 全部唯一。重复查询命中与真实写后失效继续由 credential-free provider smoke 覆盖。

### 产物

- 结果：`benchmarks/amb/runs/personamem/paw-m1-deepseek-q20/rag/32k.json`。
- 日志：`logs/amb/paw-amb-deepseek-q20.jsonl`。
- adapter 仍标记 `paw / m1-retrieval-only`；在完整 589 queries 与公开提交协议跑完前，不对外宣称 leaderboard score。

## 2026-08-24 — M1 检索升级与确定性 AMB 消融

### 产品实现

- 新增版本化 provider：`paw.memory-v2-readonly-provider.rrf.v1` 与可选
  `paw.memory-v2-readonly-provider.rrf-rerank.v1`。旧 provider 仍是产品默认，升级必须在冻结
  memory profile 中显式选择；`@paw/runtime` 与 `@paw/agent-loop` 继续零改动。
- 查询输入从单条当前消息扩展为最多三条结构化检索文本：当前输入、工作段初始目标、目标与当前输入组合。
  BM25 与 vector 结果按 rank-only RRF（K=60）融合；可选 reranker 只能返回已知候选 ID，失败时退回 RRF 顺序。
- 召回范围扩展到 semantic / episodic / profile，仍保持 repository scope 密封、只读、无 hit ledger、
  无 trial 扣减和无写入副作用。
- Postgres store 增加可注入的 1536 维 embedding port；模型名、版本、维度进入公开冻结 identity、
  revision token 与行级过滤。切换 embedding 模型后，旧向量在 reindex 前不可见，避免混用向量空间。
- 增加 OpenAI-compatible embedding adapter，带进程内 LRU 与 in-flight 去重；增加 JSON reranker adapter。
  两者日志均为 content-free 事件，只记录 identity、哈希、计数、耗时与状态。
- retrieval cache key 增加结构化 search-plan hash；AMB DeepSeek answer cache key 覆盖完整 prompt hash、
  model/config、cache policy、schema、temperature、thinking 与 reasoning effort，只原子写入成功 JSON。
  retrieval policy 不重复入 key：两种检索策略若生成完全相同 prompt，应复用同一答案以消除生成噪声与成本。

### 验证证据

- `packages/memory-plugin` 专项：12 pass；定向 composition memory 回归：2 pass；合并定向回归：
  14 pass / 80 filtered。
- Postgres embedding identity/reindex 专项：2 pass，覆盖错误维度拒绝、跨模型向量隔离、revision 变化与重建。
- `bunx tsc --noEmit -p packages/memory-plugin/tsconfig.json`、memory 与 AMB 三个 tsconfig：通过；
  Python adapter `py_compile`：通过。
- RRF provider smoke：5 documents，首次/重复/写后均返回 3 cards，gold hit=true；重复命中 cache，
  写后 revision miss + store，最终 hits=1、misses=2、stores=2。
- 全量 CLI typecheck 仍只被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断；本切片未修改该文件。

### AMB 消融结果

- PersonaMem 32k first-20，DeepSeek Flash，`temperature=0`，legacy 与 RRF 使用同一答案缓存：
  两者均为 14/20（70.0%）。20/20 rendered contexts 与 answers 逐字节一致，因此本切片只能证明兼容，
  不能声称 RRF 已提高 recall。
- legacy 平均检索 103.7 ms，RRF 96.6 ms；入库分别 15.460 s 与 15.154 s。该小样本延迟差异不作为性能结论。
- legacy 发生 20 次真实模型请求：60,401 prompt tokens、24,830 completion tokens；DeepSeek provider
  prompt-cache hit 59,136 tokens、miss 1,265 tokens，即 prompt token 命中率 97.9%。
- RRF 复用 20/20 本地答案缓存，评测阶段约 2 秒、模型 token 为 0。此前未固定 temperature 的两次运行在
  相同 20 条 context 下出现 70% 与 55%，已确认是答案采样噪声，不能归因于检索策略。

### 当前边界与下一步

- 真实 dense endpoint 尚未接入本机 AMB；当前只完成 fake embedder、缓存隐私测试和真实 Postgres
  model-isolation/reindex 测试。没有 1536 维 embedding endpoint 时，RRF 的 vector 路仍使用现有 n-gram fallback。
- 下一步应绑定一个固定版本的 1536 维 embedding 服务，先跑 first-20/100 的 dense+RRF 对照并检查 context
  差异，再决定是否启用 reranker；通过后才值得承担完整 589-query 的时间与模型成本。

## 2026-08-24 — 真实 dense 接入与负向结果

### 接入

- DeepSeek 官方当前没有 embedding endpoint，回答模型继续使用 `deepseek-v4-flash`；没有把聊天模型伪装成向量模型。
- AMB bridge 新增显式 `PAW_AMB_EMBEDDING_*` 绑定：只允许 RRF 策略启用，embedding 的 model/version/dimensions
  同时进入冻结 profile、Postgres 行级隔离与 revision token。未设置 endpoint 时行为完全不变。
- 新增 benchmark-only 本地 OpenAI-compatible endpoint，使用 `all-MiniLM-L6-v2`；384 维归一化向量零填充到
  1536 维，不改变 cosine similarity。长记忆按 180 words / 30 overlap 分窗，窗口向量归一化均值后入库。
- RRF v1 固定 lexical weight=1.0、vector weight=0.35，dense 仅作为辅助信号；权重与 embedding identity
  写入 content-free 启动日志。产品默认仍是 legacy provider，dense 仍为显式实验开关。

### 验证与结论

- dense provider smoke：5 documents，gold hit=true；37 个唯一文本生成真实向量，10 次重复缓存命中，
  0 embedding failure；retrieval cache 重复命中和写后失效均通过。
- 不分窗 MiniLM first-20：12/20（60.0%），平均检索 165.7 ms；相对 70% 基线丢失 2 个正确答案。
- 分窗 MiniLM first-20：仍为 12/20（60.0%）；20/20 contexts 均与基线不同，丢失题为一条
  `suggest_new_ideas` 和一条 `recall_user_shared_facts`。说明损失来自 dense 精度，而不是答案随机性。
- 分窗版入库 195 documents / 1,276 chunks，实际编码 4,091 windows，137.810 s；embedding adapter
  hits=469、misses=827、failures=0。平均查询检索 99.7 ms，已接近无 dense 的 96.6 ms。
- 分窗版 20 个 prompt 均为新上下文，因此答案缓存 0 hit；DeepSeek 使用 60,625 prompt tokens、
  29,349 completion tokens，provider prompt-cache hit/miss 为 5,888/54,737。
- 结论：不能因为“语义搜索更先进”就默认开启。本模型/融合在小样本上明确回归，dense 必须保持 opt-in；
  下一步优先做 lexical precision gate 或 reranker 消融，恢复 exact-fact 两题后再扩到 first-100。

## 2026-08-24 — Dense 精度门控与分区混合向量

### 诊断与实现

- 新增 `paw.memory-rrf-fusion-event.v1`，只记录 query id、候选计数、top score、门槛、是否调用 vector、
  list failure 与融合候选数，不记录查询或记忆正文。
- dense provider 默认使用 `lexical_gap_only`：lexical 唯一候选达到 `max(2*maxCards, 16)` 时跳过 vector，
  不足时才补语义召回；无外部 dense 的既有 RRF 保持 `always`。
- 诊断发现原始 `plainto_tsquery` 在 first-20 只有 0–1 个候选；实验性 OR 兜底将 20 条都提高到 34–36
  个候选并 20/20 跳过 dense，但 accuracy 仍为 12/20，因此该 SQL 改动已回退，没有用“有候选”冒充“相关”。
- 根因是外部 dense 替换了原有 n-gram 向量。新增 partitioned hybrid adapter：384 维 dense 与 1152 维
  n-gram 使用正交坐标，按平方根权重缩放。最终 cosine 严格等于两路 cosine 的加权和，不存在坐标交叉项。
- 增加仅限 `amb-personamem-*` scope 的事务型 rebalance 工具；通过缩放已存分区向量调权重，更新
  embedding version/index revision，不读取正文、不再次调用 embedding endpoint。

### 消融结果

- 纯 dense：12/20（60%）；partitioned dense=25% / n-gram=75%：13/20（65%），恢复一题；
  partitioned dense=10% / n-gram=90%：14/20（70%），恢复到确定性基线。
- 10% dense 最终结果相对基线有 12/20 contexts 改变，但 20/20 answers 相同，说明 dense 实际参与排序，
  不是通过关闭向量作弊恢复。平均检索 181.9 ms，平均 context 2421.2 tokens。
- 20 个查询均执行 hybrid vector recall；底层 dense adapter 15 miss / 5 hit / 0 failure，成功请求平均约
  49.1 ms。答案层 8 local-cache hits / 12 calls，新增调用使用 36,977 prompt + 11,273 completion tokens。
- 当前结论：`dense=0.1` 是 first-20 的无回归候选，不提升 accuracy，仍保持 opt-in。下一步先跑
  first-100 验证稳定性；若不能显著优于基线，再评估本地 cross-encoder/LLM reranker，而不继续手调小样本。
- 评测结束后清理隔离库 `paw-amb-postgres / paw_memory_test` 中 9 个 `amb-personamem-*` scope、10,244
  条生成项；结果 JSON 与 content-free JSONL 日志保留。清理后旧 reindex 回归由 10 秒超时恢复到 157 ms。

## 2026-08-24 — TencentDB Agent Memory 源码审计

### 源码固定

- 官方仓库 Git 传输因本机到 GitHub 443 连接异常连续失败，改用 GitHub API + codeload 固定两个官方源码快照；源码完整但不含 `.git` 历史。
- 当前默认分支 `feat/server_team` 固定提交 `97f94654280b2932c35ba4806a491999ed244cc9`，保存于 `E:\A_Louis\TencentDB-Agent-Memory`，用于分析 2.0 beta 的 Memory Hub、Proxy 和 session-init cache。
- `main` 固定提交 `3f11f6bf67a800a3a00b7d5fba3e3a8acae92ca0`，保存于 `E:\A_Louis\TencentDB-Agent-Memory-main`，包版本 0.3.6，用于分析集中的 L0/L1/L2/L3 实现。

### 审计结论

- 腾讯的主要结构性优势是 L0 原始证据、L1 原子记忆、L2 场景和 L3 画像的异步分层，以及 L1 的 store/update/merge/skip 冲突处理；不是单独依赖 RRF 或向量模型。
- 最新版明确停止每轮自动注入 L0/L1，改为 L3 + L2 索引在 `session_init` 固定注入，L0/L1 通过只读 bridge 工具按需查询，以保持 provider prompt/KV cache 的稳定前缀。
- Paw 已有插件隔离、安全边界 retrieval receipt、scope 密封和 revision-safe retrieval cache；主要缺口是可追溯的 L0/L1 写入、冲突/演化、L2/L3 投影以及 session-pinned stable memory snapshot。
- 腾讯 README 的 PersonaMem 48% → 76% 在仓库中没有对应可直接复跑的 runner、模型/Prompt/切分或题级结果，因此只作为官方效果声明，不与 Paw first-20/first-100 直接横比。
- 完整源码对照、风险与 Paw P0-P4 路线记录在 `文档/架构/TencentDB-Agent-Memory-源码分析与Paw优化路线.md`。下一建议切片为插件式 `Memory M2a — L0/L1 proposal writer`，不修改 runtime/agent-loop。

## 2026-08-25 — Memory M2a 原子写入插件与 AMB atom 模式

### 产品实现

- `@paw/protocol` 新增版本化的 memory claim / candidate / settlement facts 与严格前缀校验。写入采用 journal 两阶段协议：先 claim，再调用模型；proposal 先完整 stage，最后才确定性落库并 settle。相同写入不会重复调用模型，进程在 stage 后中断可按已记录 proposal 恢复。
- `@paw/memory-plugin` 新增 JSON atom extractor 与 deterministic atom store。原子类型覆盖 semantic / episodic / profile / instruction，动作覆盖 store / update / merge / skip；source sequence、目标记忆 ID、authority、secret scan、内容 hash 均在插件边界校验。
- 记忆 profile 增加显式 `read_write` 模式与冻结 writer identity。产品 composition 在主任务终态后 best-effort 调用同一配置模型，usage 单列为 `memory_write`；失败不会覆盖主任务结果。`@paw/runtime` 和 `@paw/agent-loop` 零修改。
- 写入只消费 journal 中稳定证据（用户输入、工具 settlement、verification/outcome），不把 assistant 自己的最终回答当事实回写。只有明确长期记忆信号，或“已完成 + 有验证 + 有工具效果”的检查点才触发，避免每轮都付写入成本。
- 模型输出兼容仍保持收敛：可选 ISO 时间的 `null` 归一化为 absent；误用 0..1 的 fractional priority 确定性映射到 0..100 integer。归一化发生在 hash/journal 之前。

### AMB 接入与日志

- `PAW_AMB_INGEST_MODE=atom` 启用真实原子化入库；默认仍是 `raw_chunk`，因此不会静默改变既有 M1 基线。atom variant 固定标记为 `m2a-rrf-atom`。
- AMB atom extractor 使用 DeepSeek Flash、12k 非重叠 evidence 窗口与写入侧本地 prompt cache；缓存 key 包含模型/config/prompt hash，成功 JSON 原子写入。日志只记录 hash、token、cache、atom/store/invalidate/skip 计数，不记录正文或密钥。
- 新增 `smoke_paw_atom.py`，默认连接隔离 AMB Postgres `127.0.0.1:54329/paw_memory_test`，外部 `DATABASE_URL` 可覆盖。该脚本只是模型/存储闭环冒烟，不是 AMB accuracy。

### 验证证据

- 真实 DeepSeek Flash + 真实隔离 Postgres 冒烟通过：1 个中文长期偏好文档抽取为 1 条 profile atom，存储 1 条、失效 0 条、跳过 0 条；RRF 返回 1 条并恢复原始 AMB document id，provider status=`completed`。
- 首次成功调用：520 prompt tokens、444 completion tokens、约 4.49 s；retrieval cache 记录 miss + store。结果为 `benchmarks/amb/runs/paw-m2a-atom-smoke.json`，content-free 日志为 `logs/amb/paw-m2a-atom-smoke.jsonl`。
- 相同输入第二次重建命中写入侧 LLM cache：0 prompt / 0 completion token、model duration 0 ms；仍只重建并召回 1 条原子。
- memory-plugin：17 pass / 0 fail；protocol、composition V3、manifest 与 dependency-boundary 定向回归通过；memory-plugin、protocol、AMB TypeScript typecheck 通过。
- 全量 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片未修改该文件。

### 成本边界与下一步

- 本次没有直接跑完整 PersonaMem：`query-limit` 只限制问答数，不限制 195 个文档的 atom ingest；首次 atom 化可能产生数百次 DeepSeek 请求，必须先做写入调用数/token/cost 预算与可恢复批处理。
- 下一切片应给 AMB atom ingestion 增加有界并发、checkpoint/resume、预算熔断与 ingest 统计，再跑小规模文档子集的 raw-vs-atom retrieval attribution；确认写入质量后才跑 first-20/100 accuracy。

## 2026-08-25 — AMB atom 成本熔断、断点恢复与证据投影

### 硬成本控制

- 新增 `atom-ingest-control.ts`。默认上限：256 次付费 writer 请求、300k prompt tokens、150k completion tokens、2 个用户分区并发；全部可用 `PAW_AMB_ATOM_*` 显式覆盖。
- 每次网络请求前先保守预留 UTF-8 prompt byte upper bound 与完整 4096 output tokens；调用数或任一 token 预算不足时，在 fetch 前以稳定错误码停止。缓存命中不占远程调用/token 预算。
- 不同 user scope 最多 2 路并发，同一 user 内文档和 source 严格保持原顺序，避免并发破坏 update/merge 冲突演化。
- bridge start / settlement / ingest / error / stats 均记录 content-free budget snapshot、稳定错误码和错误 fingerprint，不记录 prompt、原子正文或密钥。

### 断点恢复

- 每个成功 apply 的 source window 都原子更新 store directory 下的 `paw-m2a-atom-checkpoint.v1.json`。文件只包含 run/identity/source hash，不包含用户或记忆正文。
- `PAW_AMB_ATOM_RESUME=1` 明确抑制上游 reset；恢复前校验模型、base URL、提取策略、窗口、temperature、thinking 与 max-output identity。身份不匹配或 checkpoint 损坏均 fail closed。
- 实测预算中断时已完成 8 个 source；同一 run 提高预算并 resume 后，8 个全部 checkpoint skip，只处理剩余 9 个。新 evidence projection 的完整 5-source run 再次 resume：ingest 10 ms、5/5 skip、writer remoteCalls=0；3 个答案也全部命中本地 answer cache。

### PersonaMem 证据投影与成本下降

- PersonaMem 文档是 `[SYSTEM]/[USER]/[ASSISTANT]` 对话。旧版把整份文档错误标成 user evidence，既会把 assistant 猜测写成用户事实，也会放大成本。新版只保留 SYSTEM persona（verification）和 USER turns（user_input），完全排除 ASSISTANT blocks。
- 选中证据按 24k chars 打包，source seq/role 保留到 extractor；原始文档 evidence ref 仍可恢复。全量 195 文档的纯本地估算：原始 5,442,926 chars；有效证据 2,352,934 chars（43.2%）；预计 source calls 从 12k 全文方案 542 降到约 197（-63.7%）。
- 长窗口第一次证明 2048 JSON 上限会明确 truncated；保持 thinking disabled，只把 JSON max output 提到 4096，并纳入预留预算与 checkpoint identity。

### 5 文档工程样本（不是 AMB 成绩）

- 旧 12k 全文方案：17 writer calls、36,029 prompt、22,883 completion、195 atoms；一次在 30k prompt 预算前熔断，随后断点恢复完成。
- 新 system/user-only 24k 方案：5 writer calls、16,793 prompt、9,550 completion、79 atoms、49.296 s ingestion。相对旧方案：调用 -70.6%、prompt -53.4%、completion -58.3%、原子数 -59.5%。
- 同一 3-query / 5-document 工程子集两者均为 2/3；由于 `--doc-limit 5` 丢失绝大多数语料，这个 66.7% 只说明链路没有在该样本回归，不能作为公开榜分数或质量结论。
- 新增 hash-only attribution：bridge 只记录 returned document ID hashes，分析器与 pinned dataset gold IDs 对比。该工程样本 3/3 query gold-document hit、macro gold-document recall=1.0；错误的 `suggest_new_ideas` 题在 5/5 gold 文档均已返回时仍答错，因此这一个失败位于生成/选择层，不是检索漏文档。

### 验证

- AMB control 单测 5 pass：角色过滤、预算 reservation、env 边界、checkpoint identity/corruption、跨用户有界并发与同用户顺序。
- protocol + memory-plugin + AMB control 合并定向回归 83 pass / 0 fail；AMB TypeScript typecheck、Python py_compile、dependency boundary 均通过。
- 下一步先做 raw-chunk vs atom 的 gold-document attribution（同一 question/source subset），确认 79 个原子的检索覆盖率；随后再决定是否支付完整 195 文档约 197 次 writer 调用和 first-20 answer 成本。

## 2026-08-25 — AMB first-20 归因与 L0/L1 混合上下文

### 根因确认

- PersonaMem 32k first-20 oracle（只入库 15 份金标文档）中，raw chunks 为 14/20（70%），atom-only 为 10/20（50%）。修复 attribution 以 `(queryHash, userFingerprint)` 联合归因后，raw 与 atom 的 gold-document hit 都是 20/20，macro recall 分别为 45% 与 95%。
- atom-only 平均上下文只有 329.3 tokens，而 raw 为 2434.5 tokens。即原子检索找得更全，但把跨轮次的理由、转折和偏好演化压得过薄；50% 的主因不是漏召回。
- 两种直接补原文实验都没有净收益：全局拆句再按关键词选取为 10/20，按 atom source sequence 补相邻用户轮次也为 10/20。后者把 full preference evolution 恢复到 3/3，却让 recommendation 从 3/4 降到 2/4，说明局部证据不足以覆盖宽问题。

### 有效改动

- AMB adapter 新增独立 L0 source scope，不侵入 runtime/agent-loop。原子写入仍只消费 SYSTEM/USER evidence；L0 同时保存 307 个可追溯 source blocks 和 52 个连续 5k timeline chunks，assistant 内容不进入长期事实或 L0 注入。
- 新增 opt-in `PAW_AMB_ATOM_CONTEXT_MODE=hybrid`：L1 atoms 负责跨文档召回与摘要，L0 chunks 在 atom 命中文档内按 query + atom terms 排序，整块注入且受 `PAW_AMB_ATOM_SOURCE_MAX_CHARS` 全局预算约束。日志仅记录 hash、文档数与 context chars。
- hash-only attribution 以 query hash + user fingerprint 联合日志，消除不同用户相同 query text 的串行覆盖。

### 结果与成本

- hybrid 为 13/20（65%），相对 atom-only 恢复 3 题且 0 题由对变错；macro gold-document recall=97%，平均上下文 2218.3 tokens。分类：shared facts 4/4、recommendations 4/4、full evolution 3/3、update reasons 1/3、new ideas 1/6。
- 相对 raw 仍差 1 题（5pp），瓶颈集中在开放式新想法与更新理由；这是 first-20 oracle 诊断，不是公开榜成绩，也不足以默认开启 hybrid 产品策略。
- 冷启动 15 文档 atom extraction 的唯一远程 writer 成本为 15 calls、48,303 prompt、26,020 completion。最终 hybrid 重跑 checkpoint 15/15 命中，writer remoteCalls=0；answer 层 4/20 本地 cache hit，16 次远程调用使用 44,335 prompt + 14,523 completion，provider prompt-cache hit=0。
- 定向回归为 86 pass / 0 fail / 347 expectations；protocol、memory-plugin、AMB TypeScript typecheck 与 AMB Python `py_compile` 全部通过。

### 下一步门槛

- 暂不支付 first-100/完整榜成本。先对 `suggest_new_ideas` 与 `recalling_the_reasons_behind_previous_updates` 做题级、无正文泄露的候选/时间覆盖诊断，验证 L2 场景摘要或显式时间链是否能超过 70% raw oracle 基线；只有 first-20 有稳定正增益后再扩大样本。

## 2026-08-25 — Memory M2b 确定性 L2 场景投影

### 插件实现

- `@paw/memory-plugin` 新增 `paw.memory-scene-projector.v1`。它不调用模型，而是把每个已由 L1 检索命中的 source 内全部活跃 atom 按 source sequence 排序，生成 source-grounded L2 scene；不同 source 绝不混写。
- 场景投影对每个 source 公平分配字符预算，输出携带 atom IDs 与 source seqs，可追溯、可复现。AMB `scene_hybrid` 再用剩余预算加入完整的连续 L0 chunk，不做拆句。
- 新增 content-free 失败题探针，只保存 query fingerprint、题型、对错、context tokens 与延迟；不保存 query、memory、reasoning 或 answer 正文。bridge 遥测增加 scene 数、scene atom 数和 L0 chunk 数。

### 低成本探针与完整验证

- 先只重答 L0/L1 hybrid 的 7 道错题：L2 scene 恢复 3/7，其中 `suggest_new_ideas` 1 题、`recalling_the_reasons_behind_previous_updates` 2 题；writer 15 次全部命中本地缓存，远程 writer calls=0。
- 随后完整 first-20 oracle 为 15/20（75%），超过 raw chunks 14/20（70%）与 L0/L1 hybrid 13/20（65%）。macro gold-document recall=97%，20/20 均命中至少一个 gold document，平均 context=2474.0 tokens。
- 分类：shared facts 4/4、recommendations 4/4、update reasons 3/3、new ideas 2/6、full preference evolution 2/3。相对 L0/L1 hybrid 是 3 题由错变对、1 题由对变错；相对 raw 是 3 题恢复、2 题回退，净增益只有 1 题。
- 完整场景运行 checkpoint 15/15 命中，writer remoteCalls=0。answer 层 1/20 本地 cache hit、19 remote calls，57,872 prompt + 16,431 completion；DeepSeek provider KV prompt cache hit 3,840、miss 54,032，命中率 6.6%。
- protocol + memory-plugin + AMB 定向回归 89 pass / 0 fail / 355 expectations；三个 TypeScript typecheck 与 AMB Python `py_compile` 均通过。

### 结论与下一步

- L2 scene 的价值已得到 first-20 正向证据，但该切片参与了策略调优，75% 不能作为泛化结论或公开榜成绩，也不应立即成为产品默认。
- 冻结参数后已在未参与调优的 offset 20–24 做 5-query oracle holdout：raw chunks 4/5（80%），`scene_hybrid` 3/5（60%）；没有恢复 raw 错题，新增 1 个 shared-fact 回退。因此 holdout 门槛失败，停止 first-100，不把场景模式升为默认。
- holdout scene 平均 3242.6 context tokens、4.6 scenes、59.4 scene atoms、2 个 L0 chunks。writer 5/5 命中本地 response cache、remoteCalls=0；answer 5 次远程调用为 15,702 prompt + 8,208 completion，provider KV hit 768 / 15,702（4.9%）。
- 相同 holdout 立即复跑仍为 raw 4/5、scene 3/5；10/10 answer prompts 命中本地缓存，scene checkpoint 5/5 skip、writer remoteCalls=0，排除采样噪声。
- 下一步不继续扩大样本，而应先处理 scene 的证据选择精度：减少“所有 atom 全量铺开”造成的干扰，并对 full-preference-evolution/shared-fact 设置保守回退到 L0/L1 hybrid；新策略必须重新通过 untouched holdout 才能放大评测。

## 2026-08-25 — Memory M2c 场景导航、按需读取与保守路由

### 插件实现

- `@paw/memory-plugin` 新增 `paw.memory-scene-navigation.v1`，把 L2 拆为稳定的 path/summary index 与 source-grounded bodies。snapshot key 绑定 scope、projection revision、规范化 index 与 body hash；运行时无需感知 memory。
- 新增插件式稳定 context decorator：index 作为冻结的 `memory_cards` system section 放在用户消息之前；正文由 query selector 按需读取，显式因果问题最多读取 2 个场景、每场景最多 10 个 atoms，并受动态字符预算约束。
- 路由默认保守：不确定问题回退 L0/L1 hybrid；MCQ 选项不参与路由或场景选择，避免选项里的 `because/recommend` 误触发。由于尚无 L3，recommendation/new-idea 的 L2 下钻改为显式 opt-in，默认回退。
- AMB 增加独立 `scene_routed` 模式，保留旧 `scene_hybrid` 便于 A/B。content-free 日志新增 stable-prefix hash/chars、route、fallback、scene reads、selected atoms 与 dynamic chars；不记录 query、memory 或 answer 正文。

### 新 holdout 结果

- 在此前未使用的 PersonaMem offset 25–29 五题上，raw chunks 为 4/5（80%）。第一版 routed 为 3/5（60%），平均 context 2856 tokens；5 题中 4 题走 L0/L1 回退，唯一 recommendation 题读取 1 个场景、6 个 atoms 后由对变错，证明缺少 L3 时窄场景不够支撑宽推荐。
- 禁用无 L3 的 exploratory 下钻后，同一切片诊断复跑恢复为 4/5（80%），与 raw 持平；平均 context 从 raw 3335.0 降到 3152.4 tokens（约 5.5%）。5/5 均走 L0/L1 回退，scene reads=0，因此这只证明回归保护有效，不证明 L2 带来准确率增益。
- writer 5/5 命中本地 response cache，remoteCalls=0。最终 answer 复跑 4/5 命中本地 prompt cache，唯一远程请求为 3118 prompt tokens，DeepSeek provider KV hit=0；该次没有实际稳定 index 注入，不能用于判断新 prefix 设计的 KV 命中率。
- 定向验证为 96 pass / 0 fail / 389 expectations；protocol、memory-plugin、AMB TypeScript typecheck 与 Python `py_compile` 全部通过。

### 当前结论

- 索引/正文分离和插件边界已经落地，旧的“59.4 atoms 全量铺开”路径不再是新模式默认行为。
- 下一瓶颈是 L3：没有稳定的宽偏好画像，推荐/新想法只能安全回退，L2 的按需下钻无法覆盖这类题。下一开发切片应是 source-grounded、可重建、有严格大小上限的 L3 persona projection；完成后再开放 exploratory route，并用新的 untouched holdout 验证。

## 2026-08-25 — Memory M2d L3 画像、原文安全回退与新留出验证

### 插件实现

- `@paw/memory-plugin` 新增 `paw.memory-persona-projector.v1`。L3 完全本地、query-independent，仅读取活跃且高置信的 profile/semantic atoms，排除 episodic、已失效和低置信声明；在 4,000 chars / 24 claims 上限内按 source 轮转，避免画像被单个文档垄断。
- persona projection key 绑定 scope、projection revision 与规范化 claims；新增稳定 context decorator，把 L3 放在 L2 index 前。该能力仍是插件，不修改 `@paw/runtime` 或 `@paw/agent-loop`。
- `scene_routed` 在存在可用 L3 时重新开放 recommendation/new-idea exploratory route；实际下钻顺序固定为 L3 persona → L2 index → 至多一个 scene body → 至多一个连续 L0 chunk。日志只记录 projection hash、chars、claim/source 数、route 与动态上下文计数。

### 回退故障与修复

- offset 30–34 的首次 untouched gate 暴露回退问题：raw 为 3/5，scene routed 仅 1/5；五题全部 fallback，说明不是 L3/L2 误导，而是回退仍使用压缩后的 L0/L1 路径。改为本地词重叠选原文后只恢复到 2/5。
- 进一步定位到两个不等价点：旧 L0 shadow 来自 SYSTEM/USER 投影，缺少 ASSISTANT turns；provider 返回后又被 14k chars 二次裁剪。保留的修复是在隔离 source-chunk scope 中保存完整 transcript chunks，并复用与 raw 相同的 RRF、`maxCards=16` 和 4,096-token provider 预算，不再二次包裹或裁剪。
- 修复后的 offset 30–34 诊断逐题与 raw 一致，均为 3/5（60%），五题 context-token 数也完全一致。长期 atoms 仍只由 SYSTEM/USER evidence 写入，完整 transcript 只存在 L0 fallback scope，因此没有把 assistant 内容提升为长期事实。

### 冻结策略后的新留出

- 在此前未用于调参的 offset 35–39 上，raw 与 routed 均为 2/5（40%），逐题正确性一致；平均 context 从 3,502.4 降到 3,373.8 tokens（-3.7%）。这是 5-query oracle holdout，不是公开榜成绩。
- 4/5 查询走 raw-safe L0 bypass。唯一 exploratory recommendation 题维持正确，并从 3,368 降到 2,725 tokens（-19.1%），注入 1 个 scene、6 个 atoms、1 个 L0 chunk；这是当前唯一未经调参的新切片压缩正例，不能据此宣称准确率提升。
- 写入 10 个 source windows：9 次本地 LLM response-cache hit、1 次 DeepSeek Flash 远程调用，实际 3,626 prompt / 1,414 completion tokens。回答层 routed 4/5 命中本地 answer cache，仅 1 个新 prompt 远程执行（3,068 prompt tokens），provider KV hit=0；raw 的 5 个新 prompt 为 16,256 / 16,522 KV hit tokens（98.4%），两组 prompt population 不同，不做直接优劣结论。
- 新增独立 `source_chunk_cache` 与 `source_chunk_rrf_fusion` content-free 事件；冷启动新留出按预期为 miss/store。稳定 L3/L2 prefix 的 provider KV 收益仍缺少同一用户多条实际 routed query，需后续专门评测，当前只证明了结构可缓存。

### 验证与下一步

- memory-plugin 28 pass / 0 fail / 123 expectations；memory-plugin 与 AMB TypeScript typecheck 通过。结果保存在 `paw-m2d-l3-raw-safe-diagnostic-q30-35.json` 与 `paw-m2d-l3-holdout-q35-40.json`，对应日志均为 content-free JSONL。
- 下一步不应立刻扩大到 first-100。先补一个“同一 persona、多条 routed query”的 KV 专项 probe，分离本地 answer cache 与 provider prefix cache；然后增加至少 20 条新留出，以估计 raw-safe 路由的回归上界和 exploratory 压缩收益。

## 2026-08-25 — Memory M2e 时态关系图与跨来源轨迹地基

### 架构实现

- `@paw/memory-plugin` 新增 `paw.memory-temporal-graph.v1`，复用已有 `memory_relations` 正式表，不另建 benchmark 私有存储。关系类型覆盖 supersedes / supports / contradicts / derived_from；本切片的确定性 atom writer 只自动产生有明确 target 的 supersedes 边。
- 每条关系 ID 由版本、scope fingerprint、关系类型和两端 memory ID 确定性派生。update/merge 的顺序为“新条目 put → 旧条目 invalidate → 关系 upsert”；若最后一步失败，journal 不 settle，重放会跳过已存在的新条目并用同一 ID 修复关系。
- 关系存储的每次 put/list/revision 都同时 JOIN 两端 `memory_items`，并逐项核验 tenantId、userId、workspaceId、repositoryId。`memory_relations` 没有 scope 列，因此这层双端校验是必须的授权边界，不能只依赖不可猜的 memory ID。
- 新增 `paw.memory-trajectory-projector.v1`：仅依据显式 supersedes 边把不同 source 的版本连接成轨迹，按 tValid 从旧到新投影 current/historical 状态、双向版本指针和 evidence refs。它不调用 LLM、不猜主题相似度；发现悬空边或环时 fail closed。
- 轨迹输出有最大轨迹数和单轨迹状态数硬上限；超长链只保留最近窗口并标记 `truncated`。这为后续 L2 跨会话主题场景和 L3 演化索引提供可重建地基，但本切片尚未把轨迹正文注入产品上下文。

### 无正文日志

- Postgres graph store 暴露 put/list/revision 三类 content-free telemetry，只含 scope fingerprint、关系数量和耗时。
- 产品 composition 将 graph telemetry 归并到已有 memory writer 诊断 hook，新增 `relation` 类型和 `relationCount`；不记录 statement、prompt、memory 正文、evidence 内容或密钥。

### 验证

- 新增故障重放测试：关系首次写入失败后，旧条目已安全失效、journal 可重放；第二次 apply 不重复 put 新版本，并只形成一条 supersedes 边。
- 新增三来源版本链投影测试和环检测测试。memory-plugin 全包 31 pass / 0 fail / 135 expectations，memory-plugin TypeScript typecheck 通过。
- CLI composition 定向回归通过；全量 CLI typecheck 仍由既有未提交的 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片未修改该文件。

### 尚未完成

- 当前完成的是 L1 版本关系写入和纯函数轨迹投影；还缺“按主题把无显式 update 边的跨会话声明归组”、投影快照持久化/失效、证据规划器消费轨迹，以及 L2/L3 产品读取链路。
- 下一切片应实现插件拥有的 topic identity / trajectory snapshot：模型只负责提出候选主题和关系，确定性层负责证据校验、scope 封闭、版本化提交和重建；禁止重新退化为针对 AMB 题型的关键词补丁。

## 2026-08-25 — Memory M2f 动态主题与内容寻址轨迹快照

### 分类边界

- 主题没有写成业务枚举。“后端技术栈偏好”“回复风格”“部署策略”等 canonical topic name 可动态产生；代码只固定 semantic / episodic / profile / instruction / mixed 五种粗粒度治理 family。
- 新增 `paw.memory-topic-extractor.json.v1`。LLM 只提交候选主题名、family、置信度和已知 memory ID 成员；不能提交事实正文、持久化 ID、scope 或历史修改。复用已有主题时只能选择输入中已知的 topic ID，代码会强制使用已有 canonical name 和 family，阻止模型偷偷改名。
- topic ID 由插件版本、完整 scope fingerprint、family 和规范化动态名称确定性派生。Unicode NFKC、大小写、空白和标点先规范化；同一主题重放稳定，不同 tenant/user/workspace/repository 必然得到不同 ID。

### 轨迹快照与存储

- 新增 `paw.memory-topic-trajectory-snapshot.v1`。插件先验证 proposal 的成员集合与 caller-owned L1 entries 完全一致，再收集成员之间已持久化的 temporal relations，生成包含显式版本链与 singleton 状态的主题快照。
- projection hash 覆盖 scope、topic、graph revision、成员角色/置信度/证据指针、关系和轨迹状态；不覆盖生成时间。因此相同证据在不同时间重建仍得到相同 snapshot ID，关系、成员或图 revision 改变则自动产生新版本并使上层缓存失效。
- 新增 V034 migration：`memory_topics`、`memory_topic_memberships`、`memory_trajectory_snapshots`。一次 replace projection 在同一 Postgres transaction 内完成 topic 乐观版本更新、旧成员撤销、新成员 scope 校验/upsert 和不可变 snapshot insert。
- membership omission 具有明确的 retraction 语义，因此 store 只接受完整投影，不接受模型直接执行增删。每个 member 写入前都重新核对 `memory_items` 的 tenantId、userId、workspaceId、repositoryId；跨 scope 投影在获取 SQL 连接前即被拒绝。

### 缓存和日志

- topic extractor 的 system prompt 与具体 source revision、memory 正文和运行 ID 分离，动态数据只在 user payload，便于 provider KV prefix cache 复用。
- topic store telemetry 只记录 scope fingerprint、member/relation/trajectory 数量、changed 标志和耗时；不记录主题名、statement、prompt、evidence 内容或密钥。
- topic revision 仅在 projection hash 真正变化时递增；完全相同的崩溃重放不会制造新 snapshot 或无效 revision，从而避免无意义缓存失效。

### 验证与下一步

- 新增动态中文主题规范化、跨 scope ID 分离、已有 topic 身份强制复用、稳定 prompt prefix、确定性重建、快照篡改拒绝和 store 越权前置拒绝测试。
- memory-plugin 35 pass / 0 fail / 150 expectations；memory-plugin 与 memory TypeScript typecheck、相关 Biome 检查全部通过。`@paw/runtime` 与 `@paw/agent-loop` 零修改。
- 本切片完成了主题提议/身份/快照/持久化端口，但尚未把 topic organizer 调度到产品 writer，也没有让 evidence planner 读取 snapshot。下一切片应先增加 journal-backed topic organization job（避免模型重复调用），再把 topic index 作为稳定前缀、按需轨迹正文作为动态后缀接入插件 context decorator。

## 2026-08-25 — Memory M2g Journal-backed 主题整理与产品调度

### 可恢复任务协议

- canonical run journal 新增 `memory.topic_organization_claimed`、`memory.topic_candidate_staged`、`memory.topic_organization_settled` 三类事实。claim 必须引用已完成 memory write 的 proposal hash 和其实际写入 memory IDs；candidate 必须匹配 claim scope；completed/noop 必须与已落盘候选数量一致。
- 主题 proposal schema 和 semantic / episodic / profile / instruction / mixed 粗 family 类型提升到 `@paw/protocol`，插件复用同一 DTO，不再维护一份容易漂移的私有副本。
- organizer 严格按 claim → LLM proposal → stage → deterministic apply → settle 顺序执行。若崩溃发生在 stage 之后，恢复只读取 journal 中已保存的完整 proposal 并重放 store apply，绝不再次调用 LLM；若只留下 claim，则以 interrupted 终结，避免不受控重复付费。

### 插件数据适配层

- 新增 `MemoryTopicOrganizerStoreV1`，将 L1 读取、已有 topic catalog、temporal graph 和完整 projection commit 隔离在 memory-plugin 内部。控制器只依赖端口，不依赖 Postgres，也不修改 Runtime/agent-loop。
- Postgres adapter 对新写入 atoms 做 scope-sealed 精确读取，并沿 active temporal relation 扩一跳上下文；source revision 绑定 source IDs、L1 生效/失效时间、证据引用、graph revision 与已有 topic projection hash。
- 更新已有主题时先合并其完整 active memberships，再加入模型候选和显式关系邻居；模型候选优先于关系推导，显式关系只能补 supporting member。随后以完整成员集重新物化内容寻址 snapshot，逐 topic 原子替换；journal 重放依赖相同 projection hash 幂等落库。

### 产品接入与成本边界

- V3 read-write memory profile 新增冻结的 topic organizer identity：policy version、extractor version、maxTopics。配置变化会改变产品 manifest identity，不能在同一冻结 run 内静默切换整理算法。
- 产品终态链路现在是 atom writer settle 后调用 topic organizer；两次模型请求都关闭 thinking，topic extractor 保持稳定 system prefix。`memory_organization` 单独计入辅助模型成本遥测，日志仍只包含 ID、hash、数量、状态和耗时。
- 主题整理仍是可选 memory plugin 的 best-effort 后处理；失败不会覆盖 Agent Loop 的权威终态。产品 composition 负责调用插件控制器，但 Runtime 与 agent-loop 包保持零修改。

### 验证与下一步

- protocol：26 pass / 0 fail / 111 expectations；memory-plugin 全包：38 pass / 0 fail / 167 expectations；V3 manifest：13 pass / 0 fail / 291 expectations；V3 产品集成用例验证一次终态产生完整 atom journal 和 topic journal，并实际调用两个 store。
- 新增崩溃恢复测试证明 staged topic proposal 重放时 extractor calls=0、prepare calls=0、apply calls=1；pre-stage crash 会直接 interrupted settle，extractor calls=0。protocol 与 memory-plugin TypeScript typecheck 通过；composition 单文件 strict typecheck 通过。
- 全量 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片未修改该文件。下一切片是 evidence planner：稳定 topic index 进入 cache-friendly system prefix，query-selected trajectory snapshot 作为动态 evidence body，且所有读取继续由插件 context decorator 完成。

## 2026-08-25 — Memory M2h 确定性 Evidence Planner 与缓存友好上下文

### 规划架构

- 新增 `paw.memory-topic-evidence-planner.v1`。planner 不调用 LLM，也不维护 AMB/题型分类表；只依据 query 与动态 topic name、当前 L1 statement 的 Unicode 词项重叠选择主题，再按相关度、current 状态和时间排序有限轨迹状态。
- 完整 topic index 与 query-specific evidence 分离。index 只含 topic/snapshot identity、动态名称、family、成员/轨迹数量和 projection hash；具体 statement、有效/失效时间和 evidence refs 只进入动态 evidence section。
- index revision 对完整规范化目录做内容寻址，因此相同目录面对不同 query 保持相同 ID/content hash；成员、轨迹或 projection hash 变化才创建新的 cache epoch。中文使用通用 Han bigram 分词，不依赖业务关键词或 benchmark 标签。

### Durable read path

- protocol 新增 `memory.topic_evidence_settled`：必须绑定已经落 journal 的 retrieval query；completed evidence 必须引用同一事实内 index 中已知的 topic/snapshot，重复 topic、snapshot、trajectory-state identity 均 fail closed。
- 新增 Postgres 只读 evidence store：按完整 tenant/user/workspace/repository scope 查询 active topic，并只读取与 topic 当前 projection hash 匹配的最新 immutable snapshot；随后通过 exactly-scoped L1 engine 恢复 member statements，并重新执行 projection integrity 校验。
- safe-boundary input middleware 先等待常规 memory retrieval receipt，再 load/plan/commit topic evidence。Context 不查询数据库，只消费已结算 journal；同一 query 重放直接复用 plan，数据库 load 次数为 0。读取或提交异常只产生 content-free failed/skip 诊断，不阻断 Agent Loop。

### Context 与成本边界

- memory-plugin context decorator 固定按 topic index → 普通 L1 cards → query trajectory evidence 顺序注入。目录作为稳定 system evidence，正文作为动态后缀；两者都沿用 untrusted memory wrapper，不能覆盖权限、system/user 指令或当前 workspace 证据。
- Core memory evidence renderer 将 content-addressed content 放在易变 journal source seq 之前，使 provider prefix cache 可以复用完整稳定目录；Runtime 与 agent-loop 仍零修改。
- profile 冻结 `maxIndexTopics`、`maxSelectedTopics`、`maxStates`、`maxEvidenceChars`。默认建议为 96 / 3 / 16 / 8,000；statement、evidence refs、总动态字符均有硬上限，planner 不产生额外模型调用。
- planner/store/input middleware telemetry 只记录 query ID、index revision、topic/state 数量、状态、reason code 和耗时，不记录 topic name、statement、query 正文、evidence 内容或密钥。

### 验证与下一步

- memory-plugin 全包 41 pass / 0 fail / 181 expectations；protocol 全包 63 pass / 0 fail / 237 expectations；V3 manifest 13 pass / 0 fail / 292 expectations；dependency boundary 8 pass / 0 fail。
- protocol、memory-plugin、core、memory TypeScript typecheck 和 composition 单文件 strict typecheck 全部通过。产品集成测试确认 task-start 先产生 topic evidence settlement，终态随后产生 organization claim/stage/settle，两个生命周期互不混淆。
- 还未做真实 Postgres 两次会话 smoke，也未测 DeepSeek provider KV 命中率。下一步应先做固定 persona 的“首轮写入、第二轮多 query 读取”集成 smoke，核对 index revision、实际 prompt prefix hash、动态 evidence 预算和 provider cached tokens，再开始新的 AMB untouched holdout。

## 2026-08-25 — Memory M2i 真实跨会话 Evidence/KV Smoke

### 实验设计

- 新增显式驱动 `apps/cli/test/paw-next-memory-topic-smoke.driver.ts`，使用真实 Postgres、真实 DeepSeek Flash 和每次运行唯一的完整 tenant/user/workspace/repository scope。报告只保存 scope fingerprint、revision、hash、数量、状态、token/cache/cost，不保存 prompt、memory statement、模型回答或密钥。
- 流程为 1 次 seed Session + 3 次独立 recall Session。seed 明确要求长期记住两条偏好，必须经过 atom writer 和 topic organizer；recall 只读同一 scope，硬验收不得产生 memory write。
- 三次 recall 不是多余重复。DeepSeek 当前 cache 规则对 `A+B`、`A+C` 的前两次请求先检测并持久化公共前缀，第三次 `A+D` 才能完整命中该 prefix unit；provider cache 又是 best-effort，因此架构正确性与 provider 实际命中分开记录。

### 真实结果

- Postgres 测试库执行 V034 migration 后，最终隔离运行位于 `E:/A_Louis/paw-memory-topic-smoke-mt8b1s1a`。seed 正常完成 atom write 和 topic organization，写入 2 个动态 topic。
- recall-a / recall-b / recall-c 均 completed；每次 index=2、selected evidence states=2、动态 evidence JSON 约 891 chars。三次 index revision 均为 `ca35ff05baf9be33b778d15abf3d45bd3658ce8779761e5e34bc4ef660704607`，topic-index content hash 与剔除 source seq 后的稳定前缀 hash 也完全一致。
- 三次 recall 均没有触发 memory writer，证明读取实验没有在中途改变 topic projection。首轮 seed 的 evidence 为预期 noop；topic 生成后，三次 recall evidence 均为 completed。
- recall provider cache hit 分别为 256 / 256 / 768 tokens，累计 1,280 tokens；说明第三次查询实际复用了更长的稳定 topic-index prefix。完整流程为 6,144 / 22,869 prompt tokens，命中率 26.9%，估算成本 CNY 0.018502。总命中率包含 seed 内部调用，不能当作 recall index 的独立命中率；第三次 recall 的观测命中率约 13.2%（768 / 5,830）。
- 报告保存在 `.paw/memory-topic-smoke-report.json`；全部 invariant 为 true：seedCompleted、recallCompleted、recallReadOnly、stableIndexRevision、stableIndexPrefix、providerReportedRecallCacheHit、passed。

### 发现与下一步

- 稳定 index 的 provider KV 收益已经从“结构上可缓存”升级为真实命中证据，但当前可复用前缀只覆盖约 768 tokens。query-specific trajectory evidence 位于 index 之后并随 query 改变，后续大段 prompt 因此不能复用；这属于输入分层问题，不是 planner 准确率问题。
- 下一步先在新的 AMB untouched holdout 上验证 topic evidence 对正确率的影响，同时分开记录稳定 index tokens、动态 evidence tokens、provider hit/miss 和 read-only invariant。只有确认准确率无回归后，才考虑扩大稳定 persona/index 层或调整请求层次，不能为了命中率填充无信息 token。

## 2026-08-25 — Memory M2j AMB Topic Evidence 适配与单题门禁

### 真实架构适配

- AMB bridge 新增独立 `topic_evidence` 模式，不复用旧 scene 输出冒充新架构。每个 PersonaMem 文档先走现有 atom writer；随后使用同一个动态 topic extractor 提议 topic，由 Postgres organizer store 确定性生成 trajectory snapshot。查询时通过 Postgres evidence store 加载当前 projection，再调用产品同款无 LLM planner。
- AMB 上下文顺序与产品一致：稳定 topic index → 普通 query-selected L1 cards → query-selected trajectory evidence。日志新增 index revision/count、evidence state count、稳定/动态 chars，仍不保存 query、statement、context、answer 或 reasoning。
- reset 现在先按完整 scope 删除 `memory_topics`，依赖外键级联清理 memberships/snapshots，再清理 L1 entries，防止 benchmark store 重跑时留下指向已删除 memory 的旧 projection。

### 模型边界加固

- offset 40 单题 smoke 首次暴露 `MemoryTopicExtractorPrimaryMissing`：DeepSeek 选择的 topic 与成员 ID 合法，但把全部成员标成 supporting。保留严格拒绝未知 ID、空成员和越权 topic；对“合法非空成员但漏 primary”在 parser 中确定性提升最高置信成员，置信度并列时按 memory ID 排序。
- 该规范化不新增事实、不改变 topic、不再次调用 LLM，结果可重放；新增单测覆盖。它属于通用 LLM 候选规范化层，不含 AMB 类别或关键词。

### 单题 gate 与停止条件

- 修复后 offset 40 完整跑通。raw 为 1/1，topic_evidence 为 0/1；上下文从 3,121 降到 2,751 estimated tokens（-11.9%），但准确率回归，因此按门禁停止，没有扩大到 offset 40–59。
- topic 路径并非空检索：最终 index=6、selected trajectory states=10、returned documents=12、stable prefix=2,754 chars、total context=10,835 chars。问题更像“宽画像/跨主题综合信息没有被稳定层表达”，而不是 topic store 或 evidence planner 没运行。
- 该题类型为 `generalizing_to_new_scenarios`；只能作为失败诊断，不能据此写该类别的专用路由。下一架构切片应把 source-grounded L3 persona projection 正式接入新产品 evidence path，并用 query-independent revision 与硬预算稳定缓存；topic index 负责导航，L3 负责宽偏好，L1/L2 evidence 负责具体证据。完成后必须换新的未看过区间做门禁，offset 40 已不再是 untouched。

## 2026-08-25 — Memory M2k 独立 L3 Persona 插件链与 AMB 门禁

### 产品架构

- canonical journal 新增 `memory.persona_projection_settled`。每个 projection 必须绑定已存在的 retrieval query，同一 query 最多结算一次；回执只保存 exact scope fingerprint、projector revision/key、有证据引用的 profile claims、来源数量、状态与时间，不保存 query、prompt 或模型回答。
- memory-plugin 新增 exactly-scoped Postgres persona store、无 LLM 的确定性 projector、safe-boundary input middleware 与 Context section。产品组合顺序为 retrieval receipt → persona projection → topic evidence plan；Context 固定按 L3 persona → topic index → 普通 L1 cards → query trajectory evidence 注入，Runtime 与 agent-loop 均未修改。
- read-write profile 冻结 persona projector identity 与 `maxClaims`、`maxChars`、`minimumConfidence`。projection revision 对完整 eligible catalog 内容寻址，projection key 对实际入选 claims 内容寻址；不同 query 只要 profile catalog 不变，就复用相同稳定 section ID/content hash。
- telemetry 只记录 query ID、projection hash、claim/source 数量、状态、reason code 与耗时。safe-boundary 重放直接复用 journal 回执，不再次查询 Postgres。

### 失败门禁与职责收紧

- 首个 untouched offset 41 暴露错误边界：raw=1/1，最初 persona+topic=0/1，estimated context 3,121 → 5,575 tokens。日志显示 L3 选入 24 claims、persona 10,234 chars；根因是普通 semantic facts 越层进入 persona，且旧预算只统计 statement、漏算 evidence refs 等完整声明成本。
- 架构修正后，L3 只消费写入层已经判定为 active profile 的原子；semantic/episodic 继续留在 L1/主题轨迹。选择预算按完整 canonical claim JSON 计算，并通过来源优先的确定性选择维持跨文档覆盖。产品建议预算收紧为 8 claims / 2,048 claim chars / confidence ≥ 0.7，不含题型、AMB 标签或业务关键词。
- 对 offset 41 的回归诊断恢复为 1/1；persona 收敛到 5 claims / 2,234 chars，topic_evidence estimated context 为 3,945 tokens。该重复样本只用于验证失败修复，不计作 untouched gate。

### 新样本结果与验证

- 新 untouched offset 42：raw=1/1，topic_evidence=1/1；estimated context 3,368 → 3,285 tokens（-2.5%）。新路径 persona=5 claims / 2,231 chars、topic index=6、selected trajectory states=10、stable prefix=4,910 chars；说明宽画像可以补足跨场景信息，同时没有吞掉普通事实层。
- 报告分别保存为 `benchmarks/amb/runs/personamem/paw-m2k-persona-topic-evidence-smoke-q41-42.json`、`paw-m2k-persona-topic-evidence-gate-q42-43.json` 与 `paw-m2k-persona-topic-evidence-regression-q41-42.json`；对应 bridge JSONL 日志记录在 `logs/amb/paw-holdout-q41-42-topic_evidence.jsonl` 和 `paw-holdout-q42-43-topic_evidence.jsonl`。
- protocol + memory-plugin 定向回归 74 pass / 0 fail / 313 expectations；memory-plugin 单独为 46 pass。benchmark TypeScript typecheck、产品 V3 memory composition 集成用例和相关 Biome 检查通过。全量 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片未修改该文件。
- 单个 untouched 样本只能证明门禁通过，不能当作准确率结论。下一步是扩到新的连续小批次，分题型记录 raw/topic 差异；只有小批次不回归后，才运行更大公开评测区间并重新统计准确率与 KV cached-token 比例。

### 连续 5 题小批次

- 新 untouched offset 43–47 已完成，报告为 `benchmarks/amb/runs/personamem/paw-m2k-persona-topic-evidence-holdout-q43-48.json`。raw=1/5（20%），topic_evidence=1/5（20%），accuracy delta=0；因此满足“不整体回归”，但不满足“已经提升”，按门禁停止，不扩到更大区间。
- 两条路径答对的题不同：topic_evidence 将一条 `recalling_the_reasons_behind_previous_updates` 从错变对，但将一条 `recall_user_shared_facts` 从对变错；其余 preference recommendation 与 generalization 均未答对。这是评测的安全类别标签，仅用于诊断聚合，没有进入产品路由或关键词规则。
- 5 次查询的 persona/index 稳定前缀完全一致：persona 均为 5 claims / 2,231 chars，stable prefix 均为 6,608 chars；平均 dynamic evidence 6,887.4 chars，平均完整 context 14,779.2 chars。稳定性与预算边界已经成立，当前准确率瓶颈不再是 L3 漂移。
- 下一架构缺口是 L0 evidence hydration：topic/atom 选择后只能看到压缩 statement 与 trajectory，尚不能沿 evidence refs 按需读取原始连续证据。它能解释“理由链被轨迹救回、直接共享事实却在原子化后丢失”的互换结果。下一切片应新增通用 evidence resolver 端口，在动态后缀中对已选 atom/trajectory 做有界原文回读；必须按来源引用与字符预算工作，不按 benchmark 题型工作，也不能让 Context/Runtime 直接查询数据库。

## 2026-08-25 — Memory M2l L0 原文归档、按引用回读与 AMB 门禁

### 架构与插件边界

- canonical journal 新增 `memory.raw_evidence_settled`。回执必须绑定已存在的 retrieval query，同一 query 最多结算一次；只允许 `completed/noop/failed` 三种结果，并冻结 exact scope fingerprint、resolver version、evidence ref、memory ID、content hash、resolution revision 与时间。协议同时限制最多 16 段、单段最多 8,192 字符、总计最多 16,384 字符。
- memory-plugin 新增 exact-scope Postgres L0 archive、确定性 resolver、safe-boundary middleware 与独立 Context section；数据库迁移为 `V035__memory_raw_evidence_spans.sql`。归档按 scope + evidence ref 不可变写入，读取时再次校验 content hash，跨 scope、重复冲突或归档凭空返回未请求 ref 都会被拒绝。
- 这不是第二套全文搜索。resolver 只沿本次 L1 cards 与 L2 topic trajectory 已经选中的 evidence refs 回读，按产品顺序合并、去重、限段数和字符数；不读取 query 关键词、不识别 benchmark 题型、不调用 LLM。默认产品预算为 6 段 / 6,000 字符。
- 新运行时仍只通过 composition 使用插件：writer 在可重放的两阶段 apply 中归档非 `skip` 原子实际引用的 source，reader 在 safe boundary 结算 L0。Context 顺序固定为 L3 persona → topic index → L1 cards → L2 trajectory → L0 raw evidence；L0 是最后的动态后缀，因此不会破坏前面稳定内容的 KV cache 前缀。
- 原文持久化前经过 secret scan；策略可阻断或脱敏。telemetry 不记录正文，只记录 query/ref/hash、段数、字符数、状态、reason code 和耗时。读取失败会形成可重放的 `failed/noop` 回执，但不会阻断主循环。

### 产品实测与验证

- 真实 Postgres + DeepSeek Flash 跨会话 smoke 已通过。seed 写入后，三个独立 recall 都得到 `rawEvidenceStatus=completed`、1 段 / 84 字符，三次 topic revision 一致且 read-only invariant 为真；总 prompt 23,653 tokens、provider cached 5,888 tokens，命中比例 24.893%，估算成本约 ¥0.019421。
- protocol + memory-plugin 全量定向回归为 115 pass / 0 fail / 451 expectations；protocol、memory-plugin 与 AMB bridge TypeScript typecheck 通过。产品 V3 profile/manifest 为 13 pass / 0 fail / 294 expectations，真实 composition 集成用例为 1 pass / 17 expectations。
- 全量 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片没有修改该文件。

### AMB 未见样本门禁

- 首个 untouched offset 48：raw=0/1，L3+L2+L1+L0 topic_evidence=1/1；回读 6 段 / 4,167 字符，报告为 `benchmarks/amb/runs/personamem/paw-m2l-raw-evidence-gate-q48-49.json`。
- 扩展 untouched offset 49–53：raw=1/5（20%），新架构=2/5（40%），accuracy delta=+20 个百分点。5 次检索都回读 6 段，平均原文 3,992 字符；stable prefix 在相同用户内保持一致。报告为 `benchmarks/amb/runs/personamem/paw-m2l-raw-evidence-gate-q49-54.json`，日志为 `logs/amb/paw-holdout-q49-54-topic_evidence.jsonl`。
- 新增答对的是 `recall_user_shared_facts`；两道 `generalizing_to_new_scenarios` 和一道 `provide_preference_aligned_recommendations` 仍未答对。这与架构职责一致：L0 修复了“压缩后找不到用户原话”，但没有解决“把多条事实组合成新判断”。类别仅用于离线诊断，没有进入路由或代码规则。
- 合并 q48–53 仅为 6 个样本：raw=1/6，新架构=3/6。这个结果说明 L0 切片通过小样本不回归门禁并呈正向信号，但不是公开榜分数，也不足以声称稳定准确率。下一架构切片应转向 evidence synthesis/coverage：让 planner 显式表达回答需要哪些证据槽位、检查已选 L1/L2/L0 是否覆盖，并在缺口存在时扩展引用；不能继续无条件加更多原文或按题型打补丁。

## 2026-08-25 — Memory M2m 动态证据覆盖规划与压缩上下文

### 架构与权威边界

- canonical journal 新增 `memory.evidence_coverage_settled`。它必须位于同一 query 的 retrieval、topic evidence 和 raw evidence 回执之后，同一 query 最多结算一次；完整计划冻结动态 requirement、covered/partial/missing 状态、已验证 memory/topic ID、补充轨迹与最终 L0 spans，失败和 noop 不得携带伪计划。
- 新增插件内 coverage planner。LLM 只负责把当前问题动态拆成“回答必须知道什么”，并从已给出的 memory/topic ID 中提出覆盖与扩展候选；没有写死 AMB 类别或业务关键词。确定性层拥有最终权威：拒绝未知 ID，限制最多 4 个 requirement / 3 个扩展 topic / 8 个补充状态，重新计算覆盖状态，并在同一个 6 段 / 6,000 字符 L0 总预算内重选原文。
- 对模型非严格输出做了两类通用归一化：全局扩展 topic 超预算时按 requirement 顺序保留前 3 个不同 topic；已有证据达到 minimumEvidence 时强制清空多余扩展，使 journal 与实际读取动作一致。topic extractor 遇到未知 target topic ID 时不再接受虚构 identity，而是把合法 proposal 确定性 canonicalize 为新的 content-addressed topic。
- safe-boundary 链路为 retrieval → L3 persona → L2 topic → L0 raw → coverage → base input。coverage 是 memory plugin 的组合层能力，Runtime 与 agent-loop 无修改；回放直接消费 journal，不重复调用模型或数据库。

### Context、缓存与成本

- Context 的稳定前缀仍为 L3 persona → topic index。完成 coverage 后，最终动态后缀不再重复铺开原 L2/L0 section，而是只提供 requirement 的描述/优先级/最低证据数/覆盖状态、必要的补充 statement，以及有界原文 content/ref/hash；memory/topic/snapshot 等控制面 ID 只保留在 journal，不进入回答模型正文。
- coverage 使用现有 DeepSeek Flash，thinking 关闭，独立计入 `memory_coverage` 辅助阶段；无可用 memory 且无 topic index 时确定性 noop，不发模型请求。AMB bridge 复用现有内容寻址磁盘缓存，日志仅记录 prompt hash、token/cache、状态、数量、字符预算和耗时，不记录 query、记忆正文、回答或密钥。
- 真实跨会话 smoke 中三个 recall 的 coverage 都为 completed，每次 2 个 requirement 且全部 covered，topic index revision 保持不变；该次完整流程 provider cached-token 比例为 8.1%。seed 在后续加入空源短路后将不再支付 coverage 调用，因此该旧比例不能代表最终稳态成本。

### AMB 门禁结果

- q54 首次暴露模型给出超过 3 个扩展 topic，促成确定性全局预算归一化；修复后 coverage 为 3/3 covered，但 raw 与新架构仍均为 0/1。q55 为 4/4 covered，raw 与新架构均为 0/1。q56–60 的新连续 5 题为 raw=4/5、新架构=4/5，全部 coverage completed，平均 3.8 个 requirement 且 missing=0：证明无回退，但尚未证明提升。
- 压缩 Context 后，q61 的 ingestion 暴露 unknown target topic ID；通用 topic identity 归一化修复后回归为 raw=1/1、新架构=1/1。新的 untouched q62 也为 1/1 对 1/1，压缩模型可见字段没有造成回退。
- 新 untouched q63–67 小批次为 raw=3/5（60%），新架构=5/5（100%），accuracy delta=+40 个百分点；4 道 `track_full_preference_evolution` 和 1 道 `recall_user_shared_facts` 全部答对。平均 4.0 个 requirement，20/20 covered、partial=0、missing=0；平均 3.6 个 L0 spans / 2,575.2 chars，平均完整 context 19,989.4 chars。报告为 `benchmarks/amb/runs/personamem/paw-m2m-compact-coverage-holdout-q63-68.json`，日志为 `logs/amb/paw-holdout-q63-68-topic_evidence.jsonl`。
- 这些切片合计只用于开发门禁，且 q54/q61 已参与故障诊断，不能合并包装成公开榜分数。q63–67 是积极的未见样本信号，但样本量仍不足以声称稳定准确率；下一步应冻结 M2m 策略后扩大独立 holdout，并把新场景推理/建议生成单独看作回答阶段的 synthesis 能力，而不是继续向检索层加题型补丁。

### 验证

- protocol + memory-plugin 全量回归为 120 pass / 0 fail；protocol、memory-plugin 与 AMB bridge TypeScript typecheck 通过，V3 product manifest 为 13 pass / 0 fail / 295 expectations。覆盖规划单测同时验证空源零调用、未知 ID fail closed、全局 topic 预算、无缺口不扩展、缺口补齐、一次结算和 replayable Context。
- 全量 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片没有修改该文件。

### 冻结策略后的 20 题独立 holdout

- 在不再修改 M2m 策略的前提下运行新的 q68–87。raw=12/20（60%），topic_evidence=8/20（40%），accuracy delta=-20 个百分点；7 题共同答对、7 题共同答错、5 题由对变错、1 题由错变对。报告为 `benchmarks/amb/runs/personamem/paw-m2m-frozen-holdout-q68-88.json`，两组日志分别为 `logs/amb/paw-holdout-q68-88-raw_chunk.jsonl` 与 `logs/amb/paw-holdout-q68-88-topic_evidence.jsonl`。
- 分类型结果：shared facts 为 5/8 对 5/8（1 次回退、1 次提升）；previous-update reasons 为 raw 5/5、新架构 2/5；new ideas 为 1/3 对 0/3；full preference evolution 两组均为 0/2；generalization 两组均为 1/1；preference recommendation 两组均为 0/1。类型只用于离线诊断，没有进入产品规则。
- 20 次 coverage 均 completed，平均 3.8 个 requirement；76/76 requirement 被标记 covered，partial=0、missing=0。但 5 次回答回退说明当前 `covered` 只是“模型把一个已选 memory ID 分配给 requirement”，还不是经原文支持验证的语义充分性证明，存在系统性过度自信。
- 回退组平均仍注入 10.4 个 topic states、3.2 个 L0 spans / 2,391.8 chars，完整 Context 平均 18,937 chars；新架构总体平均 4,778 answer tokens，raw 为 3,305，增加约 44.6%。当前 assembler 仍保留 persona、完整 topic index、普通 L1 cards、L2 states，再追加 coverage manifest 和重选 L0；coverage 没有真正成为“唯一的动态证据装配权威”，冗余和干扰仍然存在。
- 辅助 memory 模型共 44 次 settlement，其中 6 次命中内容寻址磁盘缓存；远程 prompt/completion 为 75,364 / 23,933 tokens，provider cached prompt tokens 为 4,096。回答阶段 cached/miss prompt tokens 为 41,472 / 102,258。独立 query 的 retrieval result cache 为预期 0 命中，不能与 provider KV cache 混为一谈。
- 结论：M2m 不能以当前形态作为默认准确率优化上线。下一架构切片应让 coverage plan 成为动态 suffix 的唯一装配清单，只注入被 requirement 选中的 L1/L2/L0，移除重复候选；同时把 covered 从 ID 计数升级为可验证的原文 support span，明确绑定 requirement → statement → source span。完成后必须另换未见区间重新门禁，q68–87 只能用于失败诊断。

## 2026-08-25 — Memory M2n 插件化渐进检索与腾讯式轻前缀

### 架构替换

- 新增 `paw.memory-tools` 只读工具插件，产品暴露 `memory_search_atoms`、`memory_list_topics`、`memory_read_topic`、`memory_search_conversation` 和 `memory_read_evidence`。模型参数中没有 tenant/user/workspace/repository 字段；exact scope 由插件闭包冻结，topic store 与 L0 archive 在创建执行器时再次做完整 scope 等值校验。
- Memory 插件自有 executor decorator，Runtime 与 Harness 内核没有新增 memory 分支。基础 executor 仍先完成统一 registry validation、read permission fact 和 resource-lock 生命周期，插件只替换 Harness 不认识的 memory tool 结果；真实 V3 集成已证明 `tool.permission_resolved` 与 `tool.settled(completed)` 可通过 canonical journal 恢复校验。
- 产品 Context 改用 tool-driven decorator，只常驻 canonical JSON 工具说明、稳定 L3 persona 和稳定 L2 topic index。普通 L1 cards、query-selected L2 states、L0 原文和 coverage manifest 不再自动注入；一次性 coverage LLM 与自动 L0 hydration 已从产品回答热路径移除，旧实现保留为独立 legacy/诊断单元。
- 工具执行采用每个 session executor 最多 6 次调用、总计 24,000 个模型可见字符的联合预算；单次结果最多 8,000 字符。相同工具参数使用 scope/provider/version 绑定的内容寻址缓存；事件只记录 tool、状态、cache hit、调用序号、结果字符数、耗时、scope fingerprint 和 reason code，正文仍只进入正常 tool settlement。
- L0 archive 新增可选的 scope-sealed conversation search：只从精确 scope 的最多 512 条候选中做通用词项重叠排序，最多返回 16 段 / 16,384 字符；SQL scope 谓词完全由插件生成。L1 writer prompt 同时明确要求把强关联因果消息合并成一个完整事件，保留 trigger/reason → action/decision → result 及全部支持 sourceSeq，避免在检索前就丢失“为什么”。

### AMB 工具协议适配

- 原 AMB `RAGMode` 只支持一次 `retrieve`，无法测到产品的工具架构。DeepSeek Flash adapter 现支持真实多轮 function calling；初始 retrieve 只返回稳定 persona/topic index，回答模型可以按需调用 L1、L2 和 L0 工具，最多 6 次，预算耗尽时收到结构化失败结果并利用已有证据作答。
- 模型可见工具结果已移除 bridge `rawResponse`、缓存统计和路由遥测，只保留证据 ID 与正文。最终协议版本为 `paw.amb-llm-cache.v4`；每次远程结算记录 prompt/completion、provider cache hit/miss、tool calls/rounds/cache hits 和有界结果字符数，不记录 query、context、answer 或 reasoning。
- 两次 smoke 暴露并修复了两个通用问题：直接抛出预算错误会让整题失败，应与产品一样返回工具失败 settlement；把内部遥测放进工具结果会无意义占满字符预算。修复后 1 题事实回忆从 raw 错误变为 tool-driven 正确，1 轮 2 次工具调用，模型可见结果 7,483 字符。

### q68–87 诊断结果

- q68–87 已被 M2m 使用，因此本轮明确标记为 diagnostic，不是新的 untouched holdout。最终报告为 `benchmarks/amb/runs/personamem/paw-m2n-tool-driven-diagnostic-q68-88.json`；raw=11/20（55%），tool-driven=14/20（70%），delta=+15 个百分点。与两条路径逐题比较：共同正确 10、共同错误 5、tool-driven 新增正确 4、回退 1。
- 相比同一区间上一版 M2m coverage 的 8/20（40%），新架构提高 30 个百分点。分类型：shared facts 4/8 → 6/8；previous-update reasons 5/5 → 5/5；generalization 0/1 → 1/1；full preference evolution 1/2 → 2/2；recommendation 0/1 → 0/1；new ideas 1/3 → 0/3。建议生成仍是清晰弱点，不能用更多事实注入掩盖，下一步应研究回答阶段的多证据 synthesis。
- 初始稳定上下文平均从 raw 3,304.75 tokens 降到 1,330.45（-59.7%）。20 题回答共发起 54 次工具请求，其中 49 次真正访问 bridge、5 次为预算耗尽反馈；共 26 个工具回合，平均 2.7 次请求 / 1.3 回合。模型实际看到的工具结果共 187,270 字符，平均 9,363.5 字符/题；bridge 返回但在模型边界前被裁掉的冗余不再进入 prompt。
- 多轮回答累计 prompt/completion 为 197,866 / 33,891 tokens，平均 9,893.3 / 1,694.6；其中 provider prompt cache hit/miss 为 152,576 / 45,290，prompt cached-token 比例 77.1%，平均未缓存 prompt 约 2,264.5 tokens/题。总 prompt 因多轮调用高于 raw 单轮，但稳定前缀带来了高 KV 复用；下一优化目标是减少重复 L0 下钻和预算耗尽请求，而不是重新扩大初始前缀。
- atom ingest 的 12 个来源全部命中 writer response/checkpoint cache，远程 writer 调用为 0。查询均不同，因此 retrieval result cache 只有 2/86 命中（2.3%）符合预期；它与 provider KV cached-token 77.1% 是不同层级，不能混报。

### 验证与后续门禁

- memory-plugin 为 58 pass / 0 fail / 260 expectations；V3 memory composition + manifest 定向为 5 pass / 0 fail / 84 expectations。memory-plugin typecheck、AMB bridge TypeScript typecheck、Python `py_compile` 通过；完整 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片没有修改该文件。
- 下一步冻结 M2n 后应换 q88+ 做新的独立 holdout。先补每题 executed/limited/cache-hit 工具统计，再做三项通用优化：相同/近似 L0 查询去重、topic body 的因果叙事投影、回答前的 source-span 支持检查。q68–87 以后只能继续用于回归诊断，不能包装成公开分数。

## 2026-08-25 — Memory M2o–M2q 产品 Topic 对齐、紧凑投影与预算熔断

### 冻结失败与根因

- 冻结 M2n 后首次运行 q88–107：raw=11/20（55%），tool-driven=10/20（50%），delta=-5 个百分点；共同正确 8、共同错误 7、新增正确 2、回退 3。报告为 `benchmarks/amb/runs/personamem/paw-m2n-frozen-holdout-q88-108.json`。这证明 q68–87 的 70% 没有直接泛化。
- 日志显示 tool-driven 发起 37 次 L1 搜索和 18 次宽 L0 搜索，但只调用 2 次 L2 topic read，且两次都返回 0。代码审计确认 AMB tool-driven 仍使用旧 source-scene snapshot 和宽 persona，而产品插件已经使用 Postgres 跨会话 topic catalog、受限 L3 persona 和 exact evidence resolver；评测适配器与被测产品不是同一数据平面。
- 这不是用 q88–107 调题型规则。修复只做架构一致性：tool-driven 写入同样执行 topic organization，导航和读取使用产品同款 topic store；L3 仅投影 active profile，预算为 8 claims / 2,048 chars；新增第五个 `memory_read_evidence`；模型返回的 topic ID 只有在目录中唯一可解析时才规范化，未知或歧义 ID 继续 fail closed。

### 产品对齐后的新样本

- q108 单题 gate 为 raw=1/1、tool-driven=1/1。新路径真实生成 13 个 topic，L3 为 5 claims；初始上下文从约 3,567 降到 2,041 tokens。报告为 `benchmarks/amb/runs/personamem/paw-m2o-product-topic-tools-gate-q108-109.json`。
- 新 q109–118 小批次为 raw=5/10（50%）、tool-driven=7/10（70%），新增正确 2、回退 0；平均初始上下文 3,509 → 1,793 tokens（-48.9%）。16 次 `memory_read_topic` 全部非空，证明旧 scene/topic identity 错位已消除。报告为 `benchmarks/amb/runs/personamem/paw-m2o-product-topic-tools-holdout-q109-119.json`。
- 该批回答累计 prompt/completion 为 258,463 / 35,012 tokens，provider cache hit/miss 为 190,592 / 67,871，cached-token 比例 73.7%；平均 5.9 次工具请求、2.1 个工具回合。准确率转正但调用成本仍高，因此没有把 70% 当成完成条件。

### 紧凑模型视图与协议恢复

- L2 存储图继续保留完整 trajectory ID、supersedes relation、时间和来源。模型可见 topic body 改为稳定的 trajectory/position ordinal、状态、statement、有效时间、memory ID 和 evidence refs，移除回答不需要的重复内部长 ID。产品和 AMB 共用 `projectMemoryTopicToolStatesV1`，不是 benchmark 专用压缩。
- q119–128 首跑在第 8 个回答处暴露无效 `memory_read_evidence` 参数会由 Python adapter 抛异常。产品 registry 本来会返回失败 settlement，因此 adapter 改为结构化 `MEMORY_TOOL_ARGUMENTS_INVALID` 并让模型使用已有证据继续；该区间只算故障诊断。q126 回归恢复为 raw=1/1、tool-driven=1/1。
- 真正未见的 q129–138 冻结结果为 raw=6/10（60%）、tool-driven=7/10（70%），新增正确 2、回退 1；初始上下文 3,510.5 → 1,983 tokens（-43.5%）。14 次 topic read 全部非空。跨不同样本的成本诊断显示平均 topic body 约 6,496.8 → 4,401.6 chars（-32.2%），模型可见工具结果约 18,530.6 → 16,721.5 chars/题（-9.8%），平均未缓存 prompt 约 6,787.1 → 6,089.7 tokens（-10.3%）；因题目不同，这些只能作为方向信号。

### 预算熔断与验证

- q129–138 中底层实际 bridge 调用 48 次，但模型请求 63 次；15 次是到达 6-call/24k-char 边界后的继续尝试。DeepSeek adapter 现在预算耗尽后在下一回合移除 memory tools，强制基于已有证据完成回答，并分别记录 attempted/executed/limited/failed。产品稳定 guide 同步要求遇到预算限制不得重试。
- q135 重复诊断中，工具请求 10 → 5、回合 3 → 2、累计 prompt 31,145 → 19,865（-36.2%），正确答案保持。该题已经使用过，只证明熔断机制和成本方向，不计准确率。
- memory-plugin 全量为 60 pass / 0 fail / 269 expectations；memory-plugin 与 AMB TypeScript typecheck、Python `py_compile`、相关 Biome 检查通过。完整 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断。
- 当前最重要的剩余问题是跨更多用户扩大真正独立样本，而不是继续在 q88–138 调参。其次是让 `memory_read_evidence` 更容易在已有 evidence refs 时被正确调用，并把产品 executor 的 revision-aware cache invalidation 做成显式生命周期。

## 2026-08-25 — Memory M2r–M2u 来源归因、产品工具契约与证据账本 A/B

### 扩大 holdout 后的真实状态

- 冻结 M2q 后，q139–158 为 raw=12/20（60%）、tool-driven=14/20（70%）；q159–178 为 raw=14/20（70%）、tool-driven=10/20（50%）。合并这 40 个新问题，raw=26/40（65%）、tool-driven=24/40（60%），净回退 5 个百分点，因此当前工具路径不能按 70% 宣称稳定提升，也不能直接设为默认。
- 新增 hash-only 来源归因。每个 retrieve 只记录返回来源文档的 SHA-256；离线分析用同样哈希与 query gold IDs 比较，不落 query、context、answer 或 reasoning。q159–178 的首轮归因显示 tool 路径至少命中一份 gold source 为 19/20，macro gold recall=85%，但 gold-hit 后答对率只有 52.6%；5 个 raw 对/tool 错全部已经命中 gold source。瓶颈主要在证据使用与回答综合，不是继续扩大 top-k。

### 产品形状的工具契约

- AMB adapter 原先把产品 L1 返回的 `memoryId`、`kind`、`confidence`、`sources` 丢成通用 `{id, content}`，也丢掉 topic state 的时间和 evidence refs，导致模型无法稳定去重或调用 exact L0。bridge/provider 现在返回与产品插件同形的 `evidence/topics/states/spans`，有界编码器按完整 item 装配并保留标识字段。
- q159–178 重复诊断从旧适配的 11/20（55%）提高到 13/20（65%），raw 保持 14/20（70%）；gold-hit 后答对率从 52.6% 提高到 61.1%。这证明 adapter 丢字段是实质问题，但剩余 3 个回退仍全部命中 gold source，后续应优化 L2 结论/演化/冲突表达，而不是再加检索题型规则。
- holdout runner 现在每个 variant 开始前只清空它自己的精确 JSONL 日志，避免同 offset 重跑被追加日志污染。topic organization 的无效模型输出与产品一样 fail-open，并记录 content-free `topic_organization_failed`，单个 L2 投影失败不再中止整批评测。

### 会话证据账本实验与发布决策

- memory-plugin 新增 session-local evidence ledger，可按 memory ID、topic ID、topic state 和 evidence ref 把重叠工具结果投影成 delta；它不持久化内容、不修改检索、不接触 Runtime。61 个 memory-plugin 测试全部通过。该能力通过 executor 显式注入，产品默认不启用。
- q159–178 非严格诊断中，账本去掉 54 个重复 item，answer prompt 403,372 → 330,271 tokens，但分数 13/20 → 12/20；由于两次 L2 写入投影不同，该比较只用于发现风险。
- 在全新 q179–188 上做开关 A/B。账本关闭时 raw=4/10、tool=8/10，4 个新增正确、0 回退；tool gold source hit=10/10、macro recall=80%，answer prompt=142,896 tokens、32 calls / 13 rounds。账本开启后同样为 8/10，gold hit=10/10、macro recall=86%，但 prompt=166,707（+16.7%）、36 calls / 16 rounds，并去掉 47 个重复 item。准确率保持但模型因 delta 继续搜索，成本反而上升，所以账本不作为默认成本优化上线。
- q179–188 的关闭组是冻结产品形状工具后的新 holdout，说明该路径在这个 10 题小样本上达到 80% 且无 pairwise 回退；它仍不是公开榜分数。下一架构切片是 L2 synthesis projection：在写入/投影阶段形成有来源的 current conclusion、evolution、conflict 与 unresolved 摘要，读取时一次给出结构化主题结论和必要原文引用，减少回答模型自行拼接 3–6 次工具结果。

### M2v–M2w：persona 隔离评测与写入校验修复

- 复核 PersonaMem 适配器后修正了此前归因：`gold_ids` 是问题发生前的全部 session，不是精确支持答案的证据；连续 offset 高度按 persona 聚簇，且旧 holdout 会把同一 persona 多道题的 `gold_ids` 并集一次性入库。bridge 没有按 `query_timestamp` 过滤，因此早题可能看到后题才出现的历史。raw 检索还排除了 MCQ 选项，而 tool agent 能看选项并获得多轮预算。旧 source hit 只能说明命中某段前序历史，不能证明精确证据召回已经解决。
- 新增内容无泄露的 `persona_holdout_plan.py`：排除 q0–188 已见的 13 个 persona，从剩余 24 个 persona 中按哈希稳定选择一人一题，固定 dev=6、test=12，并保留 6 个 persona 不使用。计划文件不保存题目、答案、document ID 或原始 persona ID；runner 在调用模型前重新校验 query/persona fingerprint。
- 新增 `run_paw_persona_holdout.py` 与 `tool_l0` control。`tool_l0` 和产品工具使用同一回答循环，但初始上下文为空且只暴露 L0 conversation search；每个 variant 独立存储 content-free checkpoint，并累计完整 prompt/cache/tool 统计。12-persona test 分区尚未运行。
- 六个未见 persona 的 dev 结果：raw=4/6，18,334 prompt tokens；L0-only=3/6，38,247 prompt tokens、14 calls/7 rounds；当前 L1/L2 tool=4/6，153,459 prompt tokens、27 calls/15 rounds。raw 与当前 tool 逐题完全相同（4 个共同正确、2 个共同错误），说明当前结构在该小开发集只实现不回退，没有产生准确率增益；单纯增加 L0 搜索轮次则净回退 1 题。
- 写入阶段真实触发了 `Memory extractor returned too many atoms`：原实现先缓存 raw model text、后校验，导致一个超过 16 atoms 的无效结果会永久命中缓存并重复失败。memory-plugin 现增加一次通用 validation-driven repair：第一次超量或 schema 非法时使用独立 repair policy 重新提取，不截断、不写入；第二次仍无效则 fail closed。memory-plugin 62 tests/0 fail。干净重跑中 34/34 文档完成，只有 1 次 repair，33 个非空 topic organization 全部成功。
- 当前下一步保持不变但证据更强：实现一次读取、来源可校验的 L2 Topic Dossier；停止继续增加 top-k、自由搜索轮数或默认 evidence ledger。正式效果只能由封存的 12-persona test 在策略冻结后确认。

### M2x：来源可校验的 L2 Topic Dossier

- memory plugin 新增异步物化的 Topic Dossier。小主题在预算内直接确定性收全，零次 LLM；大主题只让 LLM 选择已知 memory/relation ID，statement、时间与 evidence refs 全部从 L1 和时态图重新物化，模型不能把自由文本写进事实层。
- 无效选择先进行一次严格 repair；仍无效或模型调用失败时，整份模型提案作废，改用确定性的有界 fallback，不接受半份结果。dossier 以 `topicId + projectionId + policy + extractor` 隔离，并使用内容寻址、完整性校验和 revision-aware current projection。
- L2 关系现在保留 evidence refs；新增 V036 Postgres 表和 exact/current store。产品 composition 在 topic organization 后顺序投影 dossier，属于 memory plugin 的辅助阶段，不侵入 Runtime；读取工具优先返回 dossier，旧 flat states 仅作兼容降级。
- 修复了一个真实产品接线问题：旧 `memory.read_topic` 路径的 topic cache 初始化位于提前返回之后，实际调用会触发 `ReferenceError`；缓存现在在 executor 创建时初始化，并由真实工具测试覆盖。

### M2x smoke、成本门禁与验证

- 最终 v3 单题 smoke 生成 18 份 dossier：13 份确定性收全、5 份模型选择、18 次提交、0 次投影失败；atom writer 为 15 次远程调用、5 次响应缓存命中。该题已见，只验证接线、容错和成本，不计准确率。
- 从真实 Postgres current projection 读取一份大 dossier：12 条 current、12 个 source IDs、12 个 evidence refs，模型可见工具结果 5,493 chars，未截断。证明产品读路径拿到的是来源可追溯的主题成品，而不是测试 fixture。
- memory-plugin 全量为 71 pass / 0 fail / 319 expectations；AMB bridge 使用项目 tsconfig typecheck，Python adapter `py_compile` 和定向 composition/product tests 通过。完整 CLI typecheck 仍被既有未跟踪文件 `apps/cli/test/swe-watch.ts:6` 的未闭合字符串阻断，本切片没有修改该文件。
- 封存的 12-persona test 仍未打开。下一步只在既有 6-persona dev 上重跑冻结后的 tool-driven 路径，与已经保存的 raw control 比较；只有策略冻结后才运行 test。

### M2y–M2z：统一 Evidence Resolver 与两阶段工具披露

- 第一次把 dossier 接入自由工具循环后，6-persona dev 只有 3/6：5 题实际读了 dossier，但一个事实题仍执行 7 次 topic read、15 次 atom search 和 2 次 L0 search。根因是 dossier 只提供了可靠材料，没有改变回答模型自由游走的控制流。
- memory plugin 新增 `memory.resolve_context`。回答模型只提交一次完整问题；插件内部完成 L1 初筛、L2 topic/dossier 选择、L0 精确 span 回读和 requirements coverage，返回内容寻址的有界 packet 与 `sufficient|partial|missing` stop。Runtime 仍不认识 memory，旧五个工具只作为 partial/missing 后的降级路径。
- 工具改成两阶段披露：resolver 必须先结算；`sufficient` 后阻止继续下钻，`partial/missing` 才允许低层工具。同批提前发出的低层调用不会越过 resolver。AMB adapter 使用同样的 staged contract，避免模型在看到 stop 前并行发起重复搜索。
- coverage planner 采用与 atom/dossier 相同的一次严格 repair。第一次 JSON/ID/budget 校验失败后只修复一次；第二次仍无效则整份计划作废，退回确定性 bounded packet。q514 已开放 dev 诊断由原来的 0/0 coverage、3 次工具调用且答错，恢复为 4/4 coverage、1 次 resolver 且答对；这只是已知错题机制诊断，不单独计为新分数。
- resolver 新增 content-free 事件日志：记录 mode、stop、coverage 数量、evidence/topic/span 数量、packet revision 与集合 hash，不记录 query、statement、span 正文或答案。persona runner 日志改为使用 output stem，后续不同运行不再覆盖同一个 JSONL。

### M2z 最终 dev 结果与下一门禁

- 冻结后的完整 6-persona dev 为 4/6（66.7%），与保存的 raw control 4/6 持平；没有资格宣称准确率增益，也未运行封存 12-persona test。报告为 `benchmarks/amb/runs/personamem/paw-m2z-final-resolver-persona-disjoint-dev-tool.json`。
- 相对接入 dossier 但仍自由游走的 M2x，answer prompt 133,980 → 52,285（-61.0%），工具调用 31 → 6（-80.6%），工具回合 11 → 6（-45.5%），模型可见工具结果 88,507 → 32,450 chars（-63.3%），初始 context 2,308.2 → 1,828.5 tokens（-20.8%）。包含写入/投影/coverage 的总 prompt 为 236,284 → 161,048（-31.8%）。
- 最终 6 题全部一次 resolver、全部被 planner 标为 sufficient；但其中 2 题仍错。当前 coverage 的结构性缺口是“已知 ID 数量达到 minimum”不等于“证据语义真正支持 requirement”，也没有对 unresolved contradiction 做 support verdict。因此下一步不是再加搜索，而是增加 requirement→evidence 的可校验 supports/contradicts/unknown 映射；只有每个 required requirement 有精确支持且无未解决冲突时才能发出 sufficient。
- memory-plugin 最终为 75 pass / 0 fail / 344 expectations；memory-plugin 与 AMB TypeScript typecheck、Python `py_compile`、persona plan 5 个单测和产品 composition/product 定向测试通过。仓库根测试仍有既有 `benchmarks/repobench` 缺失 `packages/core/src/memory-retriever.js`，完整 CLI typecheck 仍有既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串；两者均非本切片修改。

### 产物

- 40 题报告：`paw-m2q-budget-circuit-breaker-holdout-q139-159.json`、`paw-m2q-budget-circuit-breaker-holdout-q159-179.json`。
- 来源归因：`paw-m2r-source-attribution-q159-179.json`、`paw-m2s-source-attribution-q159-179.json`。
- 产品工具契约：`paw-m2s-product-shaped-tools-diagnostic-q159-179.json`。
- 账本诊断/A-B：`paw-m2t-evidence-ledger-diagnostic-q159-179.json`、`paw-m2u-evidence-ledger-ab-off-holdout-q179-189.json`、`paw-m2u-evidence-ledger-ab-on-diagnostic-q179-189.json`，对应日志已按 `ledger-off` / `ledger-on` 封存。

## 2026-08-26 — Memory M3：完整对话 L0、语义支持门禁与产品自动解析

### 写入与证据边界

- L0 不再只归档被 L1 atom 选中的用户句子，而是归档本次可写范围内的完整对话。`assistant_output` 作为独立 source kind 持久化，只能提供语境；只有相邻 `user_input` 明确确认或蕴含时，才允许共同支持用户事实。数据库约束由 `V037__memory_raw_evidence_assistant_output.sql` 扩展，Runtime 和 agent-loop 均未修改。
- L1 extractor 同样能看到完整对话以处理 “Yes / 对 / 没错” 等指代，但 assistant 内容在写入 prompt 中压到 1,600 字符；L0 仍保存最多 8,192 字符。这样把“证据完整性”与“每次写入的 LLM 成本”分开，避免为了保留原文而把整段 assistant 输出重复送给 extractor。
- coverage planner 要求为每个依赖记忆的可行备选项建立独立 required discriminant，并保持时间、情态、事件次数和 claim scope；support verifier 再把 requirement → candidate memory → exact L0 span 判为 supporting / contradicting / unknown。仅相关的职业、主题或宽画像不得宣布 covered。

### L0 搜索与对话窗口

- 旧搜索只看最新 512 条并对所有词等权，长历史中的稀有事实会丢失，姓名和通用词还会压过真正的辨别短语。新实现把 recent aperture 与 exact-term old-evidence aperture 合并，在插件内按词项文档频率、长度和连续短语加权；scope 谓词仍完全由插件闭包生成。
- 命中一条消息后返回同一 evidence family 的相邻轮次，并按 `hit → next → previous` 排列。紧随命中的用户显式确认优先保留前缀，避免 “Yes, I asked about their writing process” 被后文同词命中裁掉。角色和相对位置写入标签，support verifier 可以执行 assistant 语境 / user 确认的信任边界。
- resolver 会为每个 required claim 做一次有界 L0 审计，并把支持或冲突 evidence/span 排在输出前面。模型漏写空数组时只补默认空集，未知 ID、错误 hash、分区不完整和越权字段仍 fail closed。

### 产品接线与缓存

- V3 composition 现在创建一个 session-pinned `MemoryContextResolverV1`，同时交给 memory Context decorator 与只读工具 executor。每个新问题自动注入一个最多 8,000 字符的 query-specific packet；只有 packet partial/missing 时才需要下层工具。Runtime 仍只接收普通 `JournalContextRuntimeV1`，没有 memory 分支。
- Context decorator 以 query ID 缓存 Promise，同一 work segment 的后续模型轮次不重复规划/校验；resolver 自身再以 scope + policy + normalized query 做最多 8 项的进程内内容寻址缓存，因此自动注入与显式 `memory_resolve_context` 也能共享同一结果。失败 Promise 会删除，不能把一次中断永久缓存。
- guide 升级为 `paw.memory-tool-guide.v2`：明确已有自动 packet 时先使用它，没有 packet 才调用 resolver；低层工具仍保留为有预算的 fallback。

### AMB 开发集结果与限制

- 完整重新写入并回答的 6-persona public dev 运行由旧 M3i 的 3/6（50.0%）提升到 M3q 的 5/6（83.3%）。报告为 `benchmarks/amb/runs/personamem/paw-m3q-complete-dialogue-l0-persona-disjoint-dev.json`，日志为 `logs/amb/paw-m3q-complete-dialogue-l0-persona-disjoint-dev-dev-tool_driven.jsonl`。
- 最后一条 q325 的根因不是答案模型完全看不到历史，而是 “author signing” 位于 assistant 话语、用户在下一轮以 “Yes” 指代确认；等权检索先返回泛文学内容，旧投影又在确认句前截断。稀有词/短语排序和相邻确认窗口完成后，单题真实回答为 d，0 次下层工具调用；日志为 `logs/amb/paw-m3w-q325-scope-l0-answer.jsonl`。
- 在不重新写入、只复用同一旧 memory store 的六题读取侧回放中，q274/q302/q325/q542/q566/q514 全部正确，即 6/6。回答阶段为 6 calls（其中磁盘响应缓存 1 次）、41,576 prompt tokens、5,316 completion tokens、1 次 memory tool；日志为 `logs/amb/paw-m3x-six-query-replay.jsonl`。这是已开放的 6-persona dev query replay，不是公开榜成绩，也不能替代更大的 persona-disjoint test。
- 完整 M3q 写入曾在默认 300k prompt fuse 处停止，按 checkpoint 把预算显式提高到 650k 后完成；最终 atom ingest 为 93 remote calls、345,701 prompt tokens、64,746 completion tokens。assistant extraction 压缩在该完整运行启动后才落地，因此新的完整写入成本仍需另做冷启动测量，不能拿旧数字宣称已经降本。

### 验证

- memory-plugin + AMB TypeScript 全量为 95 pass / 0 fail / 425 expectations；memory-plugin typecheck 通过。产品 V3 的自动 packet、显式 fallback tool、完整 L0 archive 相关 composition 用例通过。
- 完整 CLI typecheck 仍被既有 `apps/cli/test/swe-watch.ts:6` 未闭合字符串阻断，本切片没有修改该文件。下一步应冻结 M3 读取策略后运行更大的 persona-disjoint 集，并分别记录 exact-support recall、answer accuracy、总 prompt、缓存 token 和延迟；不能把当前 6/6 外推成稳定准确率。

## 2026-08-26 — M3 冻结 persona-disjoint test 与 raw 对照

### 安全清理与写入恢复

- 删除 4 份已经被正式 M3 日志替代的 q325 中间诊断日志：`paw-m3s-q325-projection-inspect.jsonl`、`paw-m3t-q325-idf-l0-inspect.jsonl`、`paw-m3u-q325-confirmation-window.jsonl`、`paw-m3v-q325-scope-preserving-plan.jsonl`。正式报告、正式 JSONL、store 和 checkpoint 均保留。环境策略阻止递归删除 `__pycache__`，因此未绕过保护强删。
- 封存 test 首次完整运行在 34 个已结算 evidence window 后中断。根因不是预算、数据库或并发，而是 DeepSeek 在 validation repair 后用空 `skip` 行补齐 16 个 atom；其中空 statement 触发严格校验。插件现在只丢弃 action=skip 且 statement/sourceSeqs/targetIds 全空的精确 no-op，占有任一内容的 atom 继续走原来的严格 schema、来源和 target 校验。
- 新增通用回归用例后从原 checkpoint 恢复，失败 repair response 命中本地 writer cache，未重复调用模型；最终 62 份历史文档、88 个 evidence window 全部完成。memory-plugin + AMB 回归为 89 pass / 0 fail / 396 expectations，memory-plugin typecheck 通过。

### 12-persona 冻结结果

- M3 tool-driven 为 7/12（58.3%）；raw-chunk control 为 1/12（8.3%）。逐题为 1 个共同正确、5 个共同错误、6 个 tool recovery、0 个 tool regression，即 +50 个百分点。分类型：user-mentioned facts 2/2，preference evolution 2/3，new ideas 2/4，shared facts 1/2，update reason 0/1。
- tool answer 阶段为 12 calls、106,974 prompt tokens、16,849 completion tokens、2 次下层 memory tool；平均 initial context 4,568.6 tokens。raw 为 36,794 / 16,758 prompt/completion，平均 initial context 3,332.2 tokens。tool 以更高读取成本换来 6 个净新增正确，当前不能宣称已经完成成本优化。
- 首段失败前 writer 为 101 remote calls、397,464 prompt、77,158 completion；恢复段为 193 remote calls、734,649 prompt、144,661 completion。跨两段实际总计 294 remote calls、1,132,113 prompt、221,819 completion、6 次本地 response-cache hit。provider KV cached prompt 为 90,240 / 1,132,113（8.0%）；12 个 persona 和 query 均不同，retrieval cache 0 hit 属预期。resume 当前按进程重置预算，报告只展示恢复段数字，因此成本审计必须合并两段，后续应把预算累计也放进 checkpoint。
- 错题诊断暴露一个真实架构缺口：`online investment forum` 的旧负面状态与 `online investment community` 的新正面状态没有被归入同一 trajectory，回答选择了旧状态。另有标注噪声：一题 gold 声称历史包含 film history=`stereotypical`，完整 user history 只包含 `dry`、`tedious`、`unengaging`；推荐题的多个选项也具有主观等价性。正式分数仍按 benchmark gold 原样计为 7/12，不人工改分。
- 该 test 是公开 PersonaMem 数据上的项目内 persona-disjoint 评测，不是 AMB 公开榜提交。开发集 5/6、读取回放 6/6 的乐观结果不能外推；当前最可信结论是 M3 在本 test 上明显优于 raw，但绝对准确率和跨同义表达的时态归并仍需改善。

Artifacts:

- `benchmarks/amb/runs/personamem/paw-m3y-frozen-m3-persona-disjoint-test.json`
- `benchmarks/amb/runs/personamem/paw-m3z-frozen-m3-persona-disjoint-test-raw-control.json`
- `logs/amb/paw-m3y-frozen-m3-persona-disjoint-test-test-tool_driven.jsonl`
- `logs/amb/paw-m3z-frozen-m3-persona-disjoint-test-raw-control-test-raw_chunk.jsonl`

## 2026-08-26 — M4a：Facet V2 架构收敛起点

### 目标与边界

- 不再把 Facet 作为 Topic/Trajectory/Persona 之外的又一套并行系统。Facet V2 的目标是逐步接管“同一用户侧面的身份、当前状态、历史状态和条件变体”，而 Topic、Scene、Persona 降为只读派生视图。
- 第一切片只落在 `@paw/memory-plugin`，Runtime、agent-loop 和现有产品读取路径均未修改。Facet V2 当前处于 shadow 基础设施阶段，不改变线上答案。

### 已实现

- 新增稳定的 `MemoryFacetV2`：ID 仅由精确 scope 与规范化 canonical key 派生；别名只服务候选召回，不改变身份。
- 新增严格 `MemoryFacetMembershipV2`，将成员角色限制为 state/event/cause/condition，将关系限制为 initial/same_state/state_change/context_variant/supports/unresolved。所有 target ID 必须存在于同一 facet，悬空引用 fail closed。
- 新增无 LLM 的 `projectMemoryFacetStateV2`。投影保留 L1 原文和证据引用，确定性生成 current、historical、contextual、supporting、events、causes、conditions、unresolved 八个桶；输入顺序不影响 membership/projection revision。
- Episodic event 不会因为后续不同事件被删除。只有明确的 state_change 会把目标 state 放入历史；context_variant 与全局当前状态可以并存，解决“通常简洁，但复杂技术问题需要详细解释”这类条件偏好。
- 新增 content-free `paw.memory-facet-state-projector-event.v2` 日志，只记录 facet/revision、数量、状态、耗时和失败 reason code，不记录 statement、alias 或证据正文。

### 验证与下一步

- 新增投资社区演化、条件偏好、顺序无关、悬空关系四组用例：4 pass / 0 fail / 17 expectations。
- 连同 context resolver、旧 topic trajectory、persona projector 的定向兼容回归为 16 pass / 0 fail / 79 expectations；memory-plugin 全量为 93 pass / 0 fail / 413 expectations，typecheck 通过。
- 下一切片实现 ID-only Facet Reconciler：复用 L1 候选召回，一次完成 existing/new facet 选择、成员角色和 state relation；随后从现有 atoms 做 shadow backfill，对照 Malia 等真实失败案例验证投影，不先修改答案提示词。

### M4b：ID-only Facet Reconciler

- 新增 `MemoryFacetReconcilerV2`。模型必须把每个新 observation 精确分到一个 decision 或 `deferredMemoryIds`；漏项、重复项、未知 observation ID 均 fail closed。低置信度可以 defer，系统不会为了覆盖率强行建立状态关系。
- existing facet 只能使用 catalog 中的精确 ID，且 `canonicalKey/displayName` 必须为 null、aliases 必须为空；新 facet 的 canonical key、名称和别名由代码清洗，scope-bound ID 由代码生成。模型不能重命名已有 facet，也不能决定持久 ID。
- target memory 只能来自已知 catalog member 或本批 observation，并且必须属于同一 facet；same_state/state_change/context_variant 的 target 还必须是 state。事件不会因为时间靠后而自动形成 state_change。
- 一次 reconciliation 同时决定 facet、state/event/cause/condition 角色和关系，目标是后续替代旧 Conflict Resolver 与 Topic Organizer 的重复语义判断，而不是成为额外并行分类器。
- 与 atom/coverage 路径一致，首次输出失败后只允许一次严格 repair；第二次仍无效则整批失败。新增 content-free reconciler event，仅包含 source revision hash、计数、repair 标志、revision、reason code 和耗时。
- 典型投资社区端到端单测已将 reconciler 输出直接送入 Facet State Projector：新参与状态为 current、旧回避状态为 historical，两个不可变事件均保留，友好氛围进入 condition。另覆盖 prefix 稳定、新 facet ID 确定性、虚构 ID repair、跨 facet target 和不完整分区拒绝。
- M4b 完成后 memory-plugin 全量为 97 pass / 0 fail / 432 expectations，typecheck 通过；旧 Conflict、Topic、Trajectory、Persona 和 Resolver 路径保持兼容，尚未切换产品读写行为。

### M4c：Shadow Backfill 与真实时态归并

- 新增不可变 `MemoryFacetShadowSnapshotV2` reducer，从现有 semantic/episodic/profile atoms 分批构建 facet、membership 和 projection；deferred observation 可安全重试。该层只读正式 memory store，只写诊断 JSON/JSONL，不创建表、不改线上读路径。
- 新增通用 `benchmarks/amb/run_facet_shadow_backfill.ts`。支持 exact memory ID 或完整用户范围、1–32 条分批、DeepSeek JSON 模型、本地内容寻址响应缓存、供应商 cache hit/miss token 和 content-free 生命周期日志；报告明确标记 `diagnosticOnly=true`、`persistenceWrites=false`。
- 第一轮真实三条 Malia 诊断暴露协议缺陷：同一 canonical key 的 alias 文案略有不同会造成整批失败。修复没有放宽身份或证据边界：canonical key 继续作为唯一身份，代码按 memory ID 确定性选择 display name 并合并规范化 aliases；展示元数据不再要求模型逐字一致。角色 prompt 同时明确 state change 是 linkKind，不是 role。
- 修复后，旧负面 forum profile、后来加入 community 的 profile、当前正面 semantic 被归入唯一 `investment.community.participation` facet；3 memberships、0 deferred。旧负面状态进入 historical，当前 engagement 状态进入 current。首次成功调用 DeepSeek 1 次，829 prompt / 349 completion tokens，0 repair；完全相同重放为 0 remote calls、1 local cache hit、0 tokens。
- 诊断产物：`benchmarks/amb/runs/facet-shadow-malia-targeted-v3.json`、`benchmarks/amb/runs/facet-shadow-malia-targeted-v3-replay.json`；日志：`logs/amb/facet-shadow-malia-targeted-v3.jsonl`、`logs/amb/facet-shadow-malia-targeted-v3-replay.jsonl`。这些是公开 PersonaMem 数据上的定向架构诊断，不是新 benchmark 分数。

### M4d：薄 Query Intent 与确定性按视图取证

- 新增 `MemoryFacetQueryPlannerV2`。LLM 只从已知 facet index 选择精确 ID，并把问题分为 current/timeline/explanation/conditions/overview；不能回答问题、改写证据或生成画像。未知 ID、额外字段、超预算选择均严格拒绝并只允许一次 repair。
- 新增无 LLM 的 `selectMemoryFacetQueryEvidenceV2`。view 决定可读 bucket：current 默认不读取 historical；timeline 才同时读取当前、历史和事件；explanation/conditions 优先对应 cause/condition。最终返回精确 L1 statement、memory ID、时间和 evidence refs，并受 item/char 双预算限制。
- 没有新增第二套语义支持判定器。需要回答前 claim-level 校验时继续复用既有 L0-direct `MemoryEvidenceSupportVerifierV1`，避免 Facet V2 再复制 coverage/support 架构。
- 用 AMB 题 `4b803069-7679-411e-8310-d885e6ed1e7d` 的 retrieval query 做真实 probe：planner 选择唯一 investment community facet 与 current view，selector 只返回 1 条当前正面 evidence（151 chars），没有把旧负面状态注入。backfill 命中本地缓存，query planner 新调用为 387 prompt / 60 completion tokens、0 repair。该 evidence 与 gold option c 一致，但本次未执行回答模型，因此不把它计为 accuracy 改分。
- 产物：`benchmarks/amb/runs/facet-shadow-malia-query-v1.json`；日志：`logs/amb/facet-shadow-malia-query-v1.jsonl`。下一门禁是多 persona shadow backfill + query A/B，冻结通用策略后再接产品持久化和读取 composition。

### M4e：全历史回填、失败隔离与证据单元批处理

- 直接扩大到 Malia 全部 74 条 atoms 后，任意 12-row 分批暴露两个真实协议问题：模型会把 state 的 same_state target 指向 event，或把 memory ID/虚构值当 facet ID。state relation 的非 state target 现在由代码做单向削弱：删除无效 target，空 target 降为 initial，并记录 `normalizedRelationCount`；跨 facet target、未知 target 和未知 facet 仍严格拒绝。
- 单次 repair 后仍非法时，不再让一条坏 decision 毁掉整批。salvage 对每条 decision 独立执行完整 schema/scope/ID 校验，只保留可独立成立的 decision，其余进入 deferred；shadow 在主批次后只重试 deferred。事件新增 salvaged 与 salvagedDecisionCount，不能把局部降级伪装成正常成功。
- 批处理从任意 row count 改为 evidence-reference 连通分量：共享 exact evidence ref 的 event/profile/semantic 不可拆开；同一来源的独立连通分量按时间装入最多 16 条的批次。Facet identity prompt 同时要求 canonical key 为中性侧面，即使状态反转仍成立，禁止 stopped/avoidance 等当前值或极性进入身份。
- 第一次整文档批处理把 31 条 observation 挤进一个单元，超过 16 个新 facet 上限并造成旧证据延后，诊断失败；改为 evidence span 连通分量后，完整 74 条成功得到 19 facets、74 memberships、0 unassigned。关键旧 forum avoidance 与新 community engagement 同属 `community.participation`；旧负面为 historical，当前只有 `semantic-9e216e9de0f7d46d` 正面状态。包含 query 的完整运行为 8 remote calls、38,568 prompt、10,538 completion、3,712 provider cache-hit tokens、1 repair、1 salvage、1 deferred retry batch。
- 完整目录下 query planner 首次仍因宽词 investment 多选 3 facets。契约收紧为“单一具体侧面只能选一个最佳 facet；只有明确多侧面问题才多选”后重放成功：完整 backfill 为 7 local cache hits、0 remote backfill calls；query 仅选 `community.participation`，只返回 151 chars 的当前正面 evidence。新增 query 调用为 2,419 prompt / 56 completion tokens、0 repair。
- 成功产物：`benchmarks/amb/runs/facet-shadow-malia-full-v5.json`、`benchmarks/amb/runs/facet-shadow-malia-full-v5-query-replay.json`；日志为同名 JSONL。该结果证明已知 Malia 错因在完整历史干扰下被结构性修复，但仍不是 accuracy 分数。剩余门禁是多 persona A/B；另需观察现有 L1 中同时包含多个侧面的宽 profile atom 是否应在写入层进一步原子化。
- 最终 memory-plugin 全量为 107 pass / 0 fail / 467 expectations；memory-plugin 与 AMB TypeScript typecheck、Facet 相关 Biome 检查全部通过。已删除被成功 v5 替代的 7 个 v1–v4 失败报告/日志；模型响应缓存与成功产物保留，可继续做低成本重放。

### M4f：冻结 Persona 答题闸门与查询视图补全

- 新增 `run_facet_persona_holdout.py`。它复用内容无泄露的 persona-disjoint plan、相同 DeepSeek Flash 答题器和 AMB 判分，逐 Persona 运行完整 Facet shadow、保存断点、独立诊断报告与 JSONL，并与冻结 M3 tool-driven 逐题比较；聚合报告不保存题目、答案、原始 persona ID 或上下文。
- 第一题暴露了 query view 缺口：`I spent some time at a film discussion club` 被判成 current，正确的旧 surface-level 经历虽已保存在 historical/event，却未进入答案上下文。新增 `recollection` view；具体经历优先 event/history，并在 Facet 内用确定性多语言词项相关性排序，不增加模型调用。
- 推荐题暴露了 current 视图会过滤已发生经历。新增 `decision` view，组合 condition/current/context/supporting/event/history，并允许推荐/决策为不同喜恶和约束选择 2–4 个具体 Facet；事实、状态、历史和因果问题仍保持单 Facet。查询层明确拒绝可由具体 Facet 替代的 umbrella facet。
- 增加 Facet source admission 边界：semantic/episodic 永久属于 L1 source；短 profile 只作为旧数据迁移桥；超过 320 字符的 L3 rollup 拒绝反向喂给 Facet，避免派生画像与自身证据竞争。真实 Marcus 题中 1,122 字符 `film.interest` 汇总被排除，改为 277 字符单侧面状态，且报告记录 `excludedDerivedProfileCount`。
- 四 Persona gate 最终仍为 Facet 1/4（25%），冻结 M3 baseline 为 2/4（50%）：1 个共同正确、2 个共同错误、0 个 Facet recovery、1 个 Facet regression。平均 Facet 上下文约 2.5k 字符；结果不允许把 Facet 接为产品默认，也没有扩大到 12 Persona。
- 唯一 regression 的 L0 同时明确支持两个备选：旧俱乐部讨论 surface-level，后来新俱乐部 casual/diverse 且体验更好；AMB 只接受前者对应的 d。删除后者可以对齐单题标签，但会删除真实记忆，因此未采用。

### M4g：复用 L0 Support Verifier 的负结果

- shadow runner 增加可选 `PAW_AMB_FACET_DECISION_QUERY`：完整决策问题先由既有 `MemoryEvidenceCoveragePlannerV1` 拆成动态 discriminants，可扩展已知 Facet；随后回读 exact L0 spans，并复用 `MemoryEvidenceSupportVerifierV1` 产生 supports/contradicts/unknown。没有新增第二套 verifier，所有扩展仍为精确已知 ID，日志只记录计数。
- Python runner 以 `--verify-support` 显式开启该诊断，默认关闭。验证后的 requirement 和 evidence label 可进入 AMB answer context，但生产路径未接线。
- support gate 仍为 1/4，没有任何逐题变化；平均上下文约 5.0k 字符，每题额外 1 次 coverage planner 与 1 次 verifier。错题抽查中，多个备选均有 exact L0 支持且无直接反驳：例如 Marcus 同时真实做过 podcast、blog、film festival、film club，也真实经历过 forum 失败。瓶颈已转为“多条真实经历下的最佳回复偏好”，不是继续扩大 memory recall。
- 因准确率零收益且成本增加，support verification 只保留为证据审计/安全门禁，不作为默认提分组件。Facet V2 继续保持 shadow-only。下一结构性工作应移到新写入时的 L1 原子性和 scene/source identity，减少旧 profile 兼容桥；不能继续为 4 道已打开题增加读取规则。
- 最终 memory-plugin 全量为 110 pass / 0 fail / 476 expectations；Python persona/Facet 8 tests、memory-plugin 与 AMB TypeScript typecheck、相关 Biome 和 `git diff --check` 全部通过。

### M4h：把原子性前移到 L1 写入契约

- 根因复核发现旧 extractor 明确要求把“旧状态、变化原因、新状态、结果”全部合成一条 statement；这会制造累计 profile，并让后续 Facet 无法恢复独立状态。extractor 升级为 `v5:atomic-state`：profile/semantic 每条只能表达一个可独立验证的状态或 claim；同一事件身份的 trigger/action/result 仍可保留为一个 episodic causal unit。
- 偏好演化现在要求：新状态单独写 profile/semantic，变化原因/过程另写 episodic，旧状态由 conflict stage 的 target 关系连接，不再复制到新 profile。现有 candidate 只作冲突上下文，禁止把 candidate 汇总拷进新 statement。
- 增加确定性尺寸门禁：profile/semantic 最多 320 字符、instruction 512、episodic 1,024。超限走既有一次 validation repair；repair 明确禁止为了 atom 数量预算合并独立侧面、活动或状态。版本升级使旧响应缓存不会伪装成新 writer 结果。
- 新增累计 profile repair 回归：首轮长画像被拒绝，第二轮重抽为单一状态；同时保留既有 source-grounded causal episode 提示词稳定契约。完整 memory-plugin 为 111 pass / 0 fail / 480 expectations，typecheck、相关 Biome 与 diff check 通过。
- 该改动只影响新写入和未来重建，不能 retroactively 修复冻结 AMB store。下一次准确率验证必须在未使用的 Persona/dev 数据上做完整 L0→新 L1→Facet 冷重建，并单独记录 writer repair 率、平均 atom 字符数、超长 rollup 拒绝数和端到端答题；不能复用本轮已打开 4 题宣称提分。

## 2026-08-26 — M5a：AspectGraphV1 Shadow 真值模型

### 为什么替换 Facet 的底层模型

- 红队审查确认 Facet V2 的三个结构约束不能靠查询 prompt 修复：一条 claim 被限制为单 facet；首次 LLM canonical key 同时决定语义和永久 ID；supports/cause/condition 等关系在八桶投影后失去具体邻接。M5 不再给七类 query view 增加规则，先替换 shadow 真值模型。
- 本切片仍严格位于 `@paw/memory-plugin`：没有数据库 migration、没有 Runtime/agent-loop 改动、没有 product composition 接线，也不改变 M3 或 Facet V2 的现有行为。

### 新数据模型与不变量

- 新增 shadow-only `MemoryAspectGraphSnapshotV1`，把 `Claim`、`Aspect`、`ClaimAspectMembership`、`EvidenceEdge`、`AspectTransition` 分成独立一等记录。一条 claim 允许 0..N 个 aspect membership，解决一个 episode 同时支撑活动、偏好、社交和约束的问题。state/event/cause/condition role 属于 membership 而不是 claim：同一 episode 可以在电影侧面是 event、在社交侧面是 cause。
- Aspect ID 由精确 scope 与 opaque `identitySeed` 派生，不再由 display name/canonical key 派生；display name 和 aliases 可以更新而 ID 不变。merge/split 以 append-only transition 保存，旧 aspect 通过 redirect 指向新身份，历史不会被原地改写。
- typed edge 完整保存 `same_state/supersedes/contradicts/supports/qualifies/caused_by/derived_from` 的 from/to 邻接。确定性 current-state projector 只根据显式 active `supersedes`、valid time 和 role 生成 current/history/future，同时把相邻外部 claim ID 与原始 typed edges 一并返回，不再把图压平后丢边。
- Graph validator 对 dangling claim/aspect、非法 scope、redirect/transition 不一致、redirect cycle、supersedes cycle、反向 valid-time supersedes、非规范时间和 content revision tampering 全部 fail closed。Claim 与 transition 为 append-only；membership 和 edge 只能显式切换 active/retracted 生命周期，身份、角色、置信度、时间和 provenance 不允许借同 ID 静默改写。
- 发布快照与嵌套数组全部深冻结，revision 对完整规范化内容寻址。`paw.memory-aspect-graph-event.v1` 日志只记录 scope fingerprint、revision、各类数量、耗时和 reason code，不记录 label、claim ID 或证据正文。

### 分层结构评测

- 新增 `evaluateMemoryAspectGraphStructureV1`，不运行检索器或答案模型即可分别报告：跨不同 aspect ID/名称的 claim pairwise precision/recall/F1、精确 typed-edge precision/recall/F1、current-state micro F1 与 case exact match。
- 评测使用不可变 claim ID 对齐，因此可以直接区分“语义归组错、关系边错、当前状态错”，避免继续只看 PersonaMem 最终选项而无法定位损失发生在哪一层。

### 当前验证与下一门禁

- 新增多对多、identity rename、merge inheritance、split ambiguity、typed adjacency、current/history、非法时间、DAG cycle、append-only、edge retraction、deep freeze、revision tamper、输入顺序无关和 content-free telemetry 用例；结构 evaluator 另覆盖 label/ID 无关的 pairwise 对齐及三类错误分诊。
- AspectGraph 定向为 11 pass / 0 fail / 34 expectations；memory-plugin 全量为 122 pass / 0 fail / 514 expectations。memory-plugin TypeScript typecheck 与新增文件 Biome 检查通过。
- 本阶段只证明新 schema/reducer/evaluator 的不变量，不宣称 AMB/PersonaMem accuracy 提升。下一切片是旧 Facet/atom 到 AspectGraph 的只读迁移桥与人工结构 gold gate；只有 pairwise F1、edge F1、current-state accuracy 通过后，才在未见 persona 上用 atom v5 做 L0 cold rebuild。

### M5b：Facet Shadow 只读迁移桥

- 新增 `migrateMemoryFacetShadowToAspectGraphV1`，将现有 Facet shadow 的 entry、facet、membership 和显式 link 无 LLM 地投到 AspectGraph。Facet ID 只作为 opaque identity seed；旧 canonical key 降为 alias，不再成为永久 ID。
- `state_change→supersedes`、`same_state→same_state`、`context_variant→qualifies`、`supports→supports`，from/to 邻接完整保留。旧 deferred atom 仍迁移为带 provenance 的 claim，但保持零 membership，不为覆盖率强行归类。
- 迁移器不猜第二 aspect、不自动 merge/split，也不修复旧 Facet 决策；因此它是结构 baseline，不是新算法成绩。迁移后立即经过 AspectGraph 的 scope、provenance、时间、DAG、revision 和 dangling-reference 校验，非法旧数据 fail closed。
- 新增迁移 telemetry，只记录 source/target revision、claim/aspect/membership/edge/unassigned 数量、耗时和 reason code，不记录 facet 名称或证据正文。定向测试覆盖 state history、event、cause、support adjacency 与 deferred 零归属。
- AspectGraph、结构 evaluator 与迁移桥定向共 13 pass / 0 fail / 48 expectations；memory-plugin 全量为 124 pass / 0 fail / 528 expectations。TypeScript typecheck 与 7 个新增/变更文件的 Biome 检查通过。

### M5c：真实稀疏 Gold 与分层结构门禁

- 新增版本化 `MemoryAspectGraphGoldV1` 与严格 parser。Gold 只允许 immutable claim ID、same-aspect 布尔、typed-edge 布尔、anchor claim、as-of time 和 expected current claim IDs；任何额外字段（包括 benchmark answer）均拒绝。Gold 绑定 content-addressed claim corpus revision，换语料后不能沿用旧标注。
- 新增 label/ID 无关的 sparse evaluator：pairwise 通过“两个 claim 是否共享任一 resolved active aspect”评分；edge 通过精确 from/to/type 与 active status 评分；current state 通过 anchor claim 找 aspect 后比较集合。三层分别输出 confusion matrix、accuracy、precision/recall/F1，current 另报 case exact match。
- 新增 content-free `run_aspect_graph_structure_gate.ts`。它读取现有 Facet shadow report、验证精确用户 scope、无 LLM 地迁移 baseline、加载 gold、写独立结构报告和 JSONL；输出不含 statement、facet 名称、问题、选项或答案。
- 首批真实 gold 使用已打开的 Malia 74-claim 诊断语料，只用于结构开发，不用于宣称 PersonaMem 泛化。人工标注 46 个 claim pairs、23 个 typed edges、10 个 current-state cases；包含旧 Facet 内部正负样本，也刻意覆盖 board/video game、cooking/gardening、预算方式以及宽 rollup 应多归属的跨 Facet样本。
- 旧 Facet→AspectGraph baseline：19 aspects、74 memberships、49 edges；pair accuracy 41/46=89.1%，F1=91.2%，5 个错误全部是 should-share 的漏归属、0 个误合并；edge accuracy 15/23=65.2%，6 false-positive、2 false-negative，F1=78.9%；current-state exact 7/10=70%，micro F1=82.4%。最大单 aspect 覆盖 17.6% claims。
- 结果把最终答题前的损失定位清楚：单归属直接造成 5 个跨 aspect false-negative；旧 linkKind 把 qualifier/support 错标为 same_state/supersedes；umbrella facet 让 blog anchor 带入 podcast 当前状态，宽 finance-learning facet 也生成额外 current states。下一步应实现一个支持 multi-membership、typed-edge 和显式 retraction 的 Aspect Linker，而不是修改 answer prompt。
- lifecycle 随之补齐：错误 membership 现在可显式 retracted，保留历史但不再参与 projection、metrics 或 gold evaluation；edge 同理。定向测试覆盖 retraction，旧 Facet baseline 重跑数值不变。
- 产物：`benchmarks/amb/gold/aspect-graph/malia-structure-v1.json`、`benchmarks/amb/runs/aspect-graph-malia-facet-baseline-v2.json`；日志：`logs/amb/aspect-graph-malia-facet-baseline-v2.jsonl`。最终 memory-plugin 为 126 pass / 0 fail / 539 expectations；memory-plugin 与 AMB TypeScript typecheck、10 个相关文件 Biome 检查均通过。

### M5d：状态作用域、单调生命周期与无歧义结构 Gold

- Aspect 状态不再只由 `aspectId` 决定，而是使用 scope-bound 的 `subjectKey + aspectId + contextKey` 状态键。`supersedes/same_state/contradicts/qualifies` 必须声明精确状态作用域，且两端 claim 必须都属于该状态键；因此工作场景的状态变化不能误伤个人场景，也不能把别人的状态串到当前用户。
- 状态投影在存在多个 subject/context 时拒绝自动猜测，调用者必须显式选择；只有唯一状态维度时才允许省略。supersedes DAG 也改为按状态键分别校验，不再用一张全局图互相污染。
- membership 与 edge 不再原地切换 status。撤销改为 append-only `MemoryAspectLifecycleEventV1`，保留 reason、evidence 和 occurredAt；相同目标只能有一个不可变撤销事实。mutation 增加可选 `expectedRevision` compare-and-swap 守卫，供后续存储适配器防止并发覆盖。
- 生命周期投影按 `asOf` 生效：4 月发生的撤销不会倒改 3 月历史视图。当前 metrics 使用全部已发生撤销，历史 projector 则只使用查询时间之前的事件。
- split 改为“导航已分叉、旧宽泛证据待重分类”：旧 source membership 不再自动复制进所有子 Aspect，而是通过 `unresolvedClaimIds` 暴露；只有明确写入子 Aspect 的 claim 才进入子主题状态。
- current-state gold 从单个 `anchorClaimId` 改为 `anchorClaimIds` 交集定位。多个 anchor 必须恰好共同确定一个 subject/context/aspect 状态；0 个或多个候选均 fail closed，禁止把一个多主题 anchor 的所有当前状态做 union 后误判。
- 新增跨 context replacement、状态键端点校验、projection 歧义拒绝、revision 冲突、倒序撤销、撤销不可改写、历史 `asOf`、split unresolved 和多 anchor gold 用例。memory-plugin 全量为 130 pass / 0 fail / 551 expectations；memory-plugin 与 AMB TypeScript typecheck、10 个相关文件 Biome 检查通过。
- Malia 74-claim Facet 迁移基线重跑至 `benchmarks/amb/runs/aspect-graph-malia-facet-baseline-v3.json`，JSONL 为 `logs/amb/aspect-graph-malia-facet-baseline-v3.jsonl`。pair accuracy 仍为 41/46=89.1%，edge accuracy 15/23=65.2%，current-state exact 7/10=70%；分数不变说明本轮收紧了污染边界和审计正确性，没有伪装修复旧 Facet 上游的漏归属与错关系。
- 当前仍是 shadow-only 真值层：没有数据库持久化、没有 Aspect Linker、没有新 L1 cold rebuild，也没有接产品读取 composition。下一切片应实现 ID-only Aspect Linker，并在未见 persona 上生成 multi-membership 与 typed edges，再与本 baseline 做结构 A/B。

### M5e：单次调用、候选有界的 AspectLinkerV1

- 新增 shadow-only `AspectLinkerV1`。输入只允许已经存在于同 scope AspectGraph 的待归类 claim、最多 6 个候选 Aspect、每个最多 3 条代表 claim，以及每条新 claim 最多 12 个精确关系候选；单批最多 16 条 claim、每条最多 4 个 membership、新建 Aspect 最多 4 个。Linker 不读取整张图，也没有数据库或 Runtime 权限。
- 模型只输出 ID-only proposal：每条 claim 的 `link/defer`、0..N Aspect membership、membership role，以及候选 claim 之间的 `same_state/supersedes/qualifies/supports`。模型不能输出 subject/context、persistent ID、state key、时间、evidence refs、lifecycle、merge/split 或 retraction。
- 热路径严格最多 1 次模型调用，不做 repair。模型失败、截断或严格解析失败时，整批转为显式 defer，不写 membership/edge；取消仍抛出 `AbortError`。content-free telemetry 记录 `modelCallCount=0|1`、候选与产物计数、settlement、reason code 和耗时，不记录 claim ID、标签或正文。
- scope、默认 subject、`global` context、opaque Aspect ID、membership/edge ID、时间、provenance 和 revision 全由代码生成。新 Aspect ID 来自 graph revision、packet-local proposal key 与确定性 member receipt，模型不能直接选择持久 ID；与已知候选 display/alias 精确重名时强制复用已有 Aspect。
- 提交前先对临时 mutation 执行完整 AspectGraph 校验：未知 ID、候选外目标、跨 Aspect 端点、缺失 exact state membership、非 state/fact 的状态边、supersedes 时间反向、DAG cycle、重复 membership/edge 均拒绝。`linkingRevision` 绑定完整 proposal 产物，`applyMemoryAspectLinkingV1` 再验证结果哈希与 source revision CAS，防止调用方篡改或旧结果覆盖新图。
- 候选代表必须来自当前 scope 的默认 subject + `global` context 且 membership 未在 `observedAt` 前撤销，避免把工作等其他场景证据冒充全局状态。第一版故意不让模型选择 context；需要新的 context catalog 和独立 gold 后才开放。
- 新增多归属、typed supports、scoped supersedes、新 Aspect 确定性重放、虚构 target、非法 state role、错误 context、结果篡改、单调用 defer、模型失败和 cancellation 用例：7 pass / 0 fail / 24 expectations。memory-plugin 全量为 137 pass / 0 fail / 575 expectations；memory-plugin 与 AMB TypeScript typecheck、相关 Biome 检查均通过。
- 本切片只证明 Linker 协议和提交边界，不宣称 Malia 或 AMB 分数提升。尚缺确定性 candidate builder、DeepSeek shadow backfill runner、Linker 响应缓存和结构 A/B；下一步先在已知 Malia 结构 gold 上做开发诊断，再冻结协议到未见 persona，不能直接接产品路径。

### M5f：AspectLinkerV1 红队加固与双时间语义

- 独立 agent 红队未发现 P0，但在真实 DeepSeek A/B 前识别出五个 P1：模型置信度为 0 仍可提交、代表证据会在 prompt 多处重复、claim ID 与 statement 未绑定内容收据、未来状态可能提前 supersede，以及 linking revision 未绑定完整输入包。本切片修复这些边界，不调整 AMB 答题 prompt，也不接产品默认路径。
- EvidenceEdge 新增独立 `effectiveFrom`。`createdAt` 表示系统何时写入关系，`effectiveFrom` 表示关系在用户事实时间上何时生效；投影必须同时满足两者。Linker 对 supersedes 使用 `max(observedAt, sourceClaim.validFrom)`，因此三月获知“六月开始的新偏好”不会在三月提前淘汰旧状态。
- Linker 输入中的 claim 与 representative 增加 statement hash；`linkingInputRevision` 绑定 scope、graph revision、observedAt、全部候选 ID、statement hash、策略上限和置信阈值。最终 `linkingRevision` 再绑定该输入收据与物化产物。该机制能发现包内错配和结果篡改，但当前 AspectGraph claim 不保存 L1 statement hash，因此它不是对权威 L1 store 的端到端真实性证明；接持久化适配器时仍需由适配器校验 authoritative statement receipt。
- prompt 改为单一 evidence dictionary：正文只出现一次，claims、Aspect representatives 和 relation candidates 只引用精确 claim ID。单 statement 上限 1,024 字符，完整 system+user 上限 48,000 字符；超预算在模型调用前 fail closed，避免候选扩张把成本放大。
- membership/edge 分别增加 0.80/0.85 的确定性置信门槛。重名检查从“本批候选”扩大到图中全部 active Aspect，候选召回漏掉已有 Aspect 时模型也不能创建同名副本。已部分归属的 claim 可以补充缺失的第二 Aspect，但不能重复提交已有 claim+Aspect membership。
- 新增输入内容收据、prompt 去重、隐藏同名 Aspect、部分多归属、未来 supersedes 和低置信拒绝边界测试。memory-plugin 全量为 142 pass / 0 fail / 589 expectations；memory-plugin 与 AMB TypeScript typecheck、相关 Biome 检查均通过。
- Malia 迁移基线无模型重跑至 `benchmarks/amb/runs/aspect-graph-malia-facet-baseline-v4.json`，日志为 `logs/amb/aspect-graph-malia-facet-baseline-v4.jsonl`。由于 edge receipt 加入 `effectiveFrom`，graph revision 按预期变化；pair accuracy 41/46=89.1%、edge accuracy 15/23=65.2%、current-state exact 7/10=70% 均与 v3 相同，说明本轮加固没有把旧 baseline 伪装成提分。
- 下一门禁不是立刻调 DeepSeek：先实现纯确定性的 Candidate Builder，并在 gold 上分别记录 Aspect candidate recall、relation target recall、平均/最大 prompt 字符数和候选截断率。只有候选召回覆盖 gold 且预算稳定，才增加内容寻址响应缓存与 DeepSeek shadow runner，先做 Malia claim-only cold rebuild，再冻结到未见 persona 做结构 A/B。

### M5g：确定性 Candidate Builder 与关系证据解耦

- 新增纯代码 `MemoryAspectCandidateBuilderV1`。它只读取同 scope、默认 subject、`global` context、`observedAt` 已生效且未撤销的 membership；固定最多 6 个 Aspect、每个 3 条 identity representative、每 claim 最多 12 个 relation target。输入 statement receipt、候选产物、策略模式和截断计数均进入 content-addressed candidate revision。
- 候选正文仍只进入统一 evidence dictionary 一次。Aspect representative 与 relation evidence 被拆成两个预算：前者只负责解释 Aspect 身份，后者按 Aspect rank 以 4/3/3/2 名额选择关系目标。关系 target 不再被强制挤进 3 条展示样例；Linker 仍要求每个 target 有精确 statement receipt 且位于该 claim 的 relationCandidates。
- 第一次 Malia 门禁中 Aspect 召回 60/62=96.8%，但 relation target 只有 12/17=70.6%。分层诊断确认 17/17 的目标 Aspect 都已召回，损失发生在 representative/全局 target 截断。解耦后 relation target 17/17=100%，最大 prompt 约 12.6k 字符。
- 冷重建进一步暴露 persona name 和通用 finance 词会让所有 Aspect 得到微弱正分。候选评分升级为库内 IDF：全库共有词权重归零；identity 至少命中 1 个辨别词，member evidence 至少命中 2 个辨别词才可进入候选。最终无模型门禁 `aspect-candidate-malia-v7.json` 为 positive Aspect recall 60/62=96.8%、negative exposure 7/30=23.3%、edge Aspect recall 17/17、edge target recall 17/17；平均/最大 prompt 约 11.5k/12.7k 字符。
- 新增多 Aspect recall、scope/context 隔离、statement receipt、稳定去重、预算截断、relation-only evidence、部分归属和 missing-membership 排除用例。Candidate relation target 对多归属 claim 按首次排名稳定去重，避免同一 ID 从两个 Aspect 重复出现后触发输入校验。

### M5h：DeepSeek Claim-only Cold Rebuild 与两阶段收敛

- 新增 `run_aspect_linker_shadow.ts`：从只含 74 个 immutable claim 的空 AspectGraph 开始，不复用旧 Facet membership/edge；支持 singleton/evidence batch、内容寻址本地响应缓存、DeepSeek provider KV 指标、每批原子 checkpoint、resume、content-free JSONL、未归属 retry、missing-membership enrichment 和巩固后 recovery。报告与 checkpoint 只写 shadow artifact，不改数据库和产品路径。
- 原单次 combined membership+edge 冷重建不合格：74 claim 最终只有 6 Aspect、56 memberships、55 edges、20 未归属；pair accuracy 65.2%、edge accuracy 34.8%、current exact 0%。104 calls 使用 277,900 prompt tokens，provider KV hit 52,480（18.9%）。失败原因集中为低置信 edge、候选外 target、target membership 缺失和整批失败，证明把归属与连边塞进一次 proposal 会放大失败半径。
- 架构随之拆为两阶段。第一阶段 singleton membership-only：不提供 relation evidence、不允许 edge；candidate 无辨别 overlap 时允许新建 Aspect。74 claim 冷建得到 12 Aspect、74 memberships、7 个多归属 claim、10 未归属；pair accuracy 80.4%、precision 100%、recall 70.9%、F1 83.0%。95 remote calls + 2 local cache hits，223,072 prompt / 8,447 completion tokens，provider KV hit 48,640（21.8%）；平均/最大 prompt 约 7.6k/11.1k chars。
- 通用 Linker 直接跑第二遍前 32 条没有任何新增 membership，因此被停止，没有把无收益重跑接为默认。专用 missing-membership pass 会从候选中删除已有 Aspect，固定 `maxNewAspects=0`、禁 relation；无缺失候选时不调用模型。完成后 93 memberships、22 个多归属 claim，pair accuracy 84.8%、precision 100%、recall 77.4%、F1 87.3%。
- 巩固后只对 10 个仍未归属 claim 做一次 recovery，1 条成功，最终 12 Aspect、94 memberships、22 个多归属 claim、9 未归属；pair accuracy 40/46=87.0%、precision 100%、recall 80.6%、F1 89.3%。它比 combined 版本显著改善，但仍比旧 Facet migration baseline 的 41/46=89.1%、F1 91.2% 少 1 个正确 pair，不能宣称已经超越。
- 当前 Edge/Current 分数仍不代表最终两阶段架构：membership-only 图按预期没有 edge，edge accuracy 仅来自 negative annotations，current exact 为 0。下一切片必须实现独立 Edge Linker：输入只能是已提交且共享 exact Aspect/state scope 的 membership，对每条已知候选边输出 typed edge 或 defer；不能创建/修改 Aspect 或 membership。完成 edge/current 结构门禁后，才能决定是否实现高置信 Aspect consolidation，再冻结到未见 persona。
- 保留产物：`aspect-candidate-malia-v7.json`、`aspect-linker-malia-cold-v2.json`（combined 负结果）、`aspect-linker-malia-membership-v3.json`、`aspect-linker-malia-missing-membership-v5.json`、`aspect-linker-malia-recovered-v6.json` 及对应 JSONL/checkpoint。已删除被替代的 candidate v5/v6、combined v1 partial 和无收益通用 enrichment v4 partial。

### M5i：独立 Edge Linker、关系精度闸门与状态谱系投影

- 经过独立 agent roundtable 与本地复核，Edge 阶段被固定为只读已提交 `subject + Aspect + context` membership、只写 typed edge 的插件内组件；它不能创建、合并、拆分或修改 Aspect/membership，也不侵入 Runtime。输入按 source claim 分包，每个 target 必须来自同一精确状态域并携带代码生成的 allowed proposal；模型逐 target 输出 `edge/no_edge/defer`，代码校验 ID、方向、role、时间、置信度和 graph revision 后一次 CAS 提交整批结果。
- 新增确定性 `MemoryAspectEdgeAdmissionV1`。模型提议后、图提交前，使用 role、变化/因果/条件 cue 与 IDF discriminant overlap 做精度闸门；`same_state` 规范成无向语义，活动重复边被拒绝，edge provenance 合并两端 evidence refs，`effectiveFrom` 取观测时间和两端事实时间的最大值。日志只保存 state/source receipt hash、数量、耗时和 reason code。
- 新增 anchor-aware `projectMemoryAspectStateLineageV1`。同一宽 Aspect 内只沿 `same_state/supersedes/qualifies/contradicts` 连接状态谱系；`supports` 只用于从 event/evidence 定位谱系，不再把两个不相关状态族合并。多 scope、多谱系或无 seed 均 fail closed。
- Candidate gate 在 Malia dev gold 上有 82 packets、295 targets，12/12 structurally eligible positive edge 都进入 top-5；但另 5/17 positive edge 被上游 membership 缺失或 split Aspect 阻断。经过 admission 的结构 oracle 为 11 true positives，edge accuracy 17/23=73.9%、precision 100%、recall 64.7%，这是当前 membership 图上的上限诊断，不是公开榜成绩。
- DeepSeek top-5 初判经 admission 后为 9 true positives，edge accuracy 15/23=65.2%、precision 100%、recall 52.9%、F1 69.2%；current-state exact 2/10，另有 3/10 anchor ambiguity。相比无界候选，prompt 由约 178k tokens 降到主阶段约 64k tokens，并通过稳定 system prefix、content-addressed local cache 与 provider KV 统计控制成本。

### M5j：失败的二次召回/关系仲裁实验与下一瓶颈

- `MemoryAspectEdgeRecoveryV1` 只从初判 `no_edge/defer`、失败包或“泛化 supports 但存在更具体状态关系”的高信号对生成 singleton 二次判断；另增加独立 `relation_adjudication` prompt mode，明确区分 `supersedes/qualifies/same_state/supports`。仲裁结论按 pair 覆盖初判，完全相同的内容寻址 edge 视为幂等，`defer` 不覆盖。
- 普通 singleton 二次召回 v4 增加 32 个复核包后仍为 edge accuracy 65.2%，只增加了 5 条未命中 gold 的 admitted edge；31 remote calls 使用 25,015 prompt / 1,401 completion tokens。关系类型仲裁正确接线后的 v6 仍为 65.2%、precision 100%、recall 52.9%，current exact 2/10；31 remote + 83 local cache hits，28,782 prompt / 1,770 completion tokens，provider KV hit 13,184 tokens。两种二次层均无准确率收益，因此保留为显式实验能力，不作为默认产品路径。
- v5 曾把 primary/adjudicator 角色接反，得到 56.5% 的污染结果；报告保留作诊断但不得用于比较。该错误促成 runner 增加独立 v6 artifact/checkpoint，并暴露、修复了相同内容寻址 edge 在 admission 前的幂等去重边界。
- 分层结论：当前 8 条 positive false negatives 中，5 条在 Edge 前已被 membership/split Aspect 阻断；剩余可见候选里模型只少 2 条 admission 可接受边，继续增加 Edge 调用的投入产出很低。下一阶段应优先做上游 `membership repair / cross-Aspect bridge candidate`，只对证据充分的跨 Aspect claim pair 提议“补 membership 或 Aspect consolidation”，然后重新跑 candidate oracle；在结构上限明显高于 73.9% 前，不再扩大 Edge prompt 或默认二次调用。
- 产物：`aspect-edge-candidate-malia-v1.json`、`aspect-edge-linker-malia-top5-admission-v3.json`、`aspect-edge-linker-malia-recovery-v4.json`、`aspect-edge-linker-malia-adjudication-v6.json` 与对应 content-free JSONL。新增模块覆盖 Edge Linker、admission、recovery、state lineage；最终 memory-plugin 全量为 163 pass / 0 fail / 662 expectations，memory-plugin 与 AMB TypeScript typecheck、9 个相关文件 Biome 检查全部通过。

### M6：开源前工作区清理

- 清理范围严格限定为可重新生成的本地运行产物：`.paw` 历史 session/state/checkpoint/index、long-run 临时 worktree、SWE compare 的 run/runtime/preflight、旧日志、Python/test cache、下载型 MemoryAgentBench 数据集和根目录诊断 JSON；同时移除误生成的 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`，仓库继续以 `bun.lock` 为唯一依赖锁文件。
- 本轮约释放 2.1 GB。本次没有删除任何 tracked 源码、测试、设计文档、依赖目录、AMB 上游固定版本、DeepSeek 本地密钥或 120-query v5 结果。
- AMB `runs` 中的历史实验暂时保留：该目录同时包含密封账本、v5 baseline/treatment/comparison、原始 stdout/stderr 和 v9 pre-license source bundle。在最终 license 与源码冻结完成前，不用整目录清理破坏审计链。
- `.gitignore` 新增 Paw Next 和 completion-gate 根目录诊断产物规则，避免同类临时 JSON 再次污染工作树。
- 清理后回归：`bun test benchmarks/amb` 为 14 pass / 0 fail / 51 expectations；Python `unittest discover` 为 27 pass / 0 fail。未发现因删除运行产物造成的 fixture 或 harness 缺失。

### M7：LongMemEval-S 500 题全量运行预检

- 为现有分层盲测 runner 新增 `--full-split`，只负责选择官方 LongMemEval-S 全集，不改变检索、回答或裁判逻辑。入口要求数据集恰好包含 500 个唯一 query ID、500 个非空隔离 user ID 和完整官方题型集合，否则在 ingest 或远程调用前 fail closed。
- 全量模式禁止结合旧 holdout exclusion；清单显式写入 `fullSplit=true`、真实题型计数和 `official-full-split-seeded-order-v1`，把“公开全量回归”与“未见 holdout”分开。
- 本地预检确认 pinned 数据为 500 queries / 500 users / 23,867 documents；题型分布为 70/56/133/133/78/30。PostgreSQL 端口和 pinned embedding server 均可用，embedding revision 与 artifact SHA 校验通过。
- 回归测试：Python AMB suite 29 pass / 0 fail；TypeScript AMB suite 14 pass / 0 fail / 51 expectations。下一步在干净 commit 上生成 source-bound release plan，再以独立 cold cache 执行 DeepSeek treatment 全量运行。
- 第一次计划预检在任何 DeepSeek 调用前发现 embedding OpenAI base URL 的 `/v1` 被错误用于 health 路由，形成不存在的 `/v1/health`。runner 现将健康检查规范化到服务根 `/health`，并覆盖带/不带 `/v1` 两种地址；Python suite 更新为 30 pass / 0 fail。

### M8：全量结果诊断、按用途预算隔离与答案契约保真

- LongMemEval-S 500 题 release-blind 运行得到 378/500=75.6%。检索命中率为 95.2%，但 842 次 memory helper 调用中有 715 次因共享的 atom prompt-token 总预算耗尽而失败：离线记忆写入先消耗额度，后续 query plan 与 evidence support 被题目顺序意外饿死。planner 完成题的正确率为 82.2%，fallback 题为 68.7%，确认这不是单纯的检索召回问题。
- 将单个共享预算改为 `memory-write`、`query-plan`、`evidence-support` 三个独立 fail-closed 配额。每个用途单独做并发、调用数和 token 预留/结算；旧 `atomBudget` 指标继续提供三者聚合值，新增 `memoryLlmBudgetPortfolio` 与 `budgetScope` 日志用于逐用途审计。这样离线建库即使合法耗尽，也不会再让在线证据规划失效。
- 在 memory plugin 增加结构化 answer contract，把 evidence resolver 已确认的回答形状、时态、角色限制、证据覆盖状态和 requirement ID 保留到最终模型边界。契约只包含控制元数据，不复制或生成事实，不改变检索文档及其排序；最终回答仍只能引用不可变 L0 证据。紧凑版将契约只附在第一条 source，避免每条文档重复。
- 云端复用完整索引完成 24 题同题集开发 A/B。预算隔离 smoke 中 memory helper 40/40 完成、0 次预算错误；精确配对的 baseline 为 16/24，紧凑 answer contract 为 17/24，转换为 1 题错转对、0 题对转错，检索指标保持相同。紧凑版与较早 verbose contract 正确性逐题相同，同时答案模型总 token 少 6,395（下降 7.3%）。
- 以上 24 题只是开发诊断，不能替代新的 500 题正式成绩；目前对外可比成绩仍为 75.6%。下一次 release-blind 全量重跑必须绑定新的干净 Git 提交和独立冷缓存，用于验证预算饥饿是否消失、六类准确率是否稳定提升。后续结构瓶颈仍包括 multi-session 答案综合、preference 推断与 `eventKey` 覆盖，不应通过扩大 prompt 临时掩盖。
- 本地验证覆盖 AMB TypeScript 20 pass、memory-plugin 全量 236 pass、Python compare 2 pass，以及 memory-plugin / AMB TypeScript typecheck；云端 smoke stderr 均为空。所有正式与开发运行均保留独立 stdout、stderr、检索 JSONL、输出报告和密封账本，日志不写密封种子、题目标识或原始 benchmark 内容。

### M9：LongMemEval-S 本地可复现工作区

- 云端与本地 LongMemEval-S 原始文件逐字节校验一致：277,383,467 bytes，固定 SHA-256 为 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`，AMB upstream 固定提交为 `62364d7ead2dc1a7225d6daf4ae23f303b925b40`。本地文件继续位于 upstream 约定的 gitignored `.datasets/longmemeval/`，不复制第二份大文件。
- 新增 `local_longmemeval.py`。`verify` 在不启动数据库、embedding 或 LLM 的情况下校验文件大小、哈希、上游提交、500 个唯一 query、500 个隔离 user、23,867 个 document 及六类题目数量；`run --mode smoke|full` 统一做本地服务预检、私密 seed 管理和 runner 参数装配，不把 seed 输出到命令行或日志。
- 本地 Windows PostgreSQL `127.0.0.1:54329` 与固定 embedding 服务 `127.0.0.1:18081` 完成端到端验证。首次 retrieval-only smoke 处理 6 用户 / 277 文档，约 84 秒完成 3,007 个必需 embedding，6 题命中 gold 文档 5 题，hit rate / macro recall 均为 83.3%，未调用 DeepSeek。
- 相同 smoke 使用 `--reuse-index` 再跑时，覆盖门禁确认 3,799/3,799 个派生条目、3,007/3,007 个必需 embedding、0 个不完整用户；索引复用阶段约 0.84 秒，证明本地可以在首次小规模建库后快速迭代。结果、store、cache 与密封账本位于 gitignored local run 目录，content-free 检索日志沿用 `logs/amb/`。

### M10：独立 Memory Core、稳定 KV 前缀与紧凑证据地址

- 将 evidence-first 的唯一实现下沉到 `packages/memory-core`，Paw 插件原路径改为一行兼容转发。Core 完整依赖闭包不含任何 `@paw/*` 包，独立拥有 package/tsconfig/README、结构端口和 56 个测试，可作为单独 Git 仓库上传；许可证仍由仓库所有者显式选择，当前保持 `private: true`。
- `MemoryWriterModelV1`、context packet contract、product scope/provider/archive ports 从运行时实现中拆出。新增确定性的内存参考 store，独立用户无需 PostgreSQL 或 Paw Runtime 即可写入 L0/L1 并跑通 L1 导航到 L0 hydration；同一 evidenceRef 的冲突改写 fail closed。
- 核心源码经过 Biome 整理并移除 non-null assertion，`memory-core` 与 `memory-plugin` 分别 typecheck 通过，记忆相关回归 240/240 通过。独立 core 源码 lint 0 diagnostics。
- AMB answer/judge 适配器将稳定 JSON schema 从变化的 user prompt 尾部移到 system 前缀，缓存策略随语义升级，测试保证不同题目共享完全相同的 schema 前缀。该改动不改变模型、工具或答案契约，需在新冷缓存运行中量化 provider KV 收益。
- evidence-support selector 使用 `e1..eN` 的短期 opaque 地址替代模型可见的长 evidence path，并删除冗余 sourceId；代码在模型返回后映射回权威 evidenceRef，仍拒绝虚构或重复地址。既有长地址解析保持兼容，便于读取旧缓存。新 selector 版本单独失效语义缓存。
- 正在运行的云端 v3 正式 500 题仍绑定旧干净提交，未受本地重构影响；192/500 阶段值为 154/192=80.21%，仅作进度观察，不作为最终成绩。
