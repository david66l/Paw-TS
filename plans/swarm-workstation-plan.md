# 蜂群工作站设计方案（Swarm Workstation）

> 目标形态：一个长期开着的任务池。用户丢进去几十条**互相独立**的活（代码、调研、写作、数据处理、清单整理……），
> 32~64 路 Agent 各自领一条干活，跑几小时，中途随时加单、改优先级、取消、看进度，产出是可归档的**业务产物**而不是一段聊天摘要。
>
> 本文只做设计与缺口分析，不含实现。所有"现状"结论都带 `文件:行号` 证据。

---

## 1. 结论先行

**能改，而且不需要重写引擎。** 当前系统已经具备蜂群需要的绝大部分执行能力：

- 声明式任务清单（带 `depends_on` / `scope` / `acceptance` / 预算）——`packages/collaboration/src/delegation.ts:32-51`
- DAG 校验（重复 id、未知依赖、自依赖、环）——同文件 `419-451`
- 多路并行执行 + 结果聚合（`Promise.all` + `aggregateMissionResult`）——同文件 `526-549`、`611-649`
- 持久化任务身份与记账（`runtime.activity_started/settled` + 稳定 callId）——`packages/collaboration/src/coordinator.ts:108-152`
- 每个 child 独立 Session / Journal / 可恢复 worktree / 独立 AbortController——`packages/paw-next/src/composition.ts:3336-3383`
- 文件级写锁（FCFS + 超时）——`packages/agent/src/orchestrator/file-lock.ts:31-68`
- 429 / 5xx 分类退避——`packages/agent/src/orchestrator.ts:5545-5648`
- 桌面端已从 Journal 事实投影子 Agent 事件——`apps/desktop/agent-host/paw-next-events.ts:348-387`

卡住蜂群的只有**四个**结构性约束，全部集中在"生命周期"和"上限"上：

| # | 约束 | 位置 | 值 |
|---|---|---|---|
| 1 | 一次 mission 的任务数上限 | `delegation.ts:262-267` | 8 |
| 2 | 并发槽位 | `packages/collaboration/src/policy.ts:25` | 3 |
| 3 | 一次 mission 预留回合上限 | `delegation.ts:457-462` | 240（**按 Σ maxSteps 预扣，50 条直接超限**） |
| 4 | **调度器是函数局部变量** | `delegation.ts:475-476` | `runMission` 的 `pending`/`results` 随调用结束而销毁 |

第 4 条才是真正的问题。前三条是调参，第 4 条意味着：**任务池的生命周期 = 一次工具调用的生命周期**。
父 Agent 调 `workspace.delegate` 后会阻塞在同一轮里，等全部任务波跑完才拿回结果；池子不能比这次调用活得更久，
也无法在父 Agent 空闲时继续工作。

所以本方案的核心不是"把 3 改成 64"，而是**把任务池从函数栈里搬到会话级的常驻调度器**。

### 1.1 一个必须先知道的事实：`workspace.delegate` 和 `workspace.run_agent` 是同一个工具

`packages/collaboration/src/tool-plugin.ts:29-31,133-135`：`internalName = "workspace.run_agent"`、
`providerName = "workspace_delegate"`，面向模型的 schema 措辞不同，底层是同一条链路。
这意味着：**池化改造的收益同时作用于这两条对外路径**，不存在"改一留一"的选项。

### 1.2 另外三处也硬绑了 3（不只是 policy）

放宽 `policy.ts:25` 不够，同一个"3"散落在三个语义不同的位置：

| 位置 | 值 | 语义 | 对池的影响 |
|---|---|---|---|
| `policy.ts:25` → `launcher.ts:41` Semaphore | 3 | 装配链槽位 | **池要改的是这一处** |
| `delegation.ts:526-530` wave `slice(0, N)` | 3（有 `validateDependencyResult` 时为 1） | 波内任务数 | 改为事件驱动后消失（§7.1） |
| `agent-group.ts:103-117` | 3 / 深度 1 / 步数 12 | 父 Agent 单轮子 Agent 数，**超限直接 `throw` 而非排队** | 池绕过它（§5.1） |

另有几处独立的小上限：`tool-scheduler` 的 `maxParallel` 默认 4（`packages/agent/src/loop-v2/tool-scheduler.ts`）、
`managed-job-registry` 的 `maxConcurrentJobsPerOwner` 默认 4（`packages/harness/src/jobs/managed-job-registry.ts:108`）、
long-horizon 的 12 阶段上限（`packages/paw-next/src/long-horizon.ts`）。这些是**并行的观测/作业通道**，
池化时要么一起放大，要么明确不让池走这些通道。

### 1.3 工具 schema 的上限是生成式的，也会挡路

`packages/collaboration/src/tool-plugin.ts:114-126` 的 JSON schema 里 `tasks` 的 `maxItems` 直接取自
`policy.maxMissionTasks`。所以"池档"必须同时改 policy 和 schema 生成，否则模型在 schema 层就被限制成 8 条。

---

## 2. 必须先讲清的一件事：两种"并发"不是一回事

这是本设计最容易做错、也最值得写进文档的判断。仓库里已有一篇《Scaling Agent Systems》精读
（`文档/工作日志/2026-09-12-Scaling-Agent-Systems论文精读.md`），它的结论与本需求存在**表面冲突**，必须正面处理：

| 论文结论（原文行号） | 表面含义 | 与本方案的关系 |
|---|---|---|
| "固定预算下 3–4 个 Agent 就是实际上限"（`:120`） | 不能上几十个 | 说的是**同一任务内**互相通信、需要收敛的协作 |
| "最优协调带：开销 200%–300%；>400% 过协调"（`:121`） | 加人越多越糟 | 同上：协调开销来自**互相通信** |
| "Independent（各自跑→聚合）协调开销 58%"，四档最低（`:48`） | 纯并行开销最低 | **本方案落在这一档** |
| "Finance-Agent 上 MAS 相对 SAS +57%~+80.8%"（`:70`） | 可分解任务并行收益巨大 | 本方案的目标场景 |
| "错误放大：Independent 17.2×，Centralized 4.4×"（`:113-114`） | 无验证的并行会放大错误 | **必须配套归并与验收**，见 §9 |

因此蜂群必须**区分两类并发**，并在架构上物理隔开：

### 2.1 簇内并发（intra-task）：一个任务内部的多个 Agent 协作
即现在 `mission` 干的事：几个 child 互相依赖、共享一个目标、结果必须收敛成一份。
- 上限**保持 3~4**，不放大。论文的 45% 饱和线、200–300% 开销带、协调失败率都适用于这一档。
- 本方案不动它。

