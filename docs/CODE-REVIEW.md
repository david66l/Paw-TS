# Paw-TS 代码审查报告（可读性 & 软件工程）

审查范围：`packages/*`（22 个 workspace 包）、`apps/desktop`（唯一 app）、`benchmarks/`、根配置与 CI。
`legacy/`（已归档的 CLI/TUI/eval）不在审查范围内。

方法：静态度量 + 交叉包扫描 + 定点精读 + 4 个专项深读（agent / memory / runtime+protocol / desktop+工具层 / 配置与 CI）。
所有结论都带 `file:line` 证据；本文中标 **[已复核]** 的条目由我独立复现过，不是二手转述。

---

## 0. 度量基线

| 指标 | 数值 |
| --- | --- |
| 受版本控制的 TS/TSX | 1170 文件 / 308,363 行（不含 legacy） |
| 源码 vs 测试 | 源码 ~162k 行，测试 ~59k 行，整体测试比 ≈ 0.36 |
| 注释占比（源码） | 8.9% |
| 源码文件 ≥1000 行 | **30 个**（其中 6 个 ≥2000 行） |
| 测试文件 ≥1000 行 | 19 个 |
| `: any` | 4 处（2 文件）— 极少，纪律很好 |
| `as any` | 43 处，**全部**在 `packages/memory/src` |
| `as unknown as` | 238 处 / 85 文件（**但 `packages/agent/src` 只占 6 处**，见下） |
| `as never` | **108 处**，其中 94 处在 `packages/memory-core` |
| 非空断言 `!` | **648 处**（Biome 统计；`packages/agent/src` 仅 29 处） |
| `@ts-ignore` / `@ts-expect-error` | 3 处（均在测试） |
| 空 `catch {}` | **0 处** |
| `TODO/FIXME/HACK` | 1 处 |
| 导出符号带 `V<n>` 后缀 | 1923 / 3523 = **54.6%** |
| `bun run lint` | **1069 error / 645 warning**（1104 文件） |

亮点先说：`: any` 只有 4 处、空 `catch` 为 0、`@ts-ignore` 只有 3 处且都在测试里。这个仓库的类型纪律在同类规模项目里属于上游水平 —— 下面的问题基本都不是"偷懒"，而是**约定没有写下来 / 没有闸门**导致的漂移。

两个必须说清的口径问题：

- **行数口径**：上表及后文用"含空行"计数；`grep -c` 或用 `Measure-Object -Line` 会得到偏小的"非空行"数（例如 `packages/agent/src/orchestrator.ts` 是 **5715** 行含空行 / 5185 非空行）。引用数字时请以后者为准。
- **类型逃逸高度集中，不是全仓均匀分布**。`packages/agent/src`（118 个非测试文件、38,952 行）里只有 **6 处 `as unknown as`、29 处非空断言、0 处 `: any`、0 处 `@ts-ignore`**，而且绝大多数 `!` 是 `noUncheckedIndexedAccess` 下的合法索引边界。238 处 `as unknown as` 主要压在 `memory-plugin`(59) / `memory-core`(53) / `memory`(48) / `runtime` 上。**结论：这是 2–3 个包的局部问题，不是仓库文化问题** —— 所以修复面比看上去小得多。

---

## 1. 最高优先级：同一个对象算出两个不同哈希（正确性缺陷）**[已复核]**

`canonicalJsonStringifyV1` / `hashCanonicalJsonV1` 这个"规范 JSON 哈希"原语在仓库里存在**多份独立实现**：

| 实现 | 位置 | 编码语义 |
| --- | --- | --- |
| A | `packages/memory-core/src/canonical.ts:12,27` | 不过滤 `undefined`，不校验 |
| B | `packages/runtime/src/context/canonical-json.ts:6,29` | 与 A **逐字节相同**（纯复制） |
| C | `packages/agent/src/loop-v2/canonical.ts:3,19` | **过滤** `undefined` 键 |
| D | `packages/paw-next/src/product-manifest.ts:116,138` | 过滤 `undefined`，并**校验**（拒绝 NaN/Infinity/循环引用） |

（`packages/memory-plugin/src/canonical.ts` 是 `export * from "@paw/memory-core/canonical"`，属于正确做法，不计为重复。）

实测差异：

```
{ a: 1, b: undefined }
  memory-core  {"a":1,"b":undefined}   -> sha256 420b9e40...
  runtime      {"a":1,"b":undefined}   -> sha256 420b9e40...
  agent/loop2  {"a":1}                 -> sha256 015abd7f...
  paw-next     {"a":1}                 -> sha256 015abd7f...

{ n: NaN }
  memory-core / runtime / agent -> {"n":null}     ← NaN、Infinity 与 null 三者哈希碰撞
  paw-next                      -> throw "Value is not valid JSON"

JSON.parse('{"a":1,"b":undefined}')  ->  ** 解析失败 **
```

三个具体危害：

1. **身份分裂**：同一个对象在 A/B 侧和 C/D 侧得到不同摘要。这些哈希被用作 `revision` / `certificateId` / `artifactHash` / `stateHash` 等**身份字段**并被跨包比较（例如 `packages/paw-next/src/composition.ts:1484` 比较两侧 manifest 哈希，`packages/memory-core/src/evidence-execution-runtime-v1.ts:335` 比较 frame 哈希）。一旦"生成方"和"校验方"落在不同实现上，校验会以极难排查的方式失败。
2. **产出非法 JSON 却继续哈希**：A/B 会生成字面量 `"b":undefined`，数组则生成 `[1,,2]`（空洞）。这段**不是合法 JSON** 的文本被直接 SHA-256 当作身份。任何把它落盘、回读、或喂给 `JSON.parse` 的路径都是定时炸弹。
3. **`NaN` / `Infinity` / `null` 哈希碰撞**：A/B/C 三者把三者都编码成 `null`，于是 `{n: NaN}` 与 `{n: null}` 拥有同一身份。

**修复建议**：把 D（paw-next 版本）提升为唯一实现 —— 它已经同时做了 undefined 归一、非法值拒绝和显式排序比较器。放在 `packages/protocol`（零依赖叶子包）导出；`memory-core` 因为要保持"无运行时依赖、可独立发布"的定位，可以保留本地副本，但**必须**加一个跨包一致性测试作为闸门：

```
packages/<x>/test/canonical-conformance.test.ts
  // 对一组含 undefined / 嵌套 undefined / NaN / -0 / unicode 键的语料，
  // 断言 memory-core 与 protocol 的编码输出逐字节相等。
```

这个测试是本次审查里**性价比最高的一条改动**：它把一个"迟早会以诡异方式爆炸"的正确性风险，变成一个会在 CI 里当场变红的断言。

---

## 2. 结构性问题（按影响排序）

### 2.1 30 个千行文件；`AgentOrchestrator` 是 4,922 行的 god class，`initializeRun` 单方法 1282 行 **[已复核]**

`packages/agent/src/orchestrator.ts` **5715 行**，其中 `export class AgentOrchestrator {`（`:631`）到 `:5552` 就是 **4,922 行**：**76 个私有实例字段**（`:667 _payloadDeduper`、`:683 compactCooldownTurns`、`:739 circuitBreakers`、`:757 _lastLoopV2ShadowReport`…）、59 个方法。同一文件还混着与实例无关的模块级代码（`:284`–`:630` 的辅助函数，`:5554`–`:5715` 的 `classifyError` / `computeRetryDelay` / `buildMemoryLlmOptions`）。

最大的几个方法（括号配对逐一验证）：

| 行数 | 位置 | 方法 |
| --- | --- | --- |
| **1282** | `orchestrator.ts:4093–5374` | `initializeRun` |
| 740 | `orchestrator.ts:995–1734` | `run` |
| 622 | `orchestrator.ts:2494–3115` | `executeTurn` |
| 488 | `action-handlers.ts:1660–2147` | `handleToolCalls` |
| 462 | `tool-runner.ts:392–853` | `executeToolCalls` |
| 411 | `action-handlers.ts:606–1016` | `handleFinalAnswer` |
| 310 | `orchestrator.ts:1770–2079` | `callModelAndParseActions` |
| 279 | `orchestrator.ts:3497–3775` | `invokeModelOnce` |
| **253** | `tool-runner.ts:589–841` | `executeOne`（**是 `executeToolCalls` 内部的闭包**） |

真正的问题不只是"长"，而是**耦合是隐形的**：`executeTurn` 收 7 个参数，`PhaseContext`（`orchestrator/types.ts:198–277`）另有 35 个字段，于是任何模块都能拿到任何东西。

`initializeRun` 内部其实**已经有天然接缝**（文件自己的分隔注释就是证据）：`:4892` 子 Agent 模式、`:4972` 完整 Agent 模式、`:5238-5281` 四步上下文压缩流水线。它同时承担：profile/凭据解析 → MCP 连接 → 记忆初始化 → session 打开 → system prompt 构建 → **两套完整 agent 模式** → 上下文预算四步流水线。而且它返回一个**匿名 30 字段结构体**，`run()`（`:1006–1029`）解构其中 22 个，再在 `:1380–1441` 重新拼成一个 35 字段的 `PhaseContext` —— 没有任何类型名字命名"一次运行的运行环境"。

建议按现有注释切：

- `initializeChildAgentRun(...)`（`:4892` 起）
- `initializeFullAgentRun(...)`（`:4972` 起）
- `applyContextBudgetPipeline(...)`（`:5238` 的四步）
- 共享前导抽成 `RunSession` 类，拥有那 30 个值并暴露 `restoreJournal()` / `selectModel()` / `connectMcp()` / `buildSystemPrompt()`

**并加一条机械约束**：新增/修改的方法不超过 ~150 行。没有闸门的话，切完还会再长回去。

同类问题（详见各专项深读）：`memory-core/src/evidence-resolution-pass.ts:122` 的 `resolveEvidencePass` **1324 行**、`memory-plugin/src/aspect-graph.ts:903` `validateGraph` 346 行、`harness/src/registry/execution.ts` 1876 行、`apps/desktop/src/agent/useAgentRun.ts` 1849 行（单个 React hook）。

### 2.2 唯一被审查的"边界"是包依赖图，模块级与文件级无人管

仓库有一个很好的闸门：`scripts/check-workspace-dependency-cycles.ts`（无环校验 + WP1a 源边界）。但它只覆盖**包级声明依赖**。于是以下的漂移完全没有闸门：

- **跨包同名不同义**（见 §3），类型系统不会报错，因为它们在各自的包里自洽。
- **文件级 god file**，没有任何检查。
- **重复原语**（§1）。

建议补两个便宜的机械闸门（都不需要引入新依赖，写成 `bun test scripts/*.test.ts` 即可）：

1. `canonical-conformance.test.ts`（§1）。
2. **跨包同名导出检测**：扫描各包导出符号，若同名符号在两个包的**定义体不同**，则要求在同名处加一行白名单注释说明为何不同。这能把 §3 那类"看起来一样其实不一样"的坑变成显式的决定。

### 2.3 CI 完全不覆盖唯一的 app **[已复核]**

`bun run check:ts` = `lint && typecheck && test:ts`，而：

- `typecheck` 脚本**不含** `typecheck:desktop`
- `test:ts` 包列表**不含** `apps/desktop`
- `apps/desktop` 的端到端测试 `test:native` 从未在 CI 里跑过
- `check:deps`（无环闸门）也**不在** `check:ts` 里

也就是说：**仓库里唯一的应用，类型检查、单测、e2e 三样在 CI 里全是零覆盖。** 而这些在本地都是通过的（桌面 190 pass / 1 skip / 0 fail，e2e 7 项全过），所以这纯粹是接线遗漏，不是代码问题。

建议：
```
"typecheck": "... && bun run typecheck:paw-next && bun run typecheck:desktop",
"check:ts":  "bun run lint && bun run typecheck && bun run test:ts && bun run check:deps",
```
CI 里再加一个 job 跑 `cd apps/desktop && bun test test`（`test:native` 需要 Electron，可放到 nightly 或加 `continue-on-error` 观察一段时间）。

### 2.4 最大的文件在所有闸门之外 **[已复核]**

`benchmarks/` 不在 `workspaces`（只声明了 `packages/*`、`apps/*`），没有 `package.json`，且：

| 闸门 | 覆盖 benchmarks？ |
| --- | --- |
| `lint`（`biome check packages apps`） | ❌ |
| `typecheck` | ❌ |
| `test:ts` | ❌ |
| `check:deps` | ❌ |

只有 `benchmarks/amb` 有 `tsconfig.json`，且要手动 `bunx tsc -p benchmarks/amb/tsconfig.json` 才会跑。结果是约 3 万行 benchmark 代码 —— **包括全仓最大的源文件 `benchmarks/amb/paw-memory-bridge.ts`（5564 行）** —— 只在有人记得的时候才被检查。这些文件通过相对路径 import `@paw/*` 源码，所以任何重命名都会静默破坏它们（我上次做 legacy 迁移时，benchmark 的 import 就是靠人工扫描才发现的）。

建议：给 `benchmarks/` 加一个 `tsconfig.json`（`include: ["**/*.ts"]`，`noEmit`），并把它挂进 `typecheck`。如果 benchmark 里确实有长期不打算维护的实验代码，就明确写进 README 而不是靠"没闸门"来默认豁免。

### 2.5 每个包的 tsconfig 复制粘贴，并共存两套模块解析制度 **[已复核]**

22 个 `packages/*/tsconfig.json` 只有 **12 种不同内容**：

- **变体 1（8 个包：agent, core, harness, memory, protocol, settings, store, workspace）** — 逐字节相同，`rootDir: "."`。
- **变体 2（4 个包：context-compaction, output-recall, task-progress, web-access）** — 逐字节相同，改用 `rootDir: "../.."` + `baseUrl: "../.."` + 一份 6 条 `@paw/*` 的 `paths` 映射。
- **变体 3（1 个包：progress-advisor）** — 自己的 `paths` 列表。

因为 `noEmit: true`，`rootDir`/`outDir` 其实是惰性的，**真正有行为差异的只有 `paths`**。于是仓库里同时存在两套 `@paw/*` 解析制度：15 个包依赖 workspace 软链（`node_modules/@paw/*`），5 个包依赖 `paths`。后果是同一个 import 在不同包里可能走不同解析路径 —— 一个包能通过的写法，另一个包可能报错或（更糟）解析到不同副本。

建议：
- 把 `compilerOptions` 的公共部分全部上提到 `tsconfig.base.json`（`rootDir`/`outDir`/`noEmit` 既然惰性就该删掉或只留一处）。
- `paths` 要么统一（所有包都开），要么全部去掉（只靠 workspace 软链）—— **不要两套并存**。若确实需要（例如为了 IDE 在未 `bun install` 时也能跳转），就写进 base 并由所有包继承。
- 目标是 22 个包各剩 3–5 行 `extends` + `include`。

### 2.6 两套错误处理约定并存，且没有写下来 **[已复核]**

按包统计 `throw new` vs `{ ok: ... }` 返回：

| 包 | throw | `{ok:}` | 倾向 |
| --- | --- | --- | --- |
| `packages/runtime` | 528 | 24 | 抛异常 |
| `packages/agent` | 352 | 63 | 抛异常 |
| `packages/protocol` | 259 | 0 | 抛异常 |
| `packages/harness` | 22 | **103** | 返回结果对象 |
| `packages/memory` | 39 | **68** | 返回结果对象 |
| `packages/workspace` | 15 | **34** | 返回结果对象 |

