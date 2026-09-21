import type { Context, PortCallOptions, SessionInputSnapshot } from "@paw/agent-loop";
import type { ModelContextSectionV1, ModelRequestV1 } from "@paw/core";
import type { InputFactV1 } from "@paw/protocol";
import type { VerifiedCanonicalPayloadEvidenceV1 } from "../payload/verified-model-response-evidence.js";

/** The strongest context reduction level reflected by one built request. */
export type JournalContextLevelV1 =
  | "lossless_projection"
  | "semantic_checkpoint"
  | "fallback_omission";

/** Exact estimator accounting used to build one provider request. */
export interface JournalContextTokenPlanV1 {
  readonly categories?: readonly {
    readonly id: string;
    readonly label: string;
    readonly tokens: number;
  }[];
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
    projection?: JournalContextRequestProjectionV1,
  ): Promise<JournalContextPlanV1>;
}

/** Request-only host evidence; cannot replace a canonical message or tool turn. */
export interface JournalContextAnnotationV1 {
  readonly sourceThroughSeq: number;
  readonly content: string;
  readonly placement: "after_unit" | "after_boundary" | "tail";
  /** Present only while the condition still holds. Reserved before history selection. */
  readonly fallbackContent?: string;
}

export interface JournalContextRequestProjectionV1 {
  readonly annotations?: readonly JournalContextAnnotationV1[];
  /** Pure annotations sharing the exact evidence already loaded for this plan. */
  readonly evidenceAnnotations?: (
    evidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
  ) => readonly JournalContextAnnotationV1[];
  /** Optional plugin evidence, admitted whole in caller priority order. */
  readonly optionalSections?: readonly ModelContextSectionV1[];
  /** Converts the existing activity section to untrusted user-role evidence. */
  readonly runtimeActivityContent?: (section: ModelContextSectionV1) => string;
}

/** Agent Loop Context port plus the read-only planning seam for extensions. */
export interface JournalContextRuntimeV1
  extends JournalContextPlannerV1,
    Context<SessionInputSnapshot<InputFactV1>, ModelRequestV1> {}
