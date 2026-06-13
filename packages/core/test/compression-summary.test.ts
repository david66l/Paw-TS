import { describe, expect, it } from "bun:test";
import {
  compressionSavingsRatio,
  meetsCompressionSavingsThreshold,
  parseMarkdownSections,
  validateCompressionSummary,
} from "../src/compression-summary.js";

describe("compression-summary", () => {
  it("parses markdown sections", () => {
    const text = `## Active Task
Fix bug
## Goal
Ship feature
## Progress
Done step 1`;
    const sections = parseMarkdownSections(text);
    expect(sections["active task"]).toBe("Fix bug");
    expect(sections.goal).toBe("Ship feature");
    expect(sections.progress).toBe("Done step 1");
  });

  it("validates required sections", () => {
    const ok = validateCompressionSummary(`## Active Task
t
## Goal
g
## Progress
p`);
    expect(ok.ok).toBe(true);

    const bad = validateCompressionSummary(`## Active Task
only one section`);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("goal");
  });

  it("checks compression savings ratio", () => {
    expect(compressionSavingsRatio(1000, 800)).toBeCloseTo(0.2);
    expect(meetsCompressionSavingsThreshold(1000, 800)).toBe(true);
    expect(meetsCompressionSavingsThreshold(1000, 900)).toBe(false);
  });
});
