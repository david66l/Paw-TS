import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
} from "@paw/models";

import { preparePawNextProductRuntimeIdentityV3 } from "../../../../packages/paw-next/src/composition.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Paw Next V3 reserves and requests the selected model's full output capacity", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paw-recovery-"));
  roots.push(workspaceRoot);
  const calls: Array<{
    readonly messages: readonly ChatMessage[];
    readonly maxOutputTokens?: number;
  }> = [];
  const model: LanguageModel = {
    label: "openai:large-output-test",
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "large-output-test",
      baseUrl: "https://example.invalid/v1",
    },
    async complete(
      messages: readonly ChatMessage[],
      options?: ModelCompleteOptions,
    ) {
      calls.push({ messages, maxOutputTokens: options?.maxOutputTokens });
      return calls.length === 1
        ? {
            text: "partial ",
            reasoningPassback: "exact-reasoning-state",
            finishReason: "length",
          }
        : { text: "complete", finishReason: "stop" };
    },
  };
  const prepared = preparePawNextProductRuntimeIdentityV3({
    workspaceRoot,
    sessionId: "session-output-recovery",
    runId: "run-output-recovery",
    inputId: "input-output-recovery",
    goal: "test output recovery",
    model,
  });

  const settlement = await prepared.model.execute(
    { messages: [{ role: "user", content: "work" }] },
    {
      signal: new AbortController().signal,
      onStreamEvent: () => undefined,
    },
  );

  expect(prepared.manifest.contextBudget).toMatchObject({
    reservedOutputTokens: 384_000,
  });
  expect(calls.map((call) => call.maxOutputTokens)).toEqual([384_000, 384_000]);
  expect(calls[1]?.messages.at(-2)).toEqual({
    role: "assistant",
    content: "partial ",
    reasoningPassback: "exact-reasoning-state",
  });
  expect(settlement.status).toBe("success");
  if (settlement.status !== "success") throw new Error("expected success");
  expect(settlement.message.text).toBe("partial complete");
});
