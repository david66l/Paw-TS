import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, LanguageModel, ModelCompletionResult } from "@paw/models";
import { buildPawNextTaskProfileV3, runFreshPawNextTaskV3 } from "@paw/paw-next";
import { desktopProfile, fingerprint } from "../agent-host/paw-next-profile.js";
import { runDesktopNext } from "../agent-host/paw-next.js";

const final = (text: string): ModelCompletionResult => ({
  text,
  nativeAssistantContent: text,
  finishReason: "stop",
});
const tool = (id: string, name: string, args: Record<string, unknown>): ModelCompletionResult => ({
  text: "",
  nativeAssistantContent: "",
  finishReason: "tool_calls",
  reasoningPassback: "Keep this exact native reasoning.",
  toolCalls: [
    {
      id,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
      argumentsValid: true,
      sourceIndex: 0,
    },
  ],
});
function cleanup(root: string) {
  if (
    path.dirname(root) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith("paw-receipt-")
  )
    throw new Error("Unexpected fixture path");
  fs.rmSync(root, { recursive: true, force: true });
}
function modelWith(complete: LanguageModel["complete"]): LanguageModel {
  return {
    label: "openai:receipt-test",
    capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "receipt-test",
      baseUrl: "https://desktop.invalid/v1",
    },
    complete,
  };
}
const lastResult = (messages: readonly ChatMessage[]) => {
  const turn = [...messages].reverse().find((message) => message.nativeToolTurn)?.nativeToolTurn;
  if (!turn?.results[0]) throw new Error("Missing native result");
  return JSON.parse(turn.results[0].content);
};

test("fresh desktop projects a write receipt, recalls the original diff and recovers without tool replay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-receipt-fresh-"));
  try {
    const content = Array.from(
      { length: 100 },
      (_, i) => `line ${i}: exact generated content`,
    ).join("\n");
    let calls = 0;
    let modelFailure: unknown;
    const model = modelWith(async (messages) => {
      try {
        if (messages[0]?.content.includes("completion reviewer"))
          return final(
            JSON.stringify({
              decision: "allow",
              reasonCode: "evidence_sufficient",
              summary: "The file and recalled evidence match.",
            }),
          );
        calls++;
        if (calls === 1)
          return tool("write", "workspace_write_file", {
            path: "note.txt",
            content,
          });
        if (calls === 2) {
          const receipt = lastResult(messages);
          expect(receipt).toMatchObject({
            status: "completed",
            isError: false,
            payload: {
              changed: true,
              bytes_written: content.length,
              diffRecall: { policyVersion: "paw.mutation-receipt.v1" },
            },
          });
          expect(receipt.payload).not.toHaveProperty("diff");
          expect(receipt.payload).toHaveProperty("diagnostics");
          const turn = messages.find((message) => message.nativeToolTurn)?.nativeToolTurn;
          expect(turn?.reasoningPassback).toBe("Keep this exact native reasoning.");
          expect(turn?.calls[0]?.rawArguments).toBe(JSON.stringify({ path: "note.txt", content }));
          const { id, part, offset, limit } = receipt.payload.diffRecall;
          return tool("recall", "context_recall", { id, part, offset, limit });
        }
        expect(calls).toBe(3);
        const recalled = lastResult(messages);
        expect(recalled.isError).toBe(false);
        expect(recalled.status).toBe("completed");
        expect(recalled.payload).toBeString();
        const original = JSON.parse(recalled.payload.split("--- content ---\n")[1]);
        expect(original.diff).toContain("+line 0: exact generated content");
        expect(original).not.toHaveProperty("diffRecall");
        return final("Created note.txt and checked its recorded diff.");
      } catch (error) {
        modelFailure = error;
        throw error;
      }
    });
    const options = {
      workspaceRoot: root,
      conversationId: "receipt",
      model,
      settings: {},
      memoryEnabled: false,
      environmentAudit: false,
      resolveToolApproval: async () => true,
      onEvent() {},
    };
    const result = await runDesktopNext("Create note.txt with the specified 100 lines", options);
    if (modelFailure) throw modelFailure;
    expect(result.ok, result.text).toBe(true);
    expect(calls).toBe(3);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe(content);
    const recordPath = path.join(
      root,
      ".paw",
      "desktop-next",
      `conversation-${fingerprint("receipt")}.json`,
    );
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    expect(record.compactMutationReceipts).toBe(true);
    const recovered = await runDesktopNext("Create note.txt with the specified 100 lines", {
      ...options,
      intent: "recover",
    });
    expect(recovered.ok, recovered.text).toBe(true);
    expect(JSON.parse(recovered.text).runId).toBe(record.runId);
    expect(calls).toBe(3);
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).configHash).toBe(record.configHash);
  } finally {
    cleanup(root);
  }
}, 30_000);

