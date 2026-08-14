import type {
  CandidateReviewPayloadV2,
  SemanticReviewerV2,
} from "./candidate-certification.js";
import { canonicalJson } from "./canonical.js";

export interface SemanticReviewUsageV2 {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
}

/** Minimal model port; the loop kernel does not depend on a provider package. */
export interface SemanticReviewModelV2 {
  readonly label: string;
  complete(
    messages: readonly Readonly<{
      readonly role: "system" | "user";
      readonly content: string;
    }>[],
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<
    Readonly<{
      readonly text: string;
      readonly usage?: SemanticReviewUsageV2;
      readonly finishReason?: string;
      readonly toolCalls?: readonly unknown[];
    }>
  >;
}

export interface ModelSemanticReviewerOptionsV2 {
  readonly model: SemanticReviewModelV2;
  readonly onUsage?: (modelLabel: string, usage: SemanticReviewUsageV2) => void;
  readonly signal?: AbortSignal;
  readonly maxInputChars?: number;
}

export function createModelSemanticReviewerV2(
  options: ModelSemanticReviewerOptionsV2,
): SemanticReviewerV2 {
  return async (payload) => {
    const messages = buildSemanticReviewMessagesV2(
      payload,
      options.maxInputChars,
    );
    const result = await options.model.complete(
      messages,
      options.signal ? { signal: options.signal } : undefined,
    );
    if (result.usage) {
      options.onUsage?.(options.model.label, result.usage);
    }
    if (result.toolCalls && result.toolCalls.length > 0) {
      throw new Error("Semantic reviewer attempted to call a tool");
    }
    if (
      result.finishReason === "length" ||
      result.finishReason === "max_tokens"
    ) {
      throw new Error("Semantic reviewer response was truncated");
    }
    return parseReviewerJson(result.text);
  };
}

export function buildSemanticReviewMessagesV2(
  payload: CandidateReviewPayloadV2,
  maxInputChars = 120_000,
): readonly Readonly<{
  readonly role: "system" | "user";
  readonly content: string;
}>[] {
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 1_000) {
    throw new Error("Semantic reviewer maxInputChars must be at least 1000");
  }
  const material = canonicalJson({
    candidateInputHash: payload.candidateInputHash,
    mutationRevision: payload.input.mutationRevision,
    goal: payload.goal,
    criteria: payload.input.criteria,
    invariants: payload.input.invariants,
    changedPublicSurface: payload.input.changedPublicSurface,
    mutationPatches: payload.mutationPatches,
    currentVerification: payload.input.currentVerification,
    unresolvedRisks: payload.input.unresolvedRisks,
    snapshots: payload.snapshots,
  });
  if (material.length > maxInputChars) {
    throw new Error(
      `Semantic review material exceeds ${maxInputChars} characters`,
    );
  }
  return [
    {
      role: "system",
      content:
        "You are an independent, read-only semantic reviewer. You have no tools. Judge only the supplied goal, contract, host facts, diff, and source snapshots. The implementing agent's final summary and hidden reasoning are intentionally absent. Do not infer failure from hypothetical hidden tests. Every blocking finding must bind a supplied criterion or invariant and visible evidence. When a public or unknown surface changed, compare it with a materially smaller alternative. Return one JSON object and no prose.",
    },
    {
      role: "user",
      content: `Review this candidate. Preserve candidateInputHash and mutationRevision exactly. Schema: {"candidateInputHash":string,"mutationRevision":number,"verdict":"pass"|"fail"|"partial","findings":[{"severity":"blocking"|"warning","criterionId"?:string,"invariantId"?:string,"file"?:string,"line"?:number,"observedChange":string,"risk":string,"minimalAlternative"?:string,"evidenceRefs":string[]}]}. Evidence refs must be one of mutation:<callId>, surface:<surfaceId>, a supplied verification id, or snapshot:<path>.\n\n${material}`,
    },
  ];
}

function parseReviewerJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Returning the original value lets the certification protocol validator
    // record one durable protocol_partial rather than opening a recovery loop.
    return text;
  }
}
