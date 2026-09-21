# legacy/ — 已归档的 CLI / TUI 代码

这里存放**只有 CLI 和 TUI 会用到**的代码。桌面端（`apps/desktop`）不依赖本目录下的任何内容；
`legacy/` 也**不在** `package.json` 的 `workspaces` 里，不参与 `typecheck` / `test:ts` / `lint`。

归档的目的是保留历史实现供查阅，而不是继续维护。目录内的 `@paw/*` 包名引用只有在把
`legacy/*` 重新加回 workspace 后才会解析。

## 内容

| 路径 | 原位置 | 说明 |
| --- | --- | --- |
| `apps/cli/` | `apps/cli` | 原 CLI 应用。`src/main.ts` 是 `paw-ts` 命令入口；`src/paw-next/{startup-cli*,legacy-run-*,new-work-cli-v3}.ts` 是 CLI 专属的启动/恢复编排。其余 `test/` 为原 CLI 测试套件。 |
| `apps/tui/` | `apps/tui` | 原 OpenTUI + SolidJS 终端界面，整体归档。 |
| `packages/eval/` | `packages/eval` | 评测系统（SWE-bench / swe-compare / 记忆基准）。只被 CLI 的 `eval` 子命令与部分 benchmark 使用。 |
| `benchmarks/desktop-harness-ab/` | `benchmarks/desktop-harness-ab` | 桌面 harness A/B 实验台。依赖被迁走的 `paw-next` 源码路径，因此随之一并归档。`.runs/` 是本地录制产物（未纳入 git）。 |
| `benchmarks/longrun-probe/` | `benchmarks/longrun-probe` | 直接 import `packages/eval` 的长跑探针。 |

## 没有归档的东西

`apps/cli/src/paw-next/` 里**桌面端真正需要**的共享 Paw Next V3 组装入口没有被归档，而是提升为
独立包 **`packages/paw-next`（`@paw/paw-next`）**。它没有 CLI 启动副作用，桌面端通过
`@paw/paw-next` 引用（原先的 `@paw/cli/paw-next` 子路径导出已废弃）。

`apps/cli/test/` 中被归档的测试如果 import 了共享模块，路径已重写为指向
`packages/paw-next/src/*`，以便把 legacy 重新接回 workspace 时仍然可读。

## 若要重新启用

1. 在根 `package.json` 的 `workspaces` 里加上 `"legacy/packages/*"`、`"legacy/apps/*"`、`"legacy/benchmarks/*"`。
2. 运行 `bun install` 建立 workspace 链接。
3. 补回根脚本：`typecheck:cli`、`typecheck:tui`、`typecheck:eval`、`cli`、`tui`、`tui:e2e`。
4. `legacy/apps/tui` 还需要 `@opentui/*` 与 `solid-js`，`legacy/apps/cli` 需要 `playwright`。
