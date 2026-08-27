# TencentDB Agent Memory 源码分析与 Paw 优化路线

## 1. 本次分析范围

分析对象固定为腾讯官方仓库 `Tencent/TencentDB-Agent-Memory` 的两个源码快照：

| 快照 | 本地路径 | 固定提交 | 用途 |
| --- | --- | --- | --- |
| 当前默认分支 `feat/server_team` | `E:\A_Louis\TencentDB-Agent-Memory` | `97f94654280b2932c35ba4806a491999ed244cc9` | 分析 2.0 beta 的 Memory Hub、团队资产、Proxy 注入和 KV cache 方案 |
| `main` | `E:\A_Louis\TencentDB-Agent-Memory-main` | `3f11f6bf67a800a3a00b7d5fba3e3a8acae92ca0` | 分析 0.3.6 中较集中的四层记忆、检索、去重和异步提炼实现 |

本机到 GitHub 的 Git 传输端口反复连接失败，因此两个目录是通过 GitHub API 与官方 codeload 下载、按提交 SHA 固定的源码快照，不含 `.git` 历史。源码分析不受影响；后续若要追提交历史、执行 `git blame` 或直接 pull，需要网络恢复后重新 clone。

腾讯仓库为 MIT License。当前默认分支处于快速迭代的 2.0 beta，不能把 beta 的部署复杂度和接口稳定性等同于成熟 SDK。

## 2. 一句话结论

腾讯方案最有价值的部分是：

> 把“记忆写入流水线”和“模型上下文投影”彻底分开；后台把原始对话逐层提炼，前台只固定注入稳定、体积小的导航信息，动态细节由工具按需查询。

这正好命中 Paw 当前的主要短板。Paw 已经有更干净的插件边界、确定性 receipt、scope 密封和 revision-safe 检索缓存，但现在只是在粗粒度会话切片上做检索，尚未形成可演化的记忆结构。继续只调 embedding 或 RRF，收益上限会很低。

## 3. 腾讯的四层记忆是怎么工作的

### 3.1 L0：不可变的原始证据

- 对话先按 checkpoint 增量捕获，原始记录追加保存。
- 记忆提炼在后台异步运行，失败不会阻塞 Agent 主链路。
- L0 保留原话，承担追溯和重新构建上层记忆的职责。

价值不在“多存一份聊天”，而在于上层摘要出现错误时还能回到证据，重新生成 L1/L2/L3。

### 3.2 L1：原子记忆

旧版核心 Prompt 一次完成场景切分与记忆抽取，主要抽出三类：

- `persona`：相对稳定的身份、偏好、习惯和特质；
- `episodic`：发生过的事件、经历和结果；
- `instruction`：用户明确要求长期遵守的规则。

每条记忆还带 priority、scene、活动时间范围和 `source_message_ids`。抽取阶段明确过滤寒暄、临时命令、无长期价值的信息，以及模型自己生成但用户没有确认的内容。

写入前不是简单做相似度去重，而是先召回候选，再让一次批量 LLM 判断：

- `store`：新事实；
- `skip`：无增量；
- `update`：新信息修正或替代旧信息；
- `merge`：多条互补记忆合成一条。

它允许跨类型、多目标合并，也会合并时间戳。这个设计对 PersonaMem 中“偏好变化”“为什么发生变化”类问题，比直接搜索整段历史有效得多。

### 3.3 L2：受限数量的场景块

L2 把大量 L1 组织成少量场景，例如“工作方式”“饮食偏好”“某项目演进”。默认优先更新已有场景，创建新场景是最后选择；场景接近上限时要求合并，默认上限约 15。

场景内不只保留总结，还能描述：

- 核心叙事；
- 演化轨迹；
- 待确认信息；
- 冲突和矛盾。

这样模型看到的是一条偏好如何演化，而不是从互相冲突的历史切片中猜哪个更新。

