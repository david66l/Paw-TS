# Paw-TS 工程卓越改进方案

> **目标**: 将 Paw-TS 从「面试可用的精品骨架」升级为「大厂生产标准的 AI Agent 项目」
> 
> **前提**: 本方案仅为**文档规划**，任何代码修改需经项目负责人确认后执行。

---

## 一、现状总评

Paw-TS 是一个设计意图清晰、架构方向正确的 AI Coding Agent 项目。其 Monorepo 边界设计、TypeScript 严格配置、事件驱动架构和三层压缩机制均体现了扎实的工程思考。但从**生产级大厂标准**审视，项目在**工程规范执行、质量门禁、可观测性、安全纵深**四个维度存在明显差距。

### 核心数据速览

| 维度 | 现状 | 大厂标准 | 差距等级 |
|------|------|----------|----------|
| 类型安全 | `strict` + `noUncheckedIndexedAccess` 全开，但 **存在编译错误** | 0 编译错误，CI 门禁 | 🔴 高 |
| 代码规范 | Biome 配置专业，但 **179 errors / 191 warnings 未修复** | pre-commit + CI 强制 0 error | 🔴 高 |
| 测试质量 | 468 通过 / 1 失败，覆盖率未知 | 100% 通过 + 覆盖率门禁 | 🟡 中 |
| CI/CD | **完全缺失** | PR 触发 lint → typecheck → test → build | 🔴 高 |
| 可观测性 | `console.log` + 本地 JSONL | 结构化日志 + OpenTelemetry + Metrics | 🟠 中高 |
| 安全策略 | 黑名单 Shell 守卫 | 白名单 + 纵深防御 + 依赖扫描 | 🟡 中 |
| 模块粒度 | `orchestrator.ts` 1301 行 | 单文件 < 300 行，单函数 < 50 行 | 🟠 中高 |
| 版本管理 | 1 个 commit，全包 `0.0.1` | Conventional Commits + Changesets | 🔴 高 |
| 文档体系 | 中文设计文档优秀，无 ARCHITECTURE/ADR | 架构文档 + ADR + API Reference | 🟡 中 |

---

## 二、改进方案：七大支柱

### 支柱 1：质量门禁体系（P0 — 立即执行）

**问题**: 当前 `bun run check:ts` 无法完全通过，但没有机制阻止脏代码进入仓库。这是工程化最基础也最重要的防线。

#### 1.1 修复现有质量问题（1-2 天）

| 问题 | 位置 | 修复方案 |
|------|------|----------|
| TS4104 `readonly` 类型错误 | `packages/core/src/skills.ts:71` | 移除不必要的 `readonly` 修饰或改用 `ReadonlyArray<T>` |
| Lint 179 errors | 全仓库 | 执行 `bun run lint:fix` 自动修复格式和 import 排序 |
| Lint 191 warnings | 全仓库 | 重点处理 `noExplicitAny`、`noNonNullAssertion` |
| CostTracker 测试失败 | `packages/core/test/cost-tracker.test.ts` | 修复货币符号断言（`~$` vs `~¥`）或统一货币处理逻辑 |
| 版本控制污染 | 根目录 | 删除 `orchestrator.ts.bak`、`.current` 等临时文件 |

#### 1.2 GitHub Actions CI 流水线（1 天）

大厂标准：任何代码合并前必须通过自动化检查。推荐配置：

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run lint        # 必须 0 error
      - run: bun run typecheck   # 必须 0 编译错误
      - run: bun run test:ts     # 必须 100% 通过
```

**关键决策**: 使用 `--frozen-lockfile` 确保 CI 与本地依赖完全一致。

#### 1.3 Pre-commit Hooks（2 小时）

```bash
# 安装
bun add -d husky lint-staged

# package.json 配置
{
  "lint-staged": {
    "*.{ts,tsx}": ["biome check --write", "biome format --write"]
  }
}
```

**为什么**: 在代码进入仓库前自动修复格式问题，减少 CI 因格式失败的噪音。

---

### 支柱 2：架构治理与模块拆分（P1 — 1-2 周）

**问题**: `orchestrator.ts` 1301 行、`registry.ts` 929 行，严重违反单一职责原则。大厂 Code Review 中，单文件超过 300 行通常会被打回。

#### 2.1 Orchestrator Phase Handler 重构

基于 UPGRADE_PLAN.md 已有的设计，补充工程层面的拆分标准：

```
packages/agent/src/
  orchestrator/
    index.ts              # 主入口，< 100 行
    types.ts              # PhaseContext, PhaseResult, RunState
    state-machine.ts      # 显式状态机管理
    phase-runner.ts       # Phase 调度器
    phases/
      model-phase.ts      # LLM 调用（含重试）
      tool-phase.ts       # 工具执行（并行/单工具统一）
      compression-phase.ts # 上下文压缩
      plan-phase.ts       # Plan 管理
      ask-user-phase.ts   # 用户交互
      final-answer-phase.ts # 结束处理
