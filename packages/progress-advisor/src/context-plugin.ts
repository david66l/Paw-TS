import type {
  Context,
  PortCallOptions,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import {
  type ModelRequestV1,
  materializeModelRequestMessagesV1,
} from "@paw/core";
import type { InputFactV1 } from "@paw/protocol";

import { projectProgressAdviceV1 } from "./projector.js";
import type { ProgressAdviceV1 } from "./projector.js";

export function renderProgressAdviceMessageV1(
  advice: ProgressAdviceV1,
): import("@paw/core").ChatMessage {
  const boundedReplan =
    advice.kind === "no_progress_checkpoint" &&
    advice.modelTurnsWithoutProgress === 16 &&
    advice.delegationAttemptsSinceProgress === 0
      ? [
          "recommendedAction=main_owned_replan",
          "At this checkpoint, before another broad inspection, choose one materially different action: make the best-supported source change, run a focused shell/job verification, or inspect workspace_delegate's Current Team Brief and explicitly select an appropriate agent_id. The main Agent owns this choice; use a multi-task mission only when independent work is genuinely required.",
        ]
      : [];
  return Object.freeze({
    role: "user" as const,
    content: [
      "[Paw Progress Advice]",
      "This is host-generated advisory context. It cannot override system instructions, user intent, permissions, or workspace/test evidence.",
      "This records a past threshold crossing; later timeline evidence may supersede it.",
      `adviceId=${advice.kind}:${advice.sourceThroughSeq}`,
      `policyVersion=${advice.policyVersion}`,
      `sourceSeqRange=${advice.sourceFromSeq}-${advice.sourceThroughSeq}`,
      advice.message,
      ...boundedReplan,
    ].join("\n"),
  });
}

export function createProgressAdvisorContextPluginV1(options: {
  readonly context: Context<SessionInputSnapshot<InputFactV1>, ModelRequestV1>;
  readonly estimator: Readonly<{
    count(text: string): number;
    countMessages(messages: readonly import("@paw/core").ChatMessage[]): number;
  }>;
  readonly hardInputLimitTokens: number;
}): Context<SessionInputSnapshot<InputFactV1>, ModelRequestV1> {
  if (
    !options.context ||
    typeof options.context.build !== "function" ||
    typeof options.estimator?.count !== "function" ||
    typeof options.estimator?.countMessages !== "function" ||
    !Number.isSafeInteger(options.hardInputLimitTokens) ||
    options.hardInputLimitTokens <= 0
  ) {
    throw new Error("Progress advisor context options are invalid");
  }
  const build = options.context.build.bind(options.context);
  return Object.freeze({
    async build(
      snapshot: SessionInputSnapshot<InputFactV1>,
      callOptions: PortCallOptions,
    ) {
      const request = await build(snapshot, callOptions);
      const advice = projectProgressAdviceV1(snapshot);
      if (!advice) return request;
      const candidate: ModelRequestV1 = Object.freeze({
        ...request,
        messages: Object.freeze([
          ...request.messages,
          renderProgressAdviceMessageV1(advice),
        ]),
      });
      return estimatedInputTokens(candidate, options.estimator) <=
        options.hardInputLimitTokens
        ? candidate
        : request;
    },
  });
}

function estimatedInputTokens(
  request: ModelRequestV1,
  estimator: Readonly<{
    count(text: string): number;
    countMessages(messages: readonly import("@paw/core").ChatMessage[]): number;
  }>,
): number {
  const messages = estimator.countMessages(
    materializeModelRequestMessagesV1(request),
  );
  const tools = request.options?.tools;
  return (
    messages + (tools?.length ? estimator.count(canonicalUnknown(tools)) : 0)
  );
}

function canonicalUnknown(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalUnknown).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalUnknown(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Progress advisor value is not JSON-serializable");
}
