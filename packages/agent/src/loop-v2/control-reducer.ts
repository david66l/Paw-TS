import { sha256Canonical } from "./canonical.js";
import type { LoopV2Envelope, VerificationRecordV2 } from "./schema.js";

export const CONTROL_STATE_SCHEMA_VERSION = 1 as const;

export type ControlStatusV1 = "running" | "candidate" | "repair_required";

export type RepairRequirementV1 =
  | Readonly<{
      kind: "direct_verification";
      revision: number;
      runnerFamily: string;
      scope: readonly string[];
    }>
  | Readonly<{
      kind: "material_change";
      afterRevision: number;
      scope?: readonly string[];
    }>;

export type RepairObligationV1 = RepairRequirementV1 &
  Readonly<{
    id: string;
    openedAtSeq: number;
  }>;

export interface ControlCandidateV1 {
  readonly id: string;
  readonly mutationRevision: number;
  readonly candidateInputHash: string;
}

export interface ControlStateV1 {
  readonly schemaVersion: typeof CONTROL_STATE_SCHEMA_VERSION;
  readonly runId: string;
  readonly lastSeq: number;
  readonly lastInputHash?: string;
  readonly goalHash?: string;
  readonly status: ControlStatusV1;
  readonly turn: number;
  readonly consecutiveNoActionStops: number;
  readonly mutationRevision: number;
  readonly candidate?: ControlCandidateV1;
  readonly openRepairObligation?: RepairObligationV1;
}

export type ControlFactV1 =
  | Readonly<{ type: "run.started"; goalHash: string }>
  | Readonly<{
      type: "provider.turn_stopped";
      turn: number;
      empty: boolean;
    }>
  | Readonly<{
      type: "candidate.submitted";
      candidate: ControlCandidateV1;
    }>
  | Readonly<{
      type: "readiness.evaluated";
      candidateId: string;
      mutationRevision: number;
      result:
        | Readonly<{ kind: "ready" }>
        | Readonly<{
            kind: "repair_required";
            requirement: RepairRequirementV1;
          }>;
    }>
  | Readonly<{
      type: "verification.observed";
      verification: Readonly<{
        revision: number;
        runnerFamily: string;
        scope: readonly string[];
        outcome: "passed" | "code_failed" | "harness_failed";
      }>;
    }>
  | Readonly<{
      type: "mutation.committed";
      revision: number;
      paths: readonly string[];
    }>
  | Readonly<{
      type: "tool.settled";
      tool: string;
      ok: boolean;
    }>;

/**
 * A reducer input is a typed view over the existing durable run journal. It is
 * deliberately not a second persistence envelope or event store.
 */
export interface ControlReducerInputV1 {
  readonly runId: string;
  readonly seq: number;
  readonly fact: ControlFactV1;
}

export type ControlEffectV1 =
  | Readonly<{
      type: "call_model";
      reason: "turn_boundary" | "empty_response_recovery" | "repair_required";
    }>
  | Readonly<{
      type: "request_readiness";
      candidateId: string;
    }>;

export interface ControlReductionV1 {
  readonly state: ControlStateV1;
  readonly effects: readonly ControlEffectV1[];
}

export interface ControlReplayStepV1 {
  readonly seq: number;
  readonly factType: ControlFactV1["type"];
  readonly stateHash: string;
  readonly effects: readonly ControlEffectV1[];
}

export interface ControlReplayResultV1 {
  readonly state: ControlStateV1;
  readonly stateHash: string;
  readonly steps: readonly ControlReplayStepV1[];
}

export function createControlStateV1(runId: string): ControlStateV1 {
  if (!runId.trim()) throw new Error("Control reducer runId must not be empty");
  return {
    schemaVersion: CONTROL_STATE_SCHEMA_VERSION,
    runId,
    lastSeq: 0,
    status: "running",
    turn: 0,
    consecutiveNoActionStops: 0,
    mutationRevision: 0,
  };
}