实现上，旧版允许 LLM 在受限目录直接编辑场景 Markdown，并在执行前备份、失败后恢复。这种做法开发快，但把文件操作交给 LLM，确定性和可审计性不够强，不建议 Paw 原样照搬。

### 3.4 L3：稳定画像与导航

L3 根据发生变化的 L2 场景增量生成用户画像，包含稳定事实、兴趣关系、交互方式、认知特征以及演化/冲突。旧版目标长度约 2000 字符；新版注入时对 L3 做上限裁剪，并在旁边放 L2 的 path + 短 summary 索引。

L3 的角色不是回答所有细节，而是给 Agent 一个稳定的长期方向；需要具体证据时再沿 L2/L1/L0 下钻。

## 4. 检索、写入与成本控制

### 4.1 早期检索

0.3.6 的本地检索是 FTS5 BM25 + dense cosine，使用 RRF（K=60）融合；腾讯云向量库路径支持服务端 dense、sparse 和 RRF 混合召回。

几个需要注意的实现边界：

- 旧版默认没有 embedding provider，未配置时所谓 hybrid 会退化成关键词检索；
- L1 去重的向量候选固定取 top-k，进入 LLM 前没有明显的相似度闸门，弱相关候选会增加判断噪音和费用；
- 自动召回的 RRF 结果没有继续使用原始相似度阈值，rank 融合可能让低质量候选进入上下文。

所以“用了 RRF”并不是它准确率提升的核心解释；真正的结构性增益更可能来自 L1 原子化、冲突更新和 L2/L3 汇总。

### 4.2 写入成本

完整流水线可能产生多次模型调用：

1. L1 抽取与场景切分；
2. L1 去重、更新或合并决策；
3. L2 场景整理；
4. L3 画像更新。

腾讯通过批量处理、checkpoint、异步执行和不同更新周期降低前台延迟，但模型账单仍然存在。Paw 若接入，必须把“写入质量提升”与“额外模型成本”同时记账，不能只看最终 accuracy。

### 4.3 最新版的 KV cache 方案

2.0 beta 做了一个非常明确的调整：L0/L1 不再每轮自动召回并注入，因为每轮变化的文本会破坏 provider 的 prompt/KV cache。新版改为：

- L3 完整画像：会话初始化时注入到稳定的 system memory 槽；
- L2：只注入稳定的 path + summary 索引；
- L1/L0：不自动塞入上下文，由只读 memory bridge 工具按需搜索；
- 静态工具说明：同样使用 `session_init` 缓存策略；
- 注入位置：通过 agent profile 的语义 anchor 落到稳定槽位，不依赖脆弱的字符串拼接位置；
- cache key：隔离到 `spaceId/userId/agentSource/sessionId/hookId`；
- cache miss：普通主会话允许执行并 self-heal，fork/read-only 请求不回写，避免产生与主会话不同的缓存字节；
- 多节点：外部 gateway URL 必须稳定，否则注入文本字节变化会导致 provider 侧 KV cache 抖动。

这套方案的重点不是“缓存了检索结果”，而是让发给模型的长前缀在一个会话内保持逐字节稳定。它和 Paw 现有 revision-safe retrieval result cache 是两种不同缓存，二者都需要。

## 5. 最新版的边界与权限设计

2.0 beta 已从个人记忆插件扩展成 Memory Hub：Chat Memory、Skill、Wiki、CodeGraph 都是可管理资产，并支持 private/team/restricted/agent 等权限与固定 loadout。

Memory bridge 做了几件正确的事：

- 只放行 L0/L1 搜索、L2 列表和读取等白名单子路径；
- 身份和 scope 由 proxy 强制注入，不信任模型自己提供的 tenant/user/session；
- 不向模型开放 L3 读取接口，因为 L3 已由受控注入提供；
- 模型侧 bridge 禁止写操作；
- 团队、用户、Agent、Session、Task 形成多级隔离。

