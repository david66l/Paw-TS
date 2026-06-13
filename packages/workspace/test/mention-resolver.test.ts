import { describe, expect, test } from "bun:test";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  extractAtMentions,
  resolveMentions,
  stripAtMentions,
} from "../src/mention-resolver.js";

describe("extractAtMentions", () => {
  test("finds unquoted @path", () => {
    const ms = extractAtMentions("fix the bug in @src/main.ts");
    expect(ms).toEqual(["src/main.ts"]);
  });

  test("finds double-quoted @path with spaces", () => {
    const ms = extractAtMentions('check @"src/my file.ts" for errors');
    expect(ms).toEqual(["src/my file.ts"]);
  });

  test("finds single-quoted @path", () => {
    const ms = extractAtMentions("see @'config/app.json'");
    expect(ms).toEqual(["config/app.json"]);
  });

  test("finds multiple mentions", () => {
    const ms = extractAtMentions("@a.txt and @b.txt");
    expect(ms).toEqual(["a.txt", "b.txt"]);
  });

  test("deduplicates repeated mentions", () => {
    const ms = extractAtMentions("@a.txt @a.txt");
    expect(ms).toEqual(["a.txt"]);
  });

  test("ignores email-like strings", () => {
    const ms = extractAtMentions("contact me@example.com");
    expect(ms).toEqual([]);
  });

  test("handles paths with dots and slashes", () => {
    const ms = extractAtMentions("@../config.json @src/deep/file.ts");
    expect(ms).toEqual(["../config.json", "src/deep/file.ts"]);
  });
});

describe("stripAtMentions", () => {
  test("removes unquoted mentions", () => {
    const s = stripAtMentions("fix @src/main.ts please");
    expect(s).toBe("fix please");
  });

  test("removes quoted mentions", () => {
    const s = stripAtMentions('read @"file name.ts" now');
    expect(s).toBe("read now");
  });
});

describe("resolveMentions", () => {
  test("resolves existing file to attachment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-mention-"));
    writeFileSync(path.join(dir, "note.txt"), "hello world", "utf8");
    const result = resolveMentions(dir, "read @note.txt");
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0]?.name).toBe("note.txt");
    expect(result.attachments[0]?.content).toBe("hello world");
    expect(result.notFound.length).toBe(0);
    expect(result.strippedText).toBe("read");
  });

  test("reports not-found paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-mention-"));
    const result = resolveMentions(dir, "read @missing.txt");
    expect(result.attachments.length).toBe(0);
    expect(result.notFound).toContain("missing.txt");
  });

  test("rejects paths outside workspace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-mention-"));
    const result = resolveMentions(dir, "read @../../etc/passwd");
    expect(result.attachments.length).toBe(0);
    expect(result.notFound.length).toBe(1);
    expect(result.notFound[0]).toContain("outside workspace");
  });

  test("skips directories", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-mention-"));
    const result = resolveMentions(dir, "read @.");
    expect(result.attachments.length).toBe(0);
    expect(result.notFound).toContain(".");
  });

  test("resolves nested relative paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-mention-"));
    const nestedDir = path.join(dir, "a");
    fs.mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(nestedDir, "b.txt"), "nested", "utf8");
    const result = resolveMentions(dir, "check @a/b.txt");
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0]?.content).toBe("nested");
  });

  test("resolves image files as base64 image attachments", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-mention-img-"));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeFileSync(path.join(dir, "shot.png"), pngBytes);
    const result = resolveMentions(dir, "what is @shot.png");
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0]?.type).toBe("image");
    expect(result.attachments[0]?.mimeType).toBe("image/png");
    expect(result.attachments[0]?.content).toBe(pngBytes.toString("base64"));
    expect(result.strippedText).toBe("what is");
  });
});
