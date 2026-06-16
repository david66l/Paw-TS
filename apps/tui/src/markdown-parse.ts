import type { ColorInput } from "@opentui/core";

/** Markdown 行内片段：文本 + 可选颜色与样式。 */
export interface MarkdownSegment {
  readonly text: string;
  readonly fg?: ColorInput;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

/** Markdown 解析器状态，跨行跟踪代码块与表格。 */
export interface MdParserState {
  inCodeBlock: boolean;        // 是否处于代码块内
  codeBlockLang: string;       // 当前代码块语言标识
  /** 表格阶段：none → header（首行） → body（分隔线之后）。 */
  tableMode: "none" | "header" | "body";
}

/** 创建初始 Markdown 解析状态。 */
export function createMdParserState(): MdParserState {
  return { inCodeBlock: false, codeBlockLang: "", tableMode: "none" };
}

/**
 * 将 Markdown 文本切分为带样式的行片段列表。
 *
 * 当前支持的元素：
 * - 代码块（围栏式）
 * - 标题（# 1-6 级）
 * - 引用块
 * - 无序/有序列表
 * - 表格（简单渲染）
 * - 水平分割线
 * - 行内加粗、行内代码
 *
 * @param text 原始 Markdown 文本
 * @param colors 颜色配置
 * @returns 每行对应的片段数组
 */
export function markdownToSegmentBlock(
  text: string,
  colors: {
    readonly defaultFg: ColorInput;
    readonly mutedFg: ColorInput;
    readonly brandFg: ColorInput;
    readonly codeFg: ColorInput;
  },
): readonly (readonly MarkdownSegment[])[] {
  const state = createMdParserState();
  return text
    .trim()
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      parseMarkdownLine(
        line,
        colors.defaultFg,
        colors.mutedFg,
        colors.brandFg,
        colors.codeFg,
        state,
      ),
    );
}

/**
 * 解析单行 Markdown，返回带样式的片段数组。
 *
 * @param line 当前行文本
 * @param defaultFg 默认文本颜色
 * @param mutedFg 次要文本颜色
 * @param brandFg 品牌/强调色
 * @param codeFg 代码文本颜色
 * @param state 跨行解析状态（会被修改）
 */
export function parseMarkdownLine(
  line: string,
  defaultFg: ColorInput,
  mutedFg: ColorInput,
  brandFg: ColorInput,
  codeFg: ColorInput,
  state: MdParserState,
): MarkdownSegment[] {
  // 代码块围栏：切换 inCodeBlock 状态
  if (/^\s*```/.test(line)) {
    if (state.inCodeBlock) {
      state.inCodeBlock = false;
      state.codeBlockLang = "";
      return [{ text: "```", fg: mutedFg }];
    }
    state.inCodeBlock = true;
    state.codeBlockLang = line.replace(/^\s*```\s*/, "").trim();
    return [{ text: line, fg: mutedFg }];
  }

  // 代码块内部整行使用代码色
  if (state.inCodeBlock) {
    return [{ text: line, fg: codeFg }];
  }

  // 空行：重置表格状态
  if (!line.trim()) {
    state.tableMode = "none";
    return [{ text: "", fg: defaultFg }];
  }

  // 标题
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    const headingText = headingMatch[2]!;
    const prefix = `${"#".repeat(level)} `;
    return [
      { text: prefix, fg: mutedFg, bold: false },
      { text: headingText, fg: brandFg, bold: true },
    ];
  }

  // 引用块
  const quoteMatch = line.match(/^>\s?(.*)$/);
  if (quoteMatch) {
    return [
      { text: "▎ ", fg: mutedFg },
      ...parseInlineMarkdown(quoteMatch[1]!, mutedFg, defaultFg, codeFg),
    ];
  }

  // 无序列表
  const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (ulMatch) {
    const indent = ulMatch[1]!;
    const prefix = `${indent}• `;
    return [
      { text: prefix, fg: mutedFg },
      ...parseInlineMarkdown(ulMatch[2]!, defaultFg, brandFg, codeFg),
    ];
  }

  // 有序列表
  const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (olMatch) {
    const indent = olMatch[1]!;
    const num = olMatch[2]!;
    const prefix = `${indent + num}. `;
    return [
      { text: prefix, fg: mutedFg },
      ...parseInlineMarkdown(olMatch[3]!, defaultFg, brandFg, codeFg),
    ];
  }

  // 表格分隔线
  if (/^\|[\s\-:|]+\|$/.test(line)) {
    if (state.tableMode === "header") {
      state.tableMode = "body";
    }
    return [{ text: line, fg: mutedFg }];
  }

  // 表格行
  if (/^\|.*\|$/.test(line)) {
    const cells = line.split("|").filter(Boolean);
    const isHeaderRow = state.tableMode === "none" || state.tableMode === "header";
    if (state.tableMode === "none") {
      state.tableMode = "header";
    }
    const segments: MarkdownSegment[] = [];
    segments.push({ text: "│ ", fg: mutedFg });
    for (let i = 0; i < cells.length; i++) {
      if (i > 0) segments.push({ text: " │ ", fg: mutedFg });
      const cell = cells[i]!.trim();
      segments.push(
        ...parseInlineMarkdown(
          cell,
          isHeaderRow ? brandFg : defaultFg,
          brandFg,
          codeFg,
        ).map((s) => (isHeaderRow ? { ...s, bold: true } : s)),
      );
    }
    segments.push({ text: " │", fg: mutedFg });
    return segments;
  }

  // 非表格行，重置表格状态
  state.tableMode = "none";

  // 水平分割线
  if (/^[-*_]{3,}\s*$/.test(line)) {
    return [{ text: "─".repeat(40), fg: mutedFg }];
  }

  // 普通段落：解析行内样式
  return parseInlineMarkdown(line, defaultFg, brandFg, codeFg);
}

/**
 * 解析行内 Markdown：加粗 `**text**` 与行内代码 `` `code` ``。
 *
 * @param text 当前行剩余文本
 * @param defaultFg 默认文本颜色
 * @param strongFg 加粗文本颜色
 * @param codeFg 行内代码颜色
 */
function parseInlineMarkdown(
  text: string,
  defaultFg: ColorInput,
  strongFg: ColorInput,
  codeFg: ColorInput,
): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*/s);
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`/s);

    // 选择最先出现的语法
    const useBold =
      boldMatch &&
      (!codeMatch || (boldMatch.index ?? 0) <= (codeMatch.index ?? 0));
    const useCode =
      codeMatch &&
      (!boldMatch || (codeMatch.index ?? 0) <= (boldMatch.index ?? 0));

    if (useBold && boldMatch) {
      const before = boldMatch[1]!;
      const boldText = boldMatch[2]!;
      if (before) segments.push({ text: before, fg: defaultFg });
      segments.push({ text: boldText, fg: strongFg, bold: true });
      remaining = remaining.slice(boldMatch[0].length);
    } else if (useCode && codeMatch) {
      const before = codeMatch[1]!;
      const codeText = codeMatch[2]!;
      if (before) segments.push({ text: before, fg: defaultFg });
      segments.push({ text: codeText, fg: codeFg, italic: true });
      remaining = remaining.slice(codeMatch[0].length);
    } else {
      segments.push({ text: remaining, fg: defaultFg });
      remaining = "";
    }
  }

  return segments;
}