### 2.2 池内并发（pool concurrency）：几十条**互相独立**的任务同时推进
即用户说的"分别干不同的工作"。
- 任务之间**零通信、零共享状态、无收敛要求**，只有"都写进同一张台账"这一个共享点。
- 这正是论文里的 Independent 档：协调开销 58%（四档最低），可分解任务上实测 +57%~+80%。
- 这一档的上限不由论文的 3–4 决定，而由**限流、预算、写入冲突、归并带宽**四个工程约束决定。

**一句话规则：蜂群放大的是"任务条数"，不是"单个任务内的 Agent 数"。**

这条规则同时决定了下文所有设计：任务池的天花板是 64，但任何**一条**任务内部的 `depends_on` 依赖簇仍然只跑 3~4 个。

---

## 3. 目标形态

### 3.1 用户视角

```
用户：开工，这 40 条活你自己分配，另外这 3 条最急的先做
  → 池子接单，返回一句"已入池 43 条，当前 32 路在跑"
  → 用户可以关掉这个对话去做别的事，池子继续跑
  → 中途：再加 20 条 / 把某条提到最高优先级 / 暂停某条 / 看第 17 条在干嘛
  → 几小时后：一张产出清单（每条的产物路径 + 一句话结论 + 需人工决策的少数几条）
  → 少数失败的：明确列出"失败原因 + 已尝试什么 + 建议怎么办"，不假装完成
```

### 3.2 指标（用于验收，不是宣传）

| 维度 | 目标 |
|---|---|
| 池容量 | 排队 200~500 条任务；同时活跃 32~64 路 |
| 单任务时长 | 几十秒 ~ 几十分钟 |
| 池寿命 | 数小时，跨多轮对话 |
| 中途改单 | 加单/改优先级/取消单条/暂停整池，秒级生效（在 worker 边界） |
| 产物 | 报告/数据/草稿/清单落盘为可归档产物，带索引，不只回一段摘要 |
| 中断 | 进程重启后池子能恢复；未完成任务的语义诚实（completed / failed / unknown） |
| 成本 | 实时可见，有池级上限，触顶停派而不是烧穿 |

---

## 4. 现状能力矩阵

| 能力 | 现状 | 证据 | 判定 |
|---|---|---|---|
| 声明式任务清单 | ✅ 已有（`delegation_plan.tasks`） | `delegation.ts:32-51`, `53-107` | 直接复用 |
| 任务图校验 | ✅ 已有（环/重复/未知依赖/自依赖） | `delegation.ts:419-451` | 直接复用 |
| 多路并行 | ✅ 有，但按**波**推进 | `delegation.ts:526-549` | 改调度模型 |
| 依赖证据传递 | ✅ 已有（`dependsOn` 摘要注入 child goal） | `delegation.ts:596-608` | 直接复用 |
| 并发槽位 | ⚠️ 硬编码 3 | `policy.ts:25`, `product-manifest-v3.ts:106` | 需分级 |
| 任务数 / 回合预算 | ⚠️ 硬编码 8 / 240 | `delegation.ts:262-267`, `457-462` | 需池级化 |
| 每任务模型选择 | ✅ 已有 `collaborationModels`（按 agent.id 配模型） | `composition.ts:400`, `3823`; `product-profile-v3.ts:98` | 扩展成三档 |
| 子 Agent 独立 Session/Journal | ✅ 已有 | `composition.ts:3444-3493` | 直接复用 |
| 可恢复 worktree（execute 用） | ✅ 已有，按 childKey 稳定派生 | `composition.ts`（见 05 文档 §11） | 直接复用 |
| 任务持久记账 | ✅ 已有（活动 started/settled，投影可列未结算活动） | `coordinator.ts:108-152`, `172-211` | 扩展成任务账本 |
| 稳定 callId 派生 child 身份 | ✅ 已有（`sessionId+runId+callId` 哈希） | `apps/desktop/agent-host/paw-next-events.ts:355-361` | 恢复的基础 |
| 单 child 取消 | ✅ 已有（per-child AbortController + 桌面 `onChildControl`） | `composition.ts:3336-3383` | 扩展成池级控制 |
| 文件写锁 | ⚠️ 有，但**只在同一批内共享**，跨批不共享 | `agent-group.ts:126`；路径判断 `304-318` | 需升级为跨批共享 |
| 跨任务写冲突策略 | ⚠️ "mission 内 mutate 串行 + V3 全局锁" | `product-manifest-v3.ts:104-105` | 需升级 |
| 辅助通道并发 | ⚠️ tool-scheduler `maxParallel=4`、job registry `maxConcurrentJobsPerOwner=4` | `loop-v2/tool-scheduler.ts:86`、`managed-job-registry.ts:108` | 池化时需一并放大或绕开 |
| **池常驻（跨轮/跨调用）** | ❌ 无，池是函数局部变量 | `delegation.ts:475-476` | **必须新写** |
| **断点续跑（任务级）** | ❌ 无。**已结算的同 id 任务仍会重跑** | `coordinator.ts:108-131`，测试 `collaboration.test.ts:806` 断言 `delegateCalls=2` | **必须新写** |
| **中途改单** | ❌ 无。新用户输入只会让未开始任务全部暂停 | `delegation.ts:477-486` + `composition.ts:3421-3430` | **必须新写** |
| **池级预算总账** | ❌ 无（预算是 per-mission 静态预留，Σ maxSteps 预扣） | `delegation.ts:453-463` | **必须新写** |
| **产物索引** | ⚠️ 结果有 `changedFiles`/`outcome.artifactRefs`，无业务产物概念 | `launcher.ts:177-203` | 需新写 |
| **工作站看板** | ❌ 无（有单层 `children` 状态树） | `agent-group.ts:322-333` | **必须新写** |
| **全局模型限流** | ❌ 无。模型层零并发控制；重试/熔断是 per-orchestrator 私有 | `orchestrator.ts:739,3928`；熔断 5 次/30s | **必须新写** |
| **成本任务级归因** | ❌ 无。`CostTracker` 仅全局累加，无 runId/childId 维度 | `packages/core/src/cost-tracker.ts:284-340` | **必须新写** |
| **成本上限/熔断** | ❌ 无任何金额预算（只有上下文 token 与步数预算） | `orchestrator-factory.ts:199` | **必须新写** |

---

## 5. 架构

### 5.1 模块图

