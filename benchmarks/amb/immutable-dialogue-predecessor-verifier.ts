import { createHash } from "node:crypto";

import type {
  MemoryDialoguePredecessorVerificationRequestV1,
  MemoryDialoguePredecessorVerificationResultV1,
  MemoryRawEvidenceArchiveV1,
  MemorySourceLocalHydratedEvidenceV1,
} from "@paw/memory-plugin";

import { logicalSourceLocalEvidenceRefV1 } from "./immutable-evidence-address.js";
import { hydrateAmbImmutableSourceLocalEvidenceV1 } from "./immutable-source-local-hydration.js";

/**
 * Verifies only supplied source-local dialogue targets against immutable L0.
 * Hydration always uses canonical logical addresses; the proof preserves the
 * caller's exact target address so core target matching remains byte-exact.
 */
export async function verifyAmbImmutableDialoguePredecessorsV1(input: {
  readonly archive: MemoryRawEvidenceArchiveV1;
  readonly verifierVersion: string;
  readonly request: MemoryDialoguePredecessorVerificationRequestV1;
  readonly signal: AbortSignal;
}): Promise<MemoryDialoguePredecessorVerificationResultV1> {
  if (input.signal.aborted) throw abortError(input.signal);
  if (!input.archive.hydrate) return emptyResult(input.verifierVersion);
  const locked = new Set(input.request.lockedSourceIds);
  const pairs = input.request.targets.flatMap((target) => {
    const logicalTarget = canonicalLogicalSourceRefV1(target.evidenceRef);
    if (!logicalTarget) return [];
    const match = /^([^#]+)#source-(\d+)$/u.exec(logicalTarget ?? "");
    const turnOrder = Number(match?.[2]);
    if (
      !match?.[1] ||
      !match[2] ||
      match[1] !== target.sourceId ||
      !locked.has(target.sourceId) ||
      !Number.isSafeInteger(turnOrder) ||
      turnOrder < 2
    ) {
      return [];
    }
    return [
      Object.freeze({
        target,
        logicalTarget,
        turnOrder,
        predecessorLogicalRef: `${match[1]}#source-${turnOrder - 1}`,
      }),
    ];
  });
  if (pairs.length === 0) return emptyResult(input.verifierVersion);

  let rows: readonly MemorySourceLocalHydratedEvidenceV1[];
  try {
    const hydrated = await hydrateAmbImmutableSourceLocalEvidenceV1({
      archive: input.archive,
      evidenceRefs: [
        ...new Set(
          pairs.flatMap((pair) => [
            pair.logicalTarget,
            pair.predecessorLogicalRef,
          ]),
        ),
      ],
      signal: input.signal,
    });
    rows = hydrated.rows;
  } catch (error) {
    if (input.signal.aborted) throw abortError(input.signal);
    if (isAbortError(error)) throw error;
    // Immutable L0 disagreement is not recoverable evidence. Return no proof
    // rather than falling back to indexed text or a string-derived turn.
    return emptyResult(input.verifierVersion);
  }
  const byLogicalRef = new Map(rows.map((row) => [row.evidenceRef, row]));
  const cutoff =
    input.request.evidenceTimeUpperBound === undefined
      ? undefined
      : Date.parse(input.request.evidenceTimeUpperBound);
  const proofs = pairs.flatMap((pair) => {
    const hydratedAssistant = byLogicalRef.get(pair.logicalTarget);
    const precedingUser = byLogicalRef.get(pair.predecessorLogicalRef);
    const assistantTime = Date.parse(hydratedAssistant?.observedAt ?? "");
    const userTime = Date.parse(precedingUser?.observedAt ?? "");
    if (
      !hydratedAssistant ||
      !precedingUser ||
      hydratedAssistant.sourceKind !== "assistant_output" ||
      precedingUser.sourceKind !== "user_input" ||
      hydratedAssistant.turnOrder !== pair.turnOrder ||
      precedingUser.turnOrder !== pair.turnOrder - 1 ||
      hydratedAssistant.turnOrder !== precedingUser.turnOrder + 1 ||
      (cutoff !== undefined &&
        (!Number.isFinite(assistantTime) ||
          !Number.isFinite(userTime) ||
          assistantTime > cutoff ||
          userTime > cutoff))
    ) {
      return [];
    }
    return [
      Object.freeze({
        sourceId: pair.target.sourceId,
        // The core validates this byte-exactly against request.targets.
        assistant: Object.freeze({
          ...hydratedAssistant,
          evidenceRef: pair.target.evidenceRef,
        }),
        precedingUser,
      }),
    ];
  });
  return Object.freeze({
    verifierVersion: input.verifierVersion,
    verificationRevision: revisionForProofs(proofs),
    proofs: Object.freeze(proofs),
  });
}

function canonicalLogicalSourceRefV1(evidenceRef: string): string | undefined {
  return (
    logicalSourceLocalEvidenceRefV1(evidenceRef) ??
    (/^[^#]+#source-\d+$/u.test(evidenceRef) ? evidenceRef : undefined)
  );
}

function emptyResult(
  verifierVersion: string,
): MemoryDialoguePredecessorVerificationResultV1 {
  return Object.freeze({
    verifierVersion,
    verificationRevision: revisionForProofs([]),
    proofs: Object.freeze([]),
  });
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function revisionForProofs(
  proofs: readonly {
    sourceId: string;
    assistant: { evidenceRef: string; contentHash: string };
    precedingUser: { evidenceRef: string; contentHash: string };
  }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        proofs.map((proof) => ({
          sourceId: proof.sourceId,
          assistantEvidenceRef: proof.assistant.evidenceRef,
          assistantContentHash: proof.assistant.contentHash,
          precedingUserEvidenceRef: proof.precedingUser.evidenceRef,
          precedingUserContentHash: proof.precedingUser.contentHash,
        })),
      ),
    )
    .digest("hex");
}
