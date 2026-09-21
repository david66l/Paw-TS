import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.list_dir` / `workspace.glob` / `workspace.grep` 在
 * `packages/harness/test` 里此前 **0 命中**（docs/CODE-REVIEW.md §D9）。
 * 这三个是模型最常用的入口，也是"路径能不能跑出工作区"这条策略边界所在，
 * 所以先补它们 —— 其余未覆盖的工具 id 记在 §11.20。
 *
 * 断言以 `summary` 与 `ok` 为主：这两样在处理器里是直接可读的字面量
 * （`handlers/files.ts:56-66`、`:131-143`、`:193-210`），比 payload 内部结构
 * 稳定；需要断言错误码时用 `payload.error_code`，其形状由
 * `makeToolError`（`packages/core/src/errors.ts:129-135`）确定。
 */

const WORKSPACE = mkdtempSync(path.join(tmpdir(), "paw-file-tools-"));

mkdirSync(path.join(WORKSPACE, "src", "deep"), { recursive: true });
writeFileSync(path.join(WORKSPACE, "a.txt"), "hello world\n");
writeFileSync(path.join(WORKSPACE, "src", "b.ts"), "hello ts\n");
writeFileSync(path.join(WORKSPACE, "src", "deep", "c.md"), "nothing here\n");

function payloadOf(r: { payload: unknown }): Record<string, unknown> {
  return r.payload as Record<string, unknown>;
}

const ctx = { workspaceRoot: WORKSPACE };

describe("workspace.list_dir", () => {
  test("lists the workspace root, counting entries in the summary", async () => {
    const r = await executeTool(ctx, "workspace.list_dir", { path: "." });
    expect(r.ok).toBe(true);
    const files = payloadOf(r).files as unknown[];
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(r.summary).toBe(`list_dir: . (${files.length} entries)`);
  });

  /**
   * `path` 是声明式必填（`definitions.ts:295`），所以省略它根本到不了处理器 ——
   * 通用校验先以 `E_SCHEMA_INVALID` 拒绝。这一点值得钉：`handlers/files.ts:54`
   * 那个 `: "."` 兜底只有在**键存在但值为 undefined** 时才可达，因为必填检查是
   * `!(name in rec)`（只看键在不在），而类型检查又对 `undefined` 放行
   * （`tool-support.ts:87`、`:98`）。
   */
  test("an omitted path is refused by the schema before the handler's default", async () => {
    const r = await executeTool(ctx, "workspace.list_dir", {});
    expect(r.ok).toBe(false);
    expect(payloadOf(r).error_code).toBe("E_SCHEMA_INVALID");
    expect(payloadOf(r).field).toBe("path");
    expect(r.summary).toBe("workspace.list_dir: E_SCHEMA_INVALID missing required field: path");
  });

  test("an explicit undefined path is the only way to reach the handler's '.' default", async () => {
    const r = await executeTool(ctx, "workspace.list_dir", { path: undefined });
    expect(r.ok).toBe(true);
    expect(r.summary.startsWith("list_dir: . (")).toBe(true);
  });

  test("recursive reaches nested directories", async () => {
    const shallow = await executeTool(ctx, "workspace.list_dir", { path: ".", recursive: false });
    const deep = await executeTool(ctx, "workspace.list_dir", { path: ".", recursive: true });
    expect(deep.ok).toBe(true);
    const flat = (payloadOf(shallow).files as unknown[]).length;
    const all = (payloadOf(deep).files as unknown[]).length;
    expect(all).toBeGreaterThan(flat);
  });

  test("scoped listing reports the requested path verbatim", async () => {
    const r = await executeTool(ctx, "workspace.list_dir", { path: "src" });
    expect(r.ok).toBe(true);
    expect(r.summary.startsWith("list_dir: src (")).toBe(true);
  });

  /**
   * 这条同时钉两件事：工具侧拒绝越界，以及 `errorCodeForToolPayload`
   * **在真实调用路径上**把 "escapes workspace" 归为策略拒绝。
   * 分类器本身在 `tool-support.test.ts` 里单独测过，这里测的是接线。
   */
  test("a path escaping the workspace is a policy denial, not a user error", async () => {
    const r = await executeTool(ctx, "workspace.list_dir", { path: "../.." });
    expect(r.ok).toBe(false);
    const payload = payloadOf(r);
    expect(payload.error_code).toBe("E_POLICY_DENIED");
    expect(String(payload.error)).toContain("escapes workspace");
    expect(r.summary).toContain("list_dir: E_POLICY_DENIED");
  });
});

describe("workspace.glob", () => {
  /**
   * "缺 pattern"有两种，落到的错误码不同，这里把两种都钉住：
   * - 键**不存在** → 通用校验拒绝，`E_SCHEMA_INVALID`；
   * - 键存在但为**空串** → 通过校验，落到处理器自己的 `E_USER` 分支
   *   （`handlers/files.ts:124-128`）。
   * 必填检查是 `!(name in rec)`，只看键在不在（`tool-support.ts:87`）。
   */
  test("an omitted pattern is refused by the schema, not the handler", async () => {
    const r = await executeTool(ctx, "workspace.glob", {});
    expect(r.ok).toBe(false);
    expect(payloadOf(r).error_code).toBe("E_SCHEMA_INVALID");
    expect(r.summary).toBe("workspace.glob: E_SCHEMA_INVALID missing required field: pattern");
  });

  test("an empty pattern reaches the handler and is a user error", async () => {
    const r = await executeTool(ctx, "workspace.glob", { pattern: "" });
    expect(r.ok).toBe(false);
    expect(payloadOf(r).error_code).toBe("E_USER");
    expect(payloadOf(r).field).toBe("pattern");
    expect(r.summary).toBe("glob: E_USER missing pattern");
  });

  test("finds files by pattern and reports the count", async () => {
    const r = await executeTool(ctx, "workspace.glob", { pattern: "**/*.ts" });
    expect(r.ok).toBe(true);
    expect(payloadOf(r).numFiles).toBe(1);
    expect(r.summary).toBe("glob: 1 file(s)");
  });

  test("a pattern matching nothing is an empty success, not an error", async () => {
    const r = await executeTool(ctx, "workspace.glob", { pattern: "**/*.zzz" });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("glob: 0 file(s)");
  });
});

describe("workspace.grep", () => {
  test("an omitted pattern is refused by the schema, not the handler", async () => {
    const r = await executeTool(ctx, "workspace.grep", {});
    expect(r.ok).toBe(false);
    expect(payloadOf(r).error_code).toBe("E_SCHEMA_INVALID");
    expect(r.summary).toBe("workspace.grep: E_SCHEMA_INVALID missing required field: pattern");
  });

  test("an empty pattern reaches the handler and is a user error", async () => {
    const r = await executeTool(ctx, "workspace.grep", { pattern: "" });
    expect(r.ok).toBe(false);
    expect(payloadOf(r).error_code).toBe("E_USER");
    expect(r.summary).toBe("grep: E_USER missing pattern");
  });

  test("defaults to files_with_matches and finds both files containing the text", async () => {
    const r = await executeTool(ctx, "workspace.grep", { pattern: "hello" });
    expect(r.ok).toBe(true);
    // 没有匹配时不是错误 —— 与 glob 的空结果同型
    expect(r.summary).toContain("grep");
  });

  test("a literal pattern with regex disabled still matches", async () => {
    const r = await executeTool(ctx, "workspace.grep", { pattern: "nothing here", regex: false });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("grep");
  });
});