export function reduceControlStateV1(
  prior: ControlStateV1,
  input: ControlReducerInputV1,
): ControlReductionV1 {
  assertControlInput(prior, input);
  const inputHash = sha256Canonical(input);
  if (input.seq === prior.lastSeq) {
    if (inputHash !== prior.lastInputHash) {
      throw new Error(`Conflicting control fact at seq ${input.seq}`);
    }
    return { state: prior, effects: [] };
  }

  const base: ControlStateV1 = {
    ...prior,
    lastSeq: input.seq,
    lastInputHash: inputHash,
  };
  const fact = input.fact;

  switch (fact.type) {
    case "run.started": {
      if (prior.goalHash !== undefined) {
        throw new Error("Control run.started may only occur once");
      }
      return { state: { ...base, goalHash: fact.goalHash }, effects: [] };
    }
    case "provider.turn_stopped": {
      if (fact.turn <= prior.turn) {
        throw new Error(
          `Provider turn must increase: ${fact.turn} <= ${prior.turn}`,
        );
      }
      return {
        state: {
          ...base,
          turn: fact.turn,
          consecutiveNoActionStops: prior.consecutiveNoActionStops + 1,
        },
        effects: [
          {
            type: "call_model",
            reason: prior.openRepairObligation
              ? "repair_required"
              : fact.empty
                ? "empty_response_recovery"
                : "turn_boundary",
          },
        ],
      };
    }
    case "candidate.submitted": {
      if (fact.candidate.mutationRevision !== prior.mutationRevision) {
        throw new Error(
          `Candidate revision ${fact.candidate.mutationRevision} does not match control revision ${prior.mutationRevision}`,
        );
      }
      if (prior.openRepairObligation) {
        return {
          state: { ...base, status: "repair_required" },
          effects: [{ type: "call_model", reason: "repair_required" }],
        };
      }
      return {
        state: {
          ...base,
          status: "candidate",
          candidate: fact.candidate,
          consecutiveNoActionStops: 0,
        },
        effects: [
          { type: "request_readiness", candidateId: fact.candidate.id },
        ],
      };
    }
    case "readiness.evaluated": {
      assertCurrentCandidate(prior, fact.candidateId, fact.mutationRevision);
      if (fact.result.kind === "ready") {
        return { state: base, effects: [] };
      }
      const obligation = openRepairObligation(
        prior.runId,
        input.seq,
        fact.result.requirement,
      );
      return {
        state: {
          ...base,
          status: "repair_required",
          openRepairObligation: obligation,
        },
        effects: [{ type: "call_model", reason: "repair_required" }],
      };
    }
    case "verification.observed":
      return reduceVerification(base, prior, fact.verification, input.seq);
    case "mutation.committed":
      return reduceMutation(base, prior, fact.revision, fact.paths);
    case "tool.settled":
      return { state: base, effects: [] };
  }
}

export function replayControlFactsV1(
  runId: string,
  inputs: readonly ControlReducerInputV1[],
  checkpoint?: ControlStateV1,
): ControlReplayResultV1 {
  let state = checkpoint
    ? restoreControlStateV1(runId, checkpoint)
    : createControlStateV1(runId);
  const steps: ControlReplayStepV1[] = [];
  for (const input of inputs) {
    const reduced = reduceControlStateV1(state, input);
    state = reduced.state;
    steps.push({
      seq: input.seq,
      factType: input.fact.type,
      stateHash: controlStateHashV1(state),
      effects: reduced.effects,
    });
  }
  return { state, stateHash: controlStateHashV1(state), steps };
}

