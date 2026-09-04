import { createHash } from "node:crypto";

import type {
  MemoryEvidenceSupportSelectionInputV1,
  MemoryEvidenceSupportSelectionV1,
  MemoryEvidenceSupportSelectorV1,
  MemoryEvidenceTriageAssessmentV1,
} from "@paw/memory-plugin";

type AmbSupportSelectorGroupsV1 = Parameters<
  NonNullable<MemoryEvidenceSupportSelectorV1["selectGrouped"]>
>[1];

type ContentFreeAssessmentV1 = Readonly<{
  requirementIdHash: string;
  supportingEvidenceRefHashes: readonly string[];
  contradictingEvidenceRefHashes: readonly string[];
  unknownEvidenceRefHashes: readonly string[];
}>;

export type AmbSupportSelectorObservationV1 = Readonly<{
  status: "completed" | "partial" | "failed";
  selectorVersion: string;
  queryNormalizedChars: number;
  candidateCount: number;
  duplicateNormalizedRefCount: number;
  inputIssueCodes: readonly AmbSupportSelectorInputIssueCodeV1[];
  candidates: readonly Readonly<{
    evidenceRefHash: string;
    evidenceRefNormalizedChars: number;
    sourceIdNormalizedChars: number;
    contentNormalizedChars: number;
    eventKeyNormalizedChars: number | null;
    contextEvidenceRefCount: number;
    sourceKind: string | undefined;
    authority: string;
    certifiedAssistantDialogue: boolean;
  }>[];
  scopes: readonly Readonly<{
    requirementIdHash: string;
    eligibleEvidenceRefHashes: readonly string[];
  }>[];
  certifiedAssistantDialogueRefHashes: readonly string[];
  assessments: readonly Readonly<
    ContentFreeAssessmentV1 & {
      omittedEvidenceRefHashes: readonly string[];
    }
  >[];
  batchTelemetry?: Readonly<{
    batchCount: number;
    batches: readonly Readonly<{
      candidateCount: number;
      bodyChars: number;
      sourceCount: number;
      retryDepth: number;
      certifiedAssistantCoverage: number;
      status: "completed" | "truncated" | "failed";
    }>[];
  }>;
  failureCode?: string;
}>;

export type AmbSupportSelectorInputIssueCodeV1 =
  | "empty_ref"
  | "ref_too_long"
  | "empty_source"
  | "source_too_long"
  | "empty_content"
  | "content_too_long"
  | "empty_event_key"
  | "event_key_too_long"
  | "duplicate_ref";

/**
 * Benchmark-only observation adapter. It preserves the selector version,
 * request, result identity, and failures while emitting bounded content-free
 * telemetry. Observer failures are isolated from the retrieval path.
 */
export function observeAmbEvidenceSupportSelectorV1(input: {
  readonly selector: MemoryEvidenceSupportSelectorV1;
  readonly observe: (observation: AmbSupportSelectorObservationV1) => void;
}): MemoryEvidenceSupportSelectorV1 {
  return Object.freeze({
    selectorVersion: input.selector.selectorVersion,
    async select(
      selection: Readonly<MemoryEvidenceSupportSelectionInputV1>,
      signal: AbortSignal,
    ) {
      try {
        const result = await input.selector.select(selection, signal);
        safelyObserve(
          input.observe,
          projectObservation(selection, result, input.selector.selectorVersion),
        );
        return result;
      } catch (error) {
        safelyObserve(
          input.observe,
          Object.freeze({
            ...projectObservationBase(
              selection,
              input.selector.selectorVersion,
            ),
            status: "failed" as const,
            assessments: Object.freeze([]),
            failureCode: stableFailureCode(error),
          }),
        );
        throw error;
      }
    },
    ...(input.selector.selectGrouped === undefined
      ? {}
      : {
          async selectGrouped(
            selection: Readonly<MemoryEvidenceSupportSelectionInputV1>,
            groups: AmbSupportSelectorGroupsV1,
            signal: AbortSignal,
          ) {
            try {
              const selectGrouped = input.selector.selectGrouped;
              if (!selectGrouped) {
                throw new Error("MemoryEvidenceSupportGroupedSelectorMissing");
              }
              const result = await selectGrouped.call(
                input.selector,
                selection,
                groups,
                signal,
              );
              const flatResult = Object.freeze({
                selectorVersion: result.selectorVersion,
                selectionRevision: result.selectionRevision,
                assessments: Object.freeze(
                  result.groups.flatMap((group) => group.assessments),
                ),
                ...(result.batchTelemetry === undefined
                  ? {}
                  : { batchTelemetry: result.batchTelemetry }),
              });
              const observation = projectObservation(
                selection,
                flatResult,
                input.selector.selectorVersion,
              );
              const failureCodes = Object.freeze(
                [
                  ...new Set(
                    result.groups.flatMap((group) => group.failureCodes),
                  ),
                ].sort(),
              );
              safelyObserve(
                input.observe,
                failureCodes.length === 0
                  ? observation
                  : Object.freeze({
                      ...observation,
                      status: "partial" as const,
                      failureCode: failureCodes[0],
                    }),
              );
              return result;
            } catch (error) {
              safelyObserve(
                input.observe,
                Object.freeze({
                  ...projectObservationBase(
                    selection,
                    input.selector.selectorVersion,
                  ),
                  status: "failed" as const,
                  assessments: Object.freeze([]),
                  failureCode: stableFailureCode(error),
                }),
              );
              throw error;
            }
          },
        }),
  });
}