```

**拆分原则**:
- 每个文件 < 200 行
- 每个 Phase Handler 独立可测试
- 状态转移必须通过 `state-machine.ts`，禁止分散赋值

#### 2.2 工具注册表重构

```typescript
// packages/harness/src/tool-registry.ts
interface ToolHandler<TArgs = unknown> {
  readonly name: string;
  readonly requiresApproval: boolean;
  validate(args: unknown): TArgs;           // zod schema 校验
  execute(ctx: HarnessContext, args: TArgs): Promise<ToolResult>;
}

const registry = new Map<string, ToolHandler>();
registry.set("workspace.read_file", new ReadFileHandler());
registry.set("workspace.write_file", new WriteFileHandler());
// ...
```

**收益**:
- 新增工具只需注册一个 Handler，无需修改 `registry.ts`
- 每个工具独立文件，可单独测试
- 参数校验从运行时断言变为编译时类型安全

#### 2.3 引入循环依赖检测

```bash
bun add -d madge
# package.json script
"check:circular": "madge --circular packages/*/src/**/*.ts"
```

**大厂标准**: Monorepo 必须保证依赖方向单一，循环依赖是架构腐化的早期信号。

---

### 支柱 3：可观测性体系（P1 — 1 周）

**问题**: 当前使用 `console.log/error` 和本地 JSONL 文件，无法满足生产环境故障排查需求。

Paw-TS 已有优秀的基础：
- `RunEvent` 类型系统覆盖 27 种事件（tool.call, model.chunk, compression.auto_compact.done 等）
- `SessionStore` 支持流式回放

这是大厂 Event-driven 可观测性的雏形，只需向上叠加标准化层。

#### 3.1 结构化日志（Structured Logging）

**不推荐**: Winston / Pino（对 Bun 兼容性一般）
**推荐**: 基于 `RunEvent` 的轻量级 Logger

```typescript
// packages/core/src/logger.ts
interface LogEntry {
  timestamp: string;      // ISO 8601
  level: "debug" | "info" | "warn" | "error";
  message: string;
  traceId: string;        // 单次 run 的唯一标识
  spanId?: string;        // 当前阶段标识
  component: string;      // "orchestrator" | "tool" | "model"
  metadata?: Record<string, unknown>;
}

class StructuredLogger {
  debug(entry: Omit<LogEntry, "level" | "timestamp">): void;
  info(entry: Omit<LogEntry, "level" | "timestamp">): void;
  error(entry: Omit<LogEntry, "level" | "timestamp">): void;
}
```

**替换清单**:
- [ ] `console.error` in `maybeExtractMemories` → `logger.error({ traceId, component: "memory" })`
- [ ] 所有空 `catch {}` → `logger.debug({ err, line: lineNumber }, "skipped corrupt line")`
- [ ] `RunEvent` 自动携带 `traceId`，与日志关联

#### 3.2 OpenTelemetry Tracing（可选增强）

如果目标是**顶级大厂标准**（Google/Meta/ByteDance 级别），应接入 OTel：

```typescript
// 在 orchestrator 主循环中创建 span
const span = tracer.startSpan("agent.run", {
  attributes: {
    "agent.model": model.name,
    "agent.workspace": workspaceRoot,
  },
});

// 每个 tool call 创建 child span
const toolSpan = tracer.startSpan("tool.execute", {
  parent: span,
  attributes: {
    "tool.name": toolCall.name,
    "tool.approval_required": toolCall.requiresApproval,
  },
});
```

**投入产出评估**:
- **面试加分**: 高（展示对分布式追踪的理解）
- **实际收益**: 中（单进程应用，OTel 价值不如多服务架构大）
- **建议**: 如果时间充裕，接入轻量级 OTel SDK；如果时间紧张，用 `RunEvent` + `traceId` 模拟 tracing 语义。

#### 3.3 Metrics 与告警（生产级必备）

```typescript
// packages/core/src/metrics.ts
interface AgentMetrics {
  // Counter
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  toolCallsTotal: number;

