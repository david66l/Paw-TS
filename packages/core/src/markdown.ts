/**
 * markdown — 轻量级 Markdown 解析与序列化工具
 *
 * 【模块职责】
 * 为 paw-ts 的 memory、skills、compression 等模块提供统一的 Markdown 文本
 * 操作能力，包括：
 * - YAML frontmatter 的解析与序列化
 * - `## 标题` 样式 Markdown 段落的分段解析
 *
 * 【为什么需要这个模块】
 * paw-ts 的内部文件（如 memory 条目、skill 定义文件）大量使用 Markdown +
 * YAML frontmatter 格式存储元数据和内容。需要一套轻量、一致的工具函数来
 * 读写这些格式，避免各模块各自实现正则匹配逻辑。
 *
 * 【设计决策】
 * - 刻意保持轻量：不做完整的 YAML/Markdown 解析器
 * - 只支持 `key: value` 简单 YAML（不支持嵌套、数组、引号转义）
 * - 只解析 `## 二级标题` 段落（与 paw-ts 内部约定一致）
 * - 刻意与完整的 YAML/Markdown 解析器保持距离：引入完整解析器反而
 *   会引入兼容性问题（注释、多行字符串等），而 paw-ts 不需要这些
 *
 * Shared markdown helpers used by memory, skills, and compression modules.
 *
 * Intentionally lightweight: these are not full YAML/markdown parsers,
 * but they match the simple `key: value` frontmatter and `## Section`
 * conventions used throughout paw-ts.
 */

/**
 * frontmatter 分离结果
 *
 * 包含 YAML frontmatter 正文和 Markdown 正文两部分。
 */
export interface SplitFrontmatterResult {
  /** YAML frontmatter 部分（不含 --- 分隔符） */
  readonly frontmatter: string;
  /** Markdown 正文部分 */
  readonly body: string;
}

/**
 * frontmatter 正则：
 * 匹配以 --- 开头、--- 结尾的 YAML frontmatter 块，
 * 以及其后的全部 Markdown 正文（$ 锚定到末尾）。
 *
 * 分组说明：
 *   [1] = frontmatter 内容（不含 ---）
 *   [2] = Markdown 正文
 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * 将原始 Markdown 文本拆分为 frontmatter 和正文
 *
 * @param text - 原始 Markdown 文本
 * @returns 拆分结果，如果文本不包含 frontmatter 则返回 null
 *
 * Split raw markdown into frontmatter body and the rest, or null if no frontmatter.
 */
export function splitFrontmatter(text: string): SplitFrontmatterResult | null {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return null;
  return { frontmatter: match[1]!, body: match[2]! };
}

/**
 * 解析简单的 `key: value` 格式 YAML frontmatter 为键值对记录
 *
 * 注意：这是一个极简解析器，不支持：
 * - 嵌套结构
 * - 数组（YAML 的 - 语法）
 * - 引号包裹的值（引号会被原样保留在值中）
 * - 多行字符串
 *
 * @param text - YAML frontmatter 文本（不含 --- 分隔符）
 * @returns 键值对记录
 *
 * Parse simple `key: value` frontmatter lines into a record.
 */
export function parseYamlFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (const line of lines) {
    // 匹配 "key: value" 格式，冒号前为键、后为值
    const m = line.match(/^([^:]+):\s*(.*)$/);
    // 需要 key 和 value 都非空时才记录（m[2] 可能为空字符串）
    if (m?.[1] && m[2]) {
      result[m[1].trim()] = m[2].trim();
    }
  }
  return result;
}

/**
 * 将键值对记录渲染为 YAML frontmatter 块（包含 --- 包裹）
 *
 * @param data - 键值对数据
 * @returns 完整的 frontmatter 文本（含 --- 分隔符）
 *
 * Render a simple `key: value` frontmatter block wrapped in `---`.
 */
export function stringifyYamlFrontmatter(
  data: Record<string, string>,
): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return ["---", ...lines, "---"].join("\n");
}

/**
 * 解析 `## 标题` 样式的 Markdown 段落
 *
 * 将文本按 ## 二级标题分段，返回以"标题（小写）"为键、"段落正文"为值的映射。
 * 仅识别 ## 开头的行作为分段标记，正文中嵌套的 #/### 不会被识别。
 *
 * @param text - Markdown 文本（不含 frontmatter）
 * @returns 以标题为键、段落正文为值的记录
 *
 * Parse `## Heading` sections into a lower-cased map of heading -> body.
 */
export function parseMarkdownSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = text.split("\n");
  let currentHeading: string | null = null;
  // 累积当前段落的各行文本
  const currentLines: string[] = [];

  for (const line of lines) {
    // 匹配 ## 开头的行作为段落标题
    const headingMatch = line.match(/^##\s+(.+)$/i);
    if (headingMatch) {
      // 遇到新标题，先保存上一个段落（如果存在）
      if (currentHeading) {
        sections[currentHeading.toLowerCase()] = currentLines
          .join("\n")
          .trim();
      }
      // 开始累积新段落
      currentHeading = headingMatch[1]!;
      currentLines.length = 0; // 清空数组而非新建——复用引用避免 GC
    } else if (currentHeading) {
      // 当前在某个段落内，累积文本行
      currentLines.push(line);
    }
  }

  // 保存最后一个段落（循环结束时最后一个 ## 段落尚未保存）
  if (currentHeading) {
    sections[currentHeading.toLowerCase()] = currentLines.join("\n").trim();
  }

  return sections;
}
