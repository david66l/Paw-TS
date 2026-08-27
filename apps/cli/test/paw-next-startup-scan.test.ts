import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelCompletionResult,
} from "@paw/models";
import type { InputFactV1 } from "@paw/protocol";
import {
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
  readCommittedFileRunPrefixV1,
  readFileSessionAuthorityInventoryV1,
  readFileSessionJournalCommitIndexV1,
} from "@paw/runtime";

import {
  type RunExistingPawNextTaskOptionsV1,
  preparePawNextProductRuntimeV1,
  runFreshPawNextTaskV1,
} from "../src/paw-next/composition.js";
import {
  hashCanonicalJsonV1,
  toFrozenJsonValueV1,
} from "../src/paw-next/product-manifest.js";
import { scanAndResumePawNextRunsV1 } from "../src/paw-next/startup-scan.js";

const roots: string[] = [];
const childProcesses = new Set<ChildProcess>();

afterEach(async () => {
  const liveChildren = [...childProcesses];
  await Promise.all(
    liveChildren.map((child) =>
      withTimeout(
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill();
        }),
        "startup scanner child cleanup",
      ),
    ),
  );
  childProcesses.clear();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next startup scanner", () => {
  test("two real Bun scanners race one candidate but only one enters the model", async () => {
    const root = workspace();
    const now = futureClock();
    const options = processProductOptions(root, "process-race", now);
    await appendActionableRun(options);
    const first = startScannerChild(options, "compete", now);
    const second = startScannerChild(options, "compete", now);

    await Promise.all([first.message("ready"), second.message("ready")]);
    first.send("go");
    second.send("go");
    const firstEvent = first.messageAny(["model_entered", "result"]);
    const secondEvent = second.messageAny(["model_entered", "result"]);
    const events = await Promise.all([firstEvent, secondEvent]);
    expect(
      events.filter((event) => event.type === "model_entered"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "result")).toHaveLength(1);

    const winner = events[0]?.type === "model_entered" ? first : second;
    const loserEvent = events[0]?.type === "result" ? events[0] : events[1];
    expect(singleChildStatus(loserEvent)).toMatch(/^(busy|anchor_conflict)$/);
    winner.send("finish");
    const winnerResult = await winner.message("result");
    expect(singleChildStatus(winnerResult)).toBe("resumed");
    expect(childModelCalls(winnerResult) + childModelCalls(loserEvent)).toBe(1);
    expect(
      (await Promise.all([first.exited, second.exited])).map(exitCode),
    ).toEqual([0, 0]);
  });

  test("a process exit after discovery leaves no state and the next scan resumes once", async () => {
    const root = workspace();
    const now = futureClock();
    const options = processProductOptions(root, "discover-crash", now);
    await appendActionableRun(options);
    const before = rawTree(sessionDirectory(root, options.sessionId));
    const crashed = startScannerChild(options, "discover_exit", now);

    await crashed.message("discovered");
    expect(exitCode(await crashed.exited)).toBe(41);
    expect(rawTree(sessionDirectory(root, options.sessionId))).toEqual(before);

    const resumed = startScannerChild(options, "complete", now + 1_000);
    const result = await resumed.message("result");
    expect(singleChildStatus(result)).toBe("resumed");
    expect(childModelCalls(result)).toBe(1);
    expect(exitCode(await resumed.exited)).toBe(0);
  });

  test("repair and model-dispatch process exits each recover one unknown without model replay", async () => {
    // An unknown model repair is terminal/incomplete, so there is deliberately
    // no impossible repair -> next dispatch path in the interactive reducer.
    // This first run covers exit after repair has become canonical. There is
    // no production hook for the zero-width repair-commit -> decision window.
    const repairRoot = workspace();
    const repairNow = futureClock();
    const repairOptions = processProductOptions(
      repairRoot,
      "repair-crash",
      repairNow,
    );
    await appendActionableRun(repairOptions);
    await mutateRun(repairOptions, (session) =>
      session.appendInputFacts([modelDispatch()]),
    );
    const repairCrash = startScannerChild(
      repairOptions,
      "exit_after_report",
      repairNow,
    );
    const repairedResult = await repairCrash.message("result");
    expect(singleChildStatus(repairedResult)).toBe("resumed");
    expect(childModelCalls(repairedResult)).toBe(0);
    expect(exitCode(await repairCrash.exited)).toBe(43);
    expect(
      modelUnknowns(await strictFacts(repairOptions), "model-1"),
    ).toHaveLength(1);
    const repairRestart = startScannerChild(
      repairOptions,
      "complete",
      repairNow + 1_000,
    );
    const repairRestarted = await repairRestart.message("result");
    expect(singleChildStatus(repairRestarted)).toBe("terminal");
    expect(childModelCalls(repairRestarted)).toBe(0);
    expect(exitCode(await repairRestart.exited)).toBe(0);
    expect(
      modelUnknowns(await strictFacts(repairOptions), "model-1"),
    ).toHaveLength(1);

    const dispatchRoot = workspace();
    const dispatchNow = futureClock();
    const dispatchOptions = processProductOptions(
      dispatchRoot,
      "dispatch-crash",
      dispatchNow,
    );
    await appendActionableRun(dispatchOptions);
    const dispatchCrash = startScannerChild(
      dispatchOptions,
      "exit_in_model",
      dispatchNow,
    );
    await dispatchCrash.message("model_entered");
    expect(exitCode(await dispatchCrash.exited)).toBe(42);
    const openDispatch = await strictFacts(dispatchOptions);
    expect(
      openDispatch.filter(
        (fact) =>
          fact.type === "model.dispatch_recorded" &&
          fact.modelCallId === "model-1",
      ),
    ).toHaveLength(1);
    expect(modelUnknowns(openDispatch, "model-1")).toHaveLength(0);

    const dispatchRestart = startScannerChild(
      dispatchOptions,
      "complete",
      dispatchNow + 1_000,
    );
    const dispatchRestarted = await dispatchRestart.message("result");
    expect(singleChildStatus(dispatchRestarted)).toBe("resumed");
    expect(childModelCalls(dispatchRestarted)).toBe(0);
    expect(exitCode(await dispatchRestart.exited)).toBe(0);
    expect(
      modelUnknowns(await strictFacts(dispatchOptions), "model-1"),
    ).toHaveLength(1);
  });

  test("a process exit after a terminal decision makes later scans read-only", async () => {
    const root = workspace();
    const now = futureClock();
    const options = processProductOptions(root, "terminal-crash", now);
    await appendActionableRun(options);
    const crashed = startScannerChild(options, "exit_after_report", now);

    const completed = await crashed.message("result");
    expect(singleChildStatus(completed)).toBe("resumed");
    expect(childModelCalls(completed)).toBe(1);
    expect(exitCode(await crashed.exited)).toBe(43);
    const terminalFacts = await strictFacts(options);
    expect(
      terminalFacts.filter((fact) => fact.type === "model.settled"),
    ).toHaveLength(1);
    const beforeRestart = rawTree(sessionDirectory(root, options.sessionId));

    const restarted = startScannerChild(options, "complete", now + 1_000);
    const result = await restarted.message("result");
    expect(singleChildStatus(result)).toBe("terminal");
    expect(childModelCalls(result)).toBe(0);
    expect(exitCode(await restarted.exited)).toBe(0);
    expect(rawTree(sessionDirectory(root, options.sessionId))).toEqual(
      beforeRestart,
    );
  });

  test("an absent workspace inventory stays absent and creates nothing", async () => {
    const root = workspace();
    const before = rawTree(root);
    let resolverCalls = 0;

    const report = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions() {
        resolverCalls += 1;
        return undefined;
      },
    });

    expect(report).toEqual({ issues: [], runs: [] });
    expect(resolverCalls).toBe(0);
    expect(rawTree(root)).toEqual(before);
  });

  test("terminal and pending runs are classified twice with zero new lease event or mutation", async () => {
    const root = workspace();
    const terminal = productOptions(root, "terminal", finalModel("done"));
    await runFreshPawNextTaskV1(terminal);
    const pending = productOptions(root, "pending", finalModel("done"));
    await runFreshPawNextTaskV1(pending);
    await mutateRun(pending, (session) =>
      session.appendInputFacts([accepted("pending-input")]),
    );
    const models = new Map<string, ScriptedModel>();
    const resolver = resolverFor([terminal, pending], models);
    const before = rawTree(root);

    const first = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions: resolver,
    });
    const second = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions: resolver,
    });

    expect(runStatuses(first)).toEqual([
      [pending.sessionId, pending.runId, "blocked_pending"],
      [terminal.sessionId, terminal.runId, "terminal"],
    ]);
    expect(second).toEqual(first);
    expect(
      [...models.values()].flatMap((model) => model.requests),
    ).toHaveLength(0);
    expect(rawTree(root)).toEqual(before);
  });

  test("two actionable runs in one Session are ambiguous and execute neither", async () => {
    const root = workspace();
    const first = productOptions(
      root,
      "shared-session-z",
      new ScriptedModel([]),
      "shared-session",
      "run-z",
    );
    const second = productOptions(
      root,
      "shared-session-a",
      new ScriptedModel([]),
      "shared-session",
      "run-a",
    );
    await appendActionableRun(first);
    await appendActionableRun(second);
    const models = new Map<string, ScriptedModel>();
    const before = rawTree(root);

    const report = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions: resolverFor([first, second], models),
    });

    expect(runStatuses(report)).toEqual([
      ["shared-session", "run-a", "ambiguous_session"],
      ["shared-session", "run-z", "ambiguous_session"],
    ]);
    expect(
      [...models.values()].flatMap((model) => model.requests),
    ).toHaveLength(0);
    expect(rawTree(root)).toEqual(before);
  });

  test("cross-Session candidates are stably ordered and only the first executes", async () => {
    const root = workspace();
    const later = productOptions(
      root,
      "later",
      new ScriptedModel([]),
      "session-z",
      "run-z",
    );
    const first = productOptions(
      root,
      "first",
      new ScriptedModel([]),
      "session-a",
      "run-a",
    );
    await appendActionableRun(later);
    await appendActionableRun(first);
    const firstModel = finalModel("first resumed");
    const laterModel = finalModel("must stay deferred");

    const report = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions: resolverFor(
        [first, later],
        new Map([
          [identityKey(first.sessionId, first.runId), firstModel],
          [identityKey(later.sessionId, later.runId), laterModel],
        ]),
      ),
    });

    expect(runStatuses(report)).toEqual([
      ["session-a", "run-a", "resumed"],
      ["session-z", "run-z", "deferred"],
    ]);
    expect(firstModel.requests).toHaveLength(1);
    expect(laterModel.requests).toHaveLength(0);
  });

  test("two concurrent scanners let only one blocked-model winner resume", async () => {
    const root = workspace();
    const seed = productOptions(root, "concurrent", new ScriptedModel([]));
    await appendActionableRun(seed);
    const model = new BlockingModel();
    const resolver = () => ({ ...seed, model });

    const first = scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions: resolver,
    });
    const second = scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions: resolver,
    });
    await model.started.promise;
    const loser = await Promise.race([first, second]);
    expect(loser.runs[0]?.status).toMatch(/busy|anchor_conflict/);
    model.finish({
      text: "winner resumed",
      nativeAssistantContent: "winner resumed",
      finishReason: "stop",
    });
    const reports = await Promise.all([first, second]);

    const statuses = reports.map((report) => report.runs[0]?.status);
    expect(statuses.filter((status) => status === "resumed")).toHaveLength(1);
    expect(
      statuses.filter(
        (status) => status === "busy" || status === "anchor_conflict",
      ),
    ).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  test("repairs open model and dispatched tool work once before reporting pending", async () => {
    for (const lifecycle of ["model", "tool"] as const) {
      const root = workspace();
      const model = new ScriptedModel([]);
      const base = productOptions(root, `repair-pending-${lifecycle}`, model);
      const options =
        lifecycle === "tool"
          ? { ...base, permissionConfig: allowAllPermissions() }
          : base;
      await appendActionableRun(options);
      await mutateRun(options, (session) =>
        session.appendInputFacts(
          lifecycle === "model"
            ? [modelDispatch(), accepted(`pending-during-open-${lifecycle}`)]
            : [
                ...openDispatchedWriteFacts(),
                accepted(`pending-during-open-${lifecycle}`),
              ],
        ),
      );
      const resolver = () => ({ ...options, model });

      const first = await scanAndResumePawNextRunsV1({
        workspaceRoot: root,
        resolveOptions: resolver,
      });
      const second = await scanAndResumePawNextRunsV1({
        workspaceRoot: root,
        resolveOptions: resolver,
      });

      expect(first.runs[0]).toMatchObject({
        status: "blocked_pending",
        inputIds: [`pending-during-open-${lifecycle}`],
      });
      expect(second.runs[0]).toMatchObject({
        status: "blocked_pending",
        inputIds: [`pending-during-open-${lifecycle}`],
      });
      expect(model.requests, lifecycle).toHaveLength(0);
      const facts = await strictFacts(options);
      if (lifecycle === "model") {
        expect(
          facts.filter(
            (fact) =>
              fact.type === "model.settled" &&
              fact.modelCallId === "model-1" &&
              fact.status === "unknown",
          ),
        ).toHaveLength(1);
      } else {
        expect(
          facts.filter(
            (fact) =>
              fact.type === "tool.settled" &&
              fact.callId === "write-open" &&
              fact.status === "unknown",
          ),
        ).toHaveLength(1);
        expect(fs.existsSync(path.join(root, "must-not-exist.txt"))).toBe(
          false,
        );
      }
    }
  });

  test("Session-local config failures do not block a healthy Session", async () => {
    const unavailableRoot = workspace();
    const unavailable = productOptions(
      unavailableRoot,
      "unavailable",
      new ScriptedModel([]),
      "session-a",
      "run-a",
    );
    const deferred = productOptions(
      unavailableRoot,
      "deferred",
      new ScriptedModel([]),
      "session-b",
      "run-b",
    );
    await appendActionableRun(unavailable);
    await appendActionableRun(deferred);
    const deferredModel = finalModel("must not run");
    const unavailableReport = await scanAndResumePawNextRunsV1({
      workspaceRoot: unavailableRoot,
      resolveOptions(identity) {
        return identity.sessionId === unavailable.sessionId
          ? undefined
          : { ...deferred, model: deferredModel };
      },
    });
    expect(runStatuses(unavailableReport)).toEqual([
      ["session-a", "run-a", "config_unavailable"],
      ["session-b", "run-b", "resumed"],
    ]);
    expect(deferredModel.requests).toHaveLength(1);

    const sameUnavailableRoot = workspace();
    const sameUnavailable = productOptions(
      sameUnavailableRoot,
      "same-unavailable",
      new ScriptedModel([]),
      "shared-unavailable-session",
      "run-a",
    );
    const sameUnavailableDeferred = productOptions(
      sameUnavailableRoot,
      "same-unavailable-deferred",
      new ScriptedModel([]),
      "shared-unavailable-session",
      "run-b",
    );
    await appendActionableRun(sameUnavailable);
    await appendActionableRun(sameUnavailableDeferred);
    const sameUnavailableModel = finalModel("must not run");
    const sameUnavailableReport = await scanAndResumePawNextRunsV1({
      workspaceRoot: sameUnavailableRoot,
      resolveOptions(identity) {
        return identity.runId === sameUnavailable.runId
          ? undefined
          : { ...sameUnavailableDeferred, model: sameUnavailableModel };
      },
    });
    expect(runStatuses(sameUnavailableReport)).toEqual([
      ["shared-unavailable-session", "run-a", "config_unavailable"],
      ["shared-unavailable-session", "run-b", "deferred"],
    ]);
    expect(sameUnavailableModel.requests).toHaveLength(0);

    const driftRoot = workspace();
    const drift = productOptions(
      driftRoot,
      "drift",
      new ScriptedModel([]),
      "shared-drift-session",
      "run-a",
    );
    const driftDeferred = productOptions(
      driftRoot,
      "drift-deferred",
      new ScriptedModel([]),
      "shared-drift-session",
      "run-b",
    );
    await appendActionableRun(drift);
    await appendActionableRun(driftDeferred);
    const driftDeferredModel = finalModel("must not run");
    const driftReport = await scanAndResumePawNextRunsV1({
      workspaceRoot: driftRoot,
      resolveOptions(identity) {
        if (identity.runId === drift.runId) {
          return {
            ...drift,
            model: new ScriptedModel([]),
            systemPrompt: "drift",
          };
        }
        return { ...driftDeferred, model: driftDeferredModel };
      },
    });
    expect(runStatuses(driftReport)).toEqual([
      ["shared-drift-session", "run-a", "invalid"],
      ["shared-drift-session", "run-b", "deferred"],
    ]);
    expect(driftDeferredModel.requests).toHaveLength(0);

    const corruptRoot = workspace();
    const corrupt = productOptions(
      corruptRoot,
      "corrupt",
      new ScriptedModel([]),
      "session-a",
      "run-a",
    );
    const safe = productOptions(
      corruptRoot,
      "safe",
      new ScriptedModel([]),
      "session-b",
      "run-b",
    );
    await appendActionableRun(corrupt);
    await appendActionableRun(safe);
    fs.writeFileSync(
      path.join(authorityEvents(corruptRoot, corrupt.sessionId), "foreign.bin"),
      "foreign",
    );
    const safeModel = finalModel("must not run");
    const corruptSessionRoot = sessionDirectory(corruptRoot, corrupt.sessionId);
    const corruptBefore = rawTree(corruptSessionRoot);
    const corruptReport = await scanAndResumePawNextRunsV1({
      workspaceRoot: corruptRoot,
      resolveOptions: resolverFor(
        [safe],
        new Map([[identityKey(safe.sessionId, safe.runId), safeModel]]),
      ),
    });
    expect(corruptReport.issues).toHaveLength(1);
    expect(runStatuses(corruptReport)).toEqual([
      ["session-b", "run-b", "resumed"],
    ]);
    expect(safeModel.requests).toHaveLength(1);
    expect(rawTree(corruptSessionRoot)).toEqual(corruptBefore);
  });

  test("a selected target head change is reported before model or recovery", async () => {
    const root = workspace();
    const target = productOptions(root, "head-stale", new ScriptedModel([]));
    await appendActionableRun(target);
    const model = finalModel("must not run");
    let mutated = false;

    const report = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      async resolveOptions() {
        if (!mutated) {
          mutated = true;
          await mutateRun(target, (session) =>
            session.appendInputFacts([accepted("raced-input")]),
          );
        }
        return { ...target, model };
      },
    });

    expect(runStatuses(report)).toEqual([
      [target.sessionId, target.runId, "anchor_conflict"],
    ]);
    expect(model.requests).toHaveLength(0);
    expect(repairFacts(await strictFacts(target))).toHaveLength(0);
  });

  test("a new sibling run invalidates the selected Session inventory without falling through", async () => {
    const root = workspace();
    const target = productOptions(
      root,
      "inventory-target",
      new ScriptedModel([]),
      "shared-inventory-session",
      "run-a",
    );
    await appendActionableRun(target);
    const sibling = productOptions(
      root,
      "inventory-sibling",
      new ScriptedModel([]),
      target.sessionId,
      "run-new-after-discovery",
    );
    const model = finalModel("must not run");
    let added = false;

    const report = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      async resolveOptions() {
        if (!added) {
          added = true;
          await appendActionableRun(sibling);
        }
        return { ...target, model };
      },
    });

    expect(runStatuses(report)).toEqual([
      [target.sessionId, target.runId, "inventory_stale"],
    ]);
    expect(model.requests).toHaveLength(0);
    expect(repairFacts(await strictFacts(target))).toHaveLength(0);
  });

  test("busy on the selected run never falls through to the next candidate", async () => {
    const root = workspace();
    const selected = productOptions(
      root,
      "busy-selected",
      new ScriptedModel([]),
      "session-a",
      "run-a",
    );
    const later = productOptions(
      root,
      "busy-later",
      new ScriptedModel([]),
      "session-b",
      "run-b",
    );
    await appendActionableRun(selected);
    await appendActionableRun(later);
    const lease = acquireCurrentLease(selected);
    const selectedModel = finalModel("must not run");
    const laterModel = finalModel("must not run");
    try {
      const report = await scanAndResumePawNextRunsV1({
        workspaceRoot: root,
        resolveOptions: resolverFor(
          [selected, later],
          new Map([
            [identityKey(selected.sessionId, selected.runId), selectedModel],
            [identityKey(later.sessionId, later.runId), laterModel],
          ]),
        ),
      });
      expect(runStatuses(report)).toEqual([
        ["session-a", "run-a", "busy"],
        ["session-b", "run-b", "deferred"],
      ]);
      expect(selectedModel.requests).toHaveLength(0);
      expect(laterModel.requests).toHaveLength(0);
    } finally {
      expect(await lease.release()).toBe("released");
    }
  });
});

