import type { ColorInput } from "@opentui/core";

export interface MarkdownSegment {
  readonly text: string;
  readonly fg?: ColorInput;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface MdParserState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  /** Table row phase: none → header (first row) → body (after separator). */
  tableMode: "none" | "header" | "body";
}

export function createMdParserState(): MdParserState {
  return { inCodeBlock: false, codeBlockLang: "", tableMode: "none" };
}

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

export function parseMarkdownLine(
  line: string,
  defaultFg: ColorInput,
  mutedFg: ColorInput,
  brandFg: ColorInput,
  codeFg: ColorInput,
  state: MdParserState,
): MarkdownSegment[] {
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

  if (state.inCodeBlock) {
    return [{ text: line, fg: codeFg }];
  }

  if (!line.trim()) {
    state.tableMode = "none";
    return [{ text: "", fg: defaultFg }];
  }

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

  const quoteMatch = line.match(/^>\s?(.*)$/);
  if (quoteMatch) {
    return [
      { text: "▎ ", fg: mutedFg },
      ...parseInlineMarkdown(quoteMatch[1]!, mutedFg, defaultFg, codeFg),
    ];
  }

  const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (ulMatch) {
    const indent = ulMatch[1]!;
    const prefix = `${indent}• `;
    return [
      { text: prefix, fg: mutedFg },
      ...parseInlineMarkdown(ulMatch[2]!, defaultFg, brandFg, codeFg),
    ];
  }

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

  if (/^\|[\s\-:|]+\|$/.test(line)) {
    if (state.tableMode === "header") {
      state.tableMode = "body";
    }
    return [{ text: line, fg: mutedFg }];
  }

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

  state.tableMode = "none";

  if (/^[-*_]{3,}\s*$/.test(line)) {
    return [{ text: "─".repeat(40), fg: mutedFg }];
  }

  return parseInlineMarkdown(line, defaultFg, brandFg, codeFg);
}

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
