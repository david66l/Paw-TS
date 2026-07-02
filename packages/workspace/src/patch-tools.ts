/**
 * patch-tools.ts — 统一 diff 补丁应用工具
 *
 * 【是什么】
 * 将 unified diff 格式的 patch 文本应用到工作区的多个文件中。
 * 使用 `diff` 库（npm 包）解析和应用补丁，支持多文件 patch 的一次性批量应用。
 *
 * 【为什么需要】
 * AI Agent 经常需要批量修改代码。与其逐个文件进行 read→edit→write 的多次
 * 往返，不如让 Agent 生成标准的 unified diff patch，一次性应用到多个文件。
 * 这大幅减少了工具调用次数和 token 消耗。
 *
 * 【关键设计决策】
 * 1. 事务性操作（All or Nothing）：所有 patch 先验证再应用。如果任何一个
 *    patch 应用失败（不干净），已应用的修改会被回滚（rollback）。这保证
 *    了工作区的状态一致性——不会出现"部分文件已修改、部分失败"的中间态。
 *
 * 2. 三阶段处理：
 *    Phase 1: 解析路径 → 从 patch 头中提取目标文件路径，剥离 git 风格
 *             的 a/ b/ 前缀，并通过 checkWorkspacePath 做路径安全检查。
 *    Phase 2: 读取原始内容 → 保存每个文件的原始内容到 Map，用于回滚。
 *    Phase 3: 验证并应用 → 对每个文件调用 diff 库的 applyPatch，
 *              成功则写入新内容，失败则回滚所有已修改的文件。
 *
 * 3. 路径前缀剥离：Git 生成的 diff 通常以 a/path 和 b/path 为前缀，
 *    需要剥离后才能匹配实际文件系统路径。
 *
 * 4. 创建新文件：diff 的 isCreate 标志表示这是一个新建文件的操作，
 *    此时不要求原始文件存在。
 *
 * 5. 行尾自动转换：autoConvertLineEndings: true 确保跨平台兼容。
 */

import fs from "node:fs";

import { applyPatch, parsePatch } from "diff";

import { checkWorkspacePath } from "./path-guard.js";

/** 单个文件的 patch 应用结果 */
export interface PatchFileResult {
  /** 文件路径（相对于工作区） */
  readonly path: string;
  /** 是否应用成功 */
  readonly ok: boolean;
  /** 新增行数（成功时） */
  readonly linesAdded?: number;
  /** 删除行数（成功时） */
  readonly linesRemoved?: number;
  /** 错误信息（失败时） */
  readonly error?: string;
}

/** 整个 patch 操作的汇总结果 */
export interface PatchResult {
  /** 整体是否成功 */
  readonly ok: boolean;
  /** 每个文件的详细结果 */
  readonly results: readonly PatchFileResult[];
  /** 人类可读的摘要信息 */
  readonly summary: string;
}

/**
 * 统计一个 patch 中所有 hunk 的新增和删除行数。
 *
 * diff 的行前缀约定：
 * - "+" 开头 → 新增行
 * - "-" 开头 → 删除行
 */