export function projectAmbEvidenceSupportAssessmentsV1(
  assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[],
): readonly ContentFreeAssessmentV1[] {
  return Object.freeze(
    assessments
      .map((assessment) =>
        Object.freeze({
          requirementIdHash: contentHash(assessment.requirementId),
          supportingEvidenceRefHashes: contentFreeRefHashes(
            assessment.supportingEvidenceRefs,
          ),
          contradictingEvidenceRefHashes: contentFreeRefHashes(
            assessment.contradictingEvidenceRefs,
          ),
          unknownEvidenceRefHashes: contentFreeRefHashes(
            assessment.unknownEvidenceRefs,
          ),
        }),
      )
      .sort((left, right) =>
        left.requirementIdHash.localeCompare(right.requirementIdHash),
      ),
  );
}

function projectObservation(
  input: Readonly<MemoryEvidenceSupportSelectionInputV1>,
  result: Readonly<MemoryEvidenceSupportSelectionV1>,
  selectorVersion: string,
): AmbSupportSelectorObservationV1 {
  const base = projectObservationBase(input, selectorVersion);
  const eligibleRefs = eligibleRefsByRequirement(input);
  const assessments = projectAmbEvidenceSupportAssessmentsV1(
    result.assessments,
  ).map((assessment) => {
    const eligible = eligibleRefs.get(assessment.requirementIdHash) ?? [];
    const partitioned = new Set([
      ...assessment.supportingEvidenceRefHashes,
      ...assessment.contradictingEvidenceRefHashes,
      ...assessment.unknownEvidenceRefHashes,
    ]);
    return Object.freeze({
      ...assessment,
      omittedEvidenceRefHashes: Object.freeze(
        eligible.filter((evidenceRefHash) => !partitioned.has(evidenceRefHash)),
      ),
    });
  });
  return Object.freeze({
    ...base,
    status: "completed",
    assessments: Object.freeze(assessments),
    ...(result.batchTelemetry === undefined
      ? {}
      : {
          batchTelemetry: Object.freeze({
            batchCount: result.batchTelemetry.batchCount,
            batches: Object.freeze(
              result.batchTelemetry.batches.map((batch) =>
                Object.freeze({
                  candidateCount: batch.candidateCount,
                  bodyChars: batch.bodyChars,
                  sourceCount: batch.sourceCount,
                  retryDepth: batch.retryDepth,
                  certifiedAssistantCoverage: batch.certifiedAssistantCoverage,
                  status: batch.status,
                }),
              ),
            ),
          }),
        }),
  });
}