这个分裂**很可能是有意的**（工具层返回结构化结果给模型看，durable/protocol 层靠抛异常守住不变量），但没有任何文档说明规则，新人无法判断新模块该用哪种。建议在 `ARCHITECTURE.md` 写清一条判据，例如：

> 会被模型看到并需要它据此决策的失败 → 返回 `{ ok: false, error }`；违反进程内不变量或持久化契约的失败 → 抛类型化异常。

---

## 3. 跨包同名不同义（读者陷阱）**[已复核]**

自动扫描"同名导出出现在 ≥2 个包"，26 组；其中**真正危险的是值域不同的**：

| 符号 | `packages/protocol` | 另一处 | 判定 |
| --- | --- | --- | --- |
| `MemoryKind` | `"project_rule"｜"user_preference"｜"task_episode"｜"failure_pattern"｜"module_summary"｜"procedure"｜"reference"` (`protocol/src/memory.ts:27`) | `"semantic"｜"episodic"｜"profile"｜"vault_ref"` (`memory/src/longterm/store/engine.ts:12`) | **完全不同** |
| `MemoryStatus` | `"active"｜"deprecated"｜"superseded"` (`protocol/src/memory.ts:37`) | `"active"｜"suspected_stale"｜"stale"｜"conflicted"｜"superseded"｜"archived"｜"deleted"` (`memory/src/db/types.ts:21`) | **完全不同** |
| `MemorySource` | `"session"｜"auto"｜"project"｜"user_explicit"` (`protocol/src/memory.ts:18`) | `"user_statement"｜"agent_verified"｜"agent_inferred"｜"repo_docs"｜"trial_graduated"` (`memory/src/longterm/store/engine.ts:14`) | **完全不同** |
| `SubAgentResult` | — | `agent/src/orchestrator/types.ts:298`(374 字符) vs `harness/src/context.ts:200`(1431 字符) | 同名，结构差 4 倍 |
| `ToolExecutionPolicy` 等 6 个 | — | `agent/src/execution-policy.ts:21` 与 `harness/src/registry/transaction.ts:26` | **逐字节相同**（纯复制，且注释已漂移：一份有 `appliesTo` 说明，一份没有） |

这不是"要不要合并"的问题 —— `MemoryKind` 的两套值域很可能分别对应**旧文件记忆**和**v2 Postgres 长期记忆**两个真实不同的领域。问题是**它们共用了同一个名字**，导致：

- 在同一个文件里同时 import 两边时（`memory` 依赖 `protocol`）需要别名，否则直接命名冲突；
- 读者看到 `MemoryKind` 无法知道指哪一套，必须回看 import 路径；
- 类型系统不会报错，因为两边各自自洽。

建议：**改名去歧义**（不是合并语义），例如 `LegacyMemoryKind` / `LongtermMemoryKind`（或按领域命名 `FileMemoryKind` / `V2MemoryKind`），并在 `packages/protocol/src/memory.ts` 顶部写一段说明两套词汇表的关系。`ToolExecutionPolicy` 那 6 个逐字节相同的，则应该**收敛成一份**放在 `harness`（事务契约的所在地），`agent` 改为 re-export。

---

## 4. `V1/V2/V3` 后缀已经失去信息量 **[已复核]**

- 导出符号 **54.6%（1923/3523）** 带版本后缀；`memory-plugin` 100%、`runtime` 99%、`memory-core` 95%、`protocol` 92%。
- 源码中出现 `V1` 12,107 次、`V2` 1,872 次、`V3` 310 次。

问题不在"用了版本号"，而在它同时被用在两类完全不同的东西上：

1. **真正有线上契约的序列化 schema** —— 这时候后缀是对的，而且仓库里已有更规范的写法（`PAW_MEMORY_*_VERSION_V1` 常量族）。
2. **纯进程内的私有函数** —— 没有任何序列化契约，后缀纯粹增加长度。memory 专项深读在 `memory-core` 里数出 **38 个私有的 `V<n>` 函数**（如 `parseNumericQuantityV1`、`formatExactDecimalV1`），而 `packages/memory` 是 0 个。同一个仓库两种做法。

另外 `-v2` 文件有 4 个（`state-frame-v2.ts`、`state-frame-shadow-v2.ts`、`state-observation-binder-v2.ts`、`state-observation-verifier-v2.ts`）**全仓找不到对应的 `-v1`**，而 `json-query-planner.ts` 直接从一个 `isMemoryEvidenceAnswerShapeV3` 起步。

建议：
- 后缀只保留在**导出且会被序列化**的类型/常量上；
- 私有函数去掉后缀；
- 无前驱的 `-v2` 文件要么改名，要么在文件头一行说明它替代了什么；
- 加一条能自动跑的检查：`^function \w+V[123]$` 不允许出现在 source 中。

---

## 5. 类型逃逸的真实分布：`as never` 是症状不是病因 **[已复核]**

108 处 `as never`，94 处在 `memory-core`，且**几乎全部是同一个形状**：

```ts
hashCanonicalJsonV1(identity as never)
```

根因在 §1：`hashCanonicalJsonV1(value: JsonValue)` 的入参类型过窄，调用方手里是别的类型，于是用 `as never`（`never` 可赋给一切类型）把检查彻底关掉。

**一次改动同时解决三件事**：把签名放宽为 `hashCanonicalJsonV1(value: unknown)` 并在内部做 `toJsonValue` 校验（即 paw-next 已有的实现），则
(a) §1 的非法 JSON / NaN 碰撞被修掉，
(b) 94 处 `as never` 可以直接删掉，
(c) 校验失败从"静默算错哈希"变成"当场抛错"。

这属于我说的高杠杆改动：**一处签名修改 → 消灭 94 处类型逃逸 + 修掉一个正确性缺陷**。

---

## 6. Lint 闸门是红的，但可以快速转绿 **[已复核]**

`bun run lint` → 1069 error / 645 warning / 1104 文件。**但"1069"这个数字严重高估了真实债务** —— 按诊断类别拆开后，绝大部分不是代码问题：

| 类别 | 数量 | 性质 |
| --- | --- | --- |
| `parse`（Biome 解析 CSS module 失败） | **334** | **配置缺陷，不是代码缺陷** |
| `format` | 363 | **可自动修** |
| `organizeImports` | 146 | **可自动修** |
| `noNonNullAssertion` | 584（配置为 `warn`） | 策略问题，且集中在测试 |
| `noUnusedTemplateLiteral` | 43 | **可自动修** |
| `useTemplate` | 105 | **可自动修** |
| `useLiteralKeys` / `noUnusedImports` / `useConst` / `noAssignInExpressions` / `useYield` / 其它 | ~90 | 部分可自动修 |

关键发现：**334 个 `parse` 错误全部是 Biome 1.9 不认识 CSS Modules 的 `:local` / `:global` 伪类**，报错信息是 `` `:local` and `:global` pseudo-classes are not standard CSS features.``，分布在 5 个文件：`ChatStream.module.css`(154)、`Sidebar.module.css`(86)、`SettingsModal.module.css`(36)、`RightPanel.module.css`(36)、`GlassPanel.module.css`(22)。这些是**标准 CSS Modules 语法**，代码没错。

也就是说 **334 + 363 + 146 + 43 ≈ 886（占 83%）是配置缺失或机械可修**，真正的 lint 债务只剩一小部分。这解释了一个现象：闸门常年红，于是 584 条 `noNonNullAssertion` 警告没人看。

修复顺序（顺序很重要，否则会把配置 bug 当成基线固化下来）：
1. `biome.json` 加 `"css": { "parser": { "cssModules": true } }` → 直接消掉 334 个错误。
2. `bun run lint:fix` 一次性收掉 format / organizeImports / useTemplate / useLiteralKeys（≈630+）。
3. `biome.json` 加 `overrides`：`**/test/**` 下**关闭** `noNonNullAssertion`（测试里 `!` 是惯用写法，714 条诊断中 622 条落在 `**/test/`）。
4. 此时再看剩下什么，才谈 ratchet（基线计数）或把 `noNonNullAssertion` 在 `src` 里提为 `error`。

---

## 7. 深读发现（专项）

> 以下为各专项深读结果的汇总；每条都带 `file:line`。

### 7.1 `packages/memory` / `memory-core` / `memory-plugin`

**M1. `db/` 层 43 处 `as any` 的唯一根因：行类型（row type）根本不存在** — `severity: high`
40 个手写 SQL migration（`packages/memory/src/db/migrations/V003__memory_items.sql:3`）没有对应的 TS 类型，于是每个 DAO 手工做 snake_case → camelCase 映射并以双重断言收尾：`memoryItem.ts:7` `function rowToItem(row: Record<string, unknown>): MemoryItem`，`:31` `} as unknown as MemoryItem;`。行类型还在各调用点被重新发明（`longterm/store/postgres-engine.ts:284`、`db/modules/read/memoryRetriever.ts:116`）。
危害：双重断言意味着**数据库列改名后得到的是运行期 `undefined` 字段，而不是编译错误**。
修复：新增 `packages/memory/src/db/rows.ts`，每张表一个 `type XRow`（原始 snake_case，可空列用 `| null`）；`rowToItem(row: MemoryItemRow): MemoryItem` 内部**零断言**；断言只出现在驱动边界一次（`sql.unsafe<MemoryItemRow>(...)`）。

**M2. `memoryItemDao.query` 的 if 阶梯已经丢过滤条件、截断入参** — `severity: high` **[已复核]**
`db/dao/memoryItem.ts:101` 声明了 `tags?: string[]`，但 `:110`/`:119`/`:127`/`:134`/`:142` 五个分支**没有任何一个读它**。更严重的是 `type` 只能表达单个值，调用方因此在静默丢数据：
```ts
// packages/memory/src/db/modules/read/memoryRetriever.ts:91
type: req.types?.[0],
```
（`RetrievalRequest.types?: MemoryType[]`，见 `memoryRetriever.ts:20`。）
危害：`retrieve({ types: ["rule","decision"] })` 只返回 `rule`，**不报错**。
修复：改成组合式片段构造器（`db/dao/where.ts` 导出 `and()` + `byType/byStatus/byRepo/byUser/byTags`），签名改 `types?: readonly MemoryType[]`，并补一个断言 `tags` 与多 `types` 真的生效的 DAO 测试。

**M3. 同一条写路径有两份实现，其中一份的注释与代码矛盾** — `severity: high`
`db/modules/write/memoryStore.ts:5` 写着"这是正式记忆的唯一写入入口"，但 `db/modules/write/governanceExecutor.ts:94` 在同一目录下重实现了 APPROVE_CREATE/UPDATE/MERGE，连 `as unknown as MemoryItem`（`:119` vs `memoryStore.ts:98`）、embedding 段、merge 置信度平均都一样。使用上两条路径都活着：`MemoryStore` 只在 `db/modules/evolution/admin.ts:27` 构造，而 `GovernanceExecutor` 接在 `runtime/memory-runtime.ts:111`、`evolution/selfEvolvingLoop.ts:53`、`migrate-legacy.ts:141`。
危害：注释所述的不变量是假的；修一个写路径的 bug 有两个地方要改，且没有任何信号提示另一处存在。
修复：保留 `GovernanceExecutor`（它有前置条件和真正的 `sql.begin`），把 `MemoryStore` 降成委托包装或删除；共享的 item 构造抽到 `itemFromDecision.ts`。

**M4. `resolveEvidencePass` 是 1324 行、含至少 7 个阶段的单函数** — `severity: high`
`memory-core/src/evidence-resolution-pass.ts:122` 到 `:1447`。它自己的注释横幅已经标出了接缝：`:152` 时间绑定、`:278` L0 源本地对话通道、`:653` locator 证书编译、`:780` 相对时间重排、`:810` selector 权威门、`:912` 答案侧对话绑定、`:1257` 支撑地板/包组装。
危害：它处处在守的不变量（例如 `:810` 注释"默认关闭，这样 selector 失败永远不会让 `undefined` 在下游被理解成'接受所有命中'"）在千行函数里根本无法 review。
修复：按上述接缝拆到 `memory-core/src/evidence-resolution/`，主函数退化为 ~60 行、围绕一个类型化的 `ResolutionPassState` 的编排器。同类的还有 `evidence-execution-runtime-v1.ts:577` `executeDerivedNode`（280 行、`:597`–`:672` 是 12 分支的 `if (node.operation === …)` 链，应该是 `operation → handler` 表）、`memory-plugin/src/aspect-graph.ts:903` `validateGraph`（346 行）。

**M5. 包边界是"倒置"的：17 个纯转发文件 + 改名门面** — `severity: medium`
`memory-plugin` 有 17 个文件是 1–3 行的纯 re-export（`memory-plugin/src/state-frame-v2.ts:1` `export * from "@paw/memory-core/state-frame-v2";`），同时公开名与实现名不同：`memory-core/src/public-api.ts:7` `export { createEvidenceFirstMemoryContextResolverV1 as createContextResolver } from "./evidence-context-adapter.js";`。同一个包内还有重名：`memory/src/runtime/index.ts:15` 定义 `createMemoryRuntime`，而 `memory/src/runtime/memory-runtime.ts:895` 又定义了第二个、**不可达**的同名函数。
危害：grep 公开符号找不到实现；两个同名导出保证迟早有人改错那个死代码；另外 `memory/src/index.ts` 完全没有导出 `./db/`，导致该包最大的子系统在默认入口里不可见。
修复：删掉 17 个 shim，直接从 `memory-plugin/src/index.ts` re-export 子路径（保留 `evidence-first-product.ts`，别名测试 `memory-plugin/test/evidence-first-alias.test.ts:3` 需要它）；统一或去掉改名；删除 `memory-runtime.ts:895`。

**M6. scope 指纹与短哈希跨包重复，且该字段参与校验** — `severity: medium`
同一算法、同字段顺序、同分隔符、同 `slice(0, 20)`，对两种类型各实现一次：`memory/src/longterm/store/scope-key.ts:41` 与 `memory-plugin/src/profile.ts:203`。该值被用作相等性校验（`memory-plugin/src/aspect-graph.ts:950`、`:1255`）。32 位短哈希还写了三份：`memory/src/db/modules/write/memoryWriter.ts:378` 与 `runtime/memory-runtime.ts:861` 逐字节相同，`memory-runtime.ts:886` 的 `shaShort` 函数体相同但用 `Math.abs(h)` 而非 `(h >>> 0)`（而且名字里的 "sha" 是误导，里面没有 SHA）。
危害：`memory-plugin` 本来就依赖 `@paw/memory`，这是纯粹的漂移风险，落在一个把守快照校验的字段上；`shaShort`/`hashShort` 对负值输出不同，构造出的 subject key 互不通用，而没有任何地方说明。
修复：`scope-key.ts` 导出唯一的 `memoryScopeFingerprint`（`PawNextMemoryScopeV1` 改为 `MemoryScopeKey` 的别名）；短哈希收敛到 `memory/src/shared/hash.ts` 的 `shortHash(text)`。