```
┌─ 用户 / 桌面 UI ────────────────────────────────────────────────┐
│  工作站看板：队列 / 在跑 / 完成 / 失败 / 成本 / 产物          │
│  操作：加单 · 改优先级 · 暂停 · 取消单条 · 取消整池            │
└──────────────┬──────────────────────────────┬──────────────────┘
               │ 控制面（IPC）                 │ 投影（只读）
┌──────────────▼──────────────────────────────▼──────────────────┐
│  主 Agent（狸花 / Manager）                                     │
│  · 规划：把用户意图拆成任务清单，写入池（声明式，不自己执行）    │
│  · 监督：读池级汇总，处理异常，做最终验收                       │
│  · 不阻塞：入池即返回，池在后台跑                               │
└──────────────┬──────────────────────────────────────────────────┘
               │ swarm.submit / swarm.read（工具，非阻塞）
┌──────────────▼──────────────────────────────────────────────────┐
│  ★ SwarmPool（新）：会话级常驻调度器                            │
│   TaskLedger（账本，持久）  ArtifactIndex（产物索引）           │
│   Scheduler（事件驱动，不按波）   BudgetGovernor（池级总账）    │
│   RateGovernor（全局限流）   Reconciler（重启对账）             │
└──────────────┬──────────────────────────────────────────────────┘
               │ 直接调用现有 SubAgentLauncher 链（不经过父 AgentGroup）
┌──────────────▼──────────────────────────────────────────────────┐
│  现有协作链（复用，不重写）                                     │
│  Adaptive（簇内 3~4 并发） → Bounded（池并发槽位）             │
│  → Controlled（单条取消） → Coordinator（活动记账）            │
│  → Paw Next V3 child（独立 Session / Journal / worktree）      │
└─────────────────────────────────────────────────────────────────┘
```

**关键接线点**：池的调度器**直接调用 `SubAgentLauncher.launch()`**，绕过 `AgentGroup.launchAll()`。
因为 `MULTI_AGENT_LIMITS.maxChildrenPerTurn = 3` 的守卫在 `packages/agent/src/orchestrator/agent-group.ts:103-110`，
那是**父 Agent 一轮内**的限制，语义上不适用于池；池只需要关心 `createBoundedSubAgentLauncherV1`
的槽位（`packages/collaboration/src/launcher.ts:41`），把它从 3 改成池容量即可。

### 5.2 为什么不放在独立守护进程

- 池需要用到 Session / Journal / child runtime / worktree，这些都在宿主进程里（`composition.ts`）。
- 独立进程要重新解决一遍身份、恢复、审批、工作区锁，收益只有"关掉桌面还能跑"。
- **结论**：第一阶段池内嵌在宿主运行时，状态持久化；把"独立守护进程 / 远程工作站"留作后续
  （见 §16 决策点 D）。

---

## 6. 任务账本（TaskLedger）

### 6.1 任务记录

在现有 `CollaborationDelegationTaskV1`（`delegation.ts:32-43`）基础上扩展：

```ts
interface SwarmTaskV1 {
  // ── 现有字段（复用）──
  id: string;
  goal: string;
  capability: CollaborationCapabilityV1;
  scope: readonly string[];
  acceptance: readonly string[];
  dependsOn: readonly string[];      // 只允许引用同池任务
  initialSteps: number;
  maxSteps: number;
  agentId: string;

  // ── 新增：调度 ──
  priority: number;                  // 越大越先跑；同优先级 FIFO
  lane: "read" | "work" | "publish"; // 决定并发与配额（§8）
  effort: "cheap" | "standard" | "deep";  // 模型档位（§7.4）
  minIntervalMs?: number;            // 外部副作用任务的最小间隔（业务场景）
  resourceKey?: string;              // 外部资源互斥键（如同一账号/API）

  // ── 新增：状态（三维，互不覆盖）──
  schedule: "queued" | "running" | "settled" | "paused" | "cancelled";
  attempts: number;
  verdict?: "completed" | "failed" | "unknown";  // 见 §11 诚实语义
}
```

**为什么状态要拆三维**：现有系统区分了"子运行结束 / 证据有效 / 需求完成"三件事
（`文档/项目理解与面试/05-多Agent与验收.md:7`），任务池必须继承这个区分，
否则 64 路并发下 `completed` 会变成一句没有信息量的口头禅。

### 6.2 批次默认值（控制清单体积的关键）

50 条任务 × 4000 字符合同（`policy.ts:30` 的 `maxGoalChars`）= 20 万字符，
模型要生成、Journal 要落盘、每次读回都要塞进上下文。**必须有批次级默认值**：

```ts
interface SwarmBatchV1 {
  batchId: string;
  goal: string;                      // 批次目标（写一次）
  sharedContext: readonly string[];  // 所有任务共享的前提（写一次，如"产品定位/品牌调性/输出格式"）
  defaults: {
    lane, effort, maxSteps, agentId, acceptance,
    outputSpec: { format: "md" | "csv" | "json" | "docx"; template?: string }
  };
  tasks: readonly SwarmTaskV1[];     // 每条只写差异部分
}
```

子任务的最终合同 = `sharedContext` + `defaults` + 自身字段，在**派发时**拼装，
沿用现有 `formatDelegatedGoal`（`delegation.ts:579-609`）的拼装与 4000 字符校验。

### 6.3 持久化：**不要挂在父 Agent 的 journal 流里**

第一直觉是复用现有 Journal（`coordinator.ts` 的活动事实）。调研显示这会踩两个坑：

**坑 1：journal 的写入是 O(N²) 的。**
每次 commit 都会重跑**整段前缀**的协议校验 `parseRunJournalPrefixV1([...全部事实])`，
再对全前缀做 `JSON.stringify` + `sha256`（`packages/runtime/src/session/file-run-session.ts:673,680,1822`）。
单次提交写一个新的内容寻址文件（tmp→fsync→link→dir fsync→rm），
多写者冲突只能乐观重试（`:564-576`）。
→ 一个 child 跑到几十步还能接受（各 child 有独立 journal，天然分片）；
   但**把 50 条任务的台账塞进父 Agent 的同一个流里，会变成单点热点**。

**坑 2：恢复是手动、单 run 的。**
桌面端已有 `repairRunRecoveryV1`（`packages/runtime/src/recovery/run-recovery.ts:211`，
接线在 `composition.ts:6560-6562`），但语义是"**补齐 unknown 结算，不重放已提交的工具**"，
而且桌面必须**用户手动点重试**（`intent:"recover"`，`apps/desktop/agent-host/paw-next.ts:481-502,705-717`）。
自动扫描 `startup-scan.ts` 只服务 legacy CLI、**只挑一个 run 执行**，且 `apps/desktop` 零引用。
→ **50 条任务的池不可能靠手动点 50 次恢复。**

