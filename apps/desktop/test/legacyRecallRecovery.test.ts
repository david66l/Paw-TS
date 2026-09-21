import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "@paw/models";
import {
  buildPawNextTaskProfileV3,
  runFreshPawNextTaskV3,
} from "@paw/paw-next";
import { desktopProfile, fingerprint } from "../agent-host/paw-next-profile.js";
import { runDesktopNext } from "../agent-host/paw-next.js";

test("desktop restores the exact legacy recall identity without replaying work or accepting model drift", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-legacy-recall-"));
  try {
    let calls = 0;
    const model: LanguageModel = {
      label: "openai:legacy-test",
      capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
      runtimeProfile: {
        protocol: "openai-compatible",
        model: "legacy-test",
        baseUrl: "https://desktop.invalid/v1",
      },
      async complete(messages) {
        calls++;
        const text = messages[0]?.content.includes("completion reviewer")
          ? JSON.stringify({
              decision: "allow",
              reasonCode: "evidence_sufficient",
              summary: "Greeting delivered",
            })
          : "Hello";
        return { text, nativeAssistantContent: text, finishReason: "stop" };
      },
    };
    const { environmentAudit: _audit, ...base } = desktopProfile(
      root,
      model,
      {},
      undefined,
      false,
    );
    const profile = { ...base, legacyOutputRecall: true as const };
    const identity = {
      workspaceRoot: root,
      sessionId: "desktop-session-legacy-test",
      runId: "desktop-next-legacy-test",
      inputId: "desktop-input-legacy-test",
      goal: "Say hello",
    };
    const requestApproval = async () => ({ decision: "allow_once" as const });
    const args = {
      identity,
      profile,
      apiKey: fingerprint({}),
      model,
      requestApproval,
    };
    const first = buildPawNextTaskProfileV3(args);
    const resolution = buildPawNextTaskProfileV3({
      ...args,
      profile: { ...profile, configHash: first.configHash },
    });
    expect(
      (await runFreshPawNextTaskV3({ resolution, requestApproval })).state
        .decision.kind,
    ).toBe("completed");
    const record = {
      version: 1,
      liveSteering: true,
      ...identity,
      configHash: resolution.configHash,
      status: "completed",
      segments: 1,
    };
    const dir = path.join(root, ".paw", "desktop-next");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `conversation-${fingerprint("legacy")}.json`);
    fs.writeFileSync(file, JSON.stringify(record));
    fs.writeFileSync(
      path.join(dir, `${identity.runId}.json`),
      JSON.stringify(record),
    );
    const before = calls;
    const options = {
      workspaceRoot: root,
      conversationId: "legacy",
      intent: "recover" as const,
      model,
      settings: {},
      memoryEnabled: false,
      environmentAudit: false,
      resolveToolApproval: async () => true,
      onEvent() {},
    };
    const result = await runDesktopNext(identity.goal, options);
    expect(result.ok, result.text).toBe(true);
    expect(JSON.parse(result.text).runId).toBe(identity.runId);
    expect(calls).toBe(before);
    await expect(
      runDesktopNext(identity.goal, { ...options, maxSteps: 17 }),
    ).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).configHash).toBe(
      resolution.configHash,
    );
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      configHash: resolution.configHash,
      legacyOutputRecall: true,
    });
    await expect(
      runDesktopNext(identity.goal, {
        ...options,
        model: {
          ...model,
          runtimeProfile: {
            ...model.runtimeProfile!,
            model: "different-model",
          },
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(before);
  } finally {
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("paw-legacy-recall-")
    )
      throw new Error("Unexpected fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
