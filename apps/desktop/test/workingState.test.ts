import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "@paw/models";
import { runDesktopNext } from "../agent-host/paw-next.js";

test("desktop V3 supplies one current state after real tools without extra model calls or changing the system", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-state-test-"));
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "paw-state-test-")))
    throw new Error("Unsafe fixture");
  try {
    fs.writeFileSync(path.join(root, "input.txt"), "42\n");
    let mainCalls = 0;
    let system = "";
    let modelError: unknown;
    const model: LanguageModel = {
      label: "openai:working-state-fixture",
      capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
      runtimeProfile: {
        protocol: "openai-compatible",
        model: "working-state-fixture",
        baseUrl: "https://invalid.local",
      },
      async complete(messages, options) {
        try {
          if (messages[0]?.content.includes("completion reviewer"))
            return {
              text: '{"decision":"allow","reasonCode":"evidence_sufficient","summary":"Fixture copy confirmed"}',
            };
          mainCalls++;
          const states = messages.filter((m) =>
            m.content.startsWith("[Paw Current Working State]"),
          );
          expect(options?.maxOutputTokens).toBe(4096);
          if (mainCalls === 1) {
            expect(states).toHaveLength(0);
            system = messages[0]!.content;
          } else {
            expect(messages[0]!.content).toBe(system);
            expect(states).toHaveLength(1);
            expect(messages.at(-1)).toBe(states[0]);
            const state = JSON.parse(states[0]!.content.split("\n").at(-1)!);
            expect(state.fileReads.items[0].path).toBe("input.txt");
            expect(state.latestVerificationByTarget.items).toHaveLength(0);
            if (mainCalls === 3) expect(state.workspaceChanges.confirmedOperations).toBe(1);
            // Native tool exchanges and reasoning remain present, unmodified.
            expect(
              messages.some(
                (m) => m.nativeToolTurn && JSON.stringify(m.nativeToolTurn).includes("42"),
              ),
            ).toBe(true);
          }
          if (mainCalls === 3)
            return {
              text: "Copied input.txt to output.txt.",
              finishReason: "stop",
            };
          if (mainCalls > 3) throw new Error("Unexpected extra main call");
          const args =
            mainCalls === 1 ? { path: "input.txt" } : { path: "output.txt", content: "42\n" };
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: `tool-${mainCalls}`,
                name: mainCalls === 1 ? "workspace_read_file" : "workspace_write_file",
                arguments: args,
                rawArguments: JSON.stringify(args),
                sourceIndex: 0,
                argumentsValid: true,
              },
            ],
          };
        } catch (error) {
          modelError = error;
          throw error;
        }
      },
    };
    const result = await runDesktopNext("Read input.txt and copy its content to output.txt.", {
      workspaceRoot: root,
      model,
      settings: {},
      memoryEnabled: false,
      environmentAudit: false,
      maxSteps: 6,
      resolveToolApproval: async () => true,
      onEvent() {},
    });
    if (modelError) throw modelError;
    if (!result.ok) throw new Error(result.text);
    expect(mainCalls).toBe(3);
    expect(fs.readFileSync(path.join(root, "output.txt"), "utf8")).toBe("42\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
