import type { Session } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";
import {
  type RunTaskCheckpointDistillationOptionsV1,
  type TaskCheckpointDistillationCodecV1,
  type TaskCheckpointDistillationRunResultV1,
  type TaskCheckpointDistillerV1,
  runTaskCheckpointDistillationV1,
} from "@paw/runtime";

import type { ContextCompactionBoundaryDecisionV1 } from "./boundary-input-port.js";
import {
  type ContextCompactionAttemptOutcomeV1,
  type ContextCompactionLifecyclePolicyV1,
  DEFAULT_CONTEXT_COMPACTION_LIFECYCLE_POLICY_V1,
  freezeContextCompactionLifecyclePolicyV1,
  projectContextCompactionHealthV1,
} from "./lifecycle-policy.js";

export const CONTEXT_COMPACTION_ORCHESTRATION_POLICY_VERSION_V1 =
  "paw.context-compaction-orchestrator.v1" as const;

export type ContextCompactionControllerResultV1 =
  | Readonly<{ status: "skipped"; reason: "planner_skip" }>
  | Readonly<{
      status: "throttled";
      reason: "cooldown" | "circuit_open" | "low_savings_backoff";
    }>
  | Readonly<{
      status: "ran";
      checkpointId: string;
      result: TaskCheckpointDistillationRunResultV1;
    }>;

export interface ContextCompactionControllerOptionsV1 {
  readonly session: Session<InputFactV1, unknown>;
  readonly distiller: TaskCheckpointDistillerV1;
  readonly codec: TaskCheckpointDistillationCodecV1;
  readonly signal: AbortSignal;
  readonly loadPayloadEvidence?: RunTaskCheckpointDistillationOptionsV1["loadPayloadEvidence"];
  readonly lifecyclePolicy?: ContextCompactionLifecyclePolicyV1;
  readonly onResult?: (
    result: ContextCompactionControllerResultV1,
  ) => void | Promise<void>;
}

export interface ContextCompactionControllerV1 {
  handleDecision(
    decision: ContextCompactionBoundaryDecisionV1,
  ): Promise<ContextCompactionControllerResultV1>;
}

/** External policy controller over Runtime's crash-safe checkpoint primitive. */
export function createContextCompactionControllerV1(
  options: ContextCompactionControllerOptionsV1,
): ContextCompactionControllerV1 {
  const session = captureSession(options.session);
  const distiller = captureDistiller(options.distiller);
  const codec = captureCodec(options.codec);
  const signal = options.signal;
  if (!signal || typeof signal.aborted !== "boolean") {
    throw new Error("Context compaction controller signal is invalid");
  }
  const lifecycle = freezeContextCompactionLifecyclePolicyV1(
    options.lifecyclePolicy ?? DEFAULT_CONTEXT_COMPACTION_LIFECYCLE_POLICY_V1,
  );
  const loadPayloadEvidence = options.loadPayloadEvidence?.bind(options);
  const onResult = options.onResult?.bind(undefined);

  return Object.freeze({
    async handleDecision(decision: ContextCompactionBoundaryDecisionV1) {
      if (decision.compaction.action !== "distill") {
        return publish({ status: "skipped", reason: "planner_skip" });
      }
      const snapshot = await session.readInputSnapshot();
      const currentModelTurn = latestModelTurn(snapshot.entries);
      const attempts = projectDurableAttempts(snapshot.entries);
      const recoverable = findRecoverableClaim(
        snapshot.entries,
        decision.compaction.range.sourceFromSeq,
        decision.compaction.range.sourceThroughSeq,
      );
      if (!recoverable) {
        const health = projectContextCompactionHealthV1(
          attempts,
          currentModelTurn,
          decision.context.tokens.fullInputTokens,
          lifecycle,
        );
        if (!health.canAttempt) {
          if (health.reason === "ready") {
            throw new Error("Context compaction health is inconsistent");
          }
          return publish({ status: "throttled", reason: health.reason });
        }
      }

      const checkpointId =
        recoverable?.checkpointId ??
        createCheckpointId(decision, currentModelTurn, attempts.length + 1);
      const result = await runTaskCheckpointDistillationV1(
        session,
        {
          checkpointId,
          policyVersion: CONTEXT_COMPACTION_ORCHESTRATION_POLICY_VERSION_V1,
          boundary: decision.boundary,
          sourceFromSeq: decision.compaction.range.sourceFromSeq,
          sourceThroughSeq: decision.compaction.range.sourceThroughSeq,
        },
        distiller,
        codec,
        signal,
        loadPayloadEvidence === undefined ? {} : { loadPayloadEvidence },
      );
      return publish({ status: "ran", checkpointId, result });
    },
  });

  async function publish(
    result: ContextCompactionControllerResultV1,
  ): Promise<ContextCompactionControllerResultV1> {
    const frozen = Object.freeze(result);
    if (onResult) await onResult(frozen);
    return frozen;
  }
}

function createCheckpointId(
  decision: ContextCompactionBoundaryDecisionV1,
  modelTurn: number,
  attempt: number,
): string {
  const range = decision.compaction;
  if (range.action !== "distill") {
    throw new Error("Cannot identify a skipped context compaction");
  }
  return [
    "ctxcp-v1",
    `f${range.range.sourceFromSeq}`,
    `u${range.range.sourceThroughSeq}`,
    `t${modelTurn}`,
    `n${decision.context.tokens.fullInputTokens}`,
    `a${attempt}`,
  ].join("-");
}

