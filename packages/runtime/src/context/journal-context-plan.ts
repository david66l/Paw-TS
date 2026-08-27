import type {
  Context,
  PortCallOptions,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import type { ModelRequestV1 } from "@paw/core";
import type { InputFactV1 } from "@paw/protocol";

/** The strongest context reduction level reflected by one built request. */
export type JournalContextLevelV1 =
  | "lossless_projection"
  | "semantic_checkpoint"
  | "fallback_omission";

/** Exact estimator accounting used to build one provider request. */
export interface JournalContextTokenPlanV1 {
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly hardInputLimitTokens: number;
  readonly softTargetTokens: number;
  readonly fixedInputTokens: number;
  readonly protectedInputTokens: number;
  readonly fullInputTokens: number;
  readonly selectedInputTokens: number;
  readonly estimatedOmittedInputTokens: number;
  readonly hardHeadroomTokens: number;
  readonly softHeadroomTokens: number;
  readonly estimatorId: string;
  readonly estimatorVersion: string;
}

/** Journal timeline units selected atomically for one model request. */
export interface JournalContextSelectionPlanV1 {
  readonly eligibleUnits: readonly JournalContextTimelineUnitPlanV1[];
  readonly eligibleUnitSourceSeqs: readonly number[];
  readonly protectedUnitSourceSeqs: readonly number[];
  readonly selectedUnitSourceSeqs: readonly number[];
  readonly omittedUnitSourceSeqs: readonly number[];
  readonly checkpointCoveredUnitSourceSeqs: readonly number[];
}

/** One complete input or model/tool timeline unit available to policy code. */
export interface JournalContextTimelineUnitPlanV1 {
  readonly kind: "input" | "model";
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
  readonly protected: boolean;
  readonly selected: boolean;
}

/** The active semantic checkpoint projected into this request, if any. */
export interface JournalContextCheckpointPlanV1 {
  readonly checkpointId: string;
  readonly policyVersion: string;
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
}

/**
 * Read-only explanation of one Context build.
 *
 * Policy extensions inspect this value; only Runtime may project canonical
 * Journal evidence into the request.
 */
export interface JournalContextPlanV1 {
  readonly request: ModelRequestV1;
  readonly level: JournalContextLevelV1;
  readonly tokens: JournalContextTokenPlanV1;
  readonly selection: JournalContextSelectionPlanV1;
  readonly checkpoint?: JournalContextCheckpointPlanV1;
}

export interface JournalContextPlannerV1 {
  plan(
    snapshot: SessionInputSnapshot<InputFactV1>,
    options: PortCallOptions,
  ): Promise<JournalContextPlanV1>;
}

/** Agent Loop Context port plus the read-only planning seam for extensions. */
export interface JournalContextRuntimeV1
  extends JournalContextPlannerV1,
    Context<SessionInputSnapshot<InputFactV1>, ModelRequestV1> {}
