import fs from "node:fs";
import path from "node:path";

import { type RunResult, atomicWrite } from "@paw/core";

import {
  type SemanticReviewOnceResultV2,
  createInterruptedSemanticReviewRecordV2,
  createSemanticReviewLedgerV2,
  createSemanticReviewSubjectChangedRecordV2,
  rebindSemanticReviewRecordV2,
  reviewCandidateOnceV2,
  semanticReviewKeyV2,
  semanticReviewSubjectHashV2,
} from "./candidate-certification.js";
import {
  type LoopV2LiveCandidateArtifactV1,
  loopV2LiveArtifactPath,
  parseLoopV2LiveCandidateArtifactV1,
  serializeLoopV2LiveCandidateArtifactV1,
} from "./live-artifact.js";
import { buildLoopV2LiveReviewPayloadV1 } from "./live-candidate.js";
import {
  type LoopV2LiveReviewArtifactV1,
  buildLoopV2LiveReviewArtifactV1,
  loopV2LiveReviewArtifactPath,
  parseLoopV2LiveReviewArtifactV1,
  serializeLoopV2LiveReviewArtifactV1,
} from "./live-review-artifact.js";
import {
  type LoopV2LiveReviewClaimV1,
  buildLoopV2LiveReviewClaimV1,
  loopV2LiveReviewClaimPath,
  parseLoopV2LiveReviewClaimV1,
  serializeLoopV2LiveReviewClaimV1,
} from "./live-review-claim.js";
import {
  type LoopV2LegacyTerminalV1,
  type LoopV2LiveTerminalArtifactV1,
  buildLoopV2LiveTerminalArtifactV1,
  loopV2LiveTerminalArtifactPath,
  parseLoopV2LiveTerminalArtifactV1,
  serializeLoopV2LiveTerminalArtifactV1,
} from "./live-terminal-artifact.js";
import {
  type LoopV2RunResultShadowArtifactV1,
  buildLoopV2RunResultShadowArtifactV1,
  loopV2RunResultShadowArtifactPath,
  parseLoopV2RunResultShadowArtifactV1,
  serializeLoopV2RunResultShadowArtifactV1,
} from "./run-result-shadow-artifact.js";
import {
  type SemanticReviewModelV2,
  type SemanticReviewUsageV2,
  createModelSemanticReviewerV2,
} from "./semantic-reviewer.js";

export interface LoopV2LiveReviewRuntimeResultV1
  extends SemanticReviewOnceResultV2 {
  readonly modelCalls: number;
  readonly usage?: SemanticReviewUsageV2;
}

export interface LoopV2LiveReviewRuntimeOptionsV1 {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly model?: SemanticReviewModelV2;
  readonly signal?: AbortSignal;
  readonly onUsage?: (modelLabel: string, usage: SemanticReviewUsageV2) => void;
}

/**
 * Explicit-v2 adapter for candidate/review persistence and at-most-once model
 * invocation. The pure certification kernel remains filesystem/provider-free.
 */
export class LoopV2LiveReviewRuntimeV1 {
  private readonly workspaceRoot: string;
  private readonly runId: string;
  private readonly model?: SemanticReviewModelV2;
  private readonly signal?: AbortSignal;
  private readonly onUsage?: LoopV2LiveReviewRuntimeOptionsV1["onUsage"];
  private candidate?: LoopV2LiveCandidateArtifactV1;
  private claim?: LoopV2LiveReviewClaimV1;
  private review?: LoopV2LiveReviewArtifactV1;

  constructor(options: LoopV2LiveReviewRuntimeOptionsV1) {
    if (!options.workspaceRoot.trim() || !options.runId.trim()) {
      throw new Error(
        "Loop v2 live review runtime requires workspace and runId",
      );
    }
    this.workspaceRoot = options.workspaceRoot;
    this.runId = options.runId;
    this.model = options.model;
    this.signal = options.signal;
    this.onUsage = options.onUsage;
  }

  get canReview(): boolean {
    return this.model !== undefined;
  }

  /** Restores candidate-bound claim/verdict state; stale prior candidates are ignored. */
  restoreCandidate(candidate: LoopV2LiveCandidateArtifactV1): void {
    if (candidate.report.runId !== this.runId) {
      throw new Error("Loop v2 live review restore runId mismatch");
    }
    this.candidate = candidate;
    this.claim = this.readCandidateBoundArtifact(
      loopV2LiveReviewClaimPath(this.workspaceRoot, this.runId),
      candidate,
      parseLoopV2LiveReviewClaimV1,
    );
    this.review = this.readCandidateBoundArtifact(
      loopV2LiveReviewArtifactPath(this.workspaceRoot, this.runId),
      candidate,
      parseLoopV2LiveReviewArtifactV1,
    );
  }