这与 Paw 的“不让记忆拥有执行或权限权威，只作为不可信证据”方向一致。不过腾讯通过中心 Proxy 接管所有 Agent 流量，部署和故障域更大；Paw 当前的插件式 composition 对单机/本地 runtime 更轻、更符合“不侵入运行时”的既定边界。

## 6. 官方 76% 应该怎样看

README 宣称 PersonaMem 从 48% 提升到 76%。本次源码审计没有找到对应的 PersonaMem runner、结果文件、固定模型、Prompt、数据切分、随机种子或逐题输出；仓库内可见的 benchmark 代码主要是短期上下文 token 估算。

因此：

- 可以把 76% 看作腾讯官方产品效果声明；
- 不能据此与 Paw 的本地 first-20 70% 或 first-100 59% 直接横比；
- Paw 必须使用同一 AMB 数据、同一回答模型、同一 Prompt、固定 temperature 和完整查询范围做消融；
- 最好同时报告 answer accuracy、recall@k、oracle accuracy、写入成本、检索 token、provider prompt-cache hit tokens。

## 7. Paw 当前与腾讯方案对照

| 能力 | Paw 当前 | 腾讯方案 | 判断 |
| --- | --- | --- | --- |
| 运行时边界 | 独立 `@paw/memory-plugin`，runtime/agent-loop 不感知 | 旧版插件；新版中心 Proxy + Core/Hub | Paw 边界更干净，继续保持插件化 |
| 召回时机 | `task_start` / `work_segment_start` 安全边界 | 最新版 L3/L2 会话固定注入，L1/L0 工具按需查 | Paw 需增加稳定层和按需工具，不应恢复每轮动态注入 |
| 写入 | M1 只读，无自动提炼 | L0→L1→L2→L3 异步流水线 | Paw 最大缺口 |
| 数据粒度 | AMB 约 5000 字符确定性 chunk | 原始对话 + 原子事实 + 场景 + 画像 | 粗 chunk 是 first-100 低分的重要原因 |
| 冲突/演化 | 无专用模型 | store/update/merge/skip + 时间与演化 | 对 PersonaMem 关键 |
| 检索 | 多查询 BM25/vector RRF，可选 reranker | BM25/vector RRF，云端原生 hybrid | Paw 算法骨架不差，先修数据表示 |
| 结果缓存 | scope + provider + store revision 的只读检索缓存 | session-init hook cache | 两者解决不同问题，应组合 |
| Provider KV cache | 尚未形成 memory 的稳定 session snapshot | 稳定 system 注入 + 动态工具下钻 | Paw 下一阶段高优先级 |
| 审计 | durable retrieval receipt，content-free telemetry | checkpoint、备份、操作日志 | Paw 的确定性 receipt 更强 |
| 权限 | scope 四元组、repository 密封 | team/user/agent/session/task + ACL | 团队产品化时再吸收腾讯模型 |

Paw first-100 的现有证据也支持这一判断：96 次未缓存 RRF 查询中，78 次 lexical candidate 为 0，18 次只有 1 个；92/100 最终只是返回固定 3 张粗粒度 card。问题首先是“记忆长什么样”和“可检索词在哪里”，不是简单把 dense 权重从 10% 调到 20%。

## 8. 建议落地路线

### P0：先补评测可解释性

目标：不再只看最终 accuracy，先知道答案丢在写入、召回还是回答阶段。

- 每个 memory atom/chunk 保留 source document、source message IDs、时间范围和 revision；
- AMB 记录 gold source 是否进入候选、是否进入最终 cards；
- 增加 recall@k 与 oracle-answer 消融；
- 把问题类型、召回失败、证据命中但回答错误分别统计；
- 保持 content-free 生产日志，benchmark 可在隔离结果文件中保存可复核的题级证据 ID。

### P1：实现插件式 L0/L1 写入流水线

新增独立 memory writer plugin，不修改 runtime 和 agent-loop：

