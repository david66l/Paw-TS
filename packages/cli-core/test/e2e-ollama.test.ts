import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "@paw/core";
import { runStubRun } from "../src/operations.js";

const runOllamaE2e = process.env.RUN_OLLAMA_E2E === "1";

describe("E2E: Ollama qwen2.5-coder:14b", () => {
  test.skipIf(!runOllamaE2e)(
    "diagnostics: capture model output",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "paw-e2e-ollama-"));
      mkdirSync(path.join(dir, ".paw"), { recursive: true });
      writeFileSync(
        path.join(dir, ".paw", "settings.local.json"),
        JSON.stringify(
          {
            provider: "ollama",
            ollama_host: "http://localhost:11434",
            ollama_model: "qwen2.5-coder:14b",
          },
          null,
          2,
        ),
      );
      writeFileSync(path.join(dir, "hello.txt"), "world\n", "utf8");

      const events: RunEventEnvelope[] = [];
      const result = await runStubRun(
        "List the files in the current directory",
        {
          workspaceRoot: dir,
          maxSteps: 3,
          onEvent: (e) => {
            events.push(e);
            // Real-time logging for debugging hangs
            if (
              e.event.type === "model.done" ||
              e.event.type === "tool.call" ||
              e.event.type === "tool.result"
            ) {
              console.log(
                `[event ${e.seq}]`,
                e.event.type,
                JSON.stringify(e.event).slice(0, 200),
              );
            }
          },
        },
      );

      const md = events.find((e) => e.event.type === "model.done");
      console.log("\n=== model.done text ===");
      console.log(
        md && "text" in md.event
          ? (md.event as Record<string, unknown>).text
          : "N/A",
      );
      console.log("\n=== result ===");
      console.log(JSON.stringify(result, null, 2));

      const toolCalls = events.filter((e) => e.event.type === "tool.call");
      const toolResults = events.filter((e) => e.event.type === "tool.result");
      console.log("\n=== summary ===");
      console.log("toolCalls.length:", toolCalls.length);
      console.log("toolResults.length:", toolResults.length);

      // Relaxed assertion: verify Ollama was called and returned something
      expect(events.some((e) => e.event.type === "model.done")).toBe(true);
      expect(result.ok).toBe(true);
    },
    180_000,
  );
});
