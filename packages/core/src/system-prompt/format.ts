/**
 * 系统提示词格式化工具（System Prompt Formatter）——提供构建结构化提示词的底层辅助函数。
 *
 * ## 模块职责（架构定位）
 * 本模块是系统提示词构建流程中最底层的文本格式化层。它向上层（`system-prompt.ts` 的
 * `buildSystemPrompt` 和 `buildSystemPromptWithBudget`）提供一组简洁、可组合的纯函数，
 * 用于生成格式一致的提示词片段。
 *
 * 这些函数本身不包含任何业务逻辑——它们只是定义了 paw-ts 系统提示词的"视觉语法"：
 * - 章节以 `# heading` 开头
 * - 列表项以 `- item` 开头
 * - 截断文本末尾添加 `...(truncated)` 标记
 *
 * ## 为什么需要这个模块
 * 1. **格式一致性**：所有系统提示词章节使用相同的标题级别和列表样式，
 *    让 LLM 更容易解析和理解提示词的结构层次。
 * 2. **组合性**：`sectionBullets` 由 `section` 和 `bullets` 组合而成，
 *    展示了函数式组合的设计理念。
 * 3. **防御性编程**：`bullets` 函数自动过滤 `null`、`false` 等假值项，
 *    调用方可以安全地通过条件表达式（如 `condition ? "text" : null`）控制列表项的出现。
 *
 * ## 使用场景
 * 这些函数在 `buildSystemPrompt` 中被大量使用，例如：
 * ```typescript
 * section("当前任务", taskDescription)
 * sectionBullets("可用工具", tools.map(t => t.name))
 * truncateChars(longOutput, 500)
 * ```
 */

/**
 * 按字符数截断文本，超出部分用截断标记替换。
 *
 * 截断策略：保留前 (maxChars - 20) 个字符，末尾追加 `\n...(truncated)`。
 * 预留 20 个字符用于截断标记，确保截断后的总长度不超过 maxChars。
 *
 * 使用场景：限制工具输出、错误日志等可能非常长的文本在提示词中占用的空间，
 * 避免撑爆上下文窗口。
 *
 * @param text - 原始文本
 * @param maxChars - 最大允许的字符数（包括截断标记）
 * @returns 截断后的文本（如果未超出限制则返回原文）
 */
export function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // 预留 20 个字符给截断标记 "...(truncated)"
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n...(truncated)`;
}

/**
 * 将字符串数组格式化为 markdown 无序列表（每项以 `- ` 开头）。
 *
 * 防御性过滤：自动过滤掉值为 `null`、`false`、`undefined` 的项，
 * 只保留真正的字符串。这允许调用方使用条件表达式控制列表项：
 * ```typescript
 * bullets([
 *   "始终可见的项",
 *   condition && "条件满足时才出现的项",  // false 时自动被过滤
 * ])
 * ```
 *
 * @param items - 字符串、null 或 false 组成的只读数组
 * @returns 换行分隔的 markdown 无序列表字符串
 */
export function bullets(items: readonly (string | null | false)[]): string {
  return items
    .filter((x): x is string => typeof x === "string")  // 类型守卫：过滤后 items 类型收窄为 string[]
    .map((s) => `- ${s}`)
    .join("\n");
}

/**
 * 生成 markdown 章节（一级标题 + 空行 + 内容）。
 *
 * 输出格式：
 * ```
 * # 标题
 *
 * 内容
 * ```
 *
 * @param heading - 章节标题（不含 # 前缀）
 * @param body - 章节正文内容
 * @returns 完整的 markdown 章节字符串
 */
export function section(heading: string, body: string): string {
  return `# ${heading}\n\n${body}`;
}

/**
 * 生成"标题 + 无序列表"格式的章节（`section` 和 `bullets` 的组合）。
 *
 * 输出格式：
 * ```
 * # 标题
 *
 * - 项目1
 * - 项目2
 * ```
 *
 * 这是构建提示词中最常见的章节模式（如工具列表、规则清单等），
 * 将其封装为独立函数减少了上层代码的重复。
 *
 * @param heading - 章节标题
 * @param items - 列表项数组（自动过滤 null/false）
 * @returns 完整的 markdown 章节字符串
 */
export function sectionBullets(
  heading: string,
  items: readonly (string | null | false)[],
): string {
  return section(heading, bullets(items));
}