class ScriptedModel implements LanguageModel {
  readonly label = "startup-scan-model";
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
  };
  readonly runtimeProfile = {
    protocol: "openai-compatible" as const,
    model: "startup-scan-model",
    baseUrl: "https://example.invalid/v1",
  };
  readonly requests: ChatMessage[][] = [];
  private index = 0;

  constructor(private readonly responses: readonly ModelCompletionResult[]) {}

  async complete(
    messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error("No scripted response remains");
    return response;
  }
}

class BlockingModel implements LanguageModel {
  readonly label = "startup-scan-model";
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
  };
  readonly runtimeProfile = {
    protocol: "openai-compatible" as const,
    model: "startup-scan-model",
    baseUrl: "https://example.invalid/v1",
  };
  readonly requests: ChatMessage[][] = [];
  readonly started = deferred<void>();
  private readonly response = deferred<ModelCompletionResult>();

  async complete(
    messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => ({ ...message })));
    this.started.resolve(undefined);
    return this.response.promise;
  }

  finish(response: ModelCompletionResult): void {
    this.response.resolve(response);
  }
}

function finalModel(text: string): ScriptedModel {
  return new ScriptedModel([
    { text, nativeAssistantContent: text, finishReason: "stop" },
  ]);
}

function productOptions(
  root: string,
  suffix: string,
  model: LanguageModel,
  sessionId = `session-${suffix}`,
  runId = `run-${suffix}`,
): RunExistingPawNextTaskOptionsV1 {
  return {
    workspaceRoot: root,
    sessionId,
    runId,
    inputId: `input-${suffix}`,
    goal: `goal-${suffix}`,
    model,
    providerProtocol: "openai-compatible",
    transport: "complete",
    estimator: smallEstimator(),
    estimatorId: "test-small-estimator",
    estimatorVersion: "v1",
  };
}

