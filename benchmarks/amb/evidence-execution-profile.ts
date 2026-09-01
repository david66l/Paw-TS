export type AmbEvidenceExecutionProfileIdV1 =
  | "product_parity"
  | "research_dense"
  | "research_replan";

export interface AmbEvidenceExecutionProfileV1 {
  readonly profileId: AmbEvidenceExecutionProfileIdV1;
  readonly sourceLocalDense: boolean;
  readonly closureAudit: boolean;
  readonly closureMode: "disabled" | "observe" | "repair";
  readonly maxHitsPerRequirement: number;
  readonly maximumNotebookChars: number;
}

export function resolveAmbEvidenceExecutionProfileV1(
  value: string | undefined,
): AmbEvidenceExecutionProfileV1 {
  const profileId = (value?.trim().toLowerCase() ||
    "research_dense") as AmbEvidenceExecutionProfileIdV1;
  if (profileId === "product_parity") {
    return Object.freeze({
      profileId,
      sourceLocalDense: false,
      closureAudit: false,
      closureMode: "disabled",
      maxHitsPerRequirement: 4,
      maximumNotebookChars: 4_096,
    });
  }
  if (profileId === "research_dense") {
    return Object.freeze({
      profileId,
      sourceLocalDense: true,
      closureAudit: true,
      closureMode: "observe",
      maxHitsPerRequirement: 8,
      maximumNotebookChars: 8_192,
    });
  }
  if (profileId === "research_replan") {
    return Object.freeze({
      profileId,
      sourceLocalDense: true,
      closureAudit: true,
      closureMode: "repair",
      maxHitsPerRequirement: 8,
      maximumNotebookChars: 8_192,
    });
  }
  throw namedError("AmbEvidenceExecutionProfileInvalid");
}

export function evidenceNotebookCharsForProfileV1(
  profile: AmbEvidenceExecutionProfileV1,
  sourceContextChars: number,
): number {
  if (!Number.isSafeInteger(sourceContextChars) || sourceContextChars < 1) {
    throw namedError("AmbEvidenceExecutionProfileBudgetInvalid");
  }
  return profile.profileId === "product_parity"
    ? profile.maximumNotebookChars
    : Math.min(
        profile.maximumNotebookChars,
        Math.max(512, Math.floor(sourceContextChars * 0.6)),
      );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
