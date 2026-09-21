// Offline reproduction: intercept the auditor boundary to expose the exception
// hidden behind AuditUnavailable without changing production code or calling API.
import { mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tasks } from "./tasks.js";
const moduleUrl = new URL(
  "../../packages/paw-next/src/environment-audit.ts",
  import.meta.url,
).href;
const original = await import(moduleUrl);
const factory = original.createEnvironmentCompletionReviewerV1;
const errors: string[] = [];
mock.module(moduleUrl, () => ({
  ...original,
  createEnvironmentCompletionReviewerV1(options: any) {
    return factory({
      ...options,
      async run(...args: any[]) {
        try {
          return await options.run(...args);
        } catch (e) {
          errors.push(String(e));
          throw e;
        }
      },
    });
  },
}));
const { runDesktopNext } = await import(
  "../../apps/desktop/agent-host/paw-next.js"
);
const output = [];
for (const verbose of [false, true]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-audit-repro-"));
  fs.writeFileSync(path.join(root, "REQUIREMENTS.md"), tasks.queue.goal);
  fs.writeFileSync(path.join(root, ".gitignore"), ".paw/\n");
  for (const argv of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Audit Repro",
      "-c",
      "user.email=repro@localhost",
      "commit",
      "-qm",
      "seed",
    ],
  ]) {
    const r = spawnSync("git", argv, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  let id = 0,
    manager = 0,
    worker = 0,
    auditor = 0;
  const final = (text: string) => ({
    text,
    nativeAssistantContent: text,
    finishReason: "stop",
  });
  const call = (name: string, args: Record<string, unknown>) => ({
    text: "",
    nativeAssistantContent: "",
    finishReason: "tool_calls",
    toolCalls: [
      {
        id: `repro-${++id}`,
        name,
        arguments: args,
        rawArguments: JSON.stringify(args),
        sourceIndex: 0,
        argumentsValid: true,
      },
    ],
  });
  const model = {
    label: "openai:audit-repro",
    capabilities: { contextWindow: 1000000, maxOutputTokens: 128000 },
    runtimeProfile: {
      protocol: "openai-compatible" as const,
      model: "audit-repro",
      baseUrl: "https://offline.invalid/v1",
    },
    async complete(messages: any) {
      const text = JSON.stringify(messages);
      if (text.includes("You are the Paw environment auditor")) {
        auditor++;
        if (auditor % 2 === 1)
          return call("workspace_read_file", { path: "REQUIREMENTS.md" });
        return final(
          JSON.stringify({
            completion: "complete",
            summary: "Actual requirements inspected",
            evidencePaths: ["REQUIREMENTS.md"],
            unmetCriteria: [],
          }),
        );
      }
      if (
        messages.some(
          (m: any) =>
            m.role === "system" &&
            String(m.content).includes("long-task Manager"),
        )
      ) {
        manager++;
        if (manager === 1)
          return call("workspace_delegate", {
            goal: "Inspect requirements",
            kind: "investigation",
            tasks: [
              {
                id: "inspect",
                goal: "Read REQUIREMENTS.md and report its requirements, without editing files.",
                kind: "investigation",
                agent_id: "bige",
                scope: ["REQUIREMENTS.md"],
                acceptance: [
                  "Report the actual requirements after reading the file",
                ],
                max_steps: 3,
              },
            ],
          });
        return final("Inspection complete.");
      }
      worker++;
      if (worker === 1)
        return call("workspace_read_file", { path: "REQUIREMENTS.md" });
      return final(
        verbose
          ? tasks.queue.goal.repeat(3)
          : "REQUIREMENTS.md requests a job queue library, persistence, CLI and tests.",
      );
    },
  };
  const start = errors.length;
  try {
    const result = await runDesktopNext(tasks.queue.goal, {
      workspaceRoot: root,
      conversationId: "repro",
      taskMode: "long",
      model,
      settings: {},
      memoryEnabled: false,
      maxSteps: 2,
      abortSignal: AbortSignal.timeout(30000),
      resolveToolApproval: async () => true,
      onEvent() {},
    });
    output.push({
      verbose,
      manager,
      worker,
      auditor,
      errors: errors.slice(start),
      result: JSON.parse(result.text),
      workspace: root,
    });
  } catch (e) {
    output.push({
      verbose,
      error: String(e),
      errors: errors.slice(start),
      workspace: root,
    });
  }
}
console.log(JSON.stringify(output, null, 2));
