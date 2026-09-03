import type { MemorySourceLocalHydratedEvidenceV1 } from "@paw/memory-plugin";

import {
  immutableSourceTurnEvidenceRefV1,
  legacyImmutableTurnEvidenceRefV1,
} from "./immutable-evidence-address.js";

const ARCHIVE_HYDRATION_BATCH_SIZE_V1 = 64;

export interface AmbImmutableSourceLocalHydrationPortV1 {
  hydrate?(
    evidenceRefs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly MemorySourceLocalHydratedEvidenceV1[]>;
}

export interface AmbImmutableSourceLocalHydrationV1 {
  readonly rows: readonly MemorySourceLocalHydratedEvidenceV1[];
  readonly directCount: number;
  readonly legacyMappedCount: number;
}

/**
 * Resolves logical source-local addresses exclusively through immutable L0.
 * Search-index text is intentionally not accepted by this boundary.
 */
export async function hydrateAmbImmutableSourceLocalEvidenceV1(input: {
  readonly archive: AmbImmutableSourceLocalHydrationPortV1;
  readonly evidenceRefs: readonly string[];
  readonly signal: AbortSignal;
}): Promise<AmbImmutableSourceLocalHydrationV1> {
  if (
    !input.archive.hydrate ||
    input.evidenceRefs.length > 2_048 ||
    new Set(input.evidenceRefs).size !== input.evidenceRefs.length ||
    input.evidenceRefs.some((ref) => !ref.trim())
  ) {
    throw namedError("AmbImmutableSourceLocalHydrationRequestInvalid");
  }
  if (input.evidenceRefs.length === 0) {
    return Object.freeze({
      rows: Object.freeze([]),
      directCount: 0,
      legacyMappedCount: 0,
    });
  }
  const currentAddresses = input.evidenceRefs.map((evidenceRef) => {
    const physicalRef = immutableSourceTurnEvidenceRefV1(evidenceRef);
    if (!physicalRef) {
      throw namedError("AmbImmutableSourceLocalHydrationAddressInvalid");
    }
    return Object.freeze({ evidenceRef, physicalRef });
  });
  const directlyHydrated = await hydrateInExactBatches(
    input.archive,
    currentAddresses.map((item) => item.physicalRef),
    input.signal,
  );
  const directByPhysicalRef = exactRowsByRef(
    directlyHydrated,
    currentAddresses.map((item) => item.physicalRef),
  );
  const directByRef = new Map(
    currentAddresses.flatMap(({ evidenceRef, physicalRef }) => {
      const row = directByPhysicalRef.get(physicalRef);
      return row
        ? [[evidenceRef, Object.freeze({ ...row, evidenceRef })] as const]
        : [];
    }),
  );

  // Existing LongMemEval stores may predate the #source alias. Its #atom
  // counterpart names the same immutable L0 turn, so only the address changes.
  const legacyAddresses = input.evidenceRefs.flatMap((evidenceRef) => {
    if (directByRef.has(evidenceRef)) return [];
    const legacyRef = legacyImmutableTurnEvidenceRefV1(evidenceRef);
    if (!legacyRef) {
      throw namedError("AmbImmutableSourceLocalHydrationAddressInvalid");
    }
    return [Object.freeze({ evidenceRef, legacyRef })];
  });
  const legacyHydrated =
    legacyAddresses.length === 0
      ? []
      : await hydrateInExactBatches(
          input.archive,
          legacyAddresses.map((item) => item.legacyRef),
          input.signal,
        );
  const legacyByPhysicalRef = exactRowsByRef(
    legacyHydrated,
    legacyAddresses.map((item) => item.legacyRef),
  );
  const legacyPhysicalByLogicalRef = new Map(
    legacyAddresses.map((item) => [item.evidenceRef, item.legacyRef] as const),
  );
  const rows = input.evidenceRefs.flatMap((evidenceRef) => {
    const direct = directByRef.get(evidenceRef);
    if (direct) return [direct];
    const legacyRef = legacyPhysicalByLogicalRef.get(evidenceRef);
    const legacy = legacyRef ? legacyByPhysicalRef.get(legacyRef) : undefined;
    return legacy ? [Object.freeze({ ...legacy, evidenceRef })] : [];
  });
  if (rows.length !== input.evidenceRefs.length) {
    throw namedError("AmbImmutableSourceLocalHydrationIncomplete");
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    directCount: directByRef.size,
    legacyMappedCount: rows.length - directByRef.size,
  });
}

async function hydrateInExactBatches(
  archive: AmbImmutableSourceLocalHydrationPortV1,
  evidenceRefs: readonly string[],
  signal: AbortSignal,
): Promise<readonly MemorySourceLocalHydratedEvidenceV1[]> {
  if (!archive.hydrate) {
    throw namedError("AmbImmutableSourceLocalHydrationRequestInvalid");
  }
  const rows: MemorySourceLocalHydratedEvidenceV1[] = [];
  for (
    let offset = 0;
    offset < evidenceRefs.length;
    offset += ARCHIVE_HYDRATION_BATCH_SIZE_V1
  ) {
    if (signal.aborted) throw abortError();
    const batch = evidenceRefs.slice(
      offset,
      offset + ARCHIVE_HYDRATION_BATCH_SIZE_V1,
    );
    const batchRows = await archive.hydrate(batch, signal);
    exactRowsByRef(batchRows, batch);
    rows.push(...batchRows);
  }
  return Object.freeze(rows);
}

function exactRowsByRef(
  rows: readonly MemorySourceLocalHydratedEvidenceV1[],
  requestedRefs: readonly string[],
): ReadonlyMap<string, MemorySourceLocalHydratedEvidenceV1> {
  const requested = new Set(requestedRefs);
  const byRef = new Map<string, MemorySourceLocalHydratedEvidenceV1>();
  for (const row of rows) {
    if (!requested.has(row.evidenceRef) || byRef.has(row.evidenceRef)) {
      throw namedError("AmbImmutableSourceLocalHydrationPartitionInvalid");
    }
    byRef.set(row.evidenceRef, row);
  }
  return byRef;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
