import { describe, expect, test } from "bun:test";
import {
  isGitDiffCommand,
  tokenizeCommandSegment,
} from "../src/shell-command.js";

describe("isGitDiffCommand", () => {
  test("accepts Git global options before the diff subcommand", () => {
    expect(isGitDiffCommand("git --no-pager diff -- src/a.ts")).toBe(true);
    expect(isGitDiffCommand("git -P --no-replace-objects diff HEAD")).toBe(
      true,
    );
    expect(isGitDiffCommand('git -C "repo path" --work-tree=. diff')).toBe(
      true,
    );
    expect(isGitDiffCommand("git.exe --no-optional-locks diff --stat")).toBe(
      true,
    );
  });

  test("rejects compound commands whose diff execution is ambiguous", () => {
    expect(isGitDiffCommand("git status && git --no-pager diff")).toBe(false);
    expect(isGitDiffCommand("true || git --no-pager diff")).toBe(false);
    expect(isGitDiffCommand("git --no-pager diff | head")).toBe(false);
    expect(isGitDiffCommand("git status\ngit -C . diff -- a.py")).toBe(false);
  });

  test("rejects text mentions and non-diff Git commands", () => {
    expect(isGitDiffCommand("echo git --no-pager diff")).toBe(false);
    expect(isGitDiffCommand("python -c \"print('git diff')\"")).toBe(false);
    expect(isGitDiffCommand("git --no-pager status")).toBe(false);
    expect(isGitDiffCommand("git --version diff")).toBe(false);
    expect(isGitDiffCommand("git --unknown diff")).toBe(false);
    expect(isGitDiffCommand("git -c diff.external=helper diff")).toBe(false);
    expect(isGitDiffCommand("git --config-env=x=Y diff")).toBe(false);
    expect(isGitDiffCommand('git --work-tree="" diff')).toBe(false);
    expect(isGitDiffCommand("git --no-pager diff > review.txt")).toBe(false);
    expect(isGitDiffCommand("git --no-pager diff $(touch marker)")).toBe(false);
    expect(isGitDiffCommand("git --no-pager diff `touch marker`")).toBe(false);
  });

  test("rejects malformed quoted or escaped commands", () => {
    expect(isGitDiffCommand('git --no-pager "diff')).toBe(false);
    expect(isGitDiffCommand("git --no-pager diff\\")).toBe(false);
  });

  test("tokenizes quoted Windows paths without erasing separators", () => {
    expect(
      tokenizeCommandSegment(
        '"C:\\Program Files\\Python310\\python.exe" -m pytest tests\\test_a.py',
      ),
    ).toEqual([
      "C:\\Program Files\\Python310\\python.exe",
      "-m",
      "pytest",
      "tests\\test_a.py",
    ]);
    expect(tokenizeCommandSegment("git diff repo\\ path/file.ts")).toEqual([
      "git",
      "diff",
      "repo path/file.ts",
    ]);
  });
});
