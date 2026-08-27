import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelCompletionResult,
} from "@paw/models";
import type { SessionLeaseSchedulerV1 } from "@paw/runtime";

import type { RunExistingPawNextTaskOptionsV1 } from "../../src/paw-next/composition.js";
import { scanAndResumePawNextRunsV1 } from "../../src/paw-next/startup-scan.js";

type Mode =
  | "compete"
  | "complete"
  | "discover_exit"
  | "exit_in_model"
  | "exit_after_report";

interface ChildConfig {
  readonly mode: Mode;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly inputId: string;
  readonly goal: string;
  readonly now: number;
}

class IpcModel implements LanguageModel {
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
  calls = 0;

  constructor(private readonly mode: Mode) {}

  async complete(
    _messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.calls += 1;
    await sendIpc({ type: "model_entered", modelCalls: this.calls });
    if (this.mode === "exit_in_model") process.exit(42);
    if (this.mode === "compete") await waitForCommand("finish");
    return {
      text: "child completed",
      nativeAssistantContent: "child completed",
      finishReason: "stop",
    };
  }
}

function productOptions(
  input: ChildConfig,
  languageModel: LanguageModel,
): RunExistingPawNextTaskOptionsV1 {
  return {
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    runId: input.runId,
    inputId: input.inputId,
    goal: input.goal,
    model: languageModel,
    providerProtocol: "openai-compatible",
    transport: "complete",
    estimator: smallEstimator(),
    estimatorId: "test-small-estimator",
    estimatorVersion: "v1",
    heartbeatPolicy: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: 300,
      intervalMs: 100,
    },
    leaseScheduler: staticScheduler(input.now),
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

function staticScheduler(now: number): SessionLeaseSchedulerV1 {
  return {
    now: () => now,
    scheduleAt() {
      return { cancel() {} };
    },
  };
}

function waitForCommand(expected: "go" | "finish"): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown): void => {
      if (!isCommand(message, expected)) return;
      process.off("message", listener);
      resolve();
    };
    process.on("message", listener);
  });
}

function isCommand(message: unknown, expected: "go" | "finish"): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === expected
  );
}

function sendIpc(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("startup scanner child IPC is unavailable"));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

const rawConfig = process.argv[2];
if (!rawConfig) throw new Error("startup scanner child config is missing");
const config = JSON.parse(rawConfig) as ChildConfig;
const model = new IpcModel(config.mode);
const options = productOptions(config, model);

const report = await scanAndResumePawNextRunsV1({
  workspaceRoot: config.workspaceRoot,
  async resolveOptions(identity) {
    if (
      identity.sessionId !== config.sessionId ||
      identity.runId !== config.runId
    ) {
      return undefined;
    }
    if (config.mode === "discover_exit") {
      await sendIpc({ type: "discovered" });
      process.exit(41);
    }
    if (config.mode === "compete") {
      await sendIpc({ type: "ready" });
      await waitForCommand("go");
    }
    return options;
  },
});

await sendIpc({ type: "result", report, modelCalls: model.calls });
if (config.mode === "exit_after_report") process.exit(43);
process.disconnect?.();
