# Long-run harness（新建应用 · 多班次 · 桌面 E2E）

对齐 Anthropic [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)：  
**Initializer + Coding 多班次**，磁盘工件交接；**Playwright 真点桌面浏览器**做验收。

## 约定

| 工件 | 作用 |
|---|---|
| `app_spec.txt` | 产品说明 |
| `.paw/longrun-feature-ledger.json` | outer verifier 独占写入的权威状态 |
| `feature_list.json` | agent 可读的验收契约镜像；agent 不得修改 |
| `paw-progress.md` | 班次交班信 |
| `init.mjs` / `package.json` | 起开发服 |

外环（本目录 `run.ts`）负责：开班 → 跑 coding agent → **Playwright 复验** → 不通过则打回 `passes:false` → 直到清单清空或墙钟/班次耗尽。

Windows 上 Bun+Playwright 易卡 CDP，验收委派 `node run-e2e-node.mjs`；Vite/React 应用会先起 `npm run dev`，静态参考 App 则由 Node 自托管。

Agent 不得修改 `feature_list.json`，也不要在前台挂起 `npm run dev`；UI 验收与 pass/fail 写入均由 harness 负责。Agent 对 ledger 的修改只会被审计，随后由 canonical ledger 覆盖。

Canonical ledger 使用版本化 envelope（schema/version/SHA-256），以同目录临时文件 `fsync + rename` 原子替换；上一次有效文件保留为 `.backup.json`。主文件截断或哈希不匹配时自动恢复 backup，主备同时损坏才硬失败。

## 命令

```bash
# 安装浏览器（首次）
bun add -d playwright
bunx playwright install chromium

# Windows 上 Bun+Playwright 易卡 CDP；验收器会委派 `node run-e2e-node.mjs`
# 也可直接：
#   node benchmarks/longrun-harness/run-e2e-node.mjs <workspace>

# 不调模型：灌入参考 App，只跑桌面 E2E（验证验收器）
bun run benchmarks/longrun-harness/run.ts --preset todo-mini --seed-reference --verify-only

# 短冒烟：最多 2 班、10 分钟墙钟（会调模型）
bun run benchmarks/longrun-harness/run.ts --preset todo-mini --max-sessions 2 --max-wall-ms 600000

# 连续 2 班无产品树变化、且目标 E2E 仍失败时换题（默认值）
bun run benchmarks/longrun-harness/run.ts --preset todo-mini --max-no-progress-sessions 2

# 长跑（默认最多 24 班 / 4 小时）
bun run benchmarks/longrun-harness/run.ts --preset todo-mini

# 有头模式看浏览器
bun run benchmarks/longrun-harness/run.ts --preset todo-mini --seed-reference --verify-only --headed
```

工作区默认：`benchmarks/longrun-harness/.workspace/todo-mini/`（已 gitignore）。

## Preset：todo-mini

12 个带 `e2e.actions` 的功能（data-testid 契约）。Agent 实现 Vite/React（或等价）SPA，harness 用 Chromium 点真实 UI。

## 与日常 coding 模式

每班调用 `runStubRun(..., { collaborationMode: "coding" })`，沿用单人长跑 + TaskLifecycle；**几小时**靠外环多班次，不靠单次 maxSteps。