- L0 追加写入 canonical 对话/事件引用；
- 在 `work_segment_end`、task settle 或后台队列触发 L1 抽取；
- L1 至少区分 persona、episodic、instruction、semantic/decision；
- 每条 atom 带 source refs、valid_from、valid_to、confidence、priority；
- 批量执行 store/update/merge/skip；
- 所有写入先生成 proposal，再由确定性 writer 提交，LLM 不直接改文件或数据库；
- writer receipt 进入 Journal，失败可重试且幂等。

### P2：增加 L2/L3 可重建投影

- L2 场景设数量上限，记录 narrative、evolution、contradiction、pending confirmation；
- L3 只保留稳定、高价值、跨任务适用的信息，并设严格 token 上限；
- L2/L3 是从 L0/L1 event log 生成的 versioned projection，可丢弃重建；
- 冲突信息不直接覆盖证据，旧 atom 标记 superseded/valid_to；
- 生成结果必须经过 schema 校验、引用完整性校验和最大尺寸校验。

### P3：建立两层缓存拓扑

保留现有检索结果缓存，同时增加模型前缀缓存设计：

1. `stable memory snapshot`：在 task/session 初始化时固定 L3 + L2 索引，规范化序列化后放在稳定 system 槽；
2. `dynamic evidence`：L1/L0 默认用只读工具按需查询，或只在 `work_segment_start` 追加到 user-side 动态区域；
3. snapshot key 包含 scope、memory projection revision、profile version、serialization version；
4. 同一 session 首次看到的 memory view revision 固定，显式 `memory sync` 才刷新；
5. fork/read-only child 继承主会话 snapshot，cache miss 不产生新版本；
6. 记录 stable-prefix hash、provider cached/miss input tokens、工具召回次数和动态注入 token。

这会比“缓存同一条 query 的检索结果”更直接地提高真实模型 KV 命中率。

### P4：按严格消融重跑 AMB

按相同 DeepSeek Flash、temperature=0、相同 query 顺序依次测试：

1. 当前粗 chunk baseline；
2. L1 atoms；
3. L1 + conflict/evolution；
4. L1 + L2/L3 稳定投影；
5. L3/L2 稳定注入 + L1/L0 工具下钻；
6. 最后才比较 embedding、fusion 和 reranker。

先跑固定 first-100 找错误，再跑完整 589。每组同时公布准确率、置信区间、模型调用数、输入/输出 token、prompt-cache token、写入成本和平均检索延迟。

## 9. 不建议照搬的部分

- 不把 LLM 直接编辑场景文件作为正式写入协议；
- 不为了兼容所有 Agent 就把 Paw 改造成中心 Proxy；
- 不在没有阈值和可解释召回指标时固定塞 top-k；
- 不以 README 的 76% 代替 Paw 自己可复现的完整 AMB；
- 不一次引入 Team Hub、Wiki、CodeGraph、Skill marketplace，先把个人长期记忆闭环做对；
- 不让记忆文本获得 instruction、tool permission 或 completion authority。

## 10. 建议的下一开发切片

下一切片应是 `Memory M2a — L0/L1 proposal writer`，而不是继续调 dense 权重。最小可交付范围：

1. 冻结 atom schema 与 source/ref/time/revision 字段；
2. 新增 writer plugin port、异步触发器、幂等 proposal/commit receipt；
3. 用 DeepSeek Flash 实现批量抽取和 store/update/merge/skip；
4. 用确定性 writer 落库，保留旧版本和来源边；
5. 给 AMB ingest 增加 atom 化模式；
6. 先跑 20 条开发集与 first-100，对比粗 chunk baseline；
7. 记录抽取 token、去重 token、写入耗时、atom 数量、冲突更新数、recall@k 和 accuracy。

验收门槛应同时满足：运行时零侵入、失败不阻塞主循环、scope 不泄漏、写入可重放、证据可追溯，以及 first-100 不低于当前确定性 baseline。