function smallEstimator() {
  return {
    count: (text: string) => Math.ceil(text.length / 4),
    countMessages: (messages: readonly ChatMessage[]) =>
      messages.reduce(
        (total, message) => total + Math.ceil(message.content.length / 4),
        0,
      ),
  };
}

function processProductOptions(
  root: string,
  suffix: string,
  now: number,
): RunExistingPawNextTaskOptionsV1 {
  return {
    ...productOptions(root, suffix, new ScriptedModel([])),
    heartbeatPolicy: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: 300,
      intervalMs: 100,
    },
    leaseScheduler: {
      now: () => now,
      scheduleAt() {
        return { cancel() {} };
      },
    },
  };
}

function futureClock(): number {
  return Date.now() + 60_000;
}

type ScannerChildMode =
  | "compete"
  | "complete"
  | "discover_exit"
  | "exit_in_model"
  | "exit_after_report";

interface ScannerChildMessage {
  readonly type: string;
  readonly report?: {
    readonly runs: readonly {
      readonly status: string;
      readonly reason?: string;
    }[];
  };
  readonly modelCalls?: number;
}

interface ScannerChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

class ScannerChild {
  readonly exited: Promise<ScannerChildExit>;
  private readonly messages: ScannerChildMessage[] = [];
  private readonly waiters: Array<{
    readonly types: ReadonlySet<string>;
    readonly resolve: (message: ScannerChildMessage) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private stderr = "";

  constructor(private readonly child: ChildProcess) {
    childProcesses.add(child);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.on("message", (message: unknown) => {
      const value = message as ScannerChildMessage;
      const waiterIndex = this.waiters.findIndex((waiter) =>
        waiter.types.has(value.type),
      );
      if (waiterIndex < 0) {
        this.messages.push(value);
        return;
      }
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter?.resolve(value);
    });
    this.exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        childProcesses.delete(child);
        const result = { code, signal };
        for (const waiter of this.waiters.splice(0)) {
          waiter.reject(
            new Error(
              `startup scanner child exited ${String(code)}/${String(signal)} before ${[...waiter.types].join("|")}: ${this.stderr}`,
            ),
          );
        }
        resolve(result);
      });
    });
  }

  message(type: string): Promise<ScannerChildMessage> {
    return this.messageAny([type]);
  }

  messageAny(types: readonly string[]): Promise<ScannerChildMessage> {
    const accepted = new Set(types);
    const index = this.messages.findIndex((message) =>
      accepted.has(message.type),
    );
    if (index >= 0) {
      const [message] = this.messages.splice(index, 1);
      if (message) return Promise.resolve(message);
    }
    return withTimeout(
      new Promise((resolve, reject) => {
        this.waiters.push({ types: accepted, resolve, reject });
      }),
      `IPC message ${types.join("|")}`,
    );
  }

  send(type: "go" | "finish"): void {
    this.child.send?.({ type });
  }
}

