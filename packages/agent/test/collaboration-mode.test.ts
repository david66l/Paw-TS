import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveAllowedTools } from "../src/agents/resolve-tools.js";
import {
  CODING_LIFECYCLE_BUDGET,
  CODING_ROOT_IDENTITY,
  resolveCollaborationMode,
} from "../src/collaboration-mode.js";
import { createRunOrchestrator } from "../src/orchestrator-factory.js";
import { cleanup, tmpDir, writeFileMemorySettings } from "./fixtures.js";

describe("resolveCollaborationMode", () => {
  test("defaults to coding", () => {
    const r = resolveCollaborationMode({});
    expect(r.mode).toBe("coding");
    expect(r.injectRoster).toBe(false);
    expect(r.canSpawn).toBe(false);
    expect(r.identityText).toContain("单人长跑");
    expect(r.defaultBudget.maxSteps).toBe(CODING_LIFECYCLE_BUDGET.maxSteps);
  });

  test("settings agent_mode=orchestrated", () => {
    const r = resolveCollaborationMode({
      settings: { agent_mode: "team" },
    });
    expect(r.mode).toBe("orchestrated");
    expect(r.rootAgentId).toBe("lihua");
    expect(r.injectRoster).toBe(true);
  });

  test("explicit rootAgentId=lihua implies orchestrated", () => {
    const r = resolveCollaborationMode({ rootAgentId: "lihua" });
    expect(r.mode).toBe("orchestrated");
  });
});

describe("coding factory defaults", () => {
  test("can keep mutable runtime records outside the project workspace", () => {
    const dir = tmpDir("paw-collab-runtime-workspace-");
    const runtime = tmpDir("paw-collab-runtime-state-");
    try {
      writeFileMemorySettings(dir);
      const run = createRunOrchestrator({
        workspaceRoot: dir,
        runtimeStateRoot: runtime,
        skipAgentSeeds: true,
      });
      try {
        run.sessionStore.saveEvent("external-state", {
          runId: "external-state",
          seq: 1,
          ts: 1,
          event: { type: "run.started", goal: "test" },
        });
        expect(
          existsSync(
            path.join(runtime, ".paw", "sessions", "external-state.jsonl"),
          ),
        ).toBe(true);
        expect(
          existsSync(
            path.join(dir, ".paw", "sessions", "external-state.jsonl"),
          ),
        ).toBe(false);
      } finally {
        run.watcher.stop();
      }
    } finally {
      cleanup(dir);
      cleanup(runtime);
    }
  });

  test("createRunOrchestrator defaults to coding with loop budget", () => {
    const dir = tmpDir("paw-collab-coding-");
    try {
      writeFileMemorySettings(dir);
      const run = createRunOrchestrator({ workspaceRoot: dir });
      try {
        expect(run.collaborationMode).toBe("coding");
        expect(run.rootMaxSteps).toBe(64);
        expect(CODING_ROOT_IDENTITY.length).toBeGreaterThan(40);
        const tools = resolveAllowedTools({
          tools: "inherit",
          canSpawn: false,
        });
        expect(tools).not.toBeNull();
        if (!tools) throw new Error("coding tools unexpectedly unavailable");
        expect(tools.includes("workspace.edit_file")).toBe(true);
        expect(tools.includes("workspace.run_shell")).toBe(true);
        expect(tools.includes("workspace.run_agent")).toBe(false);
        expect(tools.includes("workspace.create_agent")).toBe(false);
      } finally {
        run.watcher.stop();
      }
    } finally {
      cleanup(dir);
    }
  });
});