**M7. DAO 的 SQL 约定三套并存；为修 bug 写的辅助函数没人用** — `severity: medium`
同一目录下 JSONB 两种序列化方式：`memoryItem.ts:70` 用 `sql.json(item.scope as any)`，`workingMemory.ts:40` 用 `JSON.stringify(wm)`。数组三种写法：`sql.array`（`memoryItem.ts:71`）、`textArrayLiteral`（`postgres-engine.ts:355`）、裸 `'{}'::jsonb`（`memoryStore.ts:123`）。关键在于 `db/connection.ts:49-55` **明确记录了** `sql.array` 在冷连接上会因序列化器未初始化而报错，并提供了 `textArrayLiteral`（`:56`）作为解法 —— 但 `textArrayLiteral` 在 `db/` 里**零调用点**，`db/dao` 仍在用 `sql.array`。另一处桥接函数 `connection.ts:39` 的 `j()` 全仓无调用者。
危害：同一个目录里两个 DAO 走不同的驱动路径；已被记录在案的冷连接数组 bug 仍然活在 `memoryWriter → memoryCandidateDao.create`（`memoryCandidate.ts:51-53`）这条写路径上，表现为间歇性的"第一个查询失败"。
修复：统一为 tagged template + `sql.json`（JSONB）与 `textArrayLiteral(...)::text[]`（数组）；把 `workingMemoryDao`/`taskSessionDao`/`governanceDecisionDao` 从位置参数 `sql.unsafe` 迁走；删掉 `j()`；补一个"新建连接池后立刻做数组参数插入"的测试。

**快速修复项（可在一次提交里做完）**
1. `db/connection.ts:39` — `j()` 无调用者，删除。
2. `db/modules/platform/outboxManager.ts:28` — `writeInTx` 是死代码，而 `memoryStore.ts:121` 与 `governanceExecutor.ts:80` 都在手搓同一段 outbox INSERT。
3. `db/modules/evolution/selfEvolvingLoop.ts:140` — 返回的 `EvolutionCandidate` 与 `:138` 刚插入的行不一致（`proposedTitle`、`riskLevel`）；构造一次再插入。
4. `selfEvolvingLoop.ts:157` — 裸 `catch { return null }` 吞掉了插入的所有失败，schema 不匹配会伪装成"没有候选"。
5. `db/modules/write/memoryWriter.ts:54` — `buildScope(input)` 算了一次，`:145` 又算一次。
6. `db/api.ts:284` — `Bun.serve` 在模块顶层执行，import 这个文件做测试会真的起服务；应放到 `if (import.meta.main)` 后面并导出 `handle`。

### 7.2 `packages/agent`

**A1. `AgentOrchestrator` 是 4,922 行 god class，一个文件里塞了三个模块** — `severity: high`
见 §2.1。76 个私有字段才是真正的耦合源。建议按现成接缝拆：`orchestrator/model-gateway.ts`（← `invokeModelOnce:3497`、`invokeModel:3776`、`callModelWithRetry:3985`、`getOrCreateBreaker:3943`，外加 `:5567–:5715` 这几个与实例几乎无关的辅助函数）、`orchestrator/context-budget.ts`（← `maybeCompactHistory:2080`、`compactHistoryOnResume:2311`、`measureBudget:5392`、`reserveRequestProjection:5422`、`emitContextBlocks:5460`）、`orchestrator/run-session.ts`（← `initializeRun` 的前导部分 + `submitUserReply:847`、`resumeRun:885`）。目标是把 `orchestrator.ts` 压到 <1500 行，只留 `run`/`executeTurn`/分发。

**A2. `emit` 闭包是 118 行、承担五件事，并在第五层嵌套里裸 `return`** — `severity: high`
`orchestrator.ts:4393–4510`。指标累加靠 6 个顺序无关的 `if`（`:4395–4420`）；排序/持久化在 `:4422–4441`；投影与 fail-open/fail-closed 决策在 `:4445–4508`，其中 `:4490` 是一个嵌了五层的裸 `return`。
危害：`emit` 被调用 72 次，其自身文档注释称之为"通往外部世界的唯一通道"（`:4383–4392`），但任何调用点都看不出"发一个 `final_answer` 事件可能提前 return、可能持久化候选、v2 下还可能抛异常"。另外指标靠副作用累加（`:4397`/`:4400` 的 `modelCallStartTime`），两次模型调用交错时会静默算错延迟。
修复：`orchestrator/run-event-sink.ts`；把 `:4395–4420` 换成 `METRIC_REDUCERS: Partial<Record<RunEvent["type"], (m, e) => void>>` 表；把 `:4445–4508` 提成 `projectDurableEnvelope(...): "continue" | "stop"`，让那个裸 `return` 变成有文档的返回值。

**A3. `executeToolCalls` 用 7 个下标对齐的并行数组串起整个流程** — `severity: high`
`tool-runner.ts:454` `blockedByPolicy`、`:455` `effectPolicyApplies`、`:467` `lockConflict`、`:506` `approvals`、`:561` `checkpointNums`、`:582` `mutationCaptures`，全部在 `:594–:684` 以 `x[i]` 形式读取。更糟的是两种构造风格混用：`approvals` 靠 4 个分支 `push`（`:510–:513`、`:538`、`:551`、`:555`），而 `checkpointNums`/`blockedByPolicy` 靠下标赋值 —— 它们必须长度和顺序完全一致，却没有任何检查。`:598` 的 `!` 正是因为编译器无法证明数组同步。
修复：`tool-runner/tool-batch-plan.ts` 导出 `planToolBatch(...): ToolCallPlan[]`，每条 call 一个记录 `{call, blockedByPolicy, effectPolicyApplies, approval, lockConflict, checkpointNum, mutationCapture}`；7 个数组与那个 `!` 一起消失。

**A4. 重复实现已经分化成正确性差异（native turn 配对）+ 同一事件三套构造** — `severity: high`
**A**：同一个"配对是否合法"的问题，两处守卫不同。`action-handlers.ts:552–558` 校验 `callId` 身份对齐（`calls.every((call, i) => call.callId === errors[i]?.id)`），而 `tool-runner.ts:1328–1332` **只校验长度**。两处随后执行同一段逻辑，于是 `nativeTurn.calls` 顺序与 `calls` 不同的批次，**一条路径拒绝、另一条路径静默错配** —— 错配会把错误的 callId 贴到结果上，污染模型下一轮看到的 native tool turn。
**B**：同一个 `tool.result` 事件有三套手写构造：`tool-runner.ts:1257–1267`（带 `detail`+`provenance`+`decisionCommit`）、`action-handlers.ts:535–549`（带 `decisionDisposition`，**没有** `detail`/`provenance`）、`action-handlers.ts:2236–2242` 子 Agent 路径（有 `detail`，**没有** `provenance`/`decisionCommit`）。而 `orchestrator.ts:4281–4288` 恰恰会在 journal 里的 `tool.result` 缺 `decisionCommit` 时抛错 —— 于是这个断言只在部分路径上会触发。
修复：`tool-runner/native-turn.ts` 导出唯一的 `pairNativeToolTurn(nativeTurn, results, { requireCallIdAlignment: true })`，两条路径都用它；`tool-runner/tool-result-event.ts` 导出唯一的 `emitToolResult(ctx, call, observed, extras)`。

**A5. `loop-control-state.ts` 三处手工镜像 24 字段的 `TurnFlags`，且无完整性检查** — `severity: high`
同一组 24 个字段被枚举三次：`checkpointLoopControlV1`（`:134–267`，7 组手工 spread，`:200–219` 还做 `_` 前缀字段改名）、`restoreLoopControlFlagsV1`（`:313–494`，19 个条件 spread 反向改名）、以及 `:325–348` 一个 **22 个字段名**的 `Omit<TurnFlags, …>` 显式豁免清单。另有 10 个手写 `parseX` 校验器（`:495–836`，342 行）。
危害：三者之间没有完备性关联。**给 `TurnFlags` 加一个字段会编译通过，但那个状态会从崩溃检查点里静默消失**，只在崩溃恢复后表现为"状态丢了"。而且真值判断（`(flags.verifyNudges ?? 0) > 0`）让 0 与缺失不可区分，save→restore 不是恒等。
修复：用一个编译器强制完备的映射类型：
```ts
const TURN_FLAG_CODECS: { readonly [K in keyof TurnFlags]-?: {
  readonly toCheckpoint: (f: TurnFlags) => unknown;
  readonly fromCheckpoint: (c: LoopControlCheckpointV1) => TurnFlags[K] | undefined;
} } = { … };
```
两个函数退化成对 `Object.entries(TURN_FLAG_CODECS)` 的通用折叠，22 项 `Omit` 清单直接删除。

**A6. 51 个方法里有 5 个是 400+ 行；最深嵌套 5 层** — `severity: high`
除 §2.1 表格外：`action-handlers.ts:1804 → :1809 → :1811 → :1812`，在 options 对象字面量里塞了一个 `async dispatchOverride(call, sourceIndex)` 子 Agent 启动器 —— 调用方和 review 都看不见它。
修复：`action-handlers.ts` 的 `handleToolCalls` 拆成 `tool-batch-policy.ts` / `tool-batch-finalize.ts` / `sub-agent-dispatch.ts`；`handleFinalAnswer` 拆出 `final-answer-gates.ts`。

**A7.【已复核】公共面是不过滤的 barrel：788 个导出，实际只被消费 8 个** — `severity: high`
`packages/agent/src` 在 118 个非测试文件里声明了 **788** 个顶层导出。而全仓**只有两个消费者**（`apps/desktop`、`packages/paw-next`），它们合计只 import 了 **8 个不同符号**：

```
AgentSpec, createInputToMarkdown, DEFAULT_AGENT_SEEDS, formatDoctorOutput,
loadAgentRegistryReadonly, parseAgentMarkdown, resolveShellSandboxConfig, validateAgentSpec
```

这是**完整集合** —— 从字面量 `"@paw/agent"` 出发的 import 位点只有 4 个（`apps/desktop/agent-host/paw-next-models.ts:6`、`paw-next-profile.ts:3`、`run.ts:22`、`packages/paw-next/src/collaboration-roster-adapter.ts:8`），没有动态 `import()`、没有 `require`、没有二次 re-export。

更能说明问题的是：**这个包以之命名的那个类，外部从来没用过**。`AgentOrchestrator`（`index.ts:13` 导出）只在本包内被 `new`（`orchestrator-factory.ts:351`、`sub-agent-launcher.ts:131`），外部一律走 `@paw/paw-next`。真实分层是 `apps/desktop → @paw/paw-next → @paw/agent` —— 也就是说，**这个 788 符号的 barrel 其实是"把内部模块图发布成了公共 API"**，剩下 780 个不是"留给未来"，而是"碰巧可达的内部实现"。

`index.ts:243` 的 `export * from "./loop-v2/index.js";` 是泄漏口：单这一行就把 `loop-v2` 的 33 个符号（含 `control-reducer.ts` 19 个、`schema.ts` 31 个 reducer/projector/probe 内部件）发给了那 8 个符号的消费者。

**为什么这升到 high**：8/788 的消费比意味着**编译器无法区分公共契约与内部细节** —— 于是第 1、4、5、6 条里任何一次内部重构都是"潜在的破坏性变更"，而且不会有任何警告。780 个导出也完全没有基于消费的测试信号。

修复：
(a) `packages/agent/package.json` 的 `exports` 改成两项：`"." → ./src/index.ts`（精选）+ `"./internal" → ./src/internal.ts`；`index.ts:243` 换成显式命名列表（只列 `paw-next` composition 真正需要的，而不是全部 33 个）；
(b) 根 barrel 里去掉 `AgentOrchestrator`，改导出 `createRunOrchestrator`（`index.ts:53`，真正的对外入口）；
(c) 按 A 命名问题改名 `finalizeToolExecution` → `commitAndFinalizeToolExecution`、`finalizeToolExecutionContext` → `finalizeToolExecutionContextOnly`；
(d) 删掉 `orchestrator.ts:839` 那个返回常量的 `describe()`。

**A7b. 顺带发现的命名陷阱：`@paw/agent` 与 `@paw/agent-loop` 是两个包，名字几乎一样，位置却在栈的两端** — `severity: medium`

| 包 | 文件 | 行数 | 导出 | 仓内依赖者 |
| --- | --- | --- | --- | --- |
| `@paw/agent` (`packages/agent`) | 118 | 38,952 | **788** | **2** |
| `@paw/agent-loop` (`packages/agent-loop`) | 7 | 2,624 | 54 | **8** |

依赖者多 4 倍的是那个**小**包（`completion-review`、`context-compaction`、`memory-plugin`、`model-output-recovery`、`models`、`paw-next`、`progress-advisor`、`runtime` 全都 import `@paw/agent-loop`）。分层本身是对的（`agent-loop` 只依赖 `@paw/protocol`，位于栈底），但**名字完全无法告诉消费者该找哪个**。这与 §3 的跨包同名问题、以及下面这个包内例子是**同一个失效模式在三个尺度上的重复**：命名没有承载"你在哪一层、该用哪个"的信息。

**包内的同一个失效模式**：`tool-runner.ts:1085` `finalizeToolExecution(` 与 `:1271` `finalizeToolExecutionContext(` 只差一个词，前者在 `:1104` 调用后者（即前者是"先提交事件的包装器"，后者是"内层一半"）。于是 `action-handlers.ts:1990–1992` 这个三元表达式在两种语义之间静默选择，而**调用点完全看不出差别**：
```ts
1990:   const final = commitsOwnedByScheduler
1991:     ? finalizeToolExecutionContext(calls, results, finalizationContext)
1992:     : finalizeToolExecution(calls, results, finalizationContext);
```
更糟的是这两个入口的守卫不一致（见 A13）。

**A8. 其它具体重复与死代码** — `severity: medium`
- `orchestrator.ts:2880–2891` 与 `:2927–2938` 是两个**逐字节相同的 10 参数 `saveState(...)` 调用**；把 `:3322–3336` 的签名改成单个 `RunCheckpoint` 对象，可一次性消灭这一类 bug（12 个调用点）。
- `verification-probe.ts:35` `const MAX_PROBES = 1 as const;` 让 `:641` 的 `if (items.length >= MAX_PROBES) break;` 成为不可达代码 —— 看起来像有重试预算，其实没有。删掉循环。
- `shadow-runtime.ts:425`/`:513`/`:539`/`:579` 的 `as unknown as Readonly<{…}>` 全都可以删：每个字段都已经声明在对应的 `RunEvent` 变体上（`packages/core/src/run-events.ts:190–251`），`envelope.event` 本来就会自行收窄。
- `orchestrator.ts:735` + `:809`：`@deprecated` 的 `memoryExtraction` 字段靠 `void this.memoryExtraction;` 续命，删掉字段和选项。
- `orchestrator.ts:667–731`：76 个私有字段里 33 个 `_` 前缀、43 个没有，选一个约定。

---

### 7.2b `packages/agent` 复核追加（含一处对前文的撤回）

**A9.【已复核，真实 bug】`loadMcpServers` 把字符串当数组用，且全链路无人校验** — `severity: high`
```ts
// packages/agent/src/orchestrator-factory.ts:161-164
const mcpServers = s.mcp_servers as unknown[] | undefined;
if (mcpServers && mcpServers.length > 0) {
  return mcpServers as readonly McpServerConfig[];
```
**完全没有 `Array.isArray` 检查**。字符串的 `.length > 0` 为真，所以 `{"mcp_servers": "npx -y foo"}` 会被当成 `readonly McpServerConfig[]` 返回。而 `orchestrator.ts:4813` 是 `for (const cfg of this.mcpServers!)` —— `for...of` 遍历字符串会**逐字符迭代**，于是每个 `cfg` 是一个单字符，`cfg.command` 为 `undefined`，最终发出 `mcp.connection_failed` 且 `server: undefined`。