  /** Persists the latest facts while keeping reviewer calls at-most-once per product revision. */
  persistCandidate(
    artifact: LoopV2LiveCandidateArtifactV1,
  ): LoopV2LiveCandidateArtifactV1 {
    if (artifact.report.runId !== this.runId) {
      throw new Error("Loop v2 live review candidate runId mismatch");
    }
    const artifactPath = loopV2LiveArtifactPath(this.workspaceRoot, this.runId);
    const prior = this.candidate;
    const settledSameProductRevision =
      prior?.assessment.mutationRevision ===
        artifact.assessment.mutationRevision &&
      (this.claim !== undefined || this.review !== undefined);
    const priorClaim = this.claim;
    const priorReview = this.review;
    if (prior?.artifactHash === artifact.artifactHash) return prior;

    let futureReview: LoopV2LiveReviewArtifactV1 | undefined;
    if (settledSameProductRevision && prior) {
      const previousPayload = buildLoopV2LiveReviewPayloadV1(
        prior.report,
        prior.policy,
      );
      const nextPayload = buildLoopV2LiveReviewPayloadV1(
        artifact.report,
        artifact.policy,
      );
      const previousSubject = semanticReviewSubjectHashV2(previousPayload);
      const nextSubject = semanticReviewSubjectHashV2(nextPayload);
      // Keep a guard bound to the old candidate before replacing its settled
      // review with a future review. If the process dies before the candidate
      // commit, resume sees this claim and fails closed without another model
      // call. Once the candidate commit lands, futureReview already matches it.
      if (!priorClaim) this.persistClaim(prior);
      if (previousSubject !== nextSubject) {
        const changed = createSemanticReviewSubjectChangedRecordV2(nextPayload);
        futureReview = this.persistReview(
          artifact,
          buildLoopV2LiveReviewArtifactV1(artifact, changed),
        );
      } else if (priorReview) {
        const rebound = rebindSemanticReviewRecordV2(
          priorReview.record,
          previousPayload,
          nextPayload,
        );
        const nextReviewKey = semanticReviewKeyV2(
          nextPayload.input.mutationRevision,
          nextPayload.candidateInputHash,
        );
        futureReview = this.persistReview(
          artifact,
          buildLoopV2LiveReviewArtifactV1(
            artifact,
            rebound,
            // Control-only report growth can change the candidate artifact
            // hash without changing the semantic review identity. In that
            // case the settled record is already bound to the exact key and
            // only needs rebinding to the new container; a reuse edge must
            // point to a different review key.
            priorReview.reviewKey === nextReviewKey
              ? priorReview.reuse
              : {
                  fromReviewKey: priorReview.reviewKey,
                  semanticSubjectHash: nextSubject,
                },
          ),
        );
      } else if (priorClaim) {
        const interrupted =
          createInterruptedSemanticReviewRecordV2(nextPayload);
        futureReview = this.persistReview(
          artifact,
          buildLoopV2LiveReviewArtifactV1(artifact, interrupted),
        );
      }
    }

    // Candidate is the commit marker and is always written last. Before it,
    // either no review exists for this revision or a future review plus an old
    // guard claim are already durable. Both sides of a process crash therefore
    // remain at-most-once and fail closed.
    this.commitCandidateArtifact(artifactPath, artifact);
    const persisted = parseLoopV2LiveCandidateArtifactV1(
      fs.readFileSync(artifactPath, "utf8"),
    );
    if (persisted.artifactHash !== artifact.artifactHash) {
      throw new Error("Loop v2 candidate commit did not persist its target");
    }
    this.candidate = persisted;
    this.claim = undefined;
    this.review = futureReview;
    return persisted;
  }

  async reviewCandidate(): Promise<LoopV2LiveReviewRuntimeResultV1> {
    const candidate = this.candidate;
    if (!candidate) {
      throw new Error(
        "Loop v2 semantic review requires a persisted candidate artifact",
      );
    }
    if (!candidate.assessment.readiness.readyForSemanticReview) {
      throw new Error("Loop v2 semantic review requires a ready candidate");
    }
    const model = this.model;
    if (!model) {
      throw new Error("Loop v2 semantic review model is not configured");
    }
    const payload = buildLoopV2LiveReviewPayloadV1(
      candidate.report,
      candidate.policy,
    );
    const existingReview =
      this.review?.candidateArtifactHash === candidate.artifactHash
        ? this.review
        : undefined;
    const existingClaim =
      this.claim?.candidateArtifactHash === candidate.artifactHash
        ? this.claim
        : undefined;
    let modelCalls = 0;
    let usage: SemanticReviewUsageV2 | undefined;
    let result: SemanticReviewOnceResultV2;

    if (existingReview) {
      result = await reviewCandidateOnceV2(
        { records: { [existingReview.reviewKey]: existingReview.record } },
        payload,
        async () => {
          throw new Error("Settled semantic review was not reused");
        },
      );
    } else if (existingClaim) {
      const interrupted = createInterruptedSemanticReviewRecordV2(payload);
      result = await reviewCandidateOnceV2(
        { records: { [interrupted.reviewKey]: interrupted } },
        payload,
        async () => {
          throw new Error("Claimed semantic review was invoked again");
        },
      );
    } else {
      this.claim = this.persistClaim(candidate);
      const countedModel: SemanticReviewModelV2 = {
        label: model.label,
        async complete(messages, options) {
          modelCalls += 1;
          return model.complete(messages, options);
        },
      };
      const reviewer = createModelSemanticReviewerV2({
        model: countedModel,
        ...(this.signal ? { signal: this.signal } : {}),
        onUsage: (modelLabel, rawUsage) => {
          usage = {
            ...rawUsage,
            totalTokens:
              rawUsage.totalTokens ??
              (rawUsage.promptTokens ?? 0) + (rawUsage.completionTokens ?? 0),
          };
          this.onUsage?.(modelLabel, rawUsage);
        },
      });
      result = await reviewCandidateOnceV2(
        createSemanticReviewLedgerV2(),
        payload,
        reviewer,
      );
    }

    if (!existingReview) {
      const record = result.ledger.records[result.reviewKey];
      if (!record) throw new Error("Loop v2 semantic review record is missing");
      this.review = this.persistReview(
        candidate,
        buildLoopV2LiveReviewArtifactV1(candidate, record),
      );
    }
    return { ...result, modelCalls, ...(usage ? { usage } : {}) };
  }

