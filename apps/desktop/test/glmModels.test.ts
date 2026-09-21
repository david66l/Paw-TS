import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAICompatibleModel } from "@paw/models";
import { desktopAgentModels } from "../agent-host/paw-next-models.js";

test("selected GLM Flash serves desktop workers and orchestrated roots", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paw-glm-desktop-"));
  try {
    const main = new OpenAICompatibleModel({
      apiKey: "test",
      model: "glm-5.3-flash",
    });
    for (const agent_mode of ["coding", "orchestrated"] as const) {
      const result = desktopAgentModels(dir, main, { agent_mode });
      expect(result.model).toBe(main);
      expect(Object.values(result.preferences)).toContain("flash");
      expect(Object.values(result.models).length).toBeGreaterThan(0);
      for (const model of Object.values(result.models)) expect(model).toBe(main);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