我验证了上下游：`packages/settings/src/schema.ts:170` 用 `.passthrough()`，`mcp_servers` **不在** `pawSettingsLocalSchema` 的已知字段里（`credentials.ts:205` 的注释也承认了这一点），所以**上游没有任何校验**。而**正确的 schema 早就在同一个仓库里**：`packages/settings/src/schema.ts:22` 的 `mcpServerConfigSchema`，且 `:15` 的注释明确说它作为独立 schema 导出。

修复：导出并复用 `mcpServerConfigSchema`，改成 `mcpServerConfigSchema.array().safeParse(s.mcp_servers)`，解析失败时返回一条明确诊断（不要静默返回 `undefined`）。

**A10.【已复核】`tool-result-detail.ts` 把 `Array.isArray` 当作元素类型的证明，且在工具已执行完之后抛异常** — `severity: high`
`:85` `if ("matches" in p && Array.isArray((p as {matches?: unknown}).matches))`，然后 `:86-90` 把 `.matches` 断言成 `Array<{path?, line?, text?}>`，`:92` 直接读 `m.path`。`Array.isArray` 只能证明是数组，**证明不了元素类型**：任何带 JSON null 的工具载荷（shell、MCP）给出 `{matches:[null]}` 就会在 `:92` 抛 `TypeError: Cannot read properties of null`。而这发生在 `commitToolExecutionResult`（`tool-runner.ts:1262`）里、**工具已经执行之后**，且本地没有 try/catch。`:79-81` 是同一形状；而 `:66-70` 的 `content` 分支写法是**正确的**（先 `typeof === "string"` 守卫）—— 同一个文件里正反两种写法都有。
修复：在本文件加 `readMatchArray(p)` / `readStringArray(p, key)`，那 18 处 `(p as {…})` 探测可以收敛成两个 helper。

**A11. 一个只检查单字段的类型谓词，授权了随后 ~7 处无保护解引用** — `severity: medium`
`sub-agent-launcher.ts:58-65` 的 `isSharedContext` 只验证 `"task" in value && typeof value.task === "string"`，但 `SharedContext` 还要求 `role`/`facts`/`constraints`/`artifacts`/`state.{completed,pending}`/`outputFormat`。`options.sharedContext` 的类型是 `unknown`，随后 `child-system-prompt.ts:64/67/70/73-77/81/105` 逐个无保护解引用（`ctx.facts.length`、`artifact.content.slice(...)`、`escapeTaskEnvelope(ctx.outputFormat)`…）。一个只有 `task` 字符串的对象（部分持久化的上下文、桥接调用方、测试替身）会在**子 Agent 的第一轮**抛 `TypeError`，而且会被归因到子 Agent 而不是 launcher。
修复：在 `orchestrator/types.ts:340` 旁边加 `parseSharedContext(x): SharedContext | undefined`，`resolveSharedContext` 失败时回退到 `buildMinimalSharedContext`。

**A12. 一个会修改入参的类型谓词，导致旧数据静默消失** — `severity: medium`
`task-state.ts:1246-1251`：`isTaskState(value): value is TaskState` 内部通过断言**写回** `value.constraints = records`。非字符串分支把旧对象**原样透传**，而签名承诺的是 `readonly ConstraintRecord[]`（`:146`）。缺 `status` 的旧条目随后在 `orchestrator.ts:272`/`:431` 的 `c.status === "active"` 判断中失败，于是**从活跃约束集合里静默消失** —— 行为变了，但没有任何报错。
修复：改成纯函数 `normalizeConstraintRecords(x: unknown): ConstraintRecord[]` 逐元素校验；恢复流程构造新的 `TaskState`，而不是在谓词里改写输入。

**A13. 导出的 `finalizeToolExecutionContext` 自身没有长度守卫，而 v2 路径直接调它** — `severity: medium-high`
`tool-runner.ts:1271-1275` 导出的 `finalizeToolExecutionContext` **没有**长度检查；它按 `results` 映射却用 `calls[i]` 索引（`:1283-1284`）。而 `finalizeToolExecution` 是有守卫的（`:1095-1096` 抛 "Tool result batch is missing source index"）。问题在于 `action-handlers.ts:1990-1992` 的三元表达式在 `commitsOwnedByScheduler` 为真时**直接调用前者**，绕过守卫 —— 于是 `calls` 偏短会得到 `undefined.tool` → `TypeError`，偏长则静默丢弃尾部调用。
修复：把 `calls.length !== results.length` 守卫放进 `finalizeToolExecutionContext` 内部（一处保护两个入口），并用 `calls.entries()` 配 `results[i]` 检查来迭代。

**A14. `shadow-runtime.ts` 的边界校验缺口（替代前文的一条错误建议）** — `severity: medium`
> **撤回**：前文快速修复项曾建议删掉 `shadow-runtime.ts:425/:513/:539/:579` 的 `as unknown as Readonly<{…}>`，理由是"字段都声明在 `RunEvent` 变体上"。**这条是错的，删了编译不过** —— 该文件刻意使用最小边界类型 `LegacyRunEventEnvelopeV1`（`:119-125`，`event` 只有 `{ type: string }`），注释写明"avoids coupling the v2 kernel to core's barrel"。这些断言是**必需**的。

真正的（更准确的）问题是：该文件声明了这种隔离，却用 4 处不校验的断言把它自己破坏掉 —— 而**正确的 helper 就在 6 行之外**：`readString`/`readNumber`/`readBoolean` 定义在 `:1178/:1187/:1196`，并在同一个 `observe()` 里用了约 14 次。
而且四处风险并不等价：`:425`/`:579` 取出的值随后有校验（`:429-431` 的 `Number.isSafeInteger`、probe outcome/authority 的真值判断）；**`:513`/`:539` 则把 legacy 的值直接拷进 schema 化的 v2 事件** —— `:539-547` 断言 `verdict: "pass"|"fail"|"partial"` 后在 `:567` 原样拷贝，**没有成员资格检查**，于是 legacy 生产者发出 `verdict: "ok"` 时，一个联合类型之外的值会进入投影后的 journal，被下游 gate 逻辑 switch。
修复：四处改用 `readString`/`readNumber`/`readBoolean`；`:513`/`:539` 另经 `assertLoopV2Envelope` 或显式成员检查（同一文件 `:1299-1303` 已有正确的 Set 成员判断写法）。

**A15. 一行修正** — `loop-control-state.ts:123`/`:130` 的 `return rest as TurnFlags;` 是**空操作断言**：`pendingControl` 是可选的（`orchestrator/types.ts:185`），所以 `Omit<TurnFlags, "pendingControl">` 本来就可赋值。`return rest;` 即可编译，该断言只传达了对类型系统的不信任。

> **贯穿 `packages/agent` 两个审查回合的统一主题**：该包的**门控逻辑按执行路径各写一份**（native-turn 配对、工具门、`tool.result` 发射、导出收尾），而副本已经漂移 —— 其中两处（A9 与 `nativeTurn` 配对）已经成为真实 bug。一个共享的 `ToolCallPlan` + `resolveToolGates` + `pairNativeToolTurn` + `emitToolResult` 可以一次性收敛掉两轮审查里 15+ 个条目中的大部分。

### 7.3 `packages/runtime` / `packages/protocol` / `packages/agent-loop`

**R1. `run-journal.ts` 是三个模块挤在一个文件里，而且拆分可证明对 API 零影响** — `severity: high`
`:1029–:1983` 是单个函数 `assertLifecycleIdentities`（**955 行、29 个 case 分支、56 个局部声明**）；`:2078–:3238` 是 `assertInputFact`（**1161 行、33 个分支**）；`:312–:643` 是 332 行的 `InputFactV1` 联合类型；`:4094–:4236` 是字段原语。全仓 grep 显示 `./run-journal.js` 的**唯一引用者是 `packages/protocol/src/index.ts:125`**，共 104 个导出符号、`index.ts` 按名 re-export 了 73 个。
危害：一个文件同时装着 wire DTO、单 fact 结构校验、跨 fact 顺序不变量 —— 三者变更频率完全不同，却被迫一起 review。
修复：拆成 `packages/protocol/src/journal/`：`versions.ts`、`primitives.ts`、`wire/*.ts`、`facts.ts`、`parse.ts`、`validate/{input,memory,model-tool}.ts`、`lifecycle.ts`；`run-journal.ts` 退化为 `export *`。因为内部符号本来就没导出，**104 个名字的对外面逐字节不变，`index.ts:125` 一行都不用改**。这是本次审查里"收益/风险"最好的结构重构之一。

**R2. durable 状态的不变量散在 ~29 个 guard 里，没有表格，还有重复的错误文案** — `severity: high`
`run-journal.ts:1029–:1134` 声明了 29 个并行可变累加器（`acceptedInputs`、`models`、`tools`、`checkpointClaims`、`terminalDecisionBoundaryOpen`、`unauthorizedPromotionReducerVersions`、`expectedSegmentIndex`…），随后一个 29 分支 `switch` 就地抛散文式错误（`:1148 "completed decision cannot abandon active activities"`、`:1266 "work segment cannot cross an unsettled model call"`）。**两条不同的规则抛出完全相同的字符串**：`:1200` 与 `:1243` 都是 `"terminal promotion requires a work segment marker"`。
危害：没有任何一个地方能回答"work segment 启动前必须成立什么"；重复文案让日志和测试无法区分两条规则。
修复：抽出 `LifecycleInvariantV1` 表（`{ id, code, check(state, fact, prefix) }`），每条规则给一个**稳定的唯一 `code`** 加上散文说明。另外仓库里唯一写得好的不变量陈述（`session-execution-lease.ts:358–367`："Claim, heartbeat, release, journal commit and recovery-snapshot commit all CAS the same immutable S+1 event slot. Only claims increment fencingToken."）**离它实际生效的地方 `reduceEvent`（`:1396`）有 1400 行**，应该搬过去。

**R3. `FileLease` 四个同类状态迁移用了四套失败协议** — `severity: high`
仅 `linearizeTransition` 内部：`:784` `throw this.markLost(error)` / `:787-788` `this.markLost(...); return { status: "lost" }` / `:808` `throw new Error("Journal commitId was reused with different content")` / `:812` `return { status: "conflict", head }`。`linearizeRecoverySnapshotTransition` 重复同样的分裂（`:867`/`:871`/`:892`/`:897`）。`releaseTransition` 把自己刚构造好的类型化错误丢掉：`:732-733` `this.markLost(error); throw error;`（`:743-744` 同）—— 于是 `release(): Promise<"released"|"already_released"|"lost">` 可能以**原始 fs 错误** reject，而同族的 `renew()` 抛类型化错误（`:673`、`:683`），`linearizeJournalBatch()` 又返回联合类型。
危害：`file-run-session.ts:731-739` 正确处理了 `"lost"`/`"conflict"`，但**没有 catch `:808`/`:892` 的裸抛**，于是 `failClosed` 的类型化包装（`file-run-session.ts:814-821`）被绕过，捕获 `SessionExecutionLeaseLostError` 的调用方全部漏掉这条路径。
修复：四者统一协议 —— 一律 resolve `{status:...}` 不抛；原始错误只在 `serializeTransition` 的 catch（`:954-961`）一处经过 `markLost`。抛异常只保留给程序员错误级别的入参校验。

**R4. `errorCode` 对崩溃恢复是承重的，却是靠正则匹配英文散文产出的** — `severity: high`
`runtime/src/tools/observation.ts:69` `normalizeErrorCode(settlement.error.name, "E_TOOL_FAILED")`，而它的 `:92-97` 只在字符串为空或非字母数字开头时才 fallback —— 所以裸的 `throw new Error(x)`（`name === "Error"`）会**原样通过，写成 `errorCode: "Error"`**。`agent-loop.ts:1085`、`paw-next/src/composition.ts:7741`/`:7792` 同样。Protocol 也接受了它（`run-journal.ts:2994 assertId(fact.errorCode, "errorCode")`）。
超时类 code 能活下来纯属侥幸：`models/src/agent-loop-adapter.ts:99` 把错误写成一句英文 `` `Model result was not proven: ${describeError(error)}` ``，然后 `composition.ts:7751-7753` 再用正则 `Model(?:Request(?:Idle|Wall)|ReasoningWithoutAction)Timeout` **从这句话里把 code 抠回来**；`interactive-control.ts:196` 要求精确相等，`:257` 又跑一遍同样的正则。而 `run-journal.ts:809-810` 把 `"model-result-unknown"`/`"tool-result-unknown"` 当作崩溃恢复后能否开启新 work segment 的闸门。
危害：~828 个 `throw new Error(` 会塌缩成同一个 `errorCode: "Error"`；run 分类依赖于**第四个包拼出来的一句话的英文措辞**；执行器真正附上的语义 code（`agent-loop-tool-executor.ts:379` `"E_TOOL_EXECUTOR_BOUNDARY"`、`:460` `"E_TOOL_RESULT_INVALID"`）根本到不了 journal，因为 `observation.ts:75` 对所有 `status:"unknown"` 硬编码 `"E_TOOL_UNKNOWN"`，从不读 `evidence.payload.code`。
修复：让 `LoopError`/settlement/端口输入携带显式 `code`；`normalizeErrorCode` 明确拒绝字面量 `"Error"`（宁可当场失败，也不要铸出一个看起来合法的 id）；`observation.ts` 优先读 `evidence.payload.code`。

**R5. `commitDerivedDecision` 声明了穷尽的返回类型，却抛出一个"不可表示"的失败** — `severity: medium`
`file-run-session.ts:599` `): Promise<"committed" | "conflict"> {` … `:610-612 throw new Error("Fenced File Session tail has a conflicting derived decision")`（`:624` vs `:632-634` 同形）。调用方只对联合类型做重试：`agent-loop.ts:163-169`（位于 `:130–:170` 的 `while (true)` 内）。
危害：冲突这种**本应被联合类型覆盖**的情况逃出了重试循环**也**逃出了 `failRuntime`（`agent-loop.ts:183-191`），run 直接死掉且**没有写 `runtime.failed` fact**。
修复：把联合类型放宽为 `"committed" | "conflict" | "fatal"`（或 `{status, reason}`），让循环自己决定"重试"还是"记 journal 后再死"。

**R6. durable 底层管道复制了 3–9 份，而且副本已经开始漂移** — `severity: medium`
稳定 id 正则 `^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$` 被内联到 **9 处**（`run-journal.ts:4133`、`session-execution-lease.ts:2329`、`file-durable-json-payload-store.ts:42`、`verified-canonical-payload-index.ts:602`、`location-aware-payload-session.ts:423`/`:629`、`accept-work-segment-input.ts:378`、`task-checkpoint.ts:282`、`task-checkpoint-distillation.ts:671`）。`hashText` 在 `file-run-session.ts:1825`、`session-execution-lease.ts:2371`、`file-durable-json-payload-store.ts:853` 逐字节相同；`fsError`、`fsyncDirectoryBestEffort`、`ARTIFACT_FILE` 正则同样重复。
**漂移证据**：`session-execution-lease.ts:1885-1890` 用 `try/catch` 容忍 `EEXIST`，而它的孪生 `file-run-session.ts:1942` 是裸的 `if (!fs.existsSync(current)) fs.mkdirSync(current);`。
**并且有两个 canonical 编码器同时喂 durable 哈希**：`canonical-json.ts:5` 声称自己是"every Runtime Context hash/render boundary"，但权威的 prefix 哈希用的是**插入顺序**的 `JSON.stringify`（`file-run-session.ts:1821-1823`、`immutableEnvelopeClone:2000`），而 `verified-canonical-payload-index.ts:504-507` 的 `digestPrefix` 用的是 `canonicalJsonStringifyV1`。**同一份字节算出两种哈希，而类型上无法区分**（这与 §1 是同一类问题，只是换了一层）。
修复：建 `packages/runtime/src/durable/`（`ids.ts`、`fs.ts`、`artifact-name.ts`），并把两个哈希按契约改名（`hashJournalPrefixBytesV1` vs `hashCanonicalPrefixV1`），让误用无法通过阅读通过。