**结论**：池台账用**自己的追加型账本**（append-only，每条记录定长校验 + 周期压缩），
与 child 的 journal 解耦；恢复走新的 `Reconciler`（§11.2），
复用 `repairRunRecoveryV1` 的"补 unknown、不重放"语义作为**单任务级**原语。

### 6.4 账本记录与两类事实

| 事实 | 时机 | 作用 |
|---|---|---|
| `swarm.task_submitted` | 任务入池 | 台账条目来源（含 batchId、priority、lane、effort） |
| `swarm.task_verdict` | 任务结算 | 三维终态 + 产物引用 + 成本 |
| `swarm.pool_control` | 用户/模型干预 | 加单、改优先级、暂停、取消——**可回放的干预日志** |

**恢复依据**：`projectCollaborationTasksV1`（`coordinator.ts:172-211`）已经能列出"已启动未结算"的活动，
这是现成的"哪些任务可能还没跑完"查询。新增的 swarm 事实与它并列投影即可。

### 6.5 必须设的防膨胀阈值

journal 无分段/无压缩/无批量提交（调研结论），所以：

- **单 child journal commit 上限**（建议 2000）：超过则该任务**迁移到新的 child session**
  继续，而不是让单个 journal 无限增长。
- 池账本周期性压缩（把已结算任务折叠成一行）。
- 这两条不做的话，"跑几小时"会先把磁盘和 commit 延迟拖垮，而不是先撞上模型限流。

---

## 7. 调度器（Scheduler）

### 7.1 从"按波"改成"按空位"

现状（`delegation.ts:509-548`）：挑一批 ready 任务 → `Promise.all` 等整波 → 再挑下一波。
20 条任务、每条 2 分钟、5 路并发时，一条跑了 10 秒的任务要等同一波最慢的跑完才释放槽位。

蜂群要改成**事件驱动**：

```
loop:
  1. 若预算/限流已触顶 → 停派，标记池状态 throttled，等待窗口
  2. ready = queued 且 dependsOn 全部 verdict=completed，按 (priority, 入池顺序) 排序
  3. while 有空闲槽位 and ready 非空 and lane 配额未满:
       取最高优先级任务 → 派发；槽位 -1
  4. await 任一任务结算（不是全部）
  5. 结算 → 释放槽位 → 记账 → 扇出依赖 → 回到 1
```

收益：槽位利用率从 `Σ波内最快 / Σ波内最慢` 提升到接近 1。代价：调度器成为常驻循环，
必须自己处理空闲、退出、暂停、恢复（见 §11）。

### 7.2 写入安全规则（沿用并升级）

现有规则必须保留：**同一波内最多一个 mutate；有 execute 时 mutate 等待**
（`delegation.ts:521-530`）。理由是验收需要观察一个稳定的工作区版本。

蜂群下这条规则要表达成"池级互斥"，而不是"波级互斥"：

| lane | 默认并发 | 说明 |
|---|---|---|
| `read`（inspect） | 池容量（32~64） | 只读，无冲突，占绝大多数 |
| `work`（execute） | 受 worktree 数量限制（建议 4~8） | 每条用可恢复 worktree 隔离 |
| `publish`（mutate） | **默认 1** | 写共享工作区；串行 |

写并发要放开时，另有两条可选加固（见 §16 决策点 B）：
1. 补全 `apply_patch` 等写路径的文件锁覆盖（现状只接了 `write_file`/`edit_file`）。
2. 文件系统快照隔离（overlay / 复制工作区），代价高，只在明确需要时上。

### 7.3 中途改单的语义边界

| 操作 | 生效点 | 必须诚实说明的边界 |
|---|---|---|
| 加单 | 立即（下个调度循环） | 新任务可依赖**已完成**任务；不可依赖正在跑的（否则要等它） |
| 改优先级 | 下个调度循环 | 不影响已派发任务 |
| 取消单条 | 立刻 abort 该 child | 已发生的副作用不回滚（沿用现有语义，`composition.ts:3355-3378`） |
| 暂停整池 | 当前运行任务跑完即停派 | 不是"冻结"，只是不再派新任务 |
| 改正在跑的任务目标 | **禁止** | 必须"取消旧任务 + 新建任务"，沿用稳定 callId 的语义漂移防护（`coordinator.ts:308-327`），避免拿旧证据冒充新工作 |

**这条"禁止改写正在跑的任务"不是保守，是必须**：现有系统用 `goalHash` + AgentSpec hash 绑定任务身份，
恢复时发现同一 callId 换了目标会直接拒绝（`coordinator.ts:308-327`）。池化后这个保护更关键。

### 7.4 模型分档（`effort` 的实现）

池要省钱，关键是**不同任务用不同模型**。现有机制已经支持，只是没被用起来：

- `AgentSpec.model ∈ flash | pro | inherit`（`packages/agent/src/agents/types.ts:9,69`，`factory.ts:28-40`）
- paw-next 侧按 agent id 覆盖：`collaborationModels[agent.id]`（`composition.ts:3822-3824`，`product-profile-v3.ts:98`）

建议映射：

| `effort` | 典型任务 | 模型 |
|---|---|---|
| `cheap` | 分片型批量：逐文件审查、条目抽取、格式转换 | flash / 最便宜档 |
| `standard` | 常规业务任务：单篇调研、单段文案、单份分析 | 默认档 |
| `deep` | 关键产物、最终归并、跨任务综合 | pro / 最强档 |

**归并阶段默认 `deep`**，执行阶段默认 `cheap/standard`——这与论文的
"子 Agent 能力比编排者能力更重要"（`:146`）不冲突：池里"编排"退化成程序调度（不需要模型能力），
而真正需要判断力的两处（任务拆分质量、最终归并）仍交给强模型。

---

## 8. 并发与限流

### 8.1 并发放大的四个真实瓶颈

放宽 `maxConcurrentChildren` 只是第一步。64 路同时跑会依次撞上：

