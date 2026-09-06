import { expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel, ModelCompletionResult } from "@paw/models";
import { readDesktopMonitor, runDesktopNext } from "../agent-host/paw-next.js";

setDefaultTimeout(90_000);
const final = (text: string): ModelCompletionResult => ({
  text,
  nativeAssistantContent: text,
  finishReason: "stop",
});
const tool = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelCompletionResult => ({
  text: "",
  nativeAssistantContent: "",
  finishReason: "tool_calls",
  toolCalls: [
    {
      id,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
      sourceIndex: 0,
      argumentsValid: true,
    },
  ],
});

for (const outcome of [
  "pass",
  "broken",
  "denied",
  "long",
  "visual_pass",
  "visual_fail",
  "visual_unknown",
  "visual_unavailable",
  "visual_long",
] as const)
  test(`desktop browser audit: ${outcome}, durable evidence and recovery`, async () => {
    const isLong = outcome === "long" || outcome === "visual_long";
    const visual = outcome.startsWith("visual_");
    const verified = ["pass", "long", "visual_pass", "visual_long"].includes(
      outcome,
    );
    let visualCalls = 0;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-browser-desktop-"));
    const source = path.join(root, "index.html");
    if (isLong) {
      fs.mkdirSync(path.join(root, ".paw", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".paw", "agents", "writer.md"),
        `---
id: writer
name: Writer
role: code implementation
capabilities: implementation
tools: read_file, write_file
childPolicy: read_write
model: inherit
outputFormat: Return changed files.
canSpawn: false
maxSteps: 4
kind: worker
---
Browser fixture writer.
`,
      );
    }
    let served = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        served++;
        return new Response(fs.readFileSync(source), {
          headers: { "content-type": "text/html" },
        });
      },
    });
    let roots = 0;
    let audits = 0;
    let executorCalls = 0;
    let approvalCount = 0;
    const report = (id: string) =>
      JSON.stringify({
        completion: "complete",
        summary: "已检查按钮行为",
        evidencePaths: ["index.html"],
        unmetCriteria: [],
        browserRequired: true,
        browserChecks: [id],
      });
    const model: LanguageModel = {
      label: "openai:browser-audit-test",
      capabilities: {
        contextWindow: 32000,
        maxOutputTokens: 4096,
        ...(visual && outcome !== "visual_unavailable"
          ? { imageInput: true as const }
          : {}),
      },
      runtimeProfile: {
        protocol: "openai-compatible",
        model: "browser-audit-test",
        baseUrl: "https://desktop.invalid/v1",
      },
      async complete(messages, options) {
        if (
          messages[0]?.content.startsWith(
            "You independently audit the attached",
          )
        ) {
          visualCalls++;
          expect(options?.tools).toEqual([]);
          expect(messages).toHaveLength(2);
          const attachment = messages[1]?.attachments?.[0];
          expect(attachment?.type).toBe("image");
          expect(
            attachment?.content.startsWith("data:image/png;base64,iVBOR"),
          ).toBe(true);
          const prompt = messages[0].content;
          const verdict =
            outcome === "visual_fail"
              ? "fail"
              : outcome === "visual_unknown"
                ? "unknown"
                : "pass";
          return final(
            JSON.stringify({
              screenshotHash: prompt.match(
                /"screenshotHash":"([a-f0-9]+)"/,
              )?.[1],
              requirementsHash: prompt.match(
                /"requirementsHash":"([a-f0-9]+)"/,
              )?.[1],
              verdict,
              summary: "独立截图检查",
              checks: [
                {
                  criterion: "计数器文字清晰可见",
                  verdict,
                  observation: "按钮下方显示 Count: 1，无裁切。",
                },
              ],
            }),
          );
        }
        const auditor = JSON.stringify(messages).includes(
          "Paw environment auditor",
        );
        const tools = options?.tools?.map((tool) => tool.function.name) ?? [];
        if (auditor) {
          expect(tools).toContain("workspace_browser_check");
          expect(tools).not.toContain("workspace_run_shell");
          expect(tools).not.toContain("workspace_write_file");
          audits++;
          const round = Math.floor((audits - 1) / 3);
          if (audits % 3 === 1)
            return tool(`read-${round}`, "workspace_read_file", {
              path: "index.html",
            });
          if (audits % 3 === 2)
            return tool(`browser-${round}`, "workspace_browser_check", {
              url: server.url.href,
              steps: [
                { action: "click", selector: "#increment" },
                {
                  action: "assert_text",
                  selector: "#counter",
                  value: "Count: 1",
                },
              ],
            });
          return final(report(`browser-${round}`));
        }
        expect(tools).not.toContain("workspace_browser_check");
        const executor =
          isLong &&
          JSON.stringify(messages).includes("Browser fixture writer.");
        if (!executor && isLong) {
          if (++roots === 1)
            return tool("delegate-page", "workspace_delegate", {
              goal: `实现 ${server.url.href} 的计数器`,
              kind: "implementation",
              agent_id: "writer",
              scope: ["index.html"],
              acceptance: ["点击 Increment 后显示 Count: 1"],
              max_steps: 4,
            });
          return final("阶段已完成，请核验整体结果。");
        }
        if ((executor ? ++executorCalls : ++roots) === 1)
          return tool("write-page", "workspace_write_file", {
            path: "index.html",
            content: `<!doctype html><html><body><button id="increment" onclick="document.querySelector('#counter').textContent='Count: ${outcome === "broken" ? "0" : "1"}'">Increment</button><p id="counter">Count: 0</p></body></html>`,
          });
        return final("完成按钮与计数器。");
      },
    };
    const options = {
      workspaceRoot: root,
      conversationId: "browser",
      memoryEnabled: false,
      ...(visual ? { visualAudit: true as const } : {}),
      ...(isLong ? { taskMode: "long" as const } : {}),
      settings: {},
      model,
      resolveToolApproval: async (request: { tool?: string }) => {
        if (
          request.tool === "workspace.browser_check" ||
          request.tool === "workspace_browser_check"
        ) {
          approvalCount++;
          return outcome !== "denied";
        }
        return true;
      },
      onEvent() {},
    };
    try {
      const result = await runDesktopNext(
        `实现 ${server.url.href} 的计数器，点击 Increment 后显示 Count: 1。`,
        options,
      );
      expect(JSON.parse(result.text).acceptance).toBe(
        verified ? "verified" : "unverified",
      );
      expect(approvalCount).toBeGreaterThan(0);
      const audit = readDesktopMonitor(root, "browser")?.audit;
      if (verified) {
        expect(audit?.browserChecks).toHaveLength(1);
        expect(audit?.browserChecks?.[0]).toMatchObject({
          callId: isLong ? "browser-1" : "browser-0",
          url: server.url.href,
          assertions: 1,
        });
        if (visual) {
          expect(visualCalls).toBe(1);
          expect(audit?.browserChecks?.[0]?.visual?.verdict).toBe("pass");
          const screenshot = audit?.browserChecks?.[0]?.visual?.screenshotHash;
          expect(
            fs.existsSync(
              path.join(root, ".paw", "visual-audits", `${screenshot}.png`),
            ),
          ).toBe(true);
        }
        const before = { roots, audits, served, visualCalls };
        await runDesktopNext("恢复计数器任务", {
          ...options,
          intent: "recover",
          visualAudit: undefined, // recovery must retain the original task policy
        });
        expect({ roots, audits, served, visualCalls }).toEqual(before);
        expect(
          readDesktopMonitor(root, "browser")?.audit?.browserChecks,
        ).toEqual(audit?.browserChecks);
        if (isLong) {
          const stage = readDesktopMonitor(root, "browser")?.tasks.find(
            (task) => task.stageRef,
          );
          expect(stage?.audit?.browserChecks?.[0]?.callId).toBe("browser-0");
          expect(stage?.freshness?.status).toBe("verified");
          expect(executorCalls).toBe(2);
        }
      } else {
        expect(audit?.status).toBe("unverified");
        if (outcome === "denied" || outcome === "visual_unavailable")
          expect(served).toBe(0);
        if (outcome === "visual_unavailable") expect(visualCalls).toBe(0);
        if (outcome === "visual_fail" || outcome === "visual_unknown") {
          expect(visualCalls).toBeGreaterThan(0);
          expect(audit?.browserChecks?.[0]?.visual?.verdict).toBe(
            outcome === "visual_fail" ? "fail" : "unknown",
          );
        }
      }
    } finally {
      await server.stop(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