**R7. `as unknown as` 大多是"校验器签名"问题，不是 schema 漂移** — `severity: medium`（重要：这会改变修复方向）
两个根因覆盖约 85%：
(a) **内部校验器返回 `void` 而不是 `asserts value is T`**，于是每个调用点都要补一次断言：`run-journal.ts:940-942` `assertRecord(envelope.record); const record = envelope.record as RunJournalRecordV1;`、`:3226-3228`、`session-execution-lease.ts:1557`。而**公共边界写法是正确的**：`run-journal.ts:952-955` `assertRunJournalEnvelopeV1(value: unknown): asserts value is RunJournalEnvelopeV1`。
(b) 约 30 处是 `X as unknown as JsonValue` 的纯放宽，因为 `canonicalJsonStringifyV1` 只收 `JsonValue`（`canonical-json.ts:6`）。
真正不健全的很少：`inbox/start-work-segment.ts:274-276` `immutableCanonicalJsonCloneV1(parsed as never)`（**这是 runtime 里唯一的 `as never`**，输入侧未被证明，只有输出在 `:277` 被重新解析）。
值得注意的是**不是**问题的：`location-aware-payload-session.ts:390-407` 对外部 `materializer.prepare` 结果做了断言，但随后通过 resolve + 哈希 + canonical JSON 比较来验证 —— 这才是真边界。
修复：把 `assertRecord`/`assertTaskCheckpoint`/`assertJournalCommitShape`/`assertCheckpointSourcesInRange` 改成收 `unknown` 的 `asserts` 谓词（一次消掉 ~10 处断言）；`canonicalJsonStringifyV1(value: unknown)` 重载并内部校验，消掉那 ~30 处放宽 —— 与 §5 的结论完全一致，**这是同一个修复动作在两个包上的两次收益**。

**R8. `V1`/`V2` 后缀在这里表示三种不同含义** — `severity: low`
`packages/protocol/src` 里 **`V2` 出现 0 次**，却给 4119 行里的所有东西都挂上 `_V1` —— 纯噪声。`file-run-session.ts` 在同一文件里混用世代：磁盘常量是 `_V2`（`:39-42`），导出的每个符号却是 `V1`（`:261 export class FileRunSessionV1`），而 `ARTIFACT_SCHEMA_V1` **全仓不存在**。别处则是真正的共存（`interactive-control.ts:6-8` 的 V1/V2 都活着，V1 仍接在 `paw-next/src/composition.ts:880`）。还有 `workspace-inspection-plugin.ts:52` `createWorkspaceInspectionToolPluginV2(): RuntimeToolPluginV1` —— 工厂用 `V2` 表示内容版本，返回类型用 `V1` 表示 schema 世代。
修复：后缀只保留给**真正共存的 wire/schema 世代**，并在文件头把这个规则写下来。

**运行时层的快速修复项**
- `run-journal.ts:1163` 一行 209 字符、`:1037` 106 字符，而该文件其余部分按 80 换行 —— 真实格式违规（CRLF 检出掩盖了它）。
- `run-journal.ts:1200` 与 `:1243` 两条不同规则抛同一字符串，给其中一条独立文案。
- `file-run-session.ts:1942` 应改用孪生实现里那个容忍 `EEXIST` 的 `mkdirSync`（`session-execution-lease.ts:1885-1890`）。
- 删掉已废弃的 `createVerifiedModelResponseEvidenceV1`（`verified-model-response-evidence.ts:107-108`），唯一调用者是测试 `verified-model-response-evidence` 相关用例。
- `agent-loop/src/work-segment.ts:157`/`:283`、`agent-loop.ts:702`/`:711` 用 `.at(-1) as X`、`[0] as X` 绕过 `noUncheckedIndexedAccess` 并在下一行直接解引用 —— 补 `if (!x) throw`。
- `interactive-control.ts:257` 的 `latestModel.errorCode!` 只是因为正则测的是 `?? ""`；绑一次 `const code = latestModel.errorCode ?? ""` 即可去掉断言。

### 7.4 配置 / CI / 仓库工程

**C1. `legacy/` 归档目录根本没进 git：592 MB / 10,866 个未跟踪文件** — `severity: high`
`git ls-files legacy` → **0**；`.gitignore` 里没有任何 `legacy` 规则；`git status` 显示 **181 个删除、0 个重命名**。未跟踪体积中 `legacy/benchmarks/desktop-harness-ab/.runs/` = 533.9 MB、`legacy/apps/tui/node_modules/` = 55.8 MB。
危害：这个"归档"**只存在于这台机器上**。直接 `git add -A` 会把 592 MB（含 534 MB 本地跑分产物）一起提交；而新克隆的人根本看不到 `legacy/`。
修复：先加 `.gitignore`（`legacy/**/.runs/`、`legacy/**/node_modules/`、`legacy/**/.paw/`），再用**纯重命名**方式 stage 源码树（让 git 记成 `R`），或干脆删掉 `.runs/`。
> 这是上一轮迁移遗留的收尾项，不是本轮审查新引入的。

**C2. `typecheck` / `test:ts` 静默跳过 3 个 workspace 成员** — `severity: high` **[已复核]**
根 `package.json:11` 串了 21 个 `typecheck:*` 一行脚本，`:36` 的 `test:ts` 列了 19 个包路径；磁盘上有 **23** 个成员（`check:deps` 输出 "23 packages, 89 edges"）。漏掉的：

- `packages/progress-advisor`（有 src + tsconfig + 2 个测试文件）—— **typecheck 与 test 都没有**
- `apps/desktop` —— 有自己的 `typecheck` 脚本（`apps/desktop/package.json:12`，覆盖两个 tsconfig），根里也有 `typecheck:desktop`（`package.json:33`），但**没有任何地方调用它**
- `packages/memory`（37 个测试文件、21k 行）—— 不在 `test:ts` 里

危害：**新加的包默认对所有闸门不可见**。修复（已验证 23 个成员全部有 `typecheck` 脚本）：
```json
"typecheck": "bun run --filter '*' typecheck"
```
一行替掉 21 行，顺带补上两个漏洞（Bun 会按依赖拓扑排序）。`test:ts` 可同理换 `bun run --filter '*' test`，**但注意 `@paw/paw-next` 目前没有 `test` 脚本**（也没有 test 目录），换之前要么给它加测试，要么先确认 bun 会跳过缺失脚本的包。

**C3. CI 实际只跑了 366 个测试文件里的约 213 个** — `severity: high`
`.github/workflows/ci.yml:22` 跑 `bun run check:ts`；`memory-db` job（27–81 行）手工枚举 17 个 memory/agent 文件。从未在 CI 跑过的：`apps/desktop/test`（30 个文件）+ `test:native`、`packages/progress-advisor/test`（2 个）、`packages/memory/test` 里 **20 个不依赖 `DATABASE_URL`** 的文件（`backbone-smoke`、`context-builder`、`embedding-cache`、`session-memory`、`perturbation`、`profile`、`shadow-replay`…），以及 **`check:deps`（`package.json:50`）—— 那个有文档、真实存在的无环闸门，居然没接进 CI**。

**C4. 幻影依赖：用了但没声明** — `severity: medium` **[已复核]**
- `packages/core/src/token-estimator.ts:49` `import { get_encoding } from "tiktoken";`，但 `packages/core/package.json` 只声明 `@paw/protocol`；`tiktoken` 只挂在根 `package.json:61`。
- `packages/harness/src/mcp-client.ts:18-19` import `@modelcontextprotocol/sdk/client/{index,stdio}.js`，但 `packages/harness/package.json` 只声明 `@paw/core`、`@paw/workspace`、`unbash`；SDK 只挂在根 `package.json:60`。

危害：hoisting 在本地掩盖了它，但这两个包都**无法独立安装**。而 `check-workspace-dependency-cycles.ts:186-194` 只读 manifest，**结构上不可能发现这类漂移**。
修复：两个依赖下沉到各自包的 `dependencies`；再考虑接 `knip` 或 `no-extraneous-dependencies` 作为闸门。

> **一处需要纠正的误报**：同一份深读建议把 `playwright` 从 `packages/paw-next` 的 prod 依赖降级，理由是"27 个 src 文件都没 import 它"。**这个结论是错的** —— `packages/paw-next/src/browser-check-worker.mjs:9` 有 `const { chromium } = await import("playwright");`，该 worker 由 `browser-check.ts:173` 在运行时按路径拉起。扫描只看了 `.ts/.tsx`，漏掉了 `.mjs`。`playwright` 必须留在 `dependencies`。这恰好说明：**运行时按路径加载的文件（worker、fixture、模板）是静态扫描的盲区**，评审与工具链都要单独覆盖。

**C5. `tsconfig.base.json` 的 3 个 emit 选项被 22 个包全部关掉；`memory-core` 干脆不继承 base** — `severity: medium`
见 §2.5。补充证据：`memory-core/tsconfig.json` **完全不 extends base**，内联 14 个选项，因此缺 `resolveJsonModule`；全仓 `"references"`/`"composite"` **零匹配** —— 这正是每个包都得手抄 `paths` 的根因。长期方案是 TS project references + `tsc -b`，可一并替掉 21 个脚本。

**C6. 文档漂移（其中一部分由上一轮迁移造成）** — `severity: medium`
- `README.md:68`、`ARCHITECTURE.md:75`、`:99` 都在教 `bun run cli -- doctor` —— 该 script 已随 CLI 归档，**新贡献者照抄的第一条命令就会失败**。→ **本次已修**：改为 `bun run memory:test:health` / `bun run check:deps`，并注明 doctor 已归档到 `legacy/apps/cli`。
- `README.md:39` 声称 `test:ts` 覆盖 "packages + apps"，实际只覆盖 19 个包、不含任何 app。
- `README.md:16-30` 与 `ARCHITECTURE.md:11-18` 分别只列了 10 个和 8 个包；**8 个包在两份文档里都不存在**：`agent-loop`、`completion-review`、`context-compaction`、`model-output-recovery`、`output-recall`、`progress-advisor`、`task-progress`、`web-access`。
- `ARCHITECTURE.md:97-98` 让读者跑的 `memory:test:runtime` 实际只跑一个文件，而不是那 37 个文件的套件。

**C7. 约定一致性：好消息与坏消息** — `severity: low`
- **文件命名 100% 一致**：22 个包全是 kebab-case，0 个 camelCase，每个包都有 `index.ts` barrel。
- **目录结构不一致**：17 个包是**扁平**的（`memory-plugin` 81 个 src 文件、`memory-core` 55、`paw-next` 27 全在 `src/` 根下），5 个包用 `src/<domain>/`（`agent` 8 子目录、`memory` 7、`runtime` 7、`core` 5、`harness` 4）。扁平包超过 ~20 个文件后会迅速难以导航。
- **22 个包里只有 2 个有 README**（`memory-core`、`memory-plugin`）。
- `packages/paw-next` 依赖 19 个 workspace 包，却**没有 test 目录也没有 test 脚本** —— 而它是桌面端唯一的组装入口，风险最高、保障最少。
- 5 条 lint 诊断来自工作区内的生成文件 `apps/desktop/.cdp-artifacts/*.json`，应 ignore。

> **另一处需要纠正的误报**：深读提到 `legacy/README.md` 可能是 GBK 编码。我做了严格 UTF-8 解码验证 —— **文件本身是合法 UTF-8**，首行 `# legacy/ — 已归档的 CLI / TUI 代码` 正常。乱码来自 PowerShell 5.1 控制台渲染，不是文件。无需动作。

### 7.5 `apps/desktop` / `packages/harness` / `packages/workspace` / `packages/models`

> 本节把专项深读的结论与我自己的独立测量合并；标 **[已复核]** 的条目我逐个读过源码确认。

**D1. `useAgentRun.ts` 1920 行，整个状态机塞在一个 930 行的 `useEffect` 里** — `severity: high` **[已复核]**
- `useEffect(() => {`（`:497`）… `}, [commitHistoryIfNeeded, clearPendingInteractions]);`（`:1427`）—— **931 行**，闭包捕获约 20 个 ref。envelope 分发、工具批次、run activity、流式、审批、host 轮询全在里面。
- `:1874-1919` 向 `App.tsx` 返回约 **45 个字段**。
- 我的计数：`useState` 4、`useRef` 6、`useEffect` 4、**`useCallback` 22、`useMemo` 0、`useReducer` 0**。
- **会话持久化写了两遍**：`:310-356`（`persistActiveIntoSessions`）与 `:457-495` 各做一次重排 + `saveSessionsToStorage`（`:344-350` / `:485-491`），而两份已经不一致（`:318` 写 `streaming: false`，`:470` 写 `streaming: m.streaming === true`）。
- 订阅注册与退订是手工 8 对：`:1418-1425` 逐个 `offEvent()`/`offDone()`/`offErr()`/`offApprovalReq()`/`offApprovalClosed?.()`/`offAskReq()`/`offHost()`/`offLog()`。

修复（保持 `App.tsx` 不变，`useAgentRun` 退化成 ~150 行门面）：`agentHostEvents.ts`（纯函数：`:670-1255` 那串 `t === "…"` 变成可测的 `switch`）、`useModelStream()`、`useToolBatches()`、`useRunActivities()`、`useFileChanges()`、`useChatSessions()`（**只留一个 `applySessionPatch()`** 供两处调用）、`usePendingInteractions()` + `useHostBridge()`，并把订阅做成按数组遍历退订。

**D2. 渲染进程/宿主边界泄漏：协议是字符串类型的，渲染进程靠正则从"给人看的摘要"里抠结构化数据** — `severity: high` **[已复核]**
- `apps/desktop/src/vite-env.d.ts:6-7` `readonly event: { readonly type: string; readonly text?: string; }` + `:14 readonly [key: string]: unknown;` —— 没有可辨识联合，于是渲染进程手工重新守卫每个载荷。
- `useAgentRun.ts:995-999`：
```ts
const fromSummary = typeof ev.summary === "string"
  ? ev.summary.match(/\[([a-zA-Z0-9_-]+)\]/)?.[1] : undefined;
```
它抠的是 `packages/harness/src/registry/execution.ts:1281` 拼出来的**人类可读摘要** `` `run_agent: ${r.status}${agentId ? \` [${agentId}]\` : ""} ...` ``。**任何人改一下摘要措辞，子 Agent 名册状态就会静默失效。**
- `:728-731` 手动拆宿主内部嵌套（`t === "child.tool_result" ? ev.originalEvent : ev`），`:1180` 用字符串判断宿主阶段（`if (ev.name === "merging_results")`）。
- 而 `packages/protocol/src/run-journal.ts:329` **已经定义了类型化的 `input.accepted`/`input.promoted` fact**，渲染进程却在 `useAgentRun.ts:685-717` 重新实现了一遍。