1. **供应商限流**：模型层**完全没有并发闸门**（唯一 Semaphore 是子 Agent 派发闸门 `launcher.ts:41`，
   不限制模型请求）。更糟的是重试与熔断状态是 **per-orchestrator 私有的**
   （熔断器实例表 `orchestrator.ts:739,3928`；策略 5 次失败 / 30s 恢复），
   **64 路会各持一份熔断器、各自退避，互相加剧限流**——这正是"惊群"的典型成因。
   另外 `Retry-After` 是从错误文本正则里抓的（`orchestrator.ts:5591-5599`），不是读 HTTP header，
   可靠性有限；而 product（paw-next）链路**根本没有 429/5xx 重试**，只有 thinking-recovery 的一次救援重试。
   需要**跨 Agent 的全局令牌桶 + 共享熔断注册表**。
2. **预算失控**：64 路 × 每条几十轮，成本是线性放大的，必须有池级熔断。
3. **本地资源**：worktree 数量、shell 进程数、文件句柄。
4. **归并带宽**：见 §9。

### 8.2 三层闸门（都要有）

```
第一层 RateGovernor：按 (provider, model) 维度的令牌桶（新写）
    · 上限来自配置：RPM / TPM / 最大并发请求（maxInflight）
    · 所有 Agent 的模型调用统一经过它（含重试）
    · 撞限流时：队列内等待，而不是让每个 Agent 自己退避
    · 必须是**跨 orchestrator 的单例**；同时把 per-orchestrator 熔断器
      （orchestrator.ts:739,3928）换成共享注册表，否则 64 路各熔断各的
    · 注入点：LanguageModel 接口收口（packages/models/src/language-model.ts:43-62）
      或装饰器链（composition.ts:921-962）；两条路径都要接
第二层 池并发槽位：按 lane 分级（§7.2）
    · read 32~64 / work 4~8 / publish 1
第三层 任务内并发：簇内 3~4（保持不变，§2.1）
```

**两条模型路径都要接**：v1 `orchestrator.ts` 与 product `agent-loop-adapter.ts` 都收敛到
`LanguageModel` 接口（`packages/models/src/language-model.ts:43-62`），
所以限流器应包在接口层（或 `composition.ts:921-962` 的装饰器链）而不是某一条路径里，
否则会出现"老路径被限流、新路径裸奔"的分裂。

### 8.3 配置暴露

现有 `agent_mode` 枚举已含 `coding | orchestrated | team | multi`
（`packages/settings/src/schema.ts:97`），新增 `swarm` 档。建议配置项：

```jsonc
{
  "agent_mode": "swarm",
  "swarm": {
    "poolConcurrency": 32,          // 16 / 32 / 48 / 64
    "maxQueued": 500,
    "lanes": { "read": 32, "work": 6, "publish": 1 },
    "rate": { "rpm": 600, "tpm": 400000, "maxInflight": 40 },
    "budget": { "poolMaxSteps": 6000, "poolMaxTokens": 20000000, "poolMaxWallMs": 21600000 },
    "onBudgetExhausted": "stop_dispatch"   // 不杀正在跑的任务
  }
}
```

注意与现有校验的关系：`freezeCollaborationPolicyV1` 强制
`defaultMaxSteps ≤ maxChildSteps ≤ maxMissionSteps`（`policy.ts:42-51`），
池级预算要作为**新的一层**叠加，而不是去违反这个不变量。

---

## 9. 结果归并（这是蜂群真正的难点）

50 条任务 × 每条 6000 字符摘要（`policy.ts:31` 的 `maxSummaryChars`）= 30 万字符。
即使全部截断，也远超父 Agent 的上下文预算。

现有做法的三个上限叠在一起，50 条时必然失效：

1. `aggregateMissionResult`（`delegation.ts:611-649`）把**所有** findings 拼成一段 summary，
   每条截断到 1000 字符但**条数无上限**，最后整段被 `maxSummaryChars = 6000` 截掉 —— 50 条时只剩前几条。
2. 即使聚合结果很大，注入父上下文时还有一道闸：`truncatePayloadWithOutcome`
   （`run_agent` **不在**免截断名单，`MAX_TOOL_RESULT_CHARS = 40000`，只保留头 600 + 尾 400，
   超限全文另存 artifact）。所以 50 条摘要**一定会被截断丢失**。
3. 没有任何分页 / 摘要树 / 按需下钻协议。

**结论：蜂群必须自带归并协议，不能指望现有聚合器。**

### 9.1 三层归并

```
L1 任务产物落盘
   每条任务把完整产出写进产物存储，返回：产物引用 + 一句话结论 + 状态
   （产出正文不进上下文）

L2 池级汇总表（进父上下文的唯一入口，硬上限 ~4000 字符）
   ├─ 计数：completed / failed / unknown / running
   ├─ 逐条一行：id · 角色 · 状态 · 一句话结论 · 产物引用
   ├─ 异常聚焦：失败与 unknown 的完整列表（这两类必须逐条列出，不截断）
   └─ 成本：本轮池消耗

L3 按需下钻
   父 Agent 对某条有疑问 → 读该任务的产物或摘要明细（工具：swarm.read(taskId)）
```

### 9.2 产物模型（业务任务的关键）

```ts
interface SwarmArtifactV1 {
  taskId: string;
  kind: "report" | "dataset" | "draft" | "list" | "code" | "other";
  path: string;              // 工作区相对路径，可归档
  bytes: number;
  summaryRef: string;        // 一句话结论
  verified: boolean;         // 是否有验收证据
}
```

`SubAgentResult` 已有 `changedFiles` / `outcome.artifactRefs`（`launcher.ts:177-203`），
可以承载引用；缺的是"业务产物"语义和索引。**产物索引是池的一部分，不是文件系统的副产品。**

### 9.3 归并纪律

50 条任务的结果**不允许**把正文合并进父上下文。父 Agent 看到的是汇总表 + 引用，
想细看再下钻。这是蜂群与"几十个 AI 各写一段然后拼起来"的本质区别。

### 9.4 父 Agent 的上下文如何随时间更新（最容易漏掉的一环）

"入池即返回、池跑几小时"带来一个新问题：**这几小时里父 Agent 的上下文不会自己长出来。**
如果不设计，结局是父 Agent 在几小时后凭空被塞进 30 万字符，归并协议白做。

因此必须定义三档交互：

| 交互 | 时机 | 进入父上下文的内容 | 上限 |
|---|---|---|---|
| **入池回执** | `swarm.submit` 返回 | "已入池 N 条，lane 分布，当前 M 路在跑" | ≤ 500 字符 |
| **增量对账** | 父 Agent 主动查（`swarm.read`），或池在**里程碑**（如每完成 10 条 / 每 10 分钟）投递一条系统提示 | 自上次以来的差分：新完成 / 新失败 / 新 unknown | ≤ 1500 字符/次 |
| **终局汇总** | 全部结算（或池暂停/触顶） | 池级汇总表（§9.1 的 L2） | ≤ 4000 字符 |

