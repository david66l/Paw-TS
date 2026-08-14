import fs from "node:fs";
import path from "node:path";

import { atomicWrite } from "@paw/core";

import {
  type SemanticReviewOnceResultV2,
  createInterruptedSemanticReviewRecordV2,
  createSemanticReviewLedgerV2,
  reviewCandidateOnceV2,
} from "./candidate-certification.js";
import { canonicalJson } from "./canonical.js";
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

  /** Persists a fact-changing candidate; summary-only proposals reuse the first artifact. */
  persistCandidate(
    artifact: LoopV2LiveCandidateArtifactV1,
  ): LoopV2LiveCandidateArtifactV1 {
    if (artifact.report.runId !== this.runId) {
      throw new Error("Loop v2 live review candidate runId mismatch");
    }
    const artifactPath = loopV2LiveArtifactPath(this.workspaceRoot, this.runId);
    const prior = this.candidate;
    const sameSemanticCandidate =
      prior?.assessment.candidateInputHash ===
        artifact.assessment.candidateInputHash &&
      canonicalJson(prior.policy) === canonicalJson(artifact.policy);
    if (!sameSemanticCandidate) {
      atomicWrite(
        artifactPath,
        serializeLoopV2LiveCandidateArtifactV1(artifact),
      );
    }
    const persisted = parseLoopV2LiveCandidateArtifactV1(
      fs.readFileSync(artifactPath, "utf8"),
    );
    if (
      sameSemanticCandidate &&
      persisted.artifactHash !== prior?.artifactHash
    ) {
      throw new Error(
        "Loop v2 semantic candidate artifact changed without a fact change",
      );
    }
    if (prior?.artifactHash !== persisted.artifactHash) {
      this.claim = undefined;
      this.review = undefined;
    }
    this.candidate = persisted;
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
    const payload = buildLoopV2LiveReviewPayloadV1(candidate.report);
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