function projectDurableAttempts(
  entries: readonly { readonly seq: number; readonly fact: InputFactV1 }[],
): readonly ContextCompactionAttemptOutcomeV1[] {
  const settlements = new Map(
    entries.flatMap((entry) =>
      entry.fact.type === "context.checkpoint_distillation_settled"
        ? [[entry.fact.claimId, entry.fact] as const]
        : [],
    ),
  );
  const recorded = new Set(
    entries.flatMap((entry) =>
      entry.fact.type === "context.checkpoint_recorded" &&
      entry.fact.distillationClaimId
        ? [entry.fact.distillationClaimId]
        : [],
    ),
  );
  return Object.freeze(
    entries.flatMap((entry) => {
      const fact = entry.fact;
      if (
        fact.type !== "context.checkpoint_distillation_claimed" ||
        fact.policyVersion !==
          CONTEXT_COMPACTION_ORCHESTRATION_POLICY_VERSION_V1
      ) {
        return [];
      }
      const identity = parseCheckpointId(fact.checkpointId);
      const settlement = settlements.get(fact.claimId);
      if (!identity || !settlement) return [];
      let outcome: ContextCompactionAttemptOutcomeV1["outcome"];
      if (recorded.has(fact.claimId)) {
        outcome = "committed";
      } else if (settlement.status === "cancelled") {
        outcome = "cancelled";
      } else if (settlement.errorCode === "CheckpointLowSavings") {
        outcome = "low_savings";
      } else if (
        settlement.errorCode?.startsWith("CheckpointEvidence") ||
        settlement.errorCode?.startsWith("CheckpointSemantic") ||
        settlement.errorCode?.startsWith("CheckpointQuality")
      ) {
        outcome = "quality_rejected";
      } else if (settlement.status === "unknown") {
        outcome = "unknown";
      } else {
        outcome = "error";
      }
      return [
        Object.freeze({
          modelTurn: identity.modelTurn,
          fullInputTokens: identity.fullInputTokens,
          outcome,
        }),
      ];
    }),
  );
}

function findRecoverableClaim(
  entries: readonly { readonly seq: number; readonly fact: InputFactV1 }[],
  sourceFromSeq: number,
  sourceThroughSeq: number,
): { readonly checkpointId: string } | undefined {
  const settlements = new Map(
    entries.flatMap((entry) =>
      entry.fact.type === "context.checkpoint_distillation_settled"
        ? [[entry.fact.claimId, entry.fact] as const]
        : [],
    ),
  );
  const recorded = new Set(
    entries.flatMap((entry) =>
      entry.fact.type === "context.checkpoint_recorded" &&
      entry.fact.distillationClaimId
        ? [entry.fact.distillationClaimId]
        : [],
    ),
  );
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const fact = entries[index]?.fact;
    if (
      fact?.type !== "context.checkpoint_distillation_claimed" ||
      fact.policyVersion !==
        CONTEXT_COMPACTION_ORCHESTRATION_POLICY_VERSION_V1 ||
      fact.sourceFromSeq !== sourceFromSeq ||
      fact.sourceThroughSeq !== sourceThroughSeq ||
      recorded.has(fact.claimId)
    ) {
      continue;
    }
    const settlement = settlements.get(fact.claimId);
    if (!settlement || settlement.status === "completed") {
      return Object.freeze({ checkpointId: fact.checkpointId });
    }
  }
  return undefined;
}

function parseCheckpointId(
  value: string,
):
  | { readonly modelTurn: number; readonly fullInputTokens: number }
  | undefined {
  const match = /^ctxcp-v1-f\d+-u\d+-t(\d+)-n(\d+)-a\d+$/.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const modelTurn = Number(match[1]);
  const fullInputTokens = Number(match[2]);
  return Number.isSafeInteger(modelTurn) &&
    modelTurn >= 0 &&
    Number.isSafeInteger(fullInputTokens) &&
    fullInputTokens >= 0
    ? Object.freeze({ modelTurn, fullInputTokens })
    : undefined;
}

function latestModelTurn(
  entries: readonly { readonly fact: InputFactV1 }[],
): number {
  return entries.reduce(
    (latest, entry) =>
      entry.fact.type === "model.settled"
        ? Math.max(latest, entry.fact.turn)
        : latest,
    0,
  );
}

function captureSession(
  session: Session<InputFactV1, unknown>,
): Session<InputFactV1, unknown> {
  if (
    !session ||
    typeof session.readInputSnapshot !== "function" ||
    typeof session.appendInputFacts !== "function" ||
    typeof session.commitInputFacts !== "function"
  ) {
    throw new Error("Context compaction controller Session is invalid");
  }
  return session;
}

function captureDistiller(
  distiller: TaskCheckpointDistillerV1,
): TaskCheckpointDistillerV1 {
  if (!distiller || typeof distiller.distill !== "function") {
    throw new Error("Context compaction controller distiller is invalid");
  }
  return Object.freeze({ distill: distiller.distill.bind(distiller) });
}

function captureCodec(
  codec: TaskCheckpointDistillationCodecV1,
): TaskCheckpointDistillationCodecV1 {
  if (
    !codec ||
    typeof codec.encode !== "function" ||
    typeof codec.hash !== "function" ||
    typeof codec.resolve !== "function"
  ) {
    throw new Error("Context compaction controller codec is invalid");
  }
  return Object.freeze({
    encode: codec.encode.bind(codec),
    hash: codec.hash.bind(codec),
    resolve: codec.resolve.bind(codec),
  });
}
