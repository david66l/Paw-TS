import { sha256Canonical } from "./canonical.js";
import {
  evidenceFingerprint,
  extendReadCoverage,
  readCoverageKey,
} from "./evidence.js";
import {
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Envelope,
  type ProgressDeltaV2,
  type WorkingDecisionStateV2,
  assertLoopV2Envelope,
} from "./schema.js";

const EMPTY_DELTA: ProgressDeltaV2 = {
  evidenceAdded: [],
  hypothesesChanged: [],
  criteriaChanged: [],
  mutationsAdded: [],
  verificationChanged: [],
  risksChanged: [],
  userStateChanged: false,
  meaningful: false,
};

export function createWorkingDecisionStateV2(
  runId: string,
): WorkingDecisionStateV2 {
  if (!runId.trim()) throw new Error("Loop v2 runId must not be empty");
  return {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    runId,
    lastSeq: 0,
    phase: "discover",
    criteria: {},
    hypotheses: {},
    evidence: {},
    readCoverage: {},
    invariants: {},
    changeSurface: {},
    risks: {},
    mutations: {},
    verification: {},
    currentMutationRevision: 0,
    contextCompactions: 0,
    contextArtifactRefs: [],
  };
}

export function projectLoopV2Event(
  prior: WorkingDecisionStateV2,
  envelope: LoopV2Envelope,
): { readonly state: WorkingDecisionStateV2; readonly delta: ProgressDeltaV2 } {
  assertLoopV2Envelope(envelope);
  assertEnvelopeCanFollow(prior, envelope);
  const base = { ...prior, lastSeq: envelope.seq };
  const event = envelope.event;

  switch (event.type) {
    case "task.started": {
      if (prior.goal)
        throw new Error("Loop v2 task.started may only occur once");
      return {
        state: {
          ...base,
          goal: { verbatim: event.goal, sourceHash: event.sourceHash },
        },
        delta: { ...EMPTY_DELTA, userStateChanged: true, meaningful: true },
      };
    }
    case "provider.turn_stopped":
      return { state: base, delta: EMPTY_DELTA };
    case "readiness.evaluated":
      return { state: base, delta: EMPTY_DELTA };
    case "semantic_review.recorded":
      return { state: base, delta: EMPTY_DELTA };
    case "evidence.observed": {
      const fingerprint = evidenceFingerprint(event.observation);
      const existing = prior.evidence[fingerprint];
      let meaningful = existing === undefined;
      let readCoverage = prior.readCoverage;
      if (event.observation.kind === "read") {
        const key = readCoverageKey(event.observation);
        const extended = extendReadCoverage(
          prior.readCoverage[key],
          event.observation,
        );
        meaningful = extended.meaningful;
        readCoverage = { ...prior.readCoverage, [key]: extended.coverage };
      }
      const record = existing
        ? {
            ...existing,
            lastObservedSeq: envelope.seq,
            observationCount: existing.observationCount + 1,
          }
        : {
            id: `evidence-${fingerprint.slice(0, 16)}`,
            fingerprint,
            observation: event.observation,
            firstObservedSeq: envelope.seq,
            lastObservedSeq: envelope.seq,
            observationCount: 1,
          };
      return {
        state: {
          ...base,
          evidence: { ...prior.evidence, [fingerprint]: record },
          readCoverage,
        },
        delta: meaningful
          ? {
              ...EMPTY_DELTA,
              evidenceAdded: [record.id],
              meaningful: true,
            }
          : EMPTY_DELTA,
      };
    }
    case "criterion.upserted": {
      const changed =
        sha256Canonical(prior.criteria[event.criterion.id]) !==
        sha256Canonical(event.criterion);
      return {
        state: {
          ...base,
          criteria: {
            ...prior.criteria,
            [event.criterion.id]: event.criterion,
          },
        },
        delta: changed
          ? {
              ...EMPTY_DELTA,
              criteriaChanged: [event.criterion.id],
              meaningful: true,
            }
          : EMPTY_DELTA,
      };
    }
    case "phase.changed": {
      const changed = prior.phase !== event.phase;
      return {
        state: { ...base, phase: event.phase },
        delta: changed ? { ...EMPTY_DELTA, meaningful: true } : EMPTY_DELTA,
      };
    }
    case "hypothesis.upserted": {
      if (
        event.hypothesis.proposedAtSeq > envelope.seq ||
        (event.hypothesis.closedAtSeq !== undefined &&
          (event.hypothesis.closedAtSeq < event.hypothesis.proposedAtSeq ||
            event.hypothesis.closedAtSeq > envelope.seq))
      ) {
        throw new Error("Hypothesis sequence references are inconsistent");
      }
      const changed =
        sha256Canonical(prior.hypotheses[event.hypothesis.id]) !==
        sha256Canonical(event.hypothesis);
      return {
        state: {
          ...base,
          hypotheses: {
            ...prior.hypotheses,
            [event.hypothesis.id]: event.hypothesis,
          },
        },
        delta: changed
          ? {
              ...EMPTY_DELTA,
              hypothesesChanged: [event.hypothesis.id],
              meaningful: true,
            }
          : EMPTY_DELTA,
      };
    }
    case "risk.upserted": {
      const changed =
        sha256Canonical(prior.risks[event.risk.id]) !==
        sha256Canonical(event.risk);
      return {
        state: {
          ...base,
          risks: { ...prior.risks, [event.risk.id]: event.risk },
        },
        delta: changed
          ? {
              ...EMPTY_DELTA,
              risksChanged: [event.risk.id],
              meaningful: true,
            }
          : EMPTY_DELTA,
      };
    }
    case "invariant.upserted": {
      const changed =
        sha256Canonical(prior.invariants[event.invariant.id]) !==
        sha256Canonical(event.invariant);
      return {
        state: {
          ...base,
          invariants: {
            ...prior.invariants,
            [event.invariant.id]: event.invariant,
          },
        },
        delta: changed ? { ...EMPTY_DELTA, meaningful: true } : EMPTY_DELTA,
      };
    }
    case "change_surface.upserted": {
      const changed =
        sha256Canonical(prior.changeSurface[event.changeSurface.id]) !==
        sha256Canonical(event.changeSurface);
      return {
        state: {
          ...base,
          changeSurface: {
            ...prior.changeSurface,
            [event.changeSurface.id]: event.changeSurface,
          },
        },
        delta: changed ? { ...EMPTY_DELTA, meaningful: true } : EMPTY_DELTA,
      };
    }
    case "next_action.updated": {
      const changed =
        sha256Canonical(prior.nextAction) !== sha256Canonical(event.nextAction);
      return {
        state: { ...base, nextAction: event.nextAction },
        delta: changed ? { ...EMPTY_DELTA, meaningful: true } : EMPTY_DELTA,
      };
    }
    case "mutation.recorded": {
      if (event.mutation.seq !== envelope.seq) {
        throw new Error("Mutation journal seq must match its event envelope");
      }
      if (
        event.mutation.mutationRevision !==
        prior.currentMutationRevision + 1
      ) {
        throw new Error(
          `Mutation revision must be ${prior.currentMutationRevision + 1}: ${event.mutation.mutationRevision}`,
        );
      }
      const existing = prior.mutations[event.mutation.callId];
      if (
        existing &&
        sha256Canonical(existing) !== sha256Canonical(event.mutation)
      ) {
        throw new Error(
          `Conflicting mutation callId: ${event.mutation.callId}`,
        );
      }
      const meaningful = existing === undefined;
      return {
        state: {
          ...base,
          mutations: {
            ...prior.mutations,
            [event.mutation.callId]: event.mutation,
          },
          currentMutationRevision: Math.max(
            prior.currentMutationRevision,
            event.mutation.mutationRevision,
          ),
          ...(meaningful ? { currentCandidate: undefined } : {}),
        },
        delta: meaningful
          ? {
              ...EMPTY_DELTA,
              mutationsAdded: [event.mutation.callId],
              meaningful: true,
            }
          : EMPTY_DELTA,
      };
    }
    case "verification.recorded": {
      if (event.verification.mutationRevision > prior.currentMutationRevision) {
        throw new Error(
          `Verification references future mutation revision: ${event.verification.mutationRevision}`,
        );
      }
      const changed =
        sha256Canonical(prior.verification[event.verification.id]) !==
        sha256Canonical(event.verification);
      return {
        state: {
          ...base,
          verification: {
            ...prior.verification,
            [event.verification.id]: event.verification,
          },
        },
        delta: changed
          ? {
              ...EMPTY_DELTA,
              verificationChanged: [event.verification.id],
              meaningful: true,
            }
          : EMPTY_DELTA,
      };
    }
    case "candidate.proposed": {
      if (event.candidate.proposedAtSeq !== envelope.seq) {
        throw new Error(
          "Candidate proposedAtSeq must match its event envelope",
        );
      }
      if (event.candidate.mutationRevision !== prior.currentMutationRevision) {
        throw new Error(
          `Candidate revision ${event.candidate.mutationRevision} does not match current revision ${prior.currentMutationRevision}`,
        );
      }
      const changed =
        sha256Canonical(prior.currentCandidate) !==
        sha256Canonical(event.candidate);
      return {
        state: {
          ...base,
          phase: "candidate",
          currentCandidate: event.candidate,
        },
        delta: changed ? { ...EMPTY_DELTA, meaningful: true } : EMPTY_DELTA,
      };
    }
    case "context.compacted": {
      if (event.summarizedSeqThrough > prior.lastSeq) {
        throw new Error("Loop v2 compaction cannot summarize future events");
      }
      return {
        state: {
          ...base,
          contextCompactions: prior.contextCompactions + 1,
          contextArtifactRefs: unique([
            ...prior.contextArtifactRefs,
            ...event.artifactRefs,
          ]),
        },
        delta: EMPTY_DELTA,
      };
    }
  }
}