function startScannerChild(
  options: Pick<
    RunExistingPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId" | "inputId" | "goal"
  >,
  mode: ScannerChildMode,
  now: number,
): ScannerChild {
  const fixture = path.join(
    import.meta.dir,
    "fixtures",
    "paw-next-startup-scan-child.ts",
  );
  const child = spawn(
    process.execPath,
    [
      fixture,
      JSON.stringify({
        mode,
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        runId: options.runId,
        inputId: options.inputId,
        goal: options.goal,
        now,
      }),
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  return new ScannerChild(child);
}

function singleChildStatus(message: ScannerChildMessage | undefined): string {
  const run = message?.report?.runs[0];
  const status = run?.status;
  if (!status) throw new Error("startup scanner child report is missing");
  if (status === "failed") {
    throw new Error(`startup scanner child failed: ${run.reason ?? "unknown"}`);
  }
  return status;
}

function childModelCalls(message: ScannerChildMessage | undefined): number {
  if (message?.modelCalls === undefined) {
    throw new Error("startup scanner child model count is missing");
  }
  return message.modelCalls;
}

function exitCode(result: ScannerChildExit): number | null {
  return result.code;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      10_000,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function appendActionableRun(
  options: RunExistingPawNextTaskOptionsV1,
): Promise<void> {
  const configHash = preparePawNextProductRuntimeV1(options).configHash;
  await mutateRun(options, (session) =>
    session.appendInputFacts([
      {
        type: "attempt.started",
        goalHash: hash(options.goal),
        configHash,
      },
      {
        type: "input.promoted",
        inputId: options.inputId,
        delivery: "initial",
        content: options.goal,
        contentHash: hash(options.goal),
      },
    ]),
  );
}

function accepted(inputId: string): InputFactV1 {
  return {
    type: "input.accepted",
    inputId,
    delivery: "queue",
    content: `content:${inputId}`,
    contentHash: hash(`content:${inputId}`),
    callerId: "startup-scan-test",
  };
}

function modelDispatch(): InputFactV1 {
  return {
    type: "model.dispatch_recorded",
    modelCallId: "model-1",
    turn: 1,
    requestHash: "request-1",
  };
}

function openDispatchedWriteFacts(): readonly InputFactV1[] {
  const args = { path: "must-not-exist.txt", content: "forbidden-effect" };
  const response = {
    schemaVersion: "paw.model-response.v1" as const,
    providerProtocol: "openai-compatible" as const,
    assistantContent: "",
    finishReason: "tool_calls",
    toolCalls: [
      {
        callId: "write-open",
        name: "workspace_write_file",
        rawArguments: JSON.stringify(args),
        args,
        sourceIndex: 0,
        argumentsValid: true,
      },
    ],
  };
  return [
    modelDispatch(),
    {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: {
        kind: "inline",
        value: toFrozenJsonValueV1(response),
        hash: hashCanonicalJsonV1(response),
      },
      finishReason: "tool_calls",
    },
    {
      type: "tool.call_observed",
      callId: "write-open",
      modelCallId: "model-1",
      turn: 1,
      tool: "workspace_write_file",
      args,
      order: 0,
    },
    {
      type: "tool.dispatch_recorded",
      callId: "write-open",
      turn: 1,
      sourceIndex: 0,
      batchId: "tool-batch-1",
      mode: "parallel",
    },
    {
      type: "tool.permission_resolved",
      turn: 1,
      sourceIndex: 0,
      callId: "write-open",
      tool: "workspace_write_file",
      policyVersion: allowAllPermissions().policyVersion,
      resolution: "allow_once",
      source: "base_policy",
      ruleId: "allow-write",
    },
    {
      type: "tool.effect_checkpoint_allocated",
      callId: "write-open",
      turn: 1,
      sourceIndex: 0,
      checkpointSeq: 1,
    },
  ];
}

function allowAllPermissions() {
  return {
    policyVersion: "startup-scan-allow-all.v1",
    defaultAction: "deny" as const,
    rules: (["read", "write", "shell"] as const).map((category) => ({
      id: `allow-${category}`,
      layer: "default" as const,
      category,
      action: "allow" as const,
    })),
  };
}

async function mutateRun(
  options: Pick<
    RunExistingPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId"
  >,
  work: (session: FileRunSessionV1) => Promise<unknown>,
): Promise<void> {
  const index = readFileSessionJournalCommitIndexV1(options);
  const acquired = acquireFileSessionExecutionLeaseV1({
    ...options,
    ttlMs: 60_000,
    baseTailSeq: index.head.tailSeq,
    basePrefixHash: index.head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`test lease was not acquired: ${acquired.status}`);
  }
  const session = new FileRunSessionV1({
    ...options,
    executionLease: acquired.lease,
  });
  try {
    await work(session);
  } finally {
    session.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

function acquireCurrentLease(
  options: Pick<
    RunExistingPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId"
  >,
) {
  const index = readFileSessionJournalCommitIndexV1(options);
  const result = acquireFileSessionExecutionLeaseV1({
    ...options,
    ttlMs: 60_000,
    baseTailSeq: index.head.tailSeq,
    basePrefixHash: index.head.prefixHash,
  });
  if (result.status !== "acquired") {
    throw new Error(`test lease was not acquired: ${result.status}`);
  }
  return result.lease;
}

function resolverFor(
  options: readonly RunExistingPawNextTaskOptionsV1[],
  models: Map<string, ScriptedModel>,
) {
  const byIdentity = new Map(
    options.map((item) => [identityKey(item.sessionId, item.runId), item]),
  );
  return (identity: { readonly sessionId: string; readonly runId: string }) => {
    const value = byIdentity.get(
      identityKey(identity.sessionId, identity.runId),
    );
    if (!value) return undefined;
    const key = identityKey(identity.sessionId, identity.runId);
    const model = models.get(key) ?? new ScriptedModel([]);
    models.set(key, model);
    return { ...value, model };
  };
}

async function strictFacts(
  options: Pick<
    RunExistingPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId"
  >,
): Promise<readonly InputFactV1[]> {
  const inventory = readFileSessionAuthorityInventoryV1(options);
  const run = inventory.runs.find((item) => item.runId === options.runId);
  if (!run) throw new Error("test run inventory is missing");
  return readCommittedFileRunPrefixV1({
    ...options,
    expectedHead: run.head,
  }).flatMap((item) =>
    item.record.kind === "input_fact" ? [item.record.fact] : [],
  );
}

function repairFacts(facts: readonly InputFactV1[]): readonly InputFactV1[] {
  return facts.filter(
    (fact) =>
      (fact.type === "model.settled" && fact.status === "unknown") ||
      (fact.type === "tool.settled" &&
        ["unknown", "cancelled", "rejected"].includes(fact.status)),
  );
}

function modelUnknowns(
  facts: readonly InputFactV1[],
  modelCallId: string,
): readonly InputFactV1[] {
  return facts.filter(
    (fact) =>
      fact.type === "model.settled" &&
      fact.modelCallId === modelCallId &&
      fact.status === "unknown",
  );
}

function runStatuses(report: {
  readonly runs: readonly {
    readonly sessionId: string;
    readonly runId: string;
    readonly status: string;
  }[];
}) {
  return report.runs.map((item) => [item.sessionId, item.runId, item.status]);
}

function identityKey(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function authorityEvents(root: string, sessionId: string): string {
  return path.join(sessionDirectory(root, sessionId), "ownership", "events");
}

function sessionDirectory(root: string, sessionId: string): string {
  return path.join(root, ".paw", "paw-next", "sessions", hash(sessionId));
}

function rawTree(root: string): readonly string[] {
  const output: string[] = [];
  function visit(current: string): void {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        output.push(`dir:${relative}`);
        visit(full);
      } else if (stat.isSymbolicLink()) {
        output.push(`link:${relative}:${fs.readlinkSync(full)}`);
      } else {
        output.push(
          `file:${relative}:${stat.nlink}:${hash(fs.readFileSync(full))}`,
        );
      }
    }
  }
  visit(root);
  return output;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-startup-scan-"));
  roots.push(root);
  return root;
}
