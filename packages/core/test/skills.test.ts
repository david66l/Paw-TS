import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type SkillDefinition,
  SkillRegistry,
  loadSkillsFromDirectory,
  renderSkillPrompt,
} from "../src/skills.js";

function makeSkill(overrides?: Partial<SkillDefinition>): SkillDefinition {
  return {
    id: "test",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    prompt: "Hello {{name}}",
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  test("register and get", () => {
    const reg = new SkillRegistry();
    const skill = makeSkill({ id: "s1" });
    reg.register(skill);
    expect(reg.get("s1")).toBe(skill);
  });

  test("get missing returns undefined", () => {
    const reg = new SkillRegistry();
    expect(reg.get("missing")).toBeUndefined();
  });

  test("list returns all skills", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ id: "a" }));
    reg.register(makeSkill({ id: "b" }));
    expect(reg.list().length).toBe(2);
  });

  test("unregister removes skill", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ id: "s1" }));
    expect(reg.unregister("s1")).toBe(true);
    expect(reg.has("s1")).toBe(false);
  });

  test("catalogText includes skill info", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ id: "s1", name: "Skill One", description: "Does one thing" }));
    const text = reg.catalogText();
    expect(text).toContain("s1");
    expect(text).toContain("Skill One");
  });

  test("catalogText empty when no skills", () => {
    const reg = new SkillRegistry();
    expect(reg.catalogText()).toContain("none loaded");
  });
});

describe("renderSkillPrompt", () => {
  test("replaces placeholders", () => {
    const skill = makeSkill({
      prompt: "Write {{type}} code for {{language}}",
      parameters: [
        {
          name: "type",
          description: "Code type",
          type: "string",
          required: true,
        },
        {
          name: "language",
          description: "Language",
          type: "string",
          required: true,
        },
      ],
    });
    const result = renderSkillPrompt(skill, { type: "test", language: "TS" });
    expect(result).toBe("Write test code for TS");
  });

  test("uses defaults for missing args", () => {
    const skill = makeSkill({
      prompt: "Hello {{name}}",
      parameters: [{ name: "name", description: "Name", type: "string", default: "World" }],
    });
    const result = renderSkillPrompt(skill, {});
    expect(result).toBe("Hello World");
  });

  test("shows missing marker for required params without value", () => {
    const skill = makeSkill({
      prompt: "Hello {{name}}",
      parameters: [{ name: "name", description: "Name", type: "string", required: true }],
    });
    const result = renderSkillPrompt(skill, {});
    expect(result).toBe("Hello [missing: name]");
  });
});

describe("loadSkillsFromDirectory", () => {
  let tmpDir: string;

  test("loads skills from JSON files", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-skills-"));
    writeFileSync(
      path.join(tmpDir, "test.json"),
      JSON.stringify({
        id: "test_skill",
        name: "Test",
        description: "A test skill",
        version: "1.0.0",
        prompt: "Do {{action}}",
        parameters: [
          {
            name: "action",
            description: "Action",
            type: "string",
            required: true,
          },
        ],
      }),
    );
    const skills = loadSkillsFromDirectory(tmpDir);
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe("test_skill");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("recursively loads from subdirectories", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-skills-"));
    const subDir = path.join(tmpDir, "nested");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      path.join(subDir, "nested.json"),
      JSON.stringify({
        id: "nested",
        name: "Nested",
        description: "Nested skill",
        version: "1.0.0",
        prompt: "Nested",
      }),
    );
    const skills = loadSkillsFromDirectory(tmpDir);
    expect(skills.length).toBe(1);
    expect(skills[0]?.id).toBe("nested");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty for missing directory", () => {
    const skills = loadSkillsFromDirectory("/nonexistent/path");
    expect(skills.length).toBe(0);
  });

  test("skips invalid JSON", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-skills-"));
    writeFileSync(path.join(tmpDir, "bad.json"), "not json");
    const skills = loadSkillsFromDirectory(tmpDir);
    expect(skills.length).toBe(0);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // `.paw/skills/` 是用户可控目录，递归必须有界。旧实现没有深度上限也没有
  // 环检测，`statSync` 又会跟随符号链接，一个自引用目录链接就能无限递归爆栈。
  describe("bounded recursion", () => {
    function skillAt(root: string, depth: number): string {
      let dir = root;
      for (let i = 0; i < depth; i++) dir = path.join(dir, `level-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), "---\nname: deep\n---\nbody", "utf8");
      return dir;
    }

    test("finds a skill a few levels down", () => {
      const root = mkdtempSync(path.join(tmpdir(), "paw-skills-deep-"));
      skillAt(root, 3);
      expect(loadSkillsFromDirectory(root).length).toBe(1);
      rmSync(root, { recursive: true, force: true });
    });

    test("stops at the depth limit instead of recursing forever", () => {
      const root = mkdtempSync(path.join(tmpdir(), "paw-skills-deep-"));
      skillAt(root, 40);
      // 关键性质是「返回」而不是「找到」：无上限时会一直递归下去。
      expect(loadSkillsFromDirectory(root).length).toBe(0);
      rmSync(root, { recursive: true, force: true });
    });

    test("survives a self-referencing directory symlink", () => {
      const root = mkdtempSync(path.join(tmpdir(), "paw-skills-loop-"));
      const child = path.join(root, "loop");
      mkdirSync(child, { recursive: true });
      try {
        // Windows 上创建符号链接需要权限，失败时跳过而不是误判为通过。
        symlinkSync(root, path.join(child, "back"), "dir");
      } catch {
        rmSync(root, { recursive: true, force: true });
        return;
      }
      writeFileSync(path.join(root, "SKILL.md"), "---\nname: top\n---\nbody", "utf8");
      const skills = loadSkillsFromDirectory(root);
      expect(skills.length).toBe(1);
      rmSync(root, { recursive: true, force: true });
    });
  });
});
