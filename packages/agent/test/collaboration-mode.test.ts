import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RunEventEnvelope } from "@paw/core";
import type { ChatMessage, ModelCompleteOptions } from "@paw/models";
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
  test("accepts caller-owned models without resolving credentials from the workspace", () => {
    const dir = tmpDir("paw-collab-injected-model-");
    const model = {
      label: "trusted-control-plane-model",
      async complete() {
        return { text: "done" };
      },
    };
    try {
      writeFileMemorySettings(dir);
      const run = createRunOrchestrator({
        workspaceRoot: dir,
        mainModel: model,
        subAgentModel: model,
        skipAgentSeeds: true,
      });
      try {
        expect(run.mainModel).toBe(model);
        expect(run.subAgentModel).toBe(model);
      } finally {
        run.watcher.stop();
      }
    } finally {
      cleanup(dir);
    }
  });

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

  test("createRunOrchestrator defaults to coding with loop budget and slim capabilities", async () => {
    const dir = tmpDir("paw-collab-coding-");
    const events: RunEventEnvelope[] = [];
    let providerToolNames: string[] = [];
    let systemPrompt = "";
    const model = {
      label: "coding-capability-probe",
      async complete(
        messages: readonly ChatMessage[],
        options?: ModelCompleteOptions,
      ) {
        systemPrompt =
          messages.find((message) => message.role === "system")?.content ?? "";
        providerToolNames =
          options?.tools?.map((tool) => tool.function.name) ?? [];
        return { text: '{"action":"final_answer","summary":"Done."}' };
      },
    };
    try {
      writeFileMemorySettings(dir);
      const run = createRunOrchestrator({
        workspaceRoot: dir,
        mainModel: model,
        subAgentModel: model,
        onEvent: (event) => events.push(event),
      });
      try {
        expect(run.collaborationMode).toBe("coding");
        expect(run.rootMaxSteps).toBe(64);
        expect(CODING_ROOT_IDENTITY.length).toBeGreaterThan(40);
        await run.orch.run({
          runId: "coding-capability-probe",
          goal: "Return a short answer",
          workspaceRoot: dir,
          maxSteps: 2,
        });
        const inventory = events.find(
          (event) => event.event.type === "capability.inventory",
        );
        expect(inventory?.event.type).toBe("capability.inventory");
        if (inventory?.event.type !== "capability.inventory") {
          throw new Error("capability inventory missing");
        }
        expect(inventory.event.fullToolCount).toBe(3);
        expect(inventory.event.executableTools).toEqual(
          expect.arrayContaining([
            "workspace.run_shell",
            "workspace.read_file",
            "workspace.edit_file",
          ]),
        );
        expect(inventory.event.executableTools).not.toContain(
          "workspace.run_agent",
        );
        expect(providerToolNames).toHaveLength(3);
        expect(providerToolNames).toEqual(
          expect.arrayContaining(
            inventory.event.executableTools?.map((name) =>
              name.replace(/[^a-zA-Z0-9_-]/g, "_"),
            ) ?? [],
          ),
        );
        for (const hidden of [
          "workspace.write_file",
          "workspace.glob",
          "workspace.grep",
          "workspace.todo_write",
          "workspace.run_agent",
          "workspace.apply_patch",
          "workspace.job_",
          "memory.list",
          "memory.read",
          "memory.save",
        ]) {
          expect(systemPrompt).not.toContain(hidden);
        }
        expect(systemPrompt).toContain(
          "to create a missing file, pass old_string as an empty string",
        );
      } finally {
        run.watcher.stop();
      }
    } finally {
      cleanup(dir);
    }
  });
});