关键约束：

- **增量对账是差分，不是全量重放**。第 5 次对账只讲第 4 次之后发生的事。
- **里程碑投递要有硬频控**，否则 64 路会把父上下文刷成日志流；建议"最多每 N 条完成或每 M 分钟一次，取先到"。
- 父 Agent 空闲时（用户没在对话），池**不应该**往上下文里灌消息，只更新看板；
  等父 Agent 下次被唤醒时一次性给差分。

---

## 10. 预算与治理

| 层级 | 口径 | 超限行为 |
|---|---|---|
| 单任务 | `maxSteps`（现有，受 AgentSpec 限制） | 转 `unknown`，不静默续命 |
| 单批次 | Σ 任务预留（现有 `maxMissionSteps`，`delegation.ts:457-462`） | 拒绝整批，让模型重拆 |
| 池 | 总回合 / 总 token / 总墙钟 | **停派**（`stop_dispatch`），不杀在跑的 |
| 供应商 | RPM / TPM | 排队等待，不退避烧穿 |

**成本需要按任务维度聚合**，否则 64 路下无法回答"哪条任务最贵、哪类任务最不划算"。
现状是 `CostTracker` **只有一个全局累加器**（`packages/core/src/cost-tracker.ts:284-340`），
按 model.label 计价，**无 runId / childId 维度**，`cost.update` 事件也只广播全局快照。
所以"按任务归因"要新写（加维度 + 聚合查询），而不是打开某个开关。

现有体系里**没有任何金额口径的预算或熔断**（只有上下文 token 与步数/时间预算，
`orchestrator-factory.ts:199`）。池级 `poolMaxTokens` 是新能力。

### 10.1 shell 作业不参与池的恢复承诺

如果任务会派 `job_start` 派生后台 shell 作业，要注意：
managed job 状态**纯内存**（`managed-job-registry.ts:98`，整文件无 fs 调用），
每 owner 上限 4 且超限**抛错不排队**（`:108,162-166`），输出 64KB 尾窗不落盘。
进程重启后旧作业一律被标记 `interrupted_orphaned`、PID 不重连、输出丢失
（`managed-job-controller.ts:180-202,399-429`）。

→ **池的持久化承诺只覆盖任务本身，不覆盖任务派生的 shell 作业。**
`work`/`publish` lane 的任务若依赖长时间 shell 作业，恢复后必须重新执行该作业，
这一点要写进任务的 `acceptance` 语义，避免拿着"重启前跑过的测试"当证据。

---

## 11. 长跑与恢复

### 11.1 已经具备的

- 每个 child 有稳定派生的 Session / run / Journal（`composition.ts:3444-3493`），
  且**每个 child 独占自己的 session + lease**（`composition.ts:3540-3541`）——
  这意味着池天然分片，不存在 50 路抢一个 journal 的问题。
- childKey 由 `sessionId + runId + callId` 哈希派生（`apps/desktop/agent-host/paw-next-events.ts:355-361`），
  **同一 callId 重放能找回同一个 child 身份**，这是恢复的地基。
- 提交走**内容寻址 artifact + lease CAS 线性化**，单写者由 fencing token 保证
  （`file-run-session.ts:651-771`；`session-execution-lease.ts:17-34`）。
- `recovery-snapshots` 机制（`file-run-session.ts:415-542`）——journal 前缀重放可加速。
- **`repairRunRecoveryV1`**（`run-recovery.ts:211`，接线 `composition.ts:6560-6562`）：
  语义是"补齐 unknown 结算，**不重放已提交的工具**"——这正是池对账需要的单任务原语。
- execute lane 有可恢复 worktree，按 childKey 稳定派生并能校验源版本（见 05 文档 §11）。
- 活动记账能列出"已启动未结算"的活动（`coordinator.ts:208-210`）。

### 11.2 要新加的：Reconciler（重启对账）

⚠️ **一个必须纠正的直觉**：`coordinator` 的活动记账**不是**缓存。
它在派发前记 `runtime.activity_started`，发现同 id 活动已存在时**只校验身份是否一致**
（`coordinator.ts:108-113` → `assertSameTask`），**然后照样重新派发**；
已结算的同 id 任务**不会**因为"已经做过"而跳过。
测试 `collaboration.test.ts:806` 明确断言同一 id 重放会产生 `delegateCalls = 2`。

所以"任务池可恢复"不是把现有记账打开，而是**新写一层真正的对账**：
真正去读 child Session 的终态并把结果收回来。

进程重启后，账本恢复流程：

| 任务状态 | 恢复动作 |
|---|---|
| 有 submit，无 start | 留在 `queued`，正常参与调度 |
| 有 start，有 settle | 视为已完成，不重跑 |
| 有 start，无 settle，child Session 有终态 | **收结果**（读取 child 已有终态，不新建身份） |
| 有 start，无 settle，child Session 未完成 | 视 `lane` 决定：`read` 可重跑；`work`/`publish` 先对账外部效果 |
| 无法判断外部效果是否已发生 | 标 `unknown`，交人工决策 |

**`unknown` 必须是一等公民。** 现有文档已经确立了这条纪律
（05 文档 §21.5：不新建随机 child 再声称是原证据；宁可 unverified 也不假装通过）。
蜂群放大 64 倍后，这条纪律只会更重要。

### 11.3 墙钟限制

现有预算是"逻辑回合"口径，不限制秒数（05 文档 §8.4 已明确）。池需要一个**任务级墙钟上限**
（如 `taskTimeoutMs`），到点 abort 并标 `unknown`，否则一条卡住的业务任务会永久占用槽位。

---

## 12. 可观测性

### 12.1 数据源：能复用，但前端必须重写渲染路径

桌面端**已经**从 Journal 事实投影子 Agent 事件（`paw-next-events.ts:348-387`），
所以池看板不需要新建数据通道，只需要新增投影：把 `swarm.task_submitted` / `task_verdict`
投影成任务卡片，与现有 `child.*` 事件按 `callId` 关联。

但当前前端在 50 路下会直接崩掉体验，以下是**实测的硬缺口**（不是推测）：

