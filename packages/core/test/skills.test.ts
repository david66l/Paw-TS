import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    reg.register(
      makeSkill({ id: "s1", name: "Skill One", description: "Does one thing" }),
    );
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
      parameters: [
        { name: "name", description: "Name", type: "string", default: "World" },
      ],
    });
    const result = renderSkillPrompt(skill, {});
    expect(result).toBe("Hello World");
  });

  test("shows missing marker for required params without value", () => {
    const skill = makeSkill({
      prompt: "Hello {{name}}",
      parameters: [
        { name: "name", description: "Name", type: "string", required: true },
      ],
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
});

function mkdirSync(p: string, opts?: { recursive?: boolean }): void {
  const { mkdirSync: fsMkdir } = require("node:fs");
  fsMkdir(p, opts);
}
