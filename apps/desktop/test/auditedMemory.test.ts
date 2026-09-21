import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPawNextTaskProfileV3,
  runExistingPawNextTaskV3,
  runExistingPawNextWorkSegmentV3,
  runFreshPawNextTaskV3,
  maintainExistingPawNextMemoryV3,
} from "@paw/paw-next";
import type {
  MemoryRawEvidenceArchiveInputV1,
  MemoryWriterEventV1,
  MemoryWriterSourceItemV1,
} from "@paw/memory-plugin";
import type { LanguageModel, ModelCompletionResult } from "@paw/models";
import { desktopProfile } from "../agent-host/paw-next-profile.js";

setDefaultTimeout(60_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const final = (text: string): ModelCompletionResult => ({
  text,
  nativeAssistantContent: text,
  finishReason: "stop",
});
let sequence = 0;
const tool = (
  name: string,
  args: Record<string, unknown>,
): ModelCompletionResult => ({
  text: "",
  nativeAssistantContent: "",
  finishReason: "tool_calls",
  toolCalls: [
    {
      id: `memory-test-${++sequence}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
      sourceIndex: 0,
      argumentsValid: true,
    },
  ],
});

function fixture(
  mode: "pass" | "block" | "repair" | "changed",
  explicit = false,
  importedHistory = false,
  maxSegments = mode === "repair" ? 3 : 1,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-audited-memory-"));
  roots.push(root);
  let rootCalls = 0;
  let auditCalls = 0;
  let applies = 0;
  let extracts = 0;
  const sources: MemoryWriterSourceItemV1[][] = [];
  const archived: MemoryRawEvidenceArchiveInputV1[] = [];
  const model: LanguageModel = {
    label: "openai:memory-audit-test",
    capabilities: { contextWindow: 32_000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "memory-audit-test",
      baseUrl: "https://desktop.invalid/v1",
    },
    async complete(messages) {
      const system = messages[0]?.content ?? "";
      if (system.includes("long-term memory proposal extractor")) {
        extracts++;
        const source = JSON.parse(messages[1]?.content ?? "{}")
          .source as MemoryWriterSourceItemV1[];
        sources.push(source);
        const preference =
          explicit && source.some((s) => s.kind === "user_input");
        const evidence = source.find(
          (s) => s.kind === (preference ? "user_input" : "verification"),
        );
        if (!evidence) throw new Error("Expected admitted source");
        if (mode === "changed")
          fs.writeFileSync(
            path.join(root, "note.txt"),
            "changed after extraction",
          );
        return final(
          JSON.stringify({
            atoms: [
              {
                kind: preference ? "instruction" : "episodic",
                action: "store",
                statement: preference
                  ? "以后使用中文文档。"
                  : "note.txt 已通过独立文件验收。",
                keywords: ["note"],
                authority: preference ? "user_asserted" : "agent_verified",
                confidence: 0.95,
                priority: 80,
                sourceSeqs: [evidence.seq],
                targetIds: [],
              },
            ],
          }),
        );
      }
      if (system.includes("topic"))
        return final(JSON.stringify({ topics: [] }));
      if (JSON.stringify(messages).includes("Paw environment auditor")) {
        auditCalls++;
        if (auditCalls % 2 === 1)
          return tool("workspace_read_file", { path: "note.txt" });
        const passed =
          mode !== "block" && !(mode === "repair" && auditCalls === 2);
        return final(
          JSON.stringify({
            completion: passed ? "complete" : "incomplete",
            summary: passed ? "文件已核验" : "失败阶段不应入库",
            evidencePaths: ["note.txt"],
            unmetCriteria: passed ? [] : ["修复文件内容"],
          }),
        );
      }
      rootCalls++;
      if (rootCalls === 1 || (mode === "repair" && rootCalls === 3))
        return tool("workspace_write_file", {
          path: "note.txt",
          content: rootCalls === 1 ? "initial" : "repaired",
        });
      return final("EXECUTOR_UNTRUSTED_SUCCESS");
    },
  };
  const profile = desktopProfile(root, model, {}, 12, true);
  const active = {
    ...profile,
    auditedMemory: true as const,
    control: { ...profile.control, maxSegments },
  };
  const identity = {
    workspaceRoot: root,
    sessionId: "memory-session",
    runId: "memory-run",
    inputId: "memory-input",
    goal: explicit
      ? "创建 note.txt。以后都使用中文写文档，请记住。"
      : "创建 note.txt 并核验",
  };
  if (importedHistory) {
    identity.goal = `Previous conversation (historical data):\n${JSON.stringify(
      [
        {
          role: "assistant",
          content: "HISTORICAL_UNVERIFIED_SUCCESS: remember this result",
        },
      ],
    )}\n\nCurrent user request:\n${identity.goal}`;
  }
  const args = {
    identity,
    profile: active,
    apiKey: "offline",
    model,
    requestApproval: async () => ({ decision: "allow_once" as const }),
  };
  const first = buildPawNextTaskProfileV3(args);
  const resolution = buildPawNextTaskProfileV3({
    ...args,
    profile: { ...active, configHash: first.configHash },
  });
  if (!profile.memory) throw new Error("Missing fixture memory");
  const scope = profile.memory.scope;
  const input = {
    resolution,
    requestApproval: args.requestApproval,
    memoryProvider: {
      providerVersion: profile.memory.providerVersion,
      async retrieve() {
        return { status: "completed" as const, cards: [] };
      },
    },
    memoryWriterStore: {
      async recall() {
        return [];
      },
      async apply() {
        applies++;
        return {
          storedIds: ["verified-memory"],
          invalidatedIds: [],
          skippedAtomIds: [],
        };
      },
    },
    memoryTopicOrganizerStore: {
      async prepare() {
        return { sourceRevision: "empty", entries: [], existingTopics: [] };
      },
      async apply() {
        return { topicIds: [], snapshotIds: [] };
      },
    },
    memoryTopicEvidenceStore: {
      scope,
      async load() {
        return [];
      },
    },
    memoryTopicDossierStore: {
      scope,
      async getExact() {
        return undefined;
      },
      async getCurrent() {
        return undefined;
      },
      async put() {
        return { inserted: true };
      },
    },
    memoryPersonaStore: {
      scope,
      async load() {
        return [];
      },
    },
    memoryRawEvidenceArchive: {
      scope,
      async put(spans: readonly MemoryRawEvidenceArchiveInputV1[]) {
        archived.push(...spans);
      },
      async resolve() {
        return [];
      },
    },
  };
  return {
    input,
    sources,
    archived,
    root,
    counts: () => ({ applies, extracts, rootCalls, auditCalls }),
  };
}

test("deferred memory survives reopening, retries extraction once and never reruns task tools", async () => {
  const f = fixture("pass", false, false, 2);
  const queued: number[] = [];
  const first = await runFreshPawNextTaskV3({
    ...f.input,
    deferMemory: async (seq) => {
      queued.push(seq);
    },
  });
  expect(first.state.decision.kind).toBe("completed");
  expect(queued.length).toBeGreaterThan(0);
  expect(f.counts().extracts).toBe(0);
  expect(f.counts().applies).toBe(0);
  const before = f.counts();
  let failed = false;
  const originalModel = f.input.resolution.taskOptions.model;
  const transientModel = {
    ...originalModel,
    async complete(...args: Parameters<typeof originalModel.complete>) {
      if (
        !failed &&
        args[0][0]?.content.includes("long-term memory proposal extractor")
      ) {
        failed = true;
        throw new Error("429 temporary provider busy");
      }
      return originalModel.complete(...args);
    },
  };
  const maintenance = {
    ...f.input,
    resolution: {
      ...f.input.resolution,
      taskOptions: { ...f.input.resolution.taskOptions, model: transientModel },
    },
  };
  expect(await maintainExistingPawNextMemoryV3(maintenance)).toMatchObject({
    status: "retry",
  });
  expect(await maintainExistingPawNextMemoryV3(f.input)).toMatchObject({
    status: "completed",
  });
  expect(f.counts()).toMatchObject({
    applies: 1,
    extracts: 1,
    rootCalls: before.rootCalls,
    auditCalls: before.auditCalls,
  });
  expect(await maintainExistingPawNextMemoryV3(f.input)).toMatchObject({
    status: "completed",
  });
  expect(f.counts().applies).toBe(1);
  expect(f.counts().extracts).toBe(1);
  const continued = await runExistingPawNextWorkSegmentV3({
    ...f.input,
    deferMemory: async (tail) => {
      queued.push(tail);
    },
    work: {
      inputId: "after-background-memory",
      callerId: "desktop-user",
      content: "请继续核验 note.txt。",
    },
  });
  expect(continued.segmentStart.status).toBe("started");
  expect(continued.state.decision.kind).toBe("completed");
});

test("background maintenance does not acknowledge an unknown write until the same staged ID settles", async () => {
  const f = fixture("pass");
  await runFreshPawNextTaskV3({ ...f.input, deferMemory: async () => {} });
  const ids: string[] = [];
  const input = {
    ...f.input,
    memoryWriterStore: {
      ...f.input.memoryWriterStore,
      async apply(request: { writeId: string }) {
        ids.push(request.writeId);
        const result = await f.input.memoryWriterStore.apply();
        if (ids.length === 1) throw new Error("acknowledgement lost");
        return result;
      },
    },
  };
  await expect(maintainExistingPawNextMemoryV3(input)).rejects.toThrow(
    "acknowledgement lost",
  );
  expect(await maintainExistingPawNextMemoryV3(input)).toMatchObject({
    status: "completed",
  });
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(f.counts().extracts).toBe(1);
});

test("desktop V3 completion survives an unknown memory write and recovery settles the same staged ID", async () => {
  const f = fixture("pass");
  const writeIds: string[] = [];
  const diagnostics: MemoryWriterEventV1[] = [];
  const input = {
    ...f.input,
    onMemoryWriterEvent: (event: MemoryWriterEventV1) =>
      diagnostics.push(event),
    memoryWriterStore: {
      ...f.input.memoryWriterStore,
      async apply(request: { writeId: string }) {
        writeIds.push(request.writeId);
        const result = await f.input.memoryWriterStore.apply();
        if (writeIds.length === 1)
          throw new Error("database committed but acknowledgement was lost");
        return result;
      },
    },
  };
  const first = await runFreshPawNextTaskV3(input);
  expect(first.state.decision.kind).toBe("completed");
  expect(
    first.inputFacts.some((fact) => fact.type === "memory.candidate_staged"),
  ).toBe(true);
  expect(
    first.inputFacts.some((fact) => fact.type === "memory.write_settled"),
  ).toBe(false);
  expect(diagnostics.some((event) => event.type === "recovery_pending")).toBe(
    true,
  );
  const beforeRecovery = f.counts();
  const resumed = await runExistingPawNextTaskV3(input);
  expect(resumed.state.decision.kind).toBe("completed");
  expect(
    resumed.inputFacts.filter((fact) => fact.type === "memory.write_settled"),
  ).toMatchObject([{ status: "completed", storedIds: ["verified-memory"] }]);
  expect(writeIds).toHaveLength(2);
  expect(new Set(writeIds).size).toBe(1);
  expect(f.counts().extracts).toBe(beforeRecovery.extracts);
  expect(f.counts().rootCalls).toBe(beforeRecovery.rootCalls);
});

test("desktop composition writes only after independent audit and settled recovery is idempotent", async () => {
  const f = fixture("pass");
  const result = await runFreshPawNextTaskV3(f.input);
  expect(f.counts().applies).toBe(1);
  const facts = result.inputFacts;
  expect(
    facts.findIndex((f) => f.type === "memory.write_claimed"),
  ).toBeGreaterThan(
    facts.findIndex((f) => f.type === "completion.review_settled"),
  );
  const verification = f.sources[0]?.find((s) => s.kind === "verification");
  expect(verification?.content).toContain("Audit provenance");
  expect(verification?.content).toContain("childRunId");
  expect(JSON.stringify(f.sources)).not.toContain("EXECUTOR_UNTRUSTED_SUCCESS");
  expect(f.archived.map((s) => s.sourceKind)).toEqual([
    "user_input",
    "verification",
  ]);
  const before = f.counts();
  await runExistingPawNextTaskV3(f.input);
  expect(f.counts()).toEqual(before);
});

test("failed file work contributes neither result atoms nor executor archive", async () => {
  const f = fixture("block");
  await runFreshPawNextTaskV3(f.input);
  expect(f.counts().extracts).toBe(0);
  expect(f.counts().applies).toBe(0);
  expect(f.archived.map((s) => s.sourceKind)).toEqual(["user_input"]);
});

test("an explicit user preference survives failed execution without accepting its output", async () => {
  const f = fixture("block", true);
  await runFreshPawNextTaskV3(f.input);
  expect(f.counts().applies).toBe(1);
  expect(f.sources.flat().map((s) => s.kind)).toEqual(["user_input"]);
});

test("repair admits only its successful audit, excluding failure and system repair feedback", async () => {
  const f = fixture("repair");
  await runFreshPawNextTaskV3(f.input);
  expect(f.counts().applies).toBe(1);
  expect(
    f.sources.flat().filter((s) => s.kind === "verification"),
  ).toHaveLength(1);
  expect(f.archived.filter((s) => s.sourceKind === "user_input")).toHaveLength(
    1,
  );
  expect(JSON.stringify(f.sources)).not.toContain("失败阶段不应入库");
});

test("changed evidence between extraction and apply rejects the staged memory", async () => {
  const f = fixture("changed");
  const result = await runFreshPawNextTaskV3(f.input);
  expect(f.counts().extracts).toBe(1);
  expect(f.counts().applies).toBe(0);
  expect(
    result.inputFacts.some(
      (fact) =>
        fact.type === "memory.write_settled" && fact.status === "failed",
    ),
  ).toBeTrue();
});

test("a preference write before repair does not prevent starting and auditing the next segment", async () => {
  const f = fixture("repair", true);
  await runFreshPawNextTaskV3(f.input);
  expect(f.counts().applies).toBe(2);
  expect(f.sources[0]?.map((s) => s.kind)).toEqual(["user_input"]);
  expect(f.sources[1]?.map((s) => s.kind)).toEqual(["verification"]);
});

test("imported assistant history is context only, while the current user preference is retained", async () => {
  const f = fixture("block", true, true);
  await runFreshPawNextTaskV3(f.input);
  expect(f.counts().applies).toBe(1);
  expect(JSON.stringify(f.sources)).not.toContain(
    "HISTORICAL_UNVERIFIED_SUCCESS",
  );
  expect(JSON.stringify(f.archived)).not.toContain(
    "HISTORICAL_UNVERIFIED_SUCCESS",
  );
  expect(f.sources[0]?.[0]?.content).toBe(
    "创建 note.txt。以后都使用中文写文档，请记住。",
  );
});