function projectObservationBase(
  input: Readonly<MemoryEvidenceSupportSelectionInputV1>,
  selectorVersion: string,
): Omit<AmbSupportSelectorObservationV1, "status" | "assessments"> {
  const certified = new Set(input.certifiedAssistantDialogueEvidenceRefs ?? []);
  const normalizedRefs = input.candidates.map((candidate) =>
    normalizedText(candidate.evidenceRef),
  );
  const duplicateNormalizedRefCount =
    normalizedRefs.length - new Set(normalizedRefs).size;
  const inputIssueCodes = new Set<AmbSupportSelectorInputIssueCodeV1>();
  const candidates = input.candidates.slice(0, 32).map((candidate) => {
    const evidenceRef = normalizedText(candidate.evidenceRef);
    const sourceId = normalizedText(candidate.sourceId);
    const content = normalizedText(candidate.content);
    const eventKey =
      candidate.eventKey === undefined
        ? undefined
        : normalizedText(candidate.eventKey);
    addBoundIssue(
      inputIssueCodes,
      evidenceRef,
      512,
      "empty_ref",
      "ref_too_long",
    );
    addBoundIssue(
      inputIssueCodes,
      sourceId,
      512,
      "empty_source",
      "source_too_long",
    );
    addBoundIssue(
      inputIssueCodes,
      content,
      8_192,
      "empty_content",
      "content_too_long",
    );
    if (eventKey !== undefined) {
      addBoundIssue(
        inputIssueCodes,
        eventKey,
        256,
        "empty_event_key",
        "event_key_too_long",
      );
    }
    return Object.freeze({
      evidenceRefHash: contentHash(candidate.evidenceRef),
      evidenceRefNormalizedChars: evidenceRef.length,
      sourceIdNormalizedChars: sourceId.length,
      contentNormalizedChars: content.length,
      eventKeyNormalizedChars: eventKey?.length ?? null,
      contextEvidenceRefCount: candidate.contextEvidenceRefs?.length ?? 0,
      sourceKind: candidate.sourceKind,
      authority: candidate.authority,
      certifiedAssistantDialogue: certified.has(candidate.evidenceRef),
    });
  });
  if (duplicateNormalizedRefCount > 0) inputIssueCodes.add("duplicate_ref");
  return Object.freeze({
    selectorVersion,
    queryNormalizedChars: normalizedText(input.query).length,
    candidateCount: input.candidates.length,
    duplicateNormalizedRefCount,
    inputIssueCodes: Object.freeze([...inputIssueCodes].sort()),
    candidates: Object.freeze(
      candidates.sort((left, right) =>
        left.evidenceRefHash.localeCompare(right.evidenceRefHash),
      ),
    ),
    scopes: Object.freeze(
      input.requirements
        .map((requirement) => {
          const explicit = input.candidateScopes?.find(
            (scope) => scope.requirementId === requirement.requirementId,
          );
          return Object.freeze({
            requirementIdHash: contentHash(requirement.requirementId),
            eligibleEvidenceRefHashes: contentFreeRefHashes(
              explicit?.evidenceRefs ??
                input.candidates.map((candidate) => candidate.evidenceRef),
            ),
          });
        })
        .sort((left, right) =>
          left.requirementIdHash.localeCompare(right.requirementIdHash),
        ),
    ),
    certifiedAssistantDialogueRefHashes: contentFreeRefHashes(certified),
  });
}

function eligibleRefsByRequirement(
  input: Readonly<MemoryEvidenceSupportSelectionInputV1>,
): ReadonlyMap<string, readonly string[]> {
  return new Map(
    input.requirements.map((requirement) => {
      const scope = input.candidateScopes?.find(
        (candidateScope) =>
          candidateScope.requirementId === requirement.requirementId,
      );
      return [
        contentHash(requirement.requirementId),
        contentFreeRefHashes(
          scope?.evidenceRefs ??
            input.candidates.map((candidate) => candidate.evidenceRef),
        ),
      ] as const;
    }),
  );
}

function contentFreeRefHashes(refs: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(refs)].slice(0, 32).map(contentHash).sort());
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function safelyObserve(
  observe: (observation: AmbSupportSelectorObservationV1) => void,
  observation: AmbSupportSelectorObservationV1,
): void {
  try {
    observe(observation);
  } catch {
    // Telemetry is never allowed to alter evidence selection.
  }
}

function stableFailureCode(error: unknown): string {
  return error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(error.name)
    ? error.name
    : "UnknownFailure";
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function addBoundIssue(
  issues: Set<AmbSupportSelectorInputIssueCodeV1>,
  value: string,
  maximum: number,
  emptyCode: AmbSupportSelectorInputIssueCodeV1,
  overlongCode: AmbSupportSelectorInputIssueCodeV1,
): void {
  if (!value) issues.add(emptyCode);
  else if (value.length > maximum) issues.add(overlongCode);
}