export function restoreControlStateV1(
  runId: string,
  checkpoint: ControlStateV1,
): ControlStateV1 {
  if (checkpoint.schemaVersion !== CONTROL_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported control state schema: ${checkpoint.schemaVersion}`,
    );
  }
  if (checkpoint.runId !== runId) {
    throw new Error(
      `Control state run mismatch: ${checkpoint.runId} != ${runId}`,
    );
  }
  return structuredClone(checkpoint);
}

export function controlStateHashV1(state: ControlStateV1): string {
  return sha256Canonical(state);
}

/**
 * Projects control-relevant facts from the existing Loop v2 journal. Events
 * that belong only to the evidence/advisor projection intentionally return
 * undefined. Provider boundaries and readiness facts will be emitted directly
 * at their current production seams in later cutover slices.
 */
export function controlInputFromLoopV2EnvelopeV1(
  envelope: LoopV2Envelope,
): ControlReducerInputV1 | undefined {
  const event = envelope.event;
  let fact: ControlFactV1 | undefined;
  switch (event.type) {
    case "task.started":
      fact = { type: "run.started", goalHash: event.sourceHash };
      break;
    case "provider.turn_stopped":
      fact = {
        type: "provider.turn_stopped",
        turn: event.turn,
        empty: event.empty,
      };
      break;
    case "mutation.recorded":
      fact = {
        type: "mutation.committed",
        revision: event.mutation.mutationRevision,
        paths: event.mutation.paths,
      };
      break;
    case "verification.recorded":
      fact = {
        type: "verification.observed",
        verification: verificationFact(event.verification),
      };
      break;
    case "candidate.proposed":
      if (event.candidate.source === "natural_stop_adapter") return undefined;
      fact = {
        type: "candidate.submitted",
        candidate: {
          id: event.candidate.id,
          mutationRevision: event.candidate.mutationRevision,
          candidateInputHash: event.candidate.candidateInputHash,
        },
      };
      break;
    default:
      return undefined;
  }
  return { runId: envelope.runId, seq: envelope.seq, fact };
}

function reduceVerification(
  base: ControlStateV1,
  prior: ControlStateV1,
  verification: Extract<
    ControlFactV1,
    { type: "verification.observed" }
  >["verification"],
  seq: number,
): ControlReductionV1 {
  const obligation = prior.openRepairObligation;
  if (
    !obligation ||
    obligation.kind !== "direct_verification" ||
    obligation.revision !== verification.revision ||
    obligation.runnerFamily !== verification.runnerFamily ||
    !sameScope(obligation.scope, verification.scope)
  ) {
    return { state: base, effects: [] };
  }

  if (verification.outcome === "harness_failed") {
    return {
      state: base,
      effects: [{ type: "call_model", reason: "repair_required" }],
    };
  }
  if (verification.outcome === "code_failed") {
    const material = openRepairObligation(prior.runId, seq, {
      kind: "material_change",
      afterRevision: verification.revision,
      ...(obligation.scope.length > 0 ? { scope: obligation.scope } : {}),
    });
    return {
      state: {
        ...base,
        status: "repair_required",
        openRepairObligation: material,
      },
      effects: [{ type: "call_model", reason: "repair_required" }],
    };
  }
  return {
    state: {
      ...base,
      status: prior.candidate ? "candidate" : "running",
      openRepairObligation: undefined,
    },
    effects: prior.candidate
      ? [{ type: "request_readiness", candidateId: prior.candidate.id }]
      : [],
  };
}

function reduceMutation(
  base: ControlStateV1,
  prior: ControlStateV1,
  revision: number,
  paths: readonly string[],
): ControlReductionV1 {
  if (!Number.isSafeInteger(revision) || revision <= prior.mutationRevision) {
    throw new Error(
      `Mutation revision must increase: ${revision} <= ${prior.mutationRevision}`,
    );
  }
  const obligation = prior.openRepairObligation;
  if (obligation?.kind === "direct_verification") {
    return {
      state: {
        ...base,
        status: "repair_required",
        mutationRevision: revision,
        candidate: undefined,
        openRepairObligation: { ...obligation, revision },
      },
      effects: [{ type: "call_model", reason: "repair_required" }],
    };
  }
  const clearsMaterial =
    obligation?.kind === "material_change" &&
    revision > obligation.afterRevision &&
    scopeCovered(obligation.scope, paths);
  return {
    state: {
      ...base,
      status: clearsMaterial ? "running" : prior.status,
      mutationRevision: revision,
      candidate: undefined,
      ...(clearsMaterial ? { openRepairObligation: undefined } : {}),
    },
    effects: [],
  };
}

function openRepairObligation(
  runId: string,
  openedAtSeq: number,
  requirement: RepairRequirementV1,
): RepairObligationV1 {
  const identity = sha256Canonical({ runId, openedAtSeq, requirement });
  return {
    ...requirement,
    id: `repair-${identity.slice(0, 16)}`,
    openedAtSeq,
  };
}

function assertControlInput(
  prior: ControlStateV1,
  input: ControlReducerInputV1,
): void {
  if (input.runId !== prior.runId) {
    throw new Error(
      `Control fact run mismatch: ${input.runId} != ${prior.runId}`,
    );
  }
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) {
    throw new Error(
      `Control fact seq must be a positive integer: ${input.seq}`,
    );
  }
  if (input.seq === prior.lastSeq) return;
  if (input.seq < prior.lastSeq) {
    throw new Error(
      `Control fact seq must increase: ${input.seq} < ${prior.lastSeq}`,
    );
  }
}

function assertCurrentCandidate(
  state: ControlStateV1,
  candidateId: string,
  mutationRevision: number,
): void {
  if (
    state.candidate?.id !== candidateId ||
    state.candidate.mutationRevision !== mutationRevision ||
    mutationRevision !== state.mutationRevision
  ) {
    throw new Error("Readiness fact does not match the current candidate");
  }
}

function verificationFact(
  verification: VerificationRecordV2,
): Extract<ControlFactV1, { type: "verification.observed" }>["verification"] {
  return {
    revision: verification.mutationRevision,
    runnerFamily: verification.runner,
    scope: verification.scope,
    outcome: verification.outcome,
  };
}

function sameScope(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function scopeCovered(
  required: readonly string[] | undefined,
  observed: readonly string[],
): boolean {
  if (!required || required.length === 0) return observed.length > 0;
  const observedSet = new Set(observed);
  return required.every((path) => observedSet.has(path));
}
