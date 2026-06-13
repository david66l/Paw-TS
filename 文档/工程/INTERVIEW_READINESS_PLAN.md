# Paw-TS 大厂面试就绪计划

> 目标：把项目从「架构能讲」升级到「CI 全绿、测试可信、效果可量化、对外可审」。
> 每步完成后运行验证命令，通过才进入下一步。

---

## Phase 1：工程门禁（P0）

| # | 子任务 | 验证标准 | 状态 |
|---|--------|----------|------|
| 1.1 | 修复 Biome format/import 错误（4 errors） | `bun run lint` exit 0 | ✅ |
| 1.2 | 修复/隔离不稳定测试（Ollama E2E、Watcher 超时、测试污染） | `bun test packages apps` 0 fail | ✅ |
| 1.3 | 添加 GitHub Actions CI | `.github/workflows/ci.yml` 存在；本地 `check:ts` 绿 | ✅ |
| 1.4 | **Phase 1 总验** | `bun run check:ts` 全绿 | ✅ |

## Phase 2：代码与叙事对齐（P0）

| # | 子任务 | 验证标准 | 状态 |
|---|--------|----------|------|
| 2.1 | 将 Ollama E2E 改为环境变量门控 | 无 Ollama 时 skip，不 fail | ✅ |
| 2.2 | MemoryExtraction：接入 orchestrator 或文档标注未接线 | 代码或 README 诚实一致 | ✅ |
| 2.3 | 更新根 README（架构摘要 + 快速开始 + check 命令） | README 可对外展示 | ✅ |

## Phase 3：可量化评测（P1）

| # | 子任务 | 验证标准 | 状态 |
|---|--------|----------|------|
| 3.1 | 上下文压缩 benchmark 脚本 + 结果样例 | `bun run benchmark:compression` 可运行 | ✅ |
| 3.2 | 记忆检索 benchmark（扩展 analyze 脚本） | 输出 recall@5 等指标 | ✅ |
| 3.3 | README 增加 Benchmark 结果表 | 有数字可引用 | ✅ |

## Phase 4：对外文档（P1）

| # | 子任务 | 验证标准 | 状态 |
|---|--------|----------|------|
| 4.1 | 添加 `ARCHITECTURE.md`（精简版，链到 Obsidian 详版） | 文件存在、路径正确 | ✅ |
| 4.2 | 添加 1 篇 ADR（三层上下文压缩决策） | `文档/架构决策/001-context-compression.md` | ✅ |

## Phase 5：仓库卫生（P2，可选）

| # | 子任务 | 验证标准 | 状态 |
|---|--------|----------|------|
| 5.1 | 扩展 `.gitignore`（面试笔记、temp 项目） | git status 更干净 | ✅ |
| 5.2 | Golden Path Demo 脚本或文档 | `文档/演示/GOLDEN_PATH.md` | ✅ |

---

## 统一验证命令

```bash
cd paw-ts
bun run lint          # 0 errors
bun run typecheck     # 0 errors
bun test packages apps  # 0 fail
bun run check:ts      # 以上全部
```
