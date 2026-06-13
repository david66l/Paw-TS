/**
 * L2 compression summary validation (quality gate).
 */

export const REQUIRED_SUMMARY_SECTIONS = [
  "active task",
  "goal",
  "progress",
] as const;

export const MIN_COMPRESSION_SAVINGS_RATIO = 0.15;

export function parseMarkdownSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = text.split("\n");
  let currentHeading: string | null = null;
  const currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/i);
    if (headingMatch) {
      if (currentHeading) {
        sections[currentHeading.toLowerCase()] = currentLines.join("\n").trim();
      }
      currentHeading = headingMatch[1]!;
      currentLines.length = 0;
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }
  if (currentHeading) {
    sections[currentHeading.toLowerCase()] = currentLines.join("\n").trim();
  }
  return sections;
}

export function validateCompressionSummary(summary: string): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  const trimmed = summary.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty summary" };
  }

  const sections = parseMarkdownSections(trimmed);
  for (const sec of REQUIRED_SUMMARY_SECTIONS) {
    if (!sections[sec]?.trim()) {
      return { ok: false, reason: `missing section: ## ${sec}` };
    }
  }
  return { ok: true };
}

export function compressionSavingsRatio(
  beforeTokens: number,
  afterTokens: number,
): number {
  if (beforeTokens <= 0) return 0;
  return (beforeTokens - afterTokens) / beforeTokens;
}

export function meetsCompressionSavingsThreshold(
  beforeTokens: number,
  afterTokens: number,
  minRatio = MIN_COMPRESSION_SAVINGS_RATIO,
): boolean {
  return compressionSavingsRatio(beforeTokens, afterTokens) >= minRatio;
}