test.each([false, true])(
  "desktop restores frozen receipt policy=%s without upgrading old sessions",
  async (enabled) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-receipt-recovery-"));
    try {
      let calls = 0;
      const model = modelWith(async (messages) => {
        calls++;
        return final(
          messages[0]?.content.includes("completion reviewer")
            ? JSON.stringify({
                decision: "allow",
                reasonCode: "evidence_sufficient",
                summary: "Greeting delivered",
              })
            : "Hello",
        );
      });
      const { environmentAudit: _audit, ...base } = desktopProfile(
        root,
        model,
        {},
        undefined,
        false,
      );
      const profile = {
        ...base,
        ...(enabled ? { compactMutationReceipts: true as const } : {}),
      };
      const identity = {
        workspaceRoot: root,
        sessionId: "desktop-session-receipt",
        runId: "desktop-next-receipt",
        inputId: "desktop-input-receipt",
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
      expect(() =>
        buildPawNextTaskProfileV3({
          ...args,
          profile: {
            ...profile,
            compactMutationReceipts: false as unknown as true,
          },
        }),
      ).toThrow("Unsupported mutation receipt policy");
      expect(() =>
        buildPawNextTaskProfileV3({
          ...args,
          profile: {
            ...profile,
            compactMutationReceipts: true,
            legacyOutputRecall: true,
          },
        }),
      ).toThrow("require journal-authority output recall");
      expect(first.manifest.compactMutationReceipts).toBe(
        enabled ? "paw.mutation-receipt.v1" : undefined,
      );
      const alternate = buildPawNextTaskProfileV3({
        ...args,
        profile: {
          ...base,
          ...(!enabled ? { compactMutationReceipts: true as const } : {}),
        },
      });
      expect(alternate.configHash).not.toBe(first.configHash);
      const resolution = buildPawNextTaskProfileV3({
        ...args,
        profile: { ...profile, configHash: first.configHash },
      });
      await runFreshPawNextTaskV3({ resolution, requestApproval });
      const record = {
        version: 1,
        ...identity,
        liveSteering: true,
        ...(enabled ? { compactMutationReceipts: true } : {}),
        configHash: resolution.configHash,
        status: "completed",
        segments: 1,
      };
      const dir = path.join(root, ".paw", "desktop-next");
      fs.mkdirSync(dir, { recursive: true });
      for (const name of [`conversation-${fingerprint("receipt")}`, identity.runId])
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(record));
      const before = calls;
      const result = await runDesktopNext(identity.goal, {
        workspaceRoot: root,
        conversationId: "receipt",
        intent: "recover",
        model,
        settings: {},
        memoryEnabled: false,
        environmentAudit: false,
        resolveToolApproval: async () => true,
        onEvent() {},
      });
      expect(result.ok, result.text).toBe(true);
      expect(JSON.parse(result.text).runId).toBe(identity.runId);
      expect(calls).toBe(before);
      const saved = JSON.parse(
        fs.readFileSync(path.join(dir, `conversation-${fingerprint("receipt")}.json`), "utf8"),
      );
      expect(saved.configHash).toBe(record.configHash);
      expect(saved.compactMutationReceipts).toBe(enabled ? true : undefined);
    } finally {
      cleanup(root);
    }
  },
  30_000,
);
