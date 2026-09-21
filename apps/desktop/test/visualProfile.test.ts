import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPawNextTaskProfileV3 } from "@paw/paw-next";
import { createDefaultLanguageModel } from "@paw/models";
import { desktopProfile } from "../agent-host/paw-next-profile.js";

test("explicit image capability and visual policy participate in frozen desktop identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-visual-profile-"));
  try {
    fs.mkdirSync(path.join(root, ".paw"));
    for (const provider of ["vision-preset", "openai", "anthropic", "ollama"]) {
      const models = {
        [provider]: {
          model: "vision-fixture",
          apiKey: "offline-fixture",
          imageInput: true as const,
        },
      };
      fs.writeFileSync(
        path.join(root, ".paw", "settings.local.json"),
        JSON.stringify({
          provider,
          models,
          ...(provider === "ollama" ? { ollama_model: "vision-fixture" } : {}),
        }),
      );
      const model = createDefaultLanguageModel(root);
      expect(model.capabilities?.imageInput).toBe(true);
      const profile = {
        ...desktopProfile(root, model, {}, 4, false),
        browserAudit: true as const,
      };
      const build = (selected: typeof profile) =>
        buildPawNextTaskProfileV3({
          identity: {
            workspaceRoot: root,
            sessionId: "visual-session",
            runId: "visual-run",
            inputId: "visual-input",
            goal: "inspect page",
          },
          profile: selected,
          apiKey: "opaque-fixture",
          requestApproval: async () => ({ decision: "allow_once" }),
          model,
        });
      const normal = build(profile);
      const visual = build({ ...profile, visualAudit: true } as typeof profile);
      expect(visual.manifest.visualAudit).toBe("paw.visual-audit.v1");
      expect(visual.taskOptions.visualAudit).toBe(true);
      expect(visual.configHash).not.toBe(normal.configHash);
      expect(() =>
        build({
          ...profile,
          visualAudit: true,
          browserAudit: undefined,
        } as unknown as typeof profile),
      ).toThrow();
      expect(() =>
        build({
          ...profile,
          model: {
            ...profile.model,
            capabilities: { ...profile.model.capabilities, imageInput: false },
          },
        } as unknown as typeof profile),
      ).toThrow();
    }
    fs.writeFileSync(
      path.join(root, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "vision-preset",
        models: {
          "vision-preset": { model: "gpt-4o", apiKey: "offline-fixture" },
        },
      }),
    );
    expect(
      createDefaultLanguageModel(root).capabilities?.imageInput,
    ).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