修复：导出一个 `DesktopRunEvent` 可辨识联合（复用 protocol 的 fact 类型 + `child.*` 变体），用它对 preload 桥做类型标注，并把 `agentId` 作为**真字段**发出而不是塞进摘要 —— 那个正则随之消失，`switch (ev.type)` 也会获得穷尽性检查。

**D3. 在 state updater 内部更新 state —— 而 `main.tsx` 开着 `<StrictMode>`** — `severity: high` **[已复核]**
```ts
// useAgentRun.ts:1844-1863
setSessions((prev) => {
  let next = prev.filter((s) => s.id !== sessionId);
  ...
  saveSessionsToStorage(next, nextActive);     // ← updater 里写 localStorage
  if (switchingAway) {
    conversationIdRef.current = t.id;          // ← updater 里改 ref
    historyRef.current = [...t.history];       // ← updater 里改 ref
    setActiveSessionId(t.id);                  // ← updater 里调 setState
    setMessages([...t.messages]);              // ← 同上
    setError(null); setStatus("idle"); setStatusText(...);   // ← 同上（共 5 个）
```
`:1234` 与 `:1318` 同样在 `setMessages` updater 里调 `commitHistoryIfNeeded(...)`，而该函数在 `:450` 以 `persistActiveIntoSessions(messagesRef.current, historyRef.current)` 结尾 —— 也就是 `setSessions` + `saveSessionsToStorage`（`:351`）**嵌套在 `setMessages` 里**。
`apps/desktop/src/main.tsx:15` 有 `<StrictMode>`，React 在开发模式下会**故意重复调用 updater** 来暴露这类不纯。
危害：updater 必须是纯函数。重复执行会把会话重排/时间戳做两次、localStorage 写两次；并且嵌套调用读的是 `messagesRef.current`（上一次渲染的值），而新的 `next` 就在作用域里 —— 两者可能不一致。
修复：在 updater 外部用 ref 算出 `next`（`reduceSessions(sessionsRef.current, …)`），然后在 handler 里**一次性**调 setter 与 `saveSessionsToStorage`；把 `next` 作为参数传进 `commitHistoryIfNeeded(assistantText, messages)`，不要读 ref。

**D4. `executeTool` 是单个 ~1460 行的函数，内含 37 个工具分支** — `severity: high` **[已复核]**
`packages/harness/src/registry/execution.ts` 共 1899 行，顶层函数只有 11 个，其中 `export async function executeTool(`（`:319`）到下一个顶层函数（`:1779`）—— **~1460 行**，是一条从 `:330` `if (tool === "workspace.browser_check")` 一直排到 `:1698` 的扁平 if 链。
- 参数别名手工写了 **13 次**，例如 `:590-594` 的三元嵌套 `typeof rec.old_string === "string" ? rec.old_string : typeof rec.oldString === "string" ? rec.oldString : undefined`。
- 文件变更后置处理（markAgentWritten + `diagnoseEditedFilesV1` + `diagnosticSummarySuffix`）**复制了 3 份**：`:579-585`、`:627-633`、`:673-679`。
- **两套错误约定并存**：`toolErrorResult`（`:197-208`）vs 30+ 处绕过 `errorCodeForToolPayload` 的内联字面量（如 `:1245-1249`）。
- 我另外确认：这个文件 **`as unknown as` 为 0、非空断言为 0** —— 是纯**结构**问题，不是类型问题。

修复：`HANDLERS: Record<string, ToolHandler>` 拆成 `handlers/files.ts`（`:342-732`）、`jobs.ts`（`:733-893`）、`shell.ts`（`:894-1035`）、`plan.ts`（`:1036-1241`）、`agents.ts`（`:1242-1437`）、`code.ts`（`:1438-1558`）、`memory.ts`（`:1559-1770`）；加 `pick(rec, "old_string", "oldString")` / `pickBool` / `pickNum`、一个 `finishFileMutation()`，所有失败统一走 `toolErrorResult`。`packages/harness` 的测试比是全仓核心包最低（**0.28**），这一刀最好和补测一起做。

**D5. shell 策略里有两条永不触发的 deny 规则，且匹配器零测试** — `severity: medium` **[已复核]**
`shell-policy-config.ts:620-631` 的 `globToRegex` 两端都加了锚（`:621` `let re = "^"` … `:629` `re += "$"`），而 `:506`/`:511` 的规则是：
```ts
{ pattern: "> /dev/sd*", action: "deny", reason: "block device overwrite" },
{ pattern: "> /dev/hd*", action: "deny", reason: "block device overwrite" },
```
锚定后它只能匹配**整条命令以 `> /dev/sd` 开头**的情况。而真实命令里重定向几乎总在命令后面（`echo x > /dev/sda`），所以这两条 deny 规则**实际上不可达**。`shell-policy.ts:119` 传的是完整命令行。
危害评级为 medium 而非 high，因为**真正的保护在另一层**（`shell-policy.ts:249`），所以没有形成漏洞 —— 但也正因如此，**没人发现这两条规则是死的**。而 `matchPattern` / `evaluatePolicy` 全仓 **0 引用**、无任何单测。
修复：要么删掉这两条，要么改成不锚定的子串匹配；并给 `matchPattern`/`evaluatePolicy` 补表驱动测试（`*`/`?`/转义/锚定/last-match-wins）。

**D6. 被放弃的模型流只 `releaseLock()`，从不 `cancel()`** — `severity: medium`
`packages/models/src/openai-compatible.ts:659-661` 的 `finally { reader.releaseLock(); }`；唯一的 `await reader.cancel()` 在循环内的 abort 分支（`:473-476`）。`anthropic-compatible.ts:493-494` 同形。而提前退出在本仓真实存在：`agent-loop-adapter.ts:180-182` 在 `sawDone` 后 `throw new Error("Model stream emitted data after its done chunk")`。
危害：**与我上一轮修掉的"每请求定时器从不清理"是同一类生命周期缺陷** —— 正常路径释放、异常路径泄漏。`return()`/抛异常会走 `finally`，而 `releaseLock()` 一执行，**就再也没人能取消这个 body 了**：socket 被占住，provider 继续生成和计费。
修复：`finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }` —— `cancel()` 幂等，正常完成后调用也安全。

**D7. `useRightPanelData` 改动已经发布给 React 的对象，且只按工具名关联网结果** — `severity: medium`
`:471-474` `entry.ok = ok; if (summary !== undefined) entry.summary = summary; setChanges([...changesRef.current]);` —— **数组是新的，元素不是**；`:489-492` 的 `existing.added = …` 同。而 `:468-469` 用 `(c) => c.tool === tool && c.ok === undefined` 查找，**没有 call id**。
危害：元素保持同一引用，被 memo 的消费方看不到变化；两次并发的同名工具调用（例如两个 `write_file`）会让一个结果的 `ok`/`summary` 落到另一个的条目上。
修复：按 `callId`（`tool.result` 里有）做不可变更新，收进单个 `changesReducer(state, event)`。

**D8. 跨边界与包内的重复实现** — `severity: medium`
- 工具参数摘要器存在两份且**键与截断长度都不同**：`apps/desktop/agent-host/tool-preview.ts:45`（键含 `file`，截断 200）vs `apps/desktop/src/agent/toolCards.ts:11-19`（键含 `relPath`，slice 120）—— 审批卡与工具卡会对同一次调用给出不同描述。
- 工作区相对 posix 路径归一化**实现了 4 次**：`workspace/src/files/read.ts:304-305` 与**逐字节副本** `:513-514`、`workspace/src/code-index.ts:189-191`、`workspace/src/watch.ts:96`。
- SSE 读取/解码/切分 + 工具调用累积块**复制 3 份**：`models/src/openai-compatible.ts:516-539`（循环内）、`:601-640`（尾部缓冲 flush）、`anthropic-compatible.ts:465`；**且副本已经分叉** —— `:516` 用 `continue` 短路 `isDoneMarker`，flush 副本在 `:604` 每个分支重测一次，而 `:630` 的工具增量循环**完全不测**。也就是说"我们是否见到 [DONE]"取决于同一份载荷落在哪个缓冲区。

**D9. harness 里风险最高的未测逻辑（点名）** — `severity: medium`
- `shell-audit.ts:115`/`:177`/`:229-238`：模块级 `_flushTimer = setInterval(...)` 与按天滚动写入只有人主动调 `flushAuditLog()` 才会拆除。而 363 个测试文件里 `logShellAudit`/`flushAuditLog`/`getPendingAuditEntries` **0 引用** —— 也就是"把 shell 历史持久化"的定时器完全没测。
- 12 个工具 id 在 `packages/harness/test` 里 **0 命中**：`workspace.list_dir`、`grep`、`glob`、`search`、`browser_check`、`web_fetch`、`web_search`、`todo_write`、`notebook_edit`、`lsp`、`create_agent`、`run_skill`。
- `errorCodeForToolPayload`（`execution.ts:288`，0 引用）**用英文子串匹配来给失败分类**（`:296-315`）—— 这本身就该有契约测试，因为它是 `errorCode` 的来源（与 §R4 同一根因）。

**D10. 死代码 + 一个潜伏崩溃** — `severity: medium` **[已复核]**
- `packages/harness/src/shell/session.ts`（**389 行**）：既没有被 `shell/index.ts` 导出，全仓也**没有任何 import**（唯一 grep 命中是 `packages/agent/src/index.ts:51` 的 `./session.js`，那是另一个文件）。而它内部有一个**真实的 TDZ 崩溃**：
```ts
const finish = (result) => { ... clearTimeout(timeoutId); ... };   // :163-166  闭包内引用 timeoutId
options.signal?.addEventListener("abort", abortListener, { once: true });
if (options.signal?.aborted) {
  abortListener();     // :223  → 走 finish() → clearTimeout(timeoutId)
  return;
}
const timeoutId = setTimeout(() => { ... });   // :227  ← 到这里才初始化
```
**调用方传入一个已经 aborted 的 signal 就会 `ReferenceError: Cannot access 'timeoutId' before initialization`。** TypeScript 不报，是因为引用发生在闭包 `finish` 内，TS 只在能证明顺序时给 TS2448。
- `apps/desktop/src/agent/useOpsPanel.ts`（192 行，0 引用）、`workspace/src/git-tools.ts:261 gitCommit`（未使用，且是阻塞式 `spawnSync`）、`useAgentRun.ts:1872` 的 `clear` 别名 —— 都是死代码。

修复：前两个直接删（零风险，因为无人引用）；`gitCommit` 要么删要么改异步。

**D11. 若干未处理的 Promise 与守卫缺失** — `severity: medium`
- `useAgentRun.ts:1657` `void desk.respondApproval(...)`、`:1684` `void desk.respondAskUser(...)` **没有 `.catch`**；`:1643 await desk.abortRun(id)` 没有 try/catch —— 而同一文件的兄弟路径 `:411-422`、`:1600-1620` 都处理了。一次 IPC rejection 就是未捕获 rejection + UI 卡死。
- `:681` `setMonitor(ev.snapshot as DesktopMonitorSnapshot);` 无条件覆盖，**绕过了轮询路径在 `:380-385` 用的 `updatedAt` 守卫** —— 一次慢轮询就能把 monitor 回退。
- `useRightPanelData.ts:356` `void desk.listMemories({limit:40}).then(...)` 无 `.catch`，而 `libraryLoading: true`（`:353`）只在 `:668` 清除 → 刷新按钮永久禁用（`RightPanel.tsx:797`）。
- `harnessClient.ts:22-31`：`off()` 会在 `const off = subscribe(...)` 初始化之前被超时回调和订阅回调调用，且 `subscribe` 抛异常会留下 20s 定时器armed。
- `models/src/thinking-recovery.ts:72` + `:93`：一次 stall 耗尽后，这个 run 级 wrapper（`:55` 注明 "Instantiate once per run"）上**后续每次 `completeStream` 都直接抛同一个陈旧错误、根本不发请求**，而 `:85` 的 `complete` 仍然正常 —— 行为不对称。

**这一层的快速修复项**：删上述两个死文件；`gitCommit` 处理掉；给 `:1657`/`:1684`/`:1643`/`listMemories` 补 `.catch`；`:681` 加 `updatedAt` 守卫；`models/src/sse.ts` + `ToolCallAccumulator` 抽公共实现。

## 8. 建议的执行顺序

按"性价比（收益 / 成本）"排序。前 6 条都属于"小改动、大收益"，建议作为一个批次先做掉。

**批次 A —— 接线与闸门（半天内可完成，纯配置）**

| # | 动作 | 影响 | 成本 |
| --- | --- | --- | --- |
| 1 | `package.json` 的 `typecheck` 换成 `bun run --filter '*' typecheck`（§C2） | 一行替 21 行；`progress-advisor` + `apps/desktop` 从"零覆盖"变成"有覆盖" | 很小 |
| 2 | `biome.json` 加 `"css": { "parser": { "cssModules": true } }`（§6） | 直接消掉 1069 个 error 里的 334 个（31%） | 很小 |
| 3 | `bun run lint:fix` + 给 `**/test/**` 关掉 `noNonNullAssertion`（§6） | 再消掉 ~630 个；闸门从"常年红"变可绿 | 小 |
| 4 | `check:ts` 里加上 `check:deps`；CI 加桌面 typecheck/test（§2.3、§C3） | 无环闸门与唯一 app 真正被强制 | 很小 |
| 5 | `.gitignore` 加 `legacy/**/.runs/` 等，并把 `legacy/` 以重命名方式入库（§C1） | 归档从"只存在本机"变成真归档 | 很小 |

**批次 B —— 正确性（小改动，修真实缺陷）**

| # | 动作 | 影响 | 成本 |
| --- | --- | --- | --- |
| 6 | 收敛 canonical JSON（§1）：`hashCanonicalJsonV1(value: unknown)` + 内部校验 | **一处签名修改同时**：修掉"同一对象两个哈希"、修掉产出非法 JSON、删掉 94 处 `as never`、再删 runtime 里 ~30 处 `as unknown as JsonValue`（§R7 指出是同一根因） | 小 |
| 7 | 补 `canonical-conformance.test.ts` 一致性闸门（§1） | 把静默风险变 CI 红灯 | 很小 |
| 8 | 修 `memoryItemDao.query`：`tags` 参数失效 + `types?.[0]` 截断（§M2） | 修掉一个静默返回错误结果的 bug | 小 |
| 9 | 修 `loadMcpServers`：复用已存在的 `mcpServerConfigSchema` 做 `safeParse`（§A9） | **修掉一个真实 bug**（字符串配置被当数组逐字符迭代），且正确 schema 就在同仓 | 很小 |
| 10 | `tool-result-detail.ts` 加 `readMatchArray`/`readStringArray`（§A10） | 消掉"工具已执行完后才抛 TypeError" | 小 |
| 11 | `finalizeToolExecutionContext` 内建长度守卫（§A13） | 一处守卫保护两个入口 | 很小 |
| 12 | **把 state updater 改纯**：`:1844` 的 `setSessions` updater 及其 `:1234`/`:1318` 的嵌套调用（§D3） | StrictMode 下当前会重复写 localStorage、重复重排会话；updater 必须是纯函数 | 小 |
| 13 | 删除两个死文件：`harness/src/shell/session.ts`（389 行，含 TDZ 崩溃）、`desktop/src/agent/useOpsPanel.ts`（192 行）（§D10） | 零风险（无引用），并顺手消掉一个潜伏 `ReferenceError` | 很小 |
| 14 | 给渲染进程 4 处 `void desk.*` 补 `.catch` + `:681` 加 `updatedAt` 守卫（§D11） | 消掉未捕获 rejection 与"刷新按钮永久禁用" | 很小 |
| 15 | 模型流 `finally` 改成 `await reader.cancel()` 再 `releaseLock()`（§D6） | 与上一轮修掉的定时器泄漏同一类缺陷：异常路径不再泄漏 socket | 很小 |
| 16 | shell 策略两条永不触发的 `> /dev/sd*` / `> /dev/hd*` deny 规则 + 补 `matchPattern` 表驱动测试（§D5） | 消掉"看起来有防护其实没有"的死规则 | 小 |
| 17 | 统一 `FileLease` 四个迁移的失败协议（§R3） | 修掉一条绕过 `failClosed` 的裸抛路径 | 中 |
| 18 | `errorCode` 改成显式 code，不再正则抠英文散文（§R4） | 崩溃恢复的分类不再依赖措辞 | 中 |