  // Histogram
  modelLatencyMs: number[];
  toolLatencyMs: number[];
  tokenUsage: number[];

  // Gauge
  contextWindowUtilization: number; // 0-1
  compressionFrequency: number;     // 每 run 的压缩次数
}
```

**输出目标**:
- 本地开发: 写入 `.paw/metrics.json`，用命令行查看
- 生产环境: 通过 Prometheus `/metrics` endpoint 暴露

---

### 支柱 4：安全纵深防御（P1 — 3-5 天）

**问题**: 当前安全策略为黑名单模式（禁止已知危险命令），大厂标准通常是白名单 + 多层防御。

#### 4.1 Shell 守卫：黑名单 → 白名单

```typescript
// 当前（黑名单）— 面试够用，生产不足
const BLOCKED_PATTERNS = [/rm -rf /, /mkfs/, ...];

// 推荐（白名单）— 大厂标准
const ALLOWED_READONLY = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "git status",
  "git log", "git diff", "git show", "pwd", "echo", "wc",
]);

const ALLOWED_MUTATING = new Set([
  "git add", "git commit", "git checkout", "git branch",
  "git merge", "git rebase", "git stash", "git cherry-pick",
]);

function classifyShellCommand(command: string): "allowed_readonly" | "allowed_mutating" | "denied" {
  // 解析 command 的第一个 token
  const base = command.trim().split(/\s+/)[0];
  const prefix2 = command.trim().split(/\s+/).slice(0, 2).join(" ");

  if (ALLOWED_READONLY.has(base) || ALLOWED_READONLY.has(prefix2)) return "allowed_readonly";
  if (ALLOWED_MUTATING.has(prefix2)) return "allowed_mutating";
  return "denied"; // 默认拒绝
}
```

**为什么**: 黑名单无法穷尽所有攻击向量（如 `curl | bash`、编码绕过），白名单的「默认拒绝」策略是 Google SRE 安全规范的核心原则。

#### 4.2 MCP 安全配置校验

```typescript
// packages/harness/src/mcp-client.ts
const McpServerSchema = z.object({
  name: z.string().min(1).max(64),
  command: z.enum(["npx", "node", "bun"]), // 白名单
  args: z.array(z.string().regex(/^[a-zA-Z0-9@/-]+$/)), // 限制字符集
  env: z.record(z.string()).optional(),
});

function validateMcpConfig(config: unknown): McpServerConfig {
  return McpServerSchema.parse(config);
}
```

**为什么**: `settings.local.json` 被篡改后，MCP 配置可能成为任意代码执行通道。

#### 4.3 Secrets 管理与扫描

```bash
# 1. 添加 secrets 扫描到 CI
- run: bunx trufflehog git file://. --only-verified --fail

# 2. API Key 加密存储（可选）
# 使用系统 keychain 替代明文 JSON
```

#### 4.4 路径安全增强

当前已有 `checkWorkspacePath`，但缺少**运行时动态校验**：

```typescript
// 在 write_file / edit_file 执行前
function validateWritePath(path: string, workspaceRoot: string): void {
  const resolved = pathResolve(workspaceRoot, path);

  // 1. Workspace 逃逸检测
  if (!resolved.startsWith(workspaceRoot)) {
    throw new PawError("POLICY", "Path escapes workspace");
  }

  // 2. 敏感路径黑名单
  const SENSITIVE_PATHS = [
    ".env", ".ssh", ".git/config", ".git/hooks",
    "package-lock.json", "yarn.lock", "bun.lock",
  ];
  if (SENSITIVE_PATHS.some(p => resolved.includes(p))) {
    throw new PawError("POLICY", `Writing to ${path} is prohibited`);
  }

  // 3. 禁止写入到已存在但未被 agent 创建的文件（防覆盖）
  // 需要结合 checkpoint 系统判断是否首次写入
}
```

---

### 支柱 5：开发体验（DX）优化（P2 — 3-5 天）

#### 5.1 Runtime 版本锁定

```bash
# .nvmrc
22.0.0

