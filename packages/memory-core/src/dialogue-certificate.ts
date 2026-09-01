import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import type { MemoryDialoguePredecessorProofV1 } from "./source-local-evidence-locator.js";

export const PAW_MEMORY_DIALOGUE_CERTIFICATE_REGISTRY_VERSION_V1 =
  "paw.memory-dialogue-certificate-registry.v1:locked-adjacent-exact" as const;

export interface MemoryDialogueCertificateV1 {
  readonly sourceId: string;
  readonly assistant: Readonly<{
    evidenceRef: string;
    content: string;
    contentHash: string;
    turnOrder: number;
    observedAt?: string;
  }>;
  readonly predecessor: Readonly<{
    evidenceRef: string;
    contentHash: string;
    turnOrder: number;
    observedAt?: string;
  }>;
  readonly verifierVersion: string;
  readonly verificationRevision: string;
  readonly originRevision: string;
  readonly evidenceTimeUpperBound: string | null;
  readonly certificateRevision: string;
}

export interface MemoryDialogueCertificateRegistryV1 {
  readonly registryVersion: typeof PAW_MEMORY_DIALOGUE_CERTIFICATE_REGISTRY_VERSION_V1;
  readonly lockedSourceIds: readonly string[];
  readonly lockedSourceIdsRevision: string;
  readonly originRevision: string;
  readonly evidenceTimeUpperBound: string | null;
  readonly certificates: readonly MemoryDialogueCertificateV1[];
  readonly registryRevision: string;
}

export function compileMemoryDialogueCertificateRegistryV1(input: {
  readonly lockedSourceIds: readonly string[];
  readonly proofs: readonly MemoryDialoguePredecessorProofV1[];
  readonly verifierVersion: string | null;
  readonly verificationRevision: string | null;
  readonly originRevision: string;
  readonly evidenceTimeUpperBound?: string;
}): MemoryDialogueCertificateRegistryV1 {
  const lockedSourceIds = Object.freeze([...input.lockedSourceIds]);
  if (
    new Set(lockedSourceIds).size !== lockedSourceIds.length ||
    lockedSourceIds.some((sourceId) => !sourceId.trim()) ||
    !input.originRevision.trim() ||
    (input.verifierVersion === null) !==
      (input.verificationRevision === null) ||
    (input.proofs.length > 0 &&
      (!input.verifierVersion?.trim() || !input.verificationRevision?.trim()))
  ) {
    throw namedError("MemoryDialogueCertificateRegistryInvalid");
  }
  const locked = new Set(lockedSourceIds);
  const seen = new Set<string>();
  const evidenceTimeUpperBound = input.evidenceTimeUpperBound ?? null;
  const certificates = Object.freeze(
    [...input.proofs]
      .sort((left, right) =>
        left.assistant.evidenceRef.localeCompare(right.assistant.evidenceRef),
      )
      .map((proof) => {
        if (
          !locked.has(proof.sourceId) ||
          seen.has(proof.assistant.evidenceRef) ||
          proof.assistant.sourceKind !== "assistant_output" ||
          proof.precedingUser.sourceKind !== "user_input" ||
          proof.assistant.turnOrder !== proof.precedingUser.turnOrder + 1 ||
          hashTextV1(proof.assistant.content) !== proof.assistant.contentHash ||
          hashTextV1(proof.precedingUser.content) !==
            proof.precedingUser.contentHash
        ) {
          throw namedError("MemoryDialogueCertificateRegistryInvalid");
        }
        seen.add(proof.assistant.evidenceRef);
        const identity = {
          sourceId: proof.sourceId,
          assistant: {
            evidenceRef: proof.assistant.evidenceRef,
            content: proof.assistant.content,
            contentHash: proof.assistant.contentHash,
            turnOrder: proof.assistant.turnOrder,
            ...(proof.assistant.observedAt === undefined
              ? {}
              : { observedAt: proof.assistant.observedAt }),
          },
          predecessor: {
            evidenceRef: proof.precedingUser.evidenceRef,
            contentHash: proof.precedingUser.contentHash,
            turnOrder: proof.precedingUser.turnOrder,
            ...(proof.precedingUser.observedAt === undefined
              ? {}
              : { observedAt: proof.precedingUser.observedAt }),
          },
          verifierVersion: input.verifierVersion as string,
          verificationRevision: input.verificationRevision as string,
          originRevision: input.originRevision,
          evidenceTimeUpperBound,
        };
        return Object.freeze({
          ...identity,
          certificateRevision: hashCanonicalJsonV1(
            identity as unknown as JsonValue,
          ),
        });
      }),
  );
  const lockedSourceIdsRevision = hashCanonicalJsonV1(
    lockedSourceIds as unknown as JsonValue,
  );
  const registryIdentity = {
    registryVersion: PAW_MEMORY_DIALOGUE_CERTIFICATE_REGISTRY_VERSION_V1,
    lockedSourceIdsRevision,
    originRevision: input.originRevision,
    evidenceTimeUpperBound,
    certificates,
  };
  return Object.freeze({
    registryVersion: PAW_MEMORY_DIALOGUE_CERTIFICATE_REGISTRY_VERSION_V1,
    lockedSourceIds,
    lockedSourceIdsRevision,
    originRevision: input.originRevision,
    evidenceTimeUpperBound,
    certificates,
    registryRevision: hashCanonicalJsonV1(
      registryIdentity as unknown as JsonValue,
    ),
  });
}

export function validateMemoryDialogueCertificateRegistryV1(
  registry: MemoryDialogueCertificateRegistryV1,
): void {
  const lockedSourceIdsRevision = hashCanonicalJsonV1(
    registry.lockedSourceIds as unknown as JsonValue,
  );
  const certificates = registry.certificates.map((certificate) => {
    const { certificateRevision, ...identity } = certificate;
    if (
      hashTextV1(certificate.assistant.content) !==
        certificate.assistant.contentHash ||
      certificate.assistant.turnOrder !==
        certificate.predecessor.turnOrder + 1 ||
      !registry.lockedSourceIds.includes(certificate.sourceId) ||
      hashCanonicalJsonV1(identity as unknown as JsonValue) !==
        certificateRevision
    ) {
      throw namedError("MemoryDialogueCertificateRegistryInvalid");
    }
    return certificate;
  });
  const registryIdentity = {
    registryVersion: PAW_MEMORY_DIALOGUE_CERTIFICATE_REGISTRY_VERSION_V1,
    lockedSourceIdsRevision,
    originRevision: registry.originRevision,
    evidenceTimeUpperBound: registry.evidenceTimeUpperBound,
    certificates,
  };
  if (
    registry.registryVersion !==
      PAW_MEMORY_DIALOGUE_CERTIFICATE_REGISTRY_VERSION_V1 ||
    registry.lockedSourceIdsRevision !== lockedSourceIdsRevision ||
    new Set(registry.lockedSourceIds).size !==
      registry.lockedSourceIds.length ||
    new Set(certificates.map((item) => item.assistant.evidenceRef)).size !==
      certificates.length ||
    certificates.some(
      (certificate) =>
        certificate.originRevision !== registry.originRevision ||
        certificate.evidenceTimeUpperBound !== registry.evidenceTimeUpperBound,
    ) ||
    hashCanonicalJsonV1(registryIdentity as unknown as JsonValue) !==
      registry.registryRevision
  ) {
    throw namedError("MemoryDialogueCertificateRegistryInvalid");
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