| 缺口 | 证据 | 50 路时的后果 |
|---|---|---|
| 一次只渲染**一个** activity | `RightPanel.tsx:383-384`（`find(selectedActivityId) ?? activities.at(-1)`） | 50 路同时跑，用户只能看到其中一批 |
| `agents` 平铺数组、**无上限、无虚拟滚动** | `useAgentRun.ts:512-535`（只 push）；`package.json` 无 react-window/virtuoso | 50 行 × 每次事件全量重渲染 |
| `child.*` 事件**同步立即 emit，无批量无丢弃** | `paw-next-events.ts`（唯一节流是 `model.chunk` 的 50ms 合并，`:148-150`） | 每个 child.tool_call/tool_result 各一次 IPC + 全量 `setState` |
| 状态枚举只有 `running/done/failed` | `types.ts:61,73` | **没有 queued/waiting/blocked/retry** —— 队列语义在 UI 层不存在 |
| 无 per-agent 成本/token/耗时 | `CostTracker` 仅全局累加（`core/src/cost-tracker.ts:284-340`） | 无法回答"哪条任务最贵" |
| 干预只有「停止子任务」与「重新委派」 | `ChatStream.tsx:399-423` → `useAgentRun.ts:1600-1621` | 无暂停/改优先级/批量操作 |
| monitor 快照全量 `structuredClone` 推送 | `paw-next-monitor.ts:287` | 非增量，随规模放大 |

### 12.2 视图（必须新建的部分）

| 视图 | 内容 | 复用/新写 |
|---|---|---|
| 池总览 | 计数、吞吐（条/分钟）、成本曲线、限流状态、预算余量 | 复用 `ContextMeter`/`BudgetBar` 范式（`ContextMeter.tsx`、`RightPanel.tsx:707+`） |
| 队列看板 | 按 lane / 状态分列；可拖优先级、可取消单条 | **新写**（含队列状态机） |
| 单路详情 | 目标、当前步骤、最近工具调用、产物 | 复用 `AgentsTab` 行 + `AgentToolStream`（12 条环形流） |
| 异常面板 | 失败 / unknown 逐条列出 + 原因 + 建议动作 | 复用 `TaskOverview` 徽标范式（`RuntimeMonitor.tsx:8-20,64-237`） |
| 产物清单 | 本次池产出的全部产物，可一键打开 | **新写** |

### 12.3 事件风暴的防护（不可选）

64 路 × 每路每步都发事件 = 高频。现有机制只转发白名单事件
（`PARENT_FORWARD_EVENTS`，`constants.ts:55-63`），但**转发本身没有节流**。
池看板必须改为**订阅投影快照 + 增量批**（如每 500ms 一批），
而不是逐事件渲染；同时 `SubAgentInfo.status` 要扩展出队列态。
这是 UI 层的硬工程，不是优化项——不做的话 50 路一开就卡死。

---

## 13. 现有测试的冲击面（实施前必读）

池档必须**新增**而不是改默认值，否则以下断言会挂。调研已定位到具体位置：

| 断言 | 位置 | 为什么会被冲击 |
|---|---|---|
| `expect(highWater).toBe(3)` | `packages/collaboration/test/collaboration.test.ts:741-762` | 7 路并发被压到 3；池档必改 |
| `maxActiveReaders=2 / maxActiveWriters=1` + 时序 | 同文件 `:540-550` | 绑定"波内并发"语义 |
| `events).toEqual([...四事件严格串行])` | 同文件 `:652-657` | 绑定"execute 整波后才 mutate" |
| `delegateCalls = 2`（同 id 重放会重跑） | 同文件 `:806` | **断点续跑要改这条语义**时需同步改测试 |
| `findings = 20` / `summary < 6100` / `tasks = 1` | 同文件 `:704,736,737,811` | 结果边界与 single 降级 |
| 预算 `60 > 30` 抛错、上限 `12/500`、`maxGoalChars=100` | 同文件 `:126-153,82-107,25` | 池档预算模型变更 |
| `toolCalls/toolResults = 2` | `packages/agent/test/phase1-integration.test.ts:132-133` | 单轮子 Agent 数 |
| `child-runX-0,1` 顺序 | `packages/agent/test/multi-agent-fixes.test.ts:95-96` | 同上 |
| child-call 批 | `packages/agent/test/orchestrator.test.ts:493-540` | 同上 |

**好消息**：未发现显式断言 `maxChildrenPerTurn = 3` 或 `maxMissionTasks = 8` 的用例，
所以"池档放宽 8 条上限"本身不会直接挂测试；真正会挂的是上面列出的并发/时序/预算断言。

---

## 14. 分阶段落地

### 阶段 1：放开上限（解锁"几十路"）
- `CollaborationPolicyV1` 分级：保留现有默认值 3，新增 pool 档（`policy.ts:23-32`）。
- `maxMissionTasks` / `maxMissionSteps` 池级化（`delegation.ts:262-267`, `457-462`）。
- `MULTI_AGENT_LIMITS.maxChildrenPerTurn` 与池解耦（池绕过 `AgentGroup`，见 §5.1）。
- **验收**：池内同时活跃 32 路只读任务跑通；现有断言 3 的测试（`collaboration.test.ts`、
  `agent` 包下的 multi-agent 测试）保持默认档通过。

### 阶段 2：池常驻 + 调度器 + 中途改单
- 新增 `SwarmPool`（TaskLedger + Scheduler + lane 配额），生命周期挂在会话而不是工具调用。
- 池台账用独立追加型账本（§6.3），**不塞进父 Agent 的 journal 流**。
- 新增工具 `workspace.swarm`：`action=submit | read | pause | resume | cancel | prioritize`。
- 主 Agent 入池即返回，不阻塞。
- **验收**：入池 40 条 → 父 Agent 立刻返回 → 池在后台跑完 → 中途加 10 条生效 → 取消单条生效。

### 阶段 3：预算/限流/产物/恢复
- `RateGovernor`（全局令牌桶 + 共享熔断注册表）、`BudgetGovernor`（池级总账）、
  `ArtifactStore`、`Reconciler`。
- 三维终态（completed / failed / unknown）落地；单 child journal 膨胀阈值（§6.5）。
- **验收**：模拟重启后池恢复正确（多任务自动对账，不是手动点一次）；
  撞限流时排队而非烧穿；触顶后停派；产物可归档。

### 阶段 4：工作站界面 + 业务能力
- 池看板、队列操作、异常面板、产物清单；`child.*` 事件批量通道。
- 业务 Agent 种子（调研员/写手/分析师/整理员等，`packages/agent/src/agents/seeds.ts` 现有 9 个种子偏编码）。
- 模型三档（cheap/standard/deep）与 `collaborationModels` 打通。
- 产物交付格式与归档约定。