export function decisionStateHash(state: WorkingDecisionStateV2): string {
  return sha256Canonical({
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    goal: state.goal,
    phase: state.phase,
    criteria: state.criteria,
    hypotheses: state.hypotheses,
    evidenceFingerprints: Object.keys(state.evidence).sort(),
    readCoverage: state.readCoverage,
    invariants: state.invariants,
    changeSurface: state.changeSurface,
    risks: state.risks,
    mutations: state.mutations,
    verification: state.verification,
    currentMutationRevision: state.currentMutationRevision,
    currentCandidate: state.currentCandidate,
    nextAction: state.nextAction,
  });
}

export function projectionHash(state: WorkingDecisionStateV2): string {
  return sha256Canonical(state);
}

function assertEnvelopeCanFollow(
  prior: WorkingDecisionStateV2,
  envelope: LoopV2Envelope,
): void {
  if (envelope.schemaVersion !== LOOP_V2_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported loop v2 event schema: ${envelope.schemaVersion}`,
    );
  }
  if (envelope.runId !== prior.runId) {
    throw new Error(
      `Loop v2 run mismatch: expected ${prior.runId}, received ${envelope.runId}`,
    );
  }
  const expectedSeq = prior.lastSeq + 1;
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq !== expectedSeq) {
    throw new Error(
      `Loop v2 seq must be contiguous; expected ${expectedSeq}, received ${envelope.seq}`,
    );
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