# package.json
"packageManager": "bun@1.3.13"
```

**为什么**: 团队开发时，Bun 版本不一致会导致 `bun.lock` 格式差异和运行时行为不同。

#### 5.2 统一 Dev 命令

```json
// package.json
{
  "scripts": {
    "dev": "turbo run dev --parallel",
    "dev:cli": "cd apps/cli && bun run --watch src/main.ts",
    "dev:tui": "cd apps/tui && bun run --watch src/main.tsx",
  }
}
```

#### 5.3 Turborepo 构建管道（可选）

```json
// turbo.json
{
  "pipeline": {
    "typecheck": { "dependsOn": ["^typecheck"] },
    "test": { "dependsOn": ["typecheck"] },
    "lint": {},
    "dev": { "cache": false, "persistent": true }
  }
}
```

**评估**: Turborepo 对当前规模（8 packages）略有 over-engineering，但如果团队扩张到 15+ packages，构建缓存会显著加速 CI。

#### 5.4 IDE 配置

```json
// .vscode/settings.json
{
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "typescript.tsdk": "node_modules/typescript/lib",
  "biome.lspBin": "node_modules/@biomejs/biome/bin/biome"
}
```

---

### 支柱 6：测试体系强化（P2 — 1 周）

#### 6.1 覆盖率门禁

```bash
# bun test 原生支持 coverage
bun test --coverage

# 推荐阈值（逐步提升）
# 初始: 60% line coverage
# 目标: 80% line coverage
```

#### 6.2 故障注入测试

```typescript
// 测试磁盘满
const originalWrite = fs.writeFileSync;
fs.writeFileSync = () => { throw new Error("ENOSPC"); };
// 断言: agent 返回 failed，不崩溃