---

## 15. 验收与度量

沿用仓库既有的度量纪律（05 文档 §23.4），蜂群要新增/关注：

| 指标 | 为什么需要 |
|---|---|
| 槽位利用率 | 验证"事件驱动"确实优于"按波" |
| 队列等待时间 P50/P95 | 32 路是否真的够，还是需要 64 |
| 每条任务成功率 / 重试率 | 分片型与业务型任务表现可能完全不同 |
| **unknown 率** | 诚实语义是否被执行（这个数字上升不一定是坏事） |
| 每条任务成本 / 每个成功产物成本 | 蜂群的经济性 |
| 归并压缩比 | 50 条任务的产出→汇总表的字符压缩倍数 |
| 限流触发次数与排队时长 | 并发上限是否设置合理 |
| 产物到达率 | 业务任务是否真的留下可归档产物 |

对照实验建议：同一批任务分别用 **串行单 Agent** / **池 8 路** / **池 32 路** 跑，固定模型与预算，
对比总墙钟、总成本、产物质量（人工或隐藏验收）。**没有这组数据之前，不要对外声称蜂群更快或更省。**

### 15.1 一个可复现的基准场景（建议用于验收）

用本仓库自身做只读蜂群基准（零副作用、可重复、有真值）：

**任务**：把 `packages/*/src` 每个模块派一个 `read` 任务，
要求"列出该模块对外导出的公共 API、最可能的 3 个缺陷、以及缺失的测试点"，产物写 `reports/<module>.md`。

- 规模：本仓库包数量即任务数（几十条，正好落在池容量区间）。
- 真值：人工抽查 10 份产物的准确率。
- 可观测：墙钟、token、限流触发次数、failure/unknown 率、槽位利用率。
- 安全性：全 `read` lane，`publish=0`，写产物走独立 `reports/` 目录不碰源码。

这个场景同时压测了调度器、限流、归并、产物索引和 UI，且不依赖任何外部账号。

---

## 16. 风险清单

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| 供应商限流击穿 | 并发 > 账号配额；per-orchestrator 熔断不共享 | RateGovernor + 共享熔断表 + 排队 |
| 成本失控 | 64 路 × 长任务；无金额预算机制 | 池级总账 + 触顶停派 + 实时成本可见 |
| **错误放大** | 无验证的并行（论文实测 17.2×） | 关键产物必须带验收证据；`unknown` 不合成 `completed` |
| 归并噪音 / 结果被闸掉 | 50 条摘要拼一起，父上下文 40000 字符闸 | 三层归并（§9），正文不进上下文 |
| 写冲突 | 多路 mutate；写锁仅批内共享 | 默认 `publish=1`；跨批共享锁；必要时快照隔离 |
| 上下文爆炸 | 汇总表超预算 | 汇总表硬上限 4000 字符；异常项优先保留 |
| 任务池饥饿 | 长任务占满槽位 | 优先级 + lane 配额 + 任务级墙钟上限 |
| 恢复语义伪造 | 重启后重跑已发生副作用 | Reconciler + 三维终态 + 宁可 `unknown` |
| **磁盘/提交延迟先崩** | journal 每次 commit 全前缀重校验+hash（O(N²)），无分段无压缩 | 独立池账本 + journal commit 上限 + 任务迁移（§6.5） |
| shell 作业丢失 | managed job 纯内存，重启即 orphaned | 池不承诺作业级恢复（§10.1），写进 acceptance 语义 |
| 现有测试大面积失败 | 默认值被改动 | 保留现有默认档位，池档独立配置（§13） |

---

## 17. 需要决策的点

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| **A** | 池住在哪 | 宿主内嵌 / 独立守护进程 | **宿主内嵌**（复用身份、恢复、workspace 锁）；守护进程留后续 |
| **B** | 写并发边界 | 保持 mutate=1 / 补写锁后放开到 N / 快照隔离 | **先保持 1**，补全跨批写锁后再评估放开 |
| **C** | 并发上限 | 16 / 32 / 48 / 64 | 默认 32，可配；先看限流触发率再决定是否上 64 |
| **D** | 产物存储 | 工作区文件 / 独立产物库 | **工作区文件 + 索引**（可归档、可 git 管理） |
| **E** | 失败重试 | 不重试 / 固定次数 / 换 Agent 重试 | **每任务最多 1 次重试，且必须换 agentId 或缩小 goal**（避免同样输入同样失败） |
| **F** | `agent_mode` 是否新增 `swarm` | 新档 / 复用 `multi` | **新增 `swarm` 档**，与 coding/orchestrated 语义清晰隔离 |
| **G** | 池台账存哪 | 父 journal 流内 / 独立追加账本 | **独立账本**（§6.3：父流是 O(N²) 且恢复是手动单 run 的） |
| **H** | 桌面自动恢复 | 保持手动 / 池自动对账 | **池自动对账**（否则 50 条任务不可能手动点 50 次） |

---

## 18. 与既有文档的关系

- `文档/多Agent协作/多Agent协作思考.md`：三层权责分层（Root / 二级调度 / 执行）。
  本方案的池 = 把"二级调度"的调度职责**下沉到宿主程序**，让模型只做规划与验收。
  这与该文档"压力分层承载、Root 不处理细碎数据"的原则一致。
- `文档/工作日志/2026-09-12-Scaling-Agent-Systems论文精读.md`：§2 已说明如何把
  论文的 3–4 上限与池的 32–64 并发区分开；论文的 45% 规则仍然有效——
  **每条任务内部**是否该再拆多 Agent，仍应按"单 Agent 基线是否超过 45%"判断。
- `文档/项目理解与面试/05-多Agent与验收.md`：本方案完整继承其纪律——
  区分执行结束/证据有效/需求完成，scope 不是权限票据，恢复不重造身份，宁可 unknown。
- `plans/memory-full-cutover-plan.md`：蜂群产出的业务产物是否进长期记忆，需要与该计划对齐（本文未展开）。

---

## 附：一句话总结

**蜂群的本质不是"更多 Agent 同时思考同一个问题"，而是"更多独立任务同时被推进、由程序调度、由产物收口"。**
现有 Paw 已经有任务合同、DAG、独立 Session、可恢复 worktree、活动记账和证据纪律——
缺的是把这些从"一次工具调用"里解放出来，做成一个跨轮、跨重启、可干预、有预算的常驻任务池。