function countLinesChanged(patch: ReturnType<typeof parsePatch>[number]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/**
 * 将 unified diff 格式的 patch 文本应用到工作区文件。
 *
 * 处理流程（三阶段事务）：
 * Phase 1: 解析 patch 头部，提取目标文件路径，做路径安全检查
 * Phase 2: 读取所有目标文件的原始内容（用于回滚）
 * Phase 3: 逐个应用 patch，成功则写入；失败则回滚所有已写入的文件
 *
 * @param workspaceRoot 工作区根目录绝对路径
 * @param patchText unified diff 格式的补丁文本（可包含多个文件的修改）
 * @returns 汇总结果，包含每个文件的状态和整体统计
 */
export function applyWorkspacePatch(
  workspaceRoot: string,
  patchText: string,
): PatchResult {
  if (!patchText.trim()) {
    return { ok: false, results: [], summary: "apply_patch: empty patch" };
  }

  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(patchText);
  } catch {
    return {
      ok: false,
      results: [],
      summary: "apply_patch: failed to parse patch",
    };
  }

  if (patches.length === 0) {
    return { ok: false, results: [], summary: "apply_patch: no patches found" };
  }

  // Phase 1: 解析目标路径，剥离 a/ b/ 前缀，验证工作区范围
  const targets: Array<{
    patch: (typeof patches)[number];
    relPath: string;
    resolvedPath: string;
  }> = [];

  for (const patch of patches) {
    // Git 风格的 diff 通常以 a/ 或 b/ 为前缀，这里剥离
    const rawPath = patch.newFileName ?? patch.oldFileName ?? "";
    if (!rawPath) {
      return {
        ok: false,
        results: [],
        summary: "apply_patch: patch missing file name",
      };
    }

    const relPath = rawPath.replace(/^(a|b)\//, "");
    const guard = checkWorkspacePath(workspaceRoot, relPath);
    if (!guard.allowed) {
      return {
        ok: false,
        results: [],
        summary: `apply_patch: ${guard.reason}`,
      };
    }
    targets.push({ patch, relPath, resolvedPath: guard.resolvedPath });
  }

  // Phase 2: 读取所有目标文件的原始内容（用于回滚）
  const originals = new Map<string, string>();
  for (const t of targets) {
    try {
      if (
        fs.existsSync(t.resolvedPath) &&
        fs.statSync(t.resolvedPath).isFile()
      ) {
        originals.set(t.resolvedPath, fs.readFileSync(t.resolvedPath, "utf8"));
      } else if (t.patch.isCreate !== true) {
        // 文件不存在且不是创建操作 → 报错
        return {
          ok: false,
          results: [],
          summary: `apply_patch: file not found: ${t.relPath}`,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        results: [],
        summary: `apply_patch: read error on ${t.relPath}: ${msg}`,
      };
    }
  }

  // Phase 3: 验证并应用所有 patch
  const results: PatchFileResult[] = [];

  for (const t of targets) {
    const original = originals.get(t.resolvedPath) ?? "";
    const patched = applyPatch(original, t.patch, {
      autoConvertLineEndings: true,
    });

    if (patched === false) {
      // patch 应用失败 → 回滚所有已修改的文件
      for (const r of results) {
        if (r.ok) {
          const rp = targets.find((tt) => tt.relPath === r.path)?.resolvedPath;
          if (rp) {
            const orig = originals.get(rp);
            if (orig !== undefined) {
              fs.writeFileSync(rp, orig, "utf8");
            }
          }
        }
      }
      return {
        ok: false,
        results: [
          ...results,
          {
            path: t.relPath,
            ok: false,
            error: "patch does not apply cleanly",
          },
        ],
        summary: `apply_patch: failed on ${t.relPath}`,
      };
    }

    // patch 应用成功 → 写入新内容
    try {
      fs.writeFileSync(t.resolvedPath, patched, "utf8");
      const counts = countLinesChanged(t.patch);
      results.push({
        path: t.relPath,
        ok: true,
        linesAdded: counts.added,
        linesRemoved: counts.removed,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 写入失败时也要回滚
      for (const r of results) {
        if (r.ok) {
          const rp = targets.find((tt) => tt.relPath === r.path)?.resolvedPath;
          if (rp) {
            const orig = originals.get(rp);
            if (orig !== undefined) {
              fs.writeFileSync(rp, orig, "utf8");
            }
          }
        }
      }
      return {
        ok: false,
        results: [...results, { path: t.relPath, ok: false, error: msg }],
        summary: `apply_patch: write error on ${t.relPath}: ${msg}`,
      };
    }
  }

  // 汇总统计
  const okCount = results.filter((r) => r.ok).length;
  const totalAdded = results.reduce((s, r) => s + (r.linesAdded ?? 0), 0);
  const totalRemoved = results.reduce((s, r) => s + (r.linesRemoved ?? 0), 0);
  const summary = `apply_patch: ${okCount}/${results.length} file(s) edited (+${totalAdded}/-${totalRemoved})`;

  return { ok: true, results, summary };
}
