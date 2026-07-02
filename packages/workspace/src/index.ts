/**
 * index.ts — Paw Workspace 包的总入口（Barrel Export）
 *
 * 【是什么】
 * 作为 workspace 包的公共 API 边界，集中 re-export 所有子模块的导出。
 * 外部使用者只需 `import { ... } from "@paw/workspace"` 即可获取所有公共
 * 类型和函数。
 *
 * 【为什么需要】
 * Barrel export 模式（桶式导出）让包的使用者不需要知道内部文件组织结构。
 * 所有公共接口在一个文件中声明，当内部模块重构时，只需要修改这个文件的
 * re-export 路径，而不影响所有消费方。
 *
 * 【关键设计决策】
 * 1. 按功能模块分组：每个 re-export 块对应一个源文件，用注释分隔，清晰直观。
 * 2. 类型与值混合导出：使用 `export { type X, Y }` 的语法，类型导出使用
 *    `type` 关键字（编译后会被擦除），值导出正常保留。
 * 3. 粒度控制：只导出公共 API，不导出内部实现细节（如 interface LspMessage、
 *    function stripHtml 等内部函数不会出现在这里）。
 */

// ---- 路径安全 ----
export {
  checkWorkspacePath,
  isPathInsideRoot,
  SENSITIVE_PATH_SEGMENTS,
  type PathDecision,
  type PathRisk,
} from "./path-guard.js";

// ---- 本地文件操作（只读）----
export {
  globWorkspaceFiles,
  grepWorkspaceText,
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceText,
  type GlobResult,
  type GrepMatch,
  type GrepResult,
  type ListFilesResult,
  type ReadFileResult,
  type SearchMatch,
  type SearchTextResult,
} from "./files/read.js";

// ---- 本地文件操作（写入）----
export {
  editWorkspaceFile,
  writeWorkspaceFile,
  type EditFileResult,
  type WriteFileResult,
} from "./files/write.js";

// ---- 网络工具（网页抓取 & 搜索） ----
export {
  fetchWebPage,
  searchWeb,
  type WebFetchOptions,
  type WebFetchResult,
  type WebSearchOptions,
  type WebSearchResult,
} from "./network-tools.js";

// ---- Jupyter Notebook 编辑 ----
export {
  editNotebook,
  type NotebookEditOptions,
  type NotebookEditResult,
} from "./notebook-tools.js";

// ---- 项目上下文（概览 + 自动发现）----
export {
  generateBrief,
  discoverContext,
  type BriefOptions,
  type BriefResult,
  type AutoContextResult,
} from "./project-context.js";

// ---- Git 操作 ----
export {
  gitCommit,
  gitDiff,
  gitLog,
  gitStatus,
  type GitCommitResult,
  type GitDiffResult,
  type GitLogResult,
  type GitStatusResult,
} from "./git-tools.js";

// ---- LSP 客户端（语言服务器协议） ----
export {
  LspClient,
  detectLspCommand,
  type LspCompletionItem,
  type LspHoverResult,
  type LspLocation,
} from "./lsp-client.js";

// ---- @ 提及解析 ----
export {
  extractAtMentions,
  resolveMentions,
  stripAtMentions,
  type MentionResult,
} from "./mention-resolver.js";

// ---- paw.md 项目指令文件 ----
export {
  loadPawMd,
  type PawMdResult,
} from "./paw-md.js";

// ---- Patch 补丁应用 ----
export {
  applyWorkspacePatch,
  type PatchFileResult,
  type PatchResult,
} from "./patch-tools.js";

// ---- 文件监听 ----
export { WorkspaceWatcher } from "./watch.js";

// ---- 符号搜索（AST 级别） ----
export {
  searchWorkspaceSymbols,
  type SymbolInfo,
  type SymbolSearchResponse,
  type SymbolSearchResult,
} from "./symbol-search.js";

// ---- CLI 参数解析 — 从 cli-core 移入 ----
export {
  parseRootFromArgv,
  tailPositionalArgs,
} from "./root.js";

// ---- Git worktree 隔离 — 从 cli-core 移入 ----
export {
  createTemporaryWorktree,
  findGitRoot,
  type TemporaryWorktree,
} from "./worktree.js";