**批次 C —— 可读性重构（收益最大，但要排期）**

| # | 动作 | 影响 | 成本 |
| --- | --- | --- | --- |
| 19 | 拆 `packages/protocol/src/journal/`（§R1） | 4623 行的单文件变 8 个模块，**且对外 104 个名字逐字节不变**（唯一引用者只有 `index.ts:125`） | 中 |
| 20 | 拆 `initializeRun`（1282 行）与 `AgentOrchestrator`（4922 行）（§2.1、§A1–A3） | 可读性最大单点收益 | 中大 |
| 21 | ✅ 完成：拆 `executeTool`（1355 行、37 个分支）—— `execution.ts` 1768 → 38 行，处理器分到 9 个文件 + 派发表；导出面与测试数字逐项不变（见 11.9） | 工具层的可读性单点最大收益 | 中大 |
| 22 | 拆 `apps/desktop` 的 931 行 `useEffect` + 引入 `useReducer`（§D1） | 订阅泄漏风险 + 状态机单一迁移点 | 中大 |
| 23 | `tool-runner` 的 7 个并行数组 → `ToolCallPlan[]`（§A3） | 消掉 flag soup 与一个 `!` | 中 |
| 24 | `TURN_FLAG_CODECS` 映射类型替掉三处手工镜像（§A5） | 消掉一个"加字段就静默丢状态"的悬崖 | 中 |
| 25 | 拆 `resolveEvidencePass`（1324 行）（§M4） | 让承重不变量可被 review | 中大 |
| 26 | 渲染进程边界：导出 `DesktopRunEvent` 联合类型，`agentId` 改真字段（§D2） | 消掉"改一句摘要就静默破坏子 Agent 名册" | 中 |
| 27 | 跨包同名不同义改名去歧义（§3） | 消除读者陷阱 | 中（面广但机械） |
| 28 | `db/rows.ts` 行类型 + DAO 断言收敛（§M1、M7） | 把静默 `undefined` 变编译错误 | 中大 |
| 29 | 抽公共实现：`sse.ts` + `ToolCallAccumulator`、`toWorkspaceRelPath()`、共享 `summarizeToolArgs`（§D8） | 消掉"同一载荷落不同缓冲区行为不同"等已分叉副本 | 中 |
| 30 | `benchmarks/` 加 tsconfig 并纳入 typecheck（§2.4） | 3 万行回到闸门内 | 小 |

**批次 D —— 结构收敛（做完前三批后再评估收益）**

| # | 动作 | 影响 |
| --- | --- | --- |
| 31 | `packages/agent` 的 `exports` 收成 `"."` + `"./internal"`，去掉 `export *`（§A7） | 让 788 个符号里的 8 个真正成为契约，其余变内部；此后所有内部重构不再是"潜在破坏性变更" |
| 32 | 统一 `as unknown as` 的两个根因：内部校验器改 `asserts` 谓词（§R7） | 一次消掉 ~40 处断言，且把"运行时校验"变成类型系统的一部分 |
| 33 | `run-journal.ts` 的不变量表化 + 唯一 error code（§R2） | 让"work segment 启动前必须成立什么"可被单点回答 |
| 34 | 给 `packages/paw-next` 补测试（它是桌面端唯一入口，却零测试，§C7） | 风险最高的模块从零保障到有保障 |
| 35 | 给 `packages/harness` 补测试：`logShellAudit`/`flushAuditLog`、`errorCodeForToolPayload`、12 个无测试的工具 id（§D9） | 该包测试比 0.28，而它决定策略与审计 |

> 建议在第 12 条之前先落地第 6 条：`canonicalJsonStringifyV1` 签名一变，`orchestrator.ts` 里若干 `as never` / `as unknown as` 会自然消失，重构时的噪声更少。

---

## 9. 值得保留的做法（不要在重构中弄丢）

1. **类型纪律**：全仓只有 4 处 `: any`、0 处空 `catch`、3 处 `@ts-ignore` 且都在测试里。`packages/agent/src`（38,952 行）更是只有 6 处 `as unknown as` / 29 处非空断言 / 0 处 `: any`。这是很硬的底子。
2. **不变量注释写得很具体，而且带事故记录**：`db/connection.ts:49-55` 记录了 postgres.js 冷连接数组序列化器 bug 的**原因和解法**；`orchestrator.ts:4431–4435` 解释了为什么流式 chunk 必须只存活于内存，并引用真实事故（"一个中等长度的推理回合产出了 188 MB JSONL"）；`:4178–4181` 解释了为什么 resume 不能重启 `seq`/检查点计数器（"会产生重复事件身份并覆盖回滚快照"）。这类注释是**承重文档**，拆函数时必须跟着搬。
3. **fail-open / fail-closed 的边界是显式且集中的**：`orchestrator.ts:4442–4444` 陈述规则，`:4505–4508` 用一处 `if (this.loopKernelVersion === "v2") throw error;` 执行 —— 投影完整性在 v2 下是权威、在 shadow 下只是诊断，没有散落各处的特例。这种"规则写在一处"的写法值得在别处复制。
4. **恢复期断言是真不变量，不是装饰**：`orchestrator.ts:4246–4267` 会拒绝 runId 不匹配、拒绝工件超前于 journal（`report.sourceThroughSeq > seq.n`）、拒绝两个工件声称同一 source seq 却内容哈希不同。
5. **`@deprecated` 用得有纪律**：18 处标记都指明了替代品（如 `core/src/index.ts:430` "WP1a compatibility alias. Import LegacyProjectMemoryV1 instead."）。
6. **包依赖无环闸门 + WP1a 源边界检查**（`scripts/check-workspace-dependency-cycles.ts`）：思路对，只是覆盖面需要从"包级"扩到"模块级/文件级"。
7. **测试比健康**：`runtime` 1.34、`agent-loop` 2.01、`progress-advisor` 1.07、`output-recall` 1.00，且 `packages/agent` 在 39k 行源码下有 0.81 的比例。
8. **`memory-core` 的独立可发布定位**被认真对待（零运行时依赖、明确的 `exports` 表、`sideEffects: false`）—— 这也是 §1 里它保留本地 canonical 副本的正当理由。
9. **lease 的 capability 模式**（`session-execution-lease.ts:36-41` 的模块私有 `WeakMap` + `:995-1021` 的 `assertFileSessionExecutionLeaseCapabilityV1`）：拒绝鸭子类型/跨 workspace 的 lease，并返回已绑定的操作，使调用方**无法**遮蔽 `release`/`linearizeJournalBatch`。理由写在 `:1023-1026`。这是"用类型系统表达权限"的正例。
10. **崩溃窗口是一等公民且显式标注 `@internal`**：`session-execution-lease.ts:63-72` 的 `beforeTransitionPublish`/`afterTransitionLink`、`file-run-session.ts:61-78` 的 `FileRunSessionCommitHooksV1` —— 让每个"发布到一半"的窗口都可被测试，而不是靠运气。这种可测性设计很值得在别处复制。
11. **protocol 的公共边界写法一致且正确**：四个 DTO 都是 `parseX` / `assertX` / `isX` 三件套（`run-journal.ts:858-919`），入口用 `asserts value is`（`:952`、`:863`、`:905`），且 `parseRunJournalPrefixV1`（`:985-1001`）把 seq 连续性、session/run 身份、decision-必须在 fact 之后这三件事集中在一处。**这正是 §R7 建议推广到内部校验器的模板。**
12. **`packages/models` 把最脏的活关在边界内**：它对接各家流式协议，却保持 0.80 的测试比、且不出现在任何类型逃逸热点里。`packages/harness` 重构时可以拿它当参照。
13. **资源清理在好几处写得是对的**（说明团队知道正确写法，只是没铺开）：`models/src/request-supervision.ts:105-110` 用**一个** `finally` 清掉 interval、父级 abort 监听与 race 监听，并用 `closed` 丢弃迟到事件；`harness/src/jobs/managed-job-registry.ts:311-329` 的 `wait()` 在三条 settle 路径上都会清定时器、删 waiter、移除 abort 监听，`:340-363` 的 `disposeOwner` 还给拆除过程加了上界；`workspace/src/lsp-client.ts:346-381` 的 `killProcess` 清 init 定时器、拒绝所有 pending 请求并清它们的定时器、移除监听、并 unref 那 2 秒的 kill-wait 定时器。**§D6 的模型流泄漏就是因为没照这几处的写法做。**
14. **用单调版本号丢弃过期异步结果**：`useRightPanelData.ts:321`/`:328` 的 `contextVersion` 守卫，以及 `:673-677` 把 400ms 定时器与两个订阅一起拆除（可选注册用 `?? (() => {})` 兜底）。这是 React 里处理竞态的正确姿势，值得在 §D1 重构时保留下来。
15. **遥测不参与推理**：`models/src/observation.ts` 把每个 telemetry 回调包在 try/catch 里，保证诊断代码不会打断推理。这是"可观测性必须是旁路"的正确实现。

---

## 10. 关于本报告的可靠性

- **覆盖范围**：5 个按包的只读专项深读（`packages/agent`、memory 系列、`runtime`+`protocol`+`agent-loop`、`apps/desktop`+`harness`+`workspace`+`models`、配置/CI）+ 我自己的全仓静态度量与交叉扫描。所有专项均已交付结论。
- **标 **[已复核]** 的条目我都独立复现过**（跑脚本、读源码、比对输出），不是转述专项深读的结论。其中包含我亲自验证为真的关键 bug：`loadMcpServers` 的字符串当数组（§A9）、`memoryItemDao.query` 的 `tags` 失效与 `types?.[0]` 截断（§M2）、canonical JSON 的双哈希与非法 JSON 输出（§1）、`shell/session.ts` 的 TDZ 崩溃（§D10）、`setSessions` updater 不纯（§D3）、shell 策略锚定导致的死规则（§D5）。
- **纠正了 3 处二手误报**，均已在上文标注：`playwright` 其实是 `browser-check-worker.mjs` 的动态依赖（静态扫描漏了 `.mjs`）；`legacy/README.md` 是合法 UTF-8（乱码来自 PowerShell 5.1 控制台）；`shadow-runtime.ts` 的 4 处 `as unknown as` 是**必需**的（该文件刻意使用最小边界类型），不能删 —— 这一条是 `packages/agent` 专项在自查后主动撤回的，我采纳了撤回。
- **行数口径统一为"含空行"**。`orchestrator.ts` = 5715（非空 5185）、`useAgentRun.ts` = 1920/1921、`harness/registry/execution.ts` = 1898/1899（读工具与行分割略有差异，不影响"~1460 行的函数"这一结论）。
- **已知的未覆盖面**：`benchmarks/`（约 3 万行）只做了闸门覆盖分析，未逐文件精读；`packages/core`、`packages/store`、`packages/settings`、`packages/web-access`、`packages/output-recall`、`packages/task-progress`、`packages/model-output-recovery`、`packages/progress-advisor`、`packages/completion-review`、`packages/context-compaction`、`packages/collaboration` 未做逐包深读（它们体量较小，且已被跨包扫描覆盖）。
- **本次审查未修改任何源码逻辑**。仅修了 3 处由上一轮 legacy 迁移造成的失效文档命令（`README.md`、`ARCHITECTURE.md`），已在 §C6 标明。

---

## 11. 执行记录

### 11.1 状态

| # | 状态 | 说明 |
| --- | --- | --- |
| 1–5 | ✅ 完成 | 闸门接线：`typecheck` 顺序化跑全部 23 个包、CI 覆盖 memory 全量 + 桌面原生、`biome.json` 修复、`legacy/` 归档 |
| 6 | ✅ 完成 | canonical JSON 收敛到 `@paw/core`（见 11.2） |
| 7 | ✅ 完成 | `packages/memory-plugin/test/canonical-json.conformance.test.ts`（86 例，含 golden 与 12 种非法值）＋ `packages/agent/test/loop-v2-canonical.test.ts`（9 例） |
| 8 | ✅ 完成 | `memoryItemDao.query` 重写为单一参数化查询；新增 `packages/memory/test/memory-item-query.test.ts`（9 例，**其中 6 例在旧实现上失败**） |
| 9 | ✅ 完成 | 导出 `mcpServerConfigSchema`，`loadMcpServers` 改用 `safeParse` |
| 10 | ✅ 完成 | `tool-result-detail.ts` 的 `files`/`matches` 元素按类型校验 |
| 11 | ✅ 完成 | `finalizeToolExecutionContext` 增加长度守卫，并消掉重复的 `calls[i]!` |
| 12 | ✅ 完成 | state updater 纯度（§D3）：抽出 `persistActiveSession` / `syncActiveSessionMessages` 两个纯 reducer，`commitSessions` 统一落盘，`commitHistoryIfNeeded` 改为「请求位 + effect」；新增 `apps/desktop/test/sessionPersistence.test.ts`（12 例） |
| 13 | ✅ 完成 | 删除 `harness/src/shell/session.ts`（419 行）与 `apps/desktop/src/agent/useOpsPanel.ts`（192 行）；两者全仓零引用（已按符号名逐一确认） |
| 14 | ✅ 完成 | `respondApproval`/`respondAskUser` 补 `.catch`、`abortRun` 补 try/catch、`listMemories` 补 `.catch`（否则 `libraryLoading` 永远为真、刷新按钮永久禁用）、`monitor.snapshot` 补 `updatedAt` 守卫（与轮询路径同一守卫） |
| 15 | ✅ 完成 | `openai-compatible.ts` / `anthropic-compatible.ts` 的 `finally` 改为 `await reader.cancel().catch(() => {})` 后再 `releaseLock()` |
| 16 | ✅ 完成 | 删掉两条不可达的块设备 deny 规则（真防护在 `shell-policy.ts:309` 的重定向目标检查，已有用例）；新增 `shell-policy-config.test.ts`（43 例：锚定/`*`/`?`/转义/大小写/last-match-wins） |
| 17 | 🟡 部分 | `releaseTransition` 两处裸抛统一为 `throw this.markLost(error)`（与 `linearizeTransition` 一致）；**但没有**把 `linearize*` 的抛出接进 `failClosed` —— 见 11.5 |
| 18 | 🟡 部分 | 已完成：`normalizeErrorCode`/`normalizeCode` 拒绝字面量 `"Error"`（不再铸出 `errorCode: "Error"`）；`canonicalErrorCode` 优先读 `evidence.payload.code`，执行器的 `E_TOOL_EXECUTOR_BOUNDARY`/`E_TOOL_RESULT_INVALID` 终于能到达 journal；消掉 `composition.ts` 里「同一正则跑两遍再从英文散文抠 code」。仍未做：`LoopError`/settlement/端口输入**携带**显式 `code`（跨包协议变更），以及 `interactive-control.ts` 两处对超时文案的精确比较 —— 见 §11.6 |