// 测试网络中断
server.close();
// 断言: 重试 3 次后 graceful fallback
```

#### 6.3 压力测试

```typescript
// 1000 轮对话，验证内存不泄漏
for (let i = 0; i < 1000; i++) {
  await orchestrator.run({ message: `turn ${i}` });
}
// 断言: heapUsed < 500MB
```

#### 6.4 测试数据工厂

```typescript
// packages/agent/test/factories.ts
export function createFakeRunOptions(overrides?: Partial<AgentOrchestratorOptions>): AgentOrchestratorOptions {
  return {
    model: new FakeLanguageModel(),
    workspaceRoot: "/tmp/test",
    systemPrompt: "test",
    ...overrides,
  };
}
```

---

### 支柱 7：文档与版本管理（P2 — 3-5 天）

#### 7.1 补齐核心文档

| 文档 | 内容 | 优先级 |
|------|------|--------|
| `ARCHITECTURE.md` | 系统架构图、包依赖图、数据流 | P1 |
| `CONTRIBUTING.md` | 开发环境 setup、PR 流程、commit 规范 | P1 |
| `docs/adr/` | 架构决策记录（6-8 个关键决策） | P2 |
| `CLAUDE.md` / `AGENTS.md` | AI 编码助手上下文 | P2 |

#### 7.2 Conventional Commits + Changesets

```bash
# 安装
bun add -d @changesets/cli
bunx changeset init
```

```json
// .changeset/config.json
{
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["@paw/*"]],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch"
}
```

**为什么**: Changesets 是 Vercel、Shopify 等大厂管理 Monorepo 版本的标准工具，能自动生成 CHANGELOG 和版本 bump PR。

#### 7.3 Commit Message 规范

```bash
# commitlint 配置
bun add -d @commitlint/config-conventional @commitlint/cli
```

```javascript
// commitlint.config.js
module.exports = { extends: ["@commitlint/config-conventional"] };
```

**格式**: `type(scope): subject`

| Type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `refactor` | 重构（不改变行为） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `docs` | 文档更新 |
| `chore` | 工程配置、依赖更新 |

**示例**: `feat(agent): add Phase Handler pattern for orchestrator`

---

## 三、实施路线图

### Phase 0: 止血（Week 0 — 2-3 天）

目标: 让 `bun run check:ts` 100% 通过，建立基线。

- [ ] 修复 `skills.ts:71` TS4104 编译错误
- [ ] 执行 `bun run lint:fix` 修复 179 errors
- [ ] 修复 `cost-tracker.test.ts` 货币符号断言
- [ ] 删除 `orchestrator.ts.bak`、`.current` 等临时文件
- [ ] 补全 `.gitignore`（`.DS_Store`, `*.log`, `dist/`, `.turbo/`）
- [ ] 添加 `packageManager` 和 `.nvmrc`

### Phase 1: 质量门禁（Week 1）

目标: 建立「代码不通过检查就不能合并」的文化。

- [ ] 配置 GitHub Actions CI（lint + typecheck + test）
- [ ] 配置 Husky + lint-staged pre-commit hooks
- [ ] 引入 commitlint（Conventional Commits）
- [ ] 配置 `.vscode/settings.json` 统一 IDE 行为

### Phase 2: 架构治理（Week 2-3）

目标: 消灭超大文件/函数，提升可维护性。

- [ ] Orchestrator Phase Handler 拆分（参照 UPGRADE_PLAN.md W1）
- [ ] 工具注册表重构（策略模式替代 god function）
- [ ] 添加 madge 循环依赖检测
- [ ] ContextManager `slice()` 优化 + 消息优先级
- [ ] 提取 `executeToolCalls()` 消除并行/单工具重复逻辑

### Phase 3: 可观测性（Week 3-4）

目标: 从「黑盒运行」变为「白盒可观测」。

- [ ] 实现 `StructuredLogger` 替代 `console.log`
- [ ] 替换所有空 `catch {}` 为结构化日志
- [ ] `RunEvent` 自动注入 `traceId`
- [ ] 实现 `AgentMetrics` 基础指标收集
- [ ] （可选）接入 OpenTelemetry SDK

### Phase 4: 安全加固（Week 4）

目标: 从「面试够用」到「生产可信赖」。

- [ ] Shell 守卫改为白名单策略
- [ ] MCP 配置 Zod Schema 校验
- [ ] 路径安全增强（敏感文件黑名单 + 防覆盖）
- [ ] CI 添加 secrets 扫描（truffleHog）
- [ ] 添加 `.editorconfig`

### Phase 5: 文档与版本（Week 5）

目标: 项目可交接、可协作。

- [ ] 编写 `ARCHITECTURE.md`
- [ ] 编写 `CONTRIBUTING.md`
- [ ] 创建 `docs/adr/` 目录，编写 6 个 ADR
- [ ] 配置 Changesets 版本管理
- [ ] 编写 `CLAUDE.md`（AI 助手上下文）

### Phase 6: 测试强化（持续）

目标: 质量可量化。

- [ ] 配置 `bun test --coverage` 并设定阈值
- [ ] 添加故障注入测试（磁盘满、网络断）
- [ ] 添加上下文压缩压力测试（1000 轮对话）
- [ ] 创建测试数据工厂（factories.ts）

---

## 四、预期收益

| 指标 | 当前 | 目标 |
|------|------|------|
| `check:ts` 通过率 | 部分失败 | **100%** |
| 单文件最大行数 | 1301 | **< 300** |
| 代码规范合规率 | ~50% | **> 95%** |
| CI 覆盖率 | 0% | **100% PR 触发** |
| 空 catch 块数量 | 10+ | **0** |
| 结构化日志覆盖率 | 0% | **100%** |
| 文档完整度 | 40% | **> 80%** |

---

## 五、不做的事（减法原则）

| 不做 | 原因 |
|------|------|
| Docker / K8s 部署 | 当前 CLI/TUI 工具，非服务端应用 |
| Web App 补全 | `apps/web/` 为远期规划，当前聚焦核心 Agent |
| 多用户并发 | 需要数据库和锁机制，超出当前骨架范围 |
| 语义搜索 / 向量索引 | P3 功能，面试不问 |
| IDE 插件 | 6 周内 ROI 过低 |

---

## 六、参考标准

本方案基于以下大厂工程实践：

- **Google**: [Software Engineering at Google](https://abseil.io/resources/swe-book) — 代码审查、测试文化、单一职责
- **Meta**: [Open Source Guidelines](https://opensource.fb.com/) — Monorepo 管理、Changesets
- **Vercel**: [Turborepo Best Practices](https://turbo.build/repo/docs) — 构建管道、远程缓存
- **Shopify**: [Internal Engineering Standards](https://shopify.engineering/) — 结构化日志、OTel
- **OpenTelemetry**: [OTel JS SDK](https://opentelemetry.io/docs/instrumentation/js/) — 分布式追踪

---

> **最后更新**: 2026-05-14
> 
> **下一步**: 请项目负责人审阅方案，确认优先级和取舍后，按 Phase 逐步实施。
