import path from "node:path";

/**
 * 把本机分隔符的路径转成 posix 形态。
 *
 * 这些字符串会直接出现在交给调用方与模型的 payload 里，因此只允许一种形态：
 * Windows 上的 `src\a.ts` 与 POSIX 上的 `src/a.ts` 必须是同一个字符串，
 * 否则同一份工作区在不同平台上会产出不同的展示、不同的匹配键。
 */
export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * 工作区相对路径（posix 形态）。
 *
 * 全包唯一的实现。此前 `files/read.ts` 内联了两份逐字节相同的副本
 * （检索路径与 glob 路径各一份），`symbol-search.ts` 又内联了第三份，
 * `code-index.ts` 则用本地 `normalizeRel` 做同一件事。四者必须给出一致结果 ——
 * `glob.test.ts` 断言 `"src/a.ts"`，`auto-context.test.ts` 断言
 * `"src/auth/login.ts"`，都依赖这里的约定。
 */
export function toWorkspaceRelPosix(workspaceRoot: string, fullPath: string): string {
  return toPosixPath(path.relative(workspaceRoot, fullPath));
}