批次 B 的闸门实测（`typecheck` 23/23、`lint` 0 error、`test:ts` 2790 pass/6 skip、`test:desktop` 190 pass/0 fail、`test:memory`（真实 Postgres）407 pass）与基线一致，唯一新增失败在逐项 A/B 后确认均为既存问题。

### 11.2 报告本身估错的地方（更正）

1. **§1 说 canonical JSON 有 4 份实现，实际是 11 份。** 除报告点名的 4 份外，还有 `packages/core/src/model-request.ts`（就在 core 内部）、`packages/output-recall/src/index.ts`、`packages/task-progress/src/service.ts`、`packages/progress-advisor/src/projector.ts`、`packages/runtime/src/inbox/durable-input-inbox.ts`，以及 3 份 runtime 测试内的本地副本。§R6 提到的「重复实现」比报告描述的更普遍。
2. **`as never` 全仓 136 处，本次共消掉 246 处类型逃逸**（94 + ~30 是低估，因为 `as unknown as JsonValue` 的数量被低估）。
3. **批次 A 结束时 lint 并非 0 error。** `apps/desktop/agent-host/paw-next-attachments.ts` 有 1 处 `noNonNullAssertion`（已按 `match[2]` 可能为 `undefined` 显式守卫修掉）。此前那次「0 error」的读数不准确。
4. **§D10 的行数**：`harness/src/shell/session.ts` 是 419 行而非 389 行（口径差异，不影响结论）。两个文件确实零引用，删除后闸门无变化。

### 11.3 新发现（报告未覆盖）

1. **`task-progress/src/service.ts` 用 `localeCompare` 排序对象键**（`canonicalJson` 的本地副本）。这比报告里说的 `undefined`/`NaN` 分歧更严重：canonical 文本因而 **hash 依赖宿主机 locale**，同一份数据在不同机器上算出不同的「稳定」哈希。收敛后该文件只剩一处实现。实测差异：code-unit 序为 `"B" "Z" "a" "e" "z"`，`localeCompare` 序为 `"a" "B" "e" "é" "z" "Z"`。
2. **稀疏数组会产出非法 JSON 而不是报错。** 旧实现的 `value.map(fn)` 会**跳过空洞**，`join(",")` 于是拼出 `"[ ,1]"`（`[,1]`）—— 直接写进 durable payload 文件。新实现改为按索引遍历并显式拒绝空洞与 `undefined` 元素。
3. **`listMemories()` 存在跨用户返回**（`packages/memory/src/runtime/memory-runtime.ts:537`）。它总是传 `scopeRepoId + scopeUserId` 但通常**不传 type**，于是落进旧实现「有 repo 无 type」的分支 —— 该分支只过滤 repo，`scopeUserId` 被静默丢弃。报告 §M2 只提了 `tags` 与 `types[0]`，但这一条的后果是**同仓库内其他用户的记忆会被返回**，属于信息泄漏而非噪声。
4. **`tool-result-detail.ts` 的 `matches` 不止是输出噪声，还会抛异常。** 旧代码在未校验的元素上直接读 `m.path`，元素为 `null` 时抛 `TypeError` —— 即报告 §A10 说的「工具执行完之后才崩」确有其事，触发条件是 `null` 元素而非类型不符。
5. **正文外还有两个既存问题**（都不在报告里，也都没改）：
   - `test:memory` 在真实 Postgres 上**本身就不稳定**：干净基线上跑两次分别得到 4 与 5 个失败。成因是跨文件互相污染 —— `governor.test.ts:192` 先全局 `DELETE ... WHERE policy_version = 'v2-m5'`、`:251` 再全局 `SELECT` 计数，而 bun 并行跑测试文件、共用同一个库，于是「删」与「查」之间会被另一个文件的写入穿过（生命周期用例的 trial 容量同理）。建议给这两处加 `repo`/测试命名空间过滤，而不是靠删除窗口。
   - `.understand-anything/`（145 个跟踪文件）是分析工具的输出目录却已入库；`biome check .` 会顺带重排它。`lint` 脚本限定 `packages apps` 是对的，但这批生成物建议移出版本库。

### 11.4 一处需要决策的分歧（#17）

§R3 建议把 `FileLease` 四个迁移统一为「一律 resolve，不抛」，并明确说 `:808` 的裸抛绕过了 `failClosed`。但 `packages/runtime/test/session-execution-lease.test.ts:127` **正是断言这个裸抛**：

```ts
await expect(
  lease.linearizeJournalBatch({ ...input, nextHead: { ...input.nextHead, prefixHash: "e".repeat(64) } }),
).rejects.toThrow("commitId was reused");
```

该测试把「同一 `commitId` 配不同内容」当作**篡改**（破坏内容寻址不变量）而与「head 冲突」（可重试）区分开。而且按 §R3 自己的原则「抛异常只保留给程序员错误级别的入参校验」，这条恰好**就是**程序员错误（`commitId` 必须由内容派生），所以保留抛出是对的；需要补的是调用方能接住它。

### 11.5 §R3 的后半条建议被实测否掉了

§R3 还建议「原始错误只在 `serializeTransition` 的 catch 一处经过 `markLost`」，即让 `failClosed` 统一接管。我按这条改了 `file-run-session.ts` 的两处 `linearize*` 调用（`.catch((e) => this.failClosed(e))`），随后 `file-run-session-fencing` 的 "two real processes on the same empty head" 出现失败。

但**不能**据此宣告该改动有害：把这条命令在干净基线上跑 8 次，**基线本身也失败了 1 次**（同一条用例，报同样的 `Session lease identity must not have an external hardlink`）。也就是说这个多进程用例家族本身就是间歇性的 —— 这本身是一条值得记录的新发现，它意味着这几个「硬门」不能按单次运行来信任。

最终决定：不引入这个 catch。理由是机制而非统计 —— 争抢 head 失败的一方若执行 `failClosed`，就会 `close()` 掉**赢家**正在写的 run 目录，用一个说得通的机制去换一个未经验证的收益不划算。代码里已写明这一判断及其证据强度（8 次里 1 次的基线噪声）。真正需要保留的是 `releaseTransition` 两处裸抛的统一，那条跑了 6 次全绿且无机制上的 downside。

### 11.6 #18 只做了一半，剩下的是协议变更

做完的三件事都已补测试，且**在旧实现上会失败**（`tool-observation.test.ts` 新增 3 例，其中 2 例在旧代码上红）：

- `normalizeErrorCode` / `normalizeCode` 拒绝字面量 `"Error"`；
- `canonicalErrorCode` 优先读 `evidence.payload.code`，于是 `agent-loop-tool-executor.ts:379`/`:460` 的语义 code 终于能进 journal；
- `composition.ts` 不再把同一个正则跑两遍从英文散文里抠 code。

**没做的**是 §R4 的根因修复：让 `LoopError`/settlement/端口输入**携带**显式 `code`。这不是能顺手带上的改动 —— `LoopError` 是 `packages/agent-loop` 的跨包类型，`ToolSettlement`/`ModelSettlement` 的每个构造点都要跟着改，还要动 `interactive-control.ts:196`/`:257` 对超时文案的精确比较。做完之前的现状是：超时类 code 仍然依赖 `agent-loop-adapter.ts` 拼出的那句英文。

### 11.7 剩余工作

批次 C 的 #20–#30 与批次 D（#31–#35）尚未完成。建议每条单独提交并单独跑闸门：这些改动的影响面是「可读性」，而不是批次 B 那种可被测试直接钉住的行为。

### 11.8 #20 做到了哪一步，以及为什么不能再往下机械地切

**已完成**（`orchestrator.ts` 5208 → 4757 行，导出面逐字节不变）：

- 9 个与实例无关的模块级函数/常量 → `orchestrator/support.ts`（约束模式、provider 恢复文案、控制动作归一化、记忆 LLM 选项）
- 6 个错误分类与重试策略声明 → `orchestrator/errors.ts`
- 3 个公开构造/回调接口 → `orchestrator/options.ts`，并由 `orchestrator.ts` 原样再导出（5 个调用方不用改）

**没有做**的是报告点名的那个核心动作：拆 `initializeRun`。原因不是规模，而是**它不能靠机械的 extract-method 完成**。我用 AST 量了三个候选块的自由变量：

| 块 | 语句数 | 块内声明 | **自由标识符** | 写外部局部变量 |
| --- | --- | --- | --- | --- |
| 子 Agent 模式 | 1 | 8 | **35** | `startTurn` |
| 完整模式（前半） | 16 | 12 | **16** | — |
| 完整模式（后半） | 17 | 25 | **43** | `startTurn` |

`initializeRun` 本身是 **1074 行、100 条顶层语句**（报告估 1282 行；批次 A 的格式化把它压到了 1074）。这些块**既读又写**外层局部变量，所以「切出去」要么变成 25+ 个参数的方法（比现状更难读），要么就得先有报告里说的那个 `RunSession` —— 一个命名「一次运行的运行环境」的类型，拥有那 30 个值。

也就是说 #20 的下一步是一个**设计决策**（`RunSession` 的边界与所有权），而不是搬运。再加上 `packages/agent` 的 `orchestrator.test.ts` 本来就在既存的 12 个失败里，缺少可信的回归网。我选择把这一步留给一次专门的改动，而不是在本轮留下一个半拆的 1100 行方法。

下一步的可行顺序：先定义 `RunSession`（把 `run()` 解构的 22 个字段和 `PhaseContext` 的 35 个字段中重合的部分收进去），再让 `initializeRun` 退化成「构造 RunSession + 调用三个具名步骤」，最后才是拆 class body。报告里那条「新增/修改的方法不超过 ~150 行」的机械约束应当与它同时落地。

**顺带发现一个闸门盲区（值得单独记一笔）**：`errors.ts` 最初抽出来时没有 `export`，于是它**不是一个模块**，TypeScript 把它的声明当成了**全局**。后果是 `orchestrator.ts` 里 `classifyError(...)` 之类没有任何 import 也能通过 `packages/agent` 自己的 `tsc`（`include: ["src/**/*.ts"]`，exit 0），而 `apps/desktop` 的 `include: ["src"]` 是另一个 program、拿不到这些全局，于是报出 4 个 `Cannot find name`。**同一个文件，两个包级 tsconfig 给出不同结论** —— 这正是 §2.3「CI 不覆盖唯一的 app」与 §2.5「每个包 tsconfig 各自复制」两条的合流后果。批次 A 已经把桌面端纳入闸门，所以这次是桌面端先抓到；否则它会以「全局符号」的形态安静地留在仓库里。这也说明「23 个包都 typecheck 通过」并不等于每个文件都被严格检查过。

### 11.9 #21 已完成：`executeTool` 拆成 37 个处理器

**结果**：`packages/harness/src/registry/execution.ts` **1768 → 38 行**，只剩一个验证 + 派发的入口。

| 新文件 | 内容 |
| --- | --- |
| `registry/tool-support.ts` | 12 个参数解析/错误整形辅助（含 `ToolScope` 定义）+ `validateToolArguments` 的再导出 |
| `registry/handlers/files.ts` | 10 个（read/list/search/glob/grep/write/edit/undo/notebook/patch） |
| `registry/handlers/jobs.ts` | 5 |
| `registry/handlers/shell-web.ts` | 4（run_shell/web_fetch/web_search/browser_check） |
| `registry/handlers/task.ts` | 5 |
| `registry/handlers/memory.ts` | 4 |
| `registry/handlers/agents.ts` | 3 |
| `registry/handlers/git.ts` | 3 |
| `registry/handlers/lsp.ts` | 2 |
| `registry/handlers/mcp.ts` | 1（+ `executeMcpProxy`） |
| `registry/handlers/index.ts` | 37 条派发表 |

两个设计点让它成为机械操作（与 #20 相反）：

1. 处理器只收一个 `ToolScope = { ctx, rec, tool, args }`，不再闭包捕获 `executeTool` 的局部变量 —— 这正是 #20 卡住的原因（那些块既读又写外层局部变量）。
2. 返回类型写成 `Promise<ToolRunResult>`，于是「某条控制流不返回」变成**编译错误**。在原来的 if 链里，这种分支会静默落到最后的 `unknown tool` 结果。

**验证**：`execution.ts` 的导出面逐字节不变（`executeTool`、`validateToolArguments`，用导出集合比对确认；后者从 `tool-support.ts` 再导出，所以 `@paw/harness` 的 index 一行没动）；派发表 37 条；lint 0 error；23 个包 + `apps/desktop` typecheck 通过；`test:ts` 与 `test:desktop` 的数字与改动前**完全一致**（2837 pass / 14 既存失败；202 pass / 0 fail）。

**方法论提醒（写给后续的脚本化重构）**：用 AST 统计「自由标识符」时，`ts.forEachChild(node.expression, visit)` **不会访问 `node.expression` 本身** —— 对 Identifier 调用 `forEachChild` 得到的是它的子节点（没有）。本次第一版脚本因此漏掉了所有 `ctx.foo` / `rec.bar` 形式的基名，生成的处理器缺参数。正确写法是直接 `visit(node.expression)`。同一类偏差会让「这个块需要多少输入」的估算偏低，进而把不可机械化的重构误判成可机械化。

### 11.10 #30 的成本被低估了：benchmarks 有 496 个类型错误

§2.4 把「给 `benchmarks/` 加 tsconfig 并纳入 typecheck」估为**小**。实测不是：加上 `benchmarks/tsconfig.json`（继承 `tsconfig.base.json`，`noEmit`）后跑一次得到 **496 个 error**：

| 错误码 | 数量 | 含义 |
| --- | --- | --- |
| TS7006 | 308 | 参数隐式 `any` |
| TS18046 | 50 | 值是 `unknown` |
| TS2339 | 29 | 属性不存在 |
| TS2345 | 26 | 实参类型不符 |
| TS2307 | 25 | 找不到模块 |
| TS18048 | 16 | 可能为 `undefined` |
| TS5097 | 12 | import 路径带 `.ts` 后缀 |

分布高度集中：`amb/paw-memory-bridge.ts` 一个文件 217 个，其次 `amb/state-semantic-audit-observer.ts` 53、`amb/run_aspect_edge_candidate_gate.ts` 44。

所以这条不是接线，而是「把 3 万行从未进过闸门的代码拉到 strict 下」的工作量。**我没有把它接进 `check:ts`** —— 那会立刻把闸门变红，违反「保持 green」的前提。`benchmarks/tsconfig.json` 保留在仓库里，作用是把这批错误变成可复现的一条命令：

```
bunx tsc --noEmit -p benchmarks/tsconfig.json
```

建议的推进方式：按文件修（先 `amb/paw-memory-bridge.ts`，一个文件就占 44%），每修一批就缩小 `exclude`，等降到 0 再并入 `check:ts`。不要用放宽 `strict` 的方式换一个绿 —— 那样只是把「未检查」换成「看起来检查过」。