  /** Persists the non-authoritative v1/v2 terminal comparison and rereads it. */
  persistTerminal(
    legacyTerminal: LoopV2LegacyTerminalV1,
  ): LoopV2LiveTerminalArtifactV1 {
    const artifact = buildLoopV2LiveTerminalArtifactV1({
      runId: this.runId,
      legacyTerminal,
      ...(this.candidate ? { candidate: this.candidate } : {}),
      ...(this.review ? { review: this.review } : {}),
    });
    const artifactPath = loopV2LiveTerminalArtifactPath(
      this.workspaceRoot,
      this.runId,
    );
    atomicWrite(
      artifactPath,
      serializeLoopV2LiveTerminalArtifactV1(
        artifact,
        this.candidate,
        this.review,
      ),
    );
    return parseLoopV2LiveTerminalArtifactV1(
      fs.readFileSync(artifactPath, "utf8"),
      this.candidate,
      this.review,
    );
  }

  /** Persists the diagnostic public-result mapping and rereads it strictly. */
  persistRunResultShadow(
    legacyResult: RunResult,
    terminal: LoopV2LiveTerminalArtifactV1,
  ): LoopV2RunResultShadowArtifactV1 {
    const artifact = buildLoopV2RunResultShadowArtifactV1(
      legacyResult,
      terminal,
      this.candidate,
      this.review,
    );
    const artifactPath = loopV2RunResultShadowArtifactPath(
      this.workspaceRoot,
      this.runId,
    );
    atomicWrite(
      artifactPath,
      serializeLoopV2RunResultShadowArtifactV1(
        artifact,
        terminal,
        this.candidate,
        this.review,
      ),
    );
    const persisted = parseLoopV2RunResultShadowArtifactV1(
      fs.readFileSync(artifactPath, "utf8"),
      terminal,
      this.candidate,
      this.review,
    );
    if (persisted.eligibility.eligible && !persisted.comparison.cutoverReady) {
      throw new Error("Eligible loop v2 RunResult shadow is not cutover-ready");
    }
    return persisted;
  }

  private persistClaim(
    candidate: LoopV2LiveCandidateArtifactV1,
  ): LoopV2LiveReviewClaimV1 {
    const claim = buildLoopV2LiveReviewClaimV1(candidate);
    const claimPath = loopV2LiveReviewClaimPath(this.workspaceRoot, this.runId);
    atomicWrite(claimPath, serializeLoopV2LiveReviewClaimV1(claim, candidate));
    return parseLoopV2LiveReviewClaimV1(
      fs.readFileSync(claimPath, "utf8"),
      candidate,
    );
  }

  private commitCandidateArtifact(
    artifactPath: string,
    artifact: LoopV2LiveCandidateArtifactV1,
  ): void {
    atomicWrite(artifactPath, serializeLoopV2LiveCandidateArtifactV1(artifact));
  }

  private persistReview(
    candidate: LoopV2LiveCandidateArtifactV1,
    review: LoopV2LiveReviewArtifactV1,
  ): LoopV2LiveReviewArtifactV1 {
    const reviewPath = loopV2LiveReviewArtifactPath(
      this.workspaceRoot,
      this.runId,
    );
    atomicWrite(
      reviewPath,
      serializeLoopV2LiveReviewArtifactV1(review, candidate),
    );
    return parseLoopV2LiveReviewArtifactV1(
      fs.readFileSync(reviewPath, "utf8"),
      candidate,
    );
  }

  private readCandidateBoundArtifact<T>(
    artifactPath: string,
    candidate: LoopV2LiveCandidateArtifactV1,
    parse: (serialized: string, candidate: LoopV2LiveCandidateArtifactV1) => T,
  ): T | undefined {
    if (!fs.existsSync(artifactPath)) return undefined;
    const serialized = fs.readFileSync(artifactPath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new Error(
        `Loop v2 resume artifact is not valid JSON: ${path.basename(artifactPath)}`,
      );
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("candidateArtifactHash" in value) ||
      value.candidateArtifactHash !== candidate.artifactHash
    ) {
      return undefined;
    }
    return parse(serialized, candidate);
  }
}
