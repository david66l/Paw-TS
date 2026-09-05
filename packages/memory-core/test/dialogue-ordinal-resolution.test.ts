import { describe, expect, test } from "bun:test";

import { hashTextV1 } from "../src/canonical.js";
import { createMemoryDialogueOrdinalCohortV1 } from "../src/dialogue-ordinal-transaction.js";
import { compileMemoryDialogueOrdinalConstraintV1 } from "../src/dialogue-ordinal.js";
import { resolveEvidencePass } from "../src/evidence-resolution-pass.js";
import { compileMemoryQueryAnswerOriginV1 } from "../src/query-answer-origin.js";

const query =
  "Of the two songs you created, what was the second song you created?";

const requirement = Object.freeze({
  requirementId: "assistant-answer",
  label: "second song created by assistant",
  searchText: query,
  temporalMode: "any" as const,
  roleConstraint: "assistant" as const,
  dependencyRelation: "independent" as const,
  dependsOnRequirementIds: Object.freeze([]),
});

const sources = Object.freeze({
  alpha: Object.freeze({
    user: "Please create a song for me.",
    assistant: "Here is my first song.",
  }),
  beta: Object.freeze({
    user: "Please create another song for me.",
    assistant: "Here is my second song.",
  }),
});

function ref(sourceId: string, turn: number): string {
  return `${sourceId}#turn-${turn}`;
}

describe("dialogue ordinal host settlement", () => {
  test("fans out immutable source cohorts and exposes only the unique winner", async () => {
    const constraint = compileMemoryDialogueOrdinalConstraintV1(query);
    const origin = compileMemoryQueryAnswerOriginV1(query);
    expect(constraint).toBeDefined();
    expect(origin.originKind).toBe("explicit_assistant");
    const ordinalCalls: string[] = [];
    let activeOrdinalCalls = 0;
    let peakOrdinalCalls = 0;
    const ordinarySelectorCalls: string[] = [];
    const locatorRequests: Array<{
      readonly lockedSourceIds: readonly string[];
      readonly fullLockedSourceIds?: readonly string[];
      readonly hasMaterialization: boolean;
      readonly maxChars: number;
    }> = [];
    const pass = await resolveEvidencePass({
      index: {
        indexVersion: "ordinal-resolution-index.v1",
        async search() {
          const candidates = Object.keys(sources).map((sourceId) => ({
            candidateId: ref(sourceId, 2),
            sourceId,
            evidenceRef: ref(sourceId, 2),
            sourceKind: "assistant_output" as const,
            authority: "context_only" as const,
          }));
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "ordinal-resolution",
                weight: 1,
                candidates,
              },
            ],
            hits: candidates.map((candidate) => ({
              sourceId: candidate.sourceId,
              evidenceRef: candidate.evidenceRef,
              sourceKind: "assistant_output" as const,
              authority: "context_only" as const,
              content:
                sources[candidate.sourceId as keyof typeof sources].assistant,
              turnOrder: 2,
              contextEvidenceRefs: [
                ref(candidate.sourceId, 1),
                candidate.evidenceRef,
              ],
            })),
          };
        },
      },
      supportSelector: {
        selectorVersion: "ordinal-resolution-selector.v1",
        dialogueOrdinalAdmission: {
          admissionVersion: "ordinal-resolution-admission.v1",
          async admit() {
            return {
              admissionVersion: "ordinal-resolution-admission.v1",
              classification: "artifact_itself" as const,
              admissionRevision: "a".repeat(64),
            };
          },
        },
        dialogueOrdinalSelector: {
          selectorVersion: "ordinal-resolution-occurrence.v1",
          async selectCohort(input) {
            ordinalCalls.push(input.cohort.activeSourceId);
            activeOrdinalCalls += 1;
            peakOrdinalCalls = Math.max(peakOrdinalCalls, activeOrdinalCalls);
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeOrdinalCalls -= 1;
            expect(input.query).toBe(query);
            expect(input.outputs).toHaveLength(1);
            expect(input.outputs[0]).toMatchObject({
              assistantOutput:
                sources[input.cohort.activeSourceId as keyof typeof sources]
                  .assistant,
              predecessorUserPrompt:
                sources[input.cohort.activeSourceId as keyof typeof sources]
                  .user,
            });
            return [
              {
                evidenceRef: input.outputs[0]?.evidenceRef ?? "missing",
                occurrenceCount:
                  input.cohort.activeSourceId === "alpha" ? 0 : 2,
              },
            ];
          },
        },
        async select() {
          ordinarySelectorCalls.push("called");
          throw new Error("ordinary selector must not see ordinal target");
        },
      },
      query,
      intent: {
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "assistant",
        needsPlanning: true,
      },
      primary: await (async () => {
        const result = await (async () => {
          const candidates = Object.keys(sources).map((sourceId) => ({
            candidateId: ref(sourceId, 2),
            sourceId,
            evidenceRef: ref(sourceId, 2),
            sourceKind: "assistant_output" as const,
            authority: "context_only" as const,
          }));
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "ordinal-resolution",
                weight: 1,
                candidates,
              },
            ],
            hits: candidates.map((candidate) => ({
              sourceId: candidate.sourceId,
              evidenceRef: candidate.evidenceRef,
              sourceKind: "assistant_output" as const,
              authority: "context_only" as const,
              content:
                sources[candidate.sourceId as keyof typeof sources].assistant,
              turnOrder: 2,
              contextEvidenceRefs: [
                ref(candidate.sourceId, 1),
                candidate.evidenceRef,
              ],
            })),
          };
        })();
        return result;
      })(),
      primaryUnfiltered: await (async () => {
        const candidates = Object.keys(sources).map((sourceId) => ({
          candidateId: ref(sourceId, 2),
          sourceId,
          evidenceRef: ref(sourceId, 2),
          sourceKind: "assistant_output" as const,
          authority: "context_only" as const,
        }));
        return {
          lists: [
            {
              channel: "l0" as const,
              retrieverId: "ordinal-resolution",
              weight: 1,
              candidates,
            },
          ],
          hits: candidates.map((candidate) => ({
            sourceId: candidate.sourceId,
            evidenceRef: candidate.evidenceRef,
            sourceKind: "assistant_output" as const,
            authority: "context_only" as const,
            content:
              sources[candidate.sourceId as keyof typeof sources].assistant,
            turnOrder: 2,
            contextEvidenceRefs: [
              ref(candidate.sourceId, 1),
              candidate.evidenceRef,
            ],
          })),
        };
      })(),
      requirements: [requirement],
      maxSources: 8,
      maxEvidencePerSource: 8,
      maxHitsPerRequirement: 2,
      maxNotebookChars: 4096,
      sourceLocalLocator: {
        locatorVersion: "ordinal-resolution-locator.v1",
        async locate(request) {
          const sourceId = request.lockedSourceIds[0];
          if (!sourceId || !request.dialogueOrdinal)
            throw new Error("missing ordinal request");
          locatorRequests.push({
            lockedSourceIds: request.lockedSourceIds,
            fullLockedSourceIds: request.dialogueOrdinalFullLockedSourceIds,
            hasMaterialization:
              request.respondingAssistantMaterialization !== undefined,
            maxChars: request.budget.maxChars,
          });
          const source = sources[sourceId as keyof typeof sources];
          if (!source) throw new Error("unexpected source");
          const userRef = ref(sourceId, 1);
          const assistantRef = ref(sourceId, 2);
          const cohort = createMemoryDialogueOrdinalCohortV1({
            constraintRevision: request.dialogueOrdinal.constraintRevision,
            fullLockedSourceIds:
              request.dialogueOrdinalFullLockedSourceIds ?? [],
            activeSourceId: sourceId,
            sourceAcquisitionRevision: request.sourceAcquisitionRevision ?? "",
            evidenceTimeUpperBound: request.evidenceTimeUpperBound ?? null,
            episodeOrder: sourceId === "alpha" ? 0 : 1,
            sourceBlockRevision: hashTextV1(`blocks:${sourceId}`),
            dialoguePairRevision: hashTextV1(`pairs:${sourceId}`),
            items: [
              {
                evidenceRef: assistantRef,
                contentHash: hashTextV1(source.assistant),
                turnOrder: 2,
                predecessorEvidenceRef: userRef,
                predecessorContentHash: hashTextV1(source.user),
                predecessorTurnOrder: 1,
              },
            ],
          });
          return {
            locatorVersion: "ordinal-resolution-locator.v1",
            locatorRevision: `ordinal-resolution:${sourceId}`,
            hits: [
              {
                sourceId,
                evidenceRef: assistantRef,
                anchorEvidenceRef: assistantRef,
                contextEvidenceRefs: [userRef, assistantRef],
                sourceKind: "assistant_output" as const,
                content: source.assistant,
                authority: "context_only" as const,
                turnOrder: 2,
                includedTurns: [
                  {
                    evidenceRef: userRef,
                    sourceKind: "user_input" as const,
                    turnOrder: 1,
                  },
                  {
                    evidenceRef: assistantRef,
                    sourceKind: "assistant_output" as const,
                    turnOrder: 2,
                  },
                ],
              },
            ],
            degradedChannels: [] as const,
            telemetry: {
              lexicalCandidates: 0,
              denseCandidates: 0,
              anchorCount: 1,
              includedTurnCount: 2,
              renderedChars: source.assistant.length,
              cacheHit: false,
              durationMs: 1,
            },
            dialogueOrdinalCohort: cohort,
          };
        },
      },
      sourceLocalHydrator: {
        hydratorVersion: "ordinal-resolution-hydrator.v1",
        async hydrate(evidenceRefs) {
          return evidenceRefs.map((evidenceRef) => {
            const [sourceId, suffix] = evidenceRef.split("#");
            const source = sources[sourceId as keyof typeof sources];
            const turn = suffix === "turn-1" ? 1 : 2;
            const content = turn === 1 ? source?.user : source?.assistant;
            if (!source || !content) throw new Error("unknown hydration ref");
            return {
              evidenceRef,
              sourceKind:
                turn === 1
                  ? ("user_input" as const)
                  : ("assistant_output" as const),
              turnOrder: turn,
              content,
              contentHash: hashTextV1(content),
            };
          });
        },
      },
      dialoguePredecessorVerifier: {
        verifierVersion: "ordinal-resolution-verifier.v1",
        async verify(input) {
          return {
            verifierVersion: "ordinal-resolution-verifier.v1",
            verificationRevision: "ordinal-resolution-proof.v1",
            proofs: input.targets.map((target) => {
              const source = sources[target.sourceId as keyof typeof sources];
              if (!source) throw new Error("unknown verifier source");
              return {
                sourceId: target.sourceId,
                assistant: {
                  evidenceRef: target.evidenceRef,
                  sourceKind: "assistant_output" as const,
                  turnOrder: 2,
                  content: source.assistant,
                  contentHash: hashTextV1(source.assistant),
                },
                precedingUser: {
                  evidenceRef: ref(target.sourceId, 1),
                  sourceKind: "user_input" as const,
                  turnOrder: 1,
                  content: source.user,
                  contentHash: hashTextV1(source.user),
                },
              };
            }),
          };
        },
      },
      queryAnswerOrigin: origin,
      signal: new AbortController().signal,
    });

    expect(locatorRequests).toHaveLength(2);
    expect(locatorRequests.map((item) => item.lockedSourceIds)).toEqual([
      ["alpha"],
      ["beta"],
    ]);
    expect(locatorRequests.every((item) => item.maxChars === 16_384)).toBe(
      true,
    );
    expect(locatorRequests.every((item) => !item.hasMaterialization)).toBe(
      true,
    );
    expect(
      locatorRequests.every((item) => item.fullLockedSourceIds?.length === 2),
    ).toBe(true);
    expect(ordinalCalls.sort()).toEqual(["alpha", "beta"]);
    expect(peakOrdinalCalls).toBe(2);
    expect(ordinarySelectorCalls).toEqual([]);
    expect(pass.supportAssessments[0]).toMatchObject({
      requirementId: "assistant-answer",
      supportingEvidenceRefs: ["beta#turn-2"],
      dialogueOrdinalSelection: { withinOutputOrdinal: 2 },
    });
    expect(pass.supportAssessments[0]?.evidenceDispositions).toHaveLength(1);
    expect(
      pass.dialogueCertificateRegistry.certificates.map(
        (item) => item.assistant.evidenceRef,
      ),
    ).toEqual(["beta#turn-2"]);
    expect(pass.selectorExecutionSnapshot?.groups[0]).toMatchObject({
      requirementIds: ["assistant-answer"],
      status: "committed",
    });
    expect(
      pass.selectorExecutionSnapshot?.groups[0]?.requirements[0]
        ?.candidateEvidenceCount,
    ).toBe(1);
    expect(
      pass.selectorExecutionSnapshot?.ordinalSettlementProof,
    ).toMatchObject({
      globalStatus: "winner",
      authorityScope: "post_settlement_winner_only",
      winnerEvidenceRef: "beta#turn-2",
    });
    expect(pass.notebook.coverage[0]?.status).toBe("covered");
  });

  test("verifies sixty-four ordinal targets as deterministic source cohorts", async () => {
    const sourceIds = Array.from(
      { length: 8 },
      (_, index) => `source-${index + 1}`,
    );
    const verifyBatches: number[] = [];
    const selectorCalls: string[] = [];
    const pass = await resolveLargeOrdinalPassV1({
      sourceIds,
      onVerify(targetCount) {
        verifyBatches.push(targetCount);
      },
      onSelect(sourceId) {
        selectorCalls.push(sourceId);
      },
    });
    expect(verifyBatches).toEqual([32, 32]);
    expect(selectorCalls.sort()).toEqual(sourceIds);
    expect(pass.selectorExecutionSnapshot?.groups[0]?.status).toBe("committed");
    expect(
      pass.selectorExecutionSnapshot?.ordinalSettlementProof,
    ).toMatchObject({
      globalStatus: "winner",
      winnerEvidenceRef: "source-8#turn-16",
    });
  });

  test("fails the whole ordinal settlement when any verifier batch fails", async () => {
    let verifyCalls = 0;
    let selectorCalls = 0;
    const pass = await resolveLargeOrdinalPassV1({
      sourceIds: Array.from({ length: 8 }, (_, index) => `source-${index + 1}`),
      onVerify() {
        verifyCalls += 1;
        if (verifyCalls === 2) throw new Error("second batch unavailable");
      },
      onSelect() {
        selectorCalls += 1;
      },
    });
    expect(verifyCalls).toBe(2);
    expect(selectorCalls).toBe(0);
    expect(pass.selectorExecutionSnapshot?.groups[0]?.status).toBe("failed");
    expect(
      pass.selectorExecutionSnapshot?.ordinalSettlementProof,
    ).toMatchObject({
      globalStatus: "unknown",
    });
  });

  test("fails closed before model invocation when one raw pair body exceeds admission", async () => {
    let selectorCalls = 0;
    const pass = await resolveLargeOrdinalPassV1({
      sourceIds: ["source-1"],
      rawBodyChars: 6_000,
      turnCount: 1,
      onVerify() {},
      onSelect() {
        selectorCalls += 1;
      },
    });
    expect(selectorCalls).toBe(0);
    expect(pass.selectorExecutionSnapshot?.groups[0]?.status).toBe("failed");
    expect(
      pass.selectorExecutionSnapshot?.ordinalSettlementProof,
    ).toMatchObject({
      globalStatus: "unknown",
      sourceSettlements: [
        {
          sourceId: "source-1",
          status: "unknown",
          knownCount: 0,
          failureCode: "raw_pair_body_too_large",
        },
      ],
    });
    expect(pass.selectorExecutionSnapshot?.groups[0]?.failureCodes).toContain(
      "MemoryDialogueOrdinalRawPairBodyTooLarge",
    );
  });

  test("semantic admission rejection/failure leaves ordinal sidecars untouched and uses the byte-identical old path", async () => {
    const baseline = await resolveLargeOrdinalPassV1({
      sourceIds: ["source-1"],
      onVerify() {},
      onSelect() {},
      admission: "absent",
    });
    for (const admission of [
      "rejected",
      "invalid",
      "transport_failure",
      "timeout",
    ] as const) {
      const ordinalCalls: string[] = [];
      const rejected = await resolveLargeOrdinalPassV1({
        sourceIds: ["source-1"],
        onVerify() {},
        onSelect(sourceId) {
          ordinalCalls.push(sourceId);
        },
        admission,
      });
      expect(ordinalCalls).toEqual([]);
      expect(rejected).toEqual(baseline);
    }
  });

  test("propagates admission cancellation instead of silently taking the old path", async () => {
    await expect(
      resolveLargeOrdinalPassV1({
        sourceIds: ["source-1"],
        onVerify() {},
        onSelect() {},
        admission: "abort",
      }),
    ).rejects.toHaveProperty("name", "AbortError");
  });

  test("records a failed ambiguous settlement when two source cohorts reach the ordinal", async () => {
    const pass = await resolveLargeOrdinalPassV1({
      sourceIds: ["source-1", "source-2"],
      turnCount: 1,
      winnerSourceIds: ["source-1", "source-2"],
      onVerify() {},
      onSelect() {},
    });
    expect(pass.selectorExecutionSnapshot?.groups[0]?.status).toBe("failed");
    expect(
      pass.selectorExecutionSnapshot?.ordinalSettlementProof,
    ).toMatchObject({
      globalStatus: "ambiguous",
      sourceSettlements: [
        { sourceId: "source-1", status: "winner" },
        { sourceId: "source-2", status: "winner" },
      ],
    });
  });
});

async function resolveLargeOrdinalPassV1(input: {
  readonly sourceIds: readonly string[];
  readonly onVerify: (targetCount: number) => void;
  readonly onSelect: (sourceId: string) => void;
  readonly rawBodyChars?: number;
  readonly turnCount?: number;
  readonly admission?:
    | "approved"
    | "rejected"
    | "invalid"
    | "transport_failure"
    | "timeout"
    | "abort"
    | "absent";
  readonly winnerSourceIds?: readonly string[];
}) {
  const sourceById = new Map(
    input.sourceIds.map((sourceId) => [
      sourceId,
      Object.freeze({
        user:
          input.rawBodyChars === undefined
            ? `prompt for ${sourceId}`
            : "u".repeat(input.rawBodyChars),
        assistant:
          input.rawBodyChars === undefined
            ? `song body for ${sourceId}`
            : "a".repeat(input.rawBodyChars),
      }),
    ]),
  );
  const candidates = input.sourceIds.map((sourceId) => ({
    candidateId: ref(sourceId, 2),
    sourceId,
    evidenceRef: ref(sourceId, 2),
    sourceKind: "assistant_output" as const,
    authority: "context_only" as const,
  }));
  const primary = {
    lists: [
      {
        channel: "l0" as const,
        retrieverId: "ordinal-large",
        weight: 1,
        candidates,
      },
    ],
    hits: candidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      evidenceRef: candidate.evidenceRef,
      sourceKind: "assistant_output" as const,
      authority: "context_only" as const,
      content: sourceById.get(candidate.sourceId)?.assistant ?? "missing",
      turnOrder: 2,
      contextEvidenceRefs: [ref(candidate.sourceId, 1), candidate.evidenceRef],
    })),
  };
  return resolveEvidencePass({
    index: {
      indexVersion: "ordinal-large-index.v1",
      async search() {
        return primary;
      },
    },
    supportSelector: {
      selectorVersion: "ordinal-large-selector.v1",
      ...(input.admission === "absent"
        ? {}
        : {
            dialogueOrdinalAdmission: {
              admissionVersion: "ordinal-large-admission.v1",
              async admit() {
                if (input.admission === "rejected") return undefined;
                if (input.admission === "transport_failure") {
                  throw new Error("ordinal admission transport unavailable");
                }
                if (input.admission === "timeout") {
                  const error = new Error("ordinal admission timeout");
                  error.name = "TimeoutError";
                  throw error;
                }
                if (input.admission === "abort") {
                  const error = new Error("ordinal admission aborted");
                  error.name = "AbortError";
                  throw error;
                }
                if (input.admission === "invalid") {
                  return {
                    admissionVersion: "ordinal-large-admission.v1",
                    classification: "artifact_itself" as const,
                    admissionRevision: "not-a-hash",
                  };
                }
                return {
                  admissionVersion: "ordinal-large-admission.v1",
                  classification: "artifact_itself" as const,
                  admissionRevision: "a".repeat(64),
                };
              },
            },
          }),
      dialogueOrdinalSelector: {
        selectorVersion: "ordinal-large-occurrence.v1",
        async selectCohort(selection) {
          input.onSelect(selection.cohort.activeSourceId);
          return selection.outputs.map((output, index) => ({
            evidenceRef: output.evidenceRef,
            occurrenceCount:
              (input.winnerSourceIds ?? ["source-8"]).includes(
                selection.cohort.activeSourceId,
              ) && index === selection.outputs.length - 1
                ? 2
                : 0,
          }));
        },
      },
      async select(selection) {
        return {
          selectorVersion: "ordinal-large-selector.v1",
          selectionRevision: "ordinary-selection.v1",
          assessments: selection.requirements.map((item) => ({
            requirementId: item.requirementId,
            supportingEvidenceRefs:
              selection.candidateScopes?.[0]?.evidenceRefs.slice(0, 1) ?? [],
            contradictingEvidenceRefs: [],
            unknownEvidenceRefs: [],
          })),
        };
      },
    },
    query,
    intent: {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    },
    primary,
    primaryUnfiltered: primary,
    requirements: [requirement],
    maxSources: 8,
    maxEvidencePerSource: 8,
    maxHitsPerRequirement: 8,
    maxNotebookChars: 4_096,
    sourceLocalLocator: {
      locatorVersion: "ordinal-large-locator.v1",
      async locate(request) {
        const sourceId = request.lockedSourceIds[0];
        const source = sourceId ? sourceById.get(sourceId) : undefined;
        if (!sourceId || !source)
          throw new Error("invalid large ordinal locator request");
        if (!request.dialogueOrdinal) {
          return {
            locatorVersion: "ordinal-large-locator.v1",
            locatorRevision: `ordinary-large:${sourceId}`,
            hits: [],
            degradedChannels: [] as const,
            telemetry: {
              lexicalCandidates: 0,
              denseCandidates: 0,
              anchorCount: 0,
              includedTurnCount: 0,
              renderedChars: 0,
              cacheHit: false,
              durationMs: 1,
            },
          };
        }
        const turns = Array.from(
          { length: input.turnCount ?? 8 },
          (_, index) => index * 2 + 2,
        );
        const cohort = createMemoryDialogueOrdinalCohortV1({
          constraintRevision: request.dialogueOrdinal.constraintRevision,
          fullLockedSourceIds: request.dialogueOrdinalFullLockedSourceIds ?? [],
          activeSourceId: sourceId,
          sourceAcquisitionRevision: request.sourceAcquisitionRevision ?? "",
          evidenceTimeUpperBound: request.evidenceTimeUpperBound ?? null,
          episodeOrder: input.sourceIds.indexOf(sourceId),
          sourceBlockRevision: hashTextV1(`blocks:${sourceId}`),
          dialoguePairRevision: hashTextV1(`pairs:${sourceId}`),
          items: turns.map((turnOrder) => ({
            evidenceRef: ref(sourceId, turnOrder),
            contentHash: hashTextV1(source.assistant),
            turnOrder,
            predecessorEvidenceRef: ref(sourceId, turnOrder - 1),
            predecessorContentHash: hashTextV1(source.user),
            predecessorTurnOrder: turnOrder - 1,
          })),
        });
        return {
          locatorVersion: "ordinal-large-locator.v1",
          locatorRevision: `ordinal-large:${sourceId}`,
          hits: cohort.items.map((item) => ({
            sourceId,
            evidenceRef: item.evidenceRef,
            anchorEvidenceRef: item.evidenceRef,
            contextEvidenceRefs: [
              item.predecessorEvidenceRef,
              item.evidenceRef,
            ],
            sourceKind: "assistant_output" as const,
            content: source.assistant,
            authority: "context_only" as const,
            turnOrder: item.turnOrder,
            includedTurns: [
              {
                evidenceRef: item.predecessorEvidenceRef,
                sourceKind: "user_input" as const,
                turnOrder: item.predecessorTurnOrder,
              },
              {
                evidenceRef: item.evidenceRef,
                sourceKind: "assistant_output" as const,
                turnOrder: item.turnOrder,
              },
            ],
          })),
          degradedChannels: [] as const,
          telemetry: {
            lexicalCandidates: 0,
            denseCandidates: 0,
            anchorCount: turns.length,
            includedTurnCount: turns.length * 2,
            renderedChars: source.assistant.length * turns.length,
            cacheHit: false,
            durationMs: 1,
          },
          dialogueOrdinalCohort: cohort,
        };
      },
    },
    sourceLocalHydrator: {
      hydratorVersion: "ordinal-large-hydrator.v1",
      async hydrate(evidenceRefs) {
        return evidenceRefs.map((evidenceRef) => {
          const [sourceId, suffix] = evidenceRef.split("#");
          const source = sourceId ? sourceById.get(sourceId) : undefined;
          const turn = Number(/turn-(\d+)/u.exec(suffix ?? "")?.[1]);
          if (!source || !Number.isSafeInteger(turn))
            throw new Error("invalid large ordinal hydration");
          const user = turn % 2 === 1;
          const content = user ? source.user : source.assistant;
          return {
            evidenceRef,
            sourceKind: user
              ? ("user_input" as const)
              : ("assistant_output" as const),
            turnOrder: turn,
            content,
            contentHash: hashTextV1(content),
          };
        });
      },
    },
    dialoguePredecessorVerifier: {
      verifierVersion: "ordinal-large-verifier.v1",
      async verify(request) {
        input.onVerify(request.targets.length);
        return {
          verifierVersion: "ordinal-large-verifier.v1",
          verificationRevision: hashTextV1(
            request.targets.map((target) => target.evidenceRef).join("\n"),
          ),
          proofs: request.targets.map((target) => {
            const source = sourceById.get(target.sourceId);
            const turn = Number(/turn-(\d+)/u.exec(target.evidenceRef)?.[1]);
            if (!source || !Number.isSafeInteger(turn))
              throw new Error("invalid large ordinal proof");
            return {
              sourceId: target.sourceId,
              assistant: {
                evidenceRef: target.evidenceRef,
                sourceKind: "assistant_output" as const,
                turnOrder: turn,
                content: source.assistant,
                contentHash: hashTextV1(source.assistant),
              },
              precedingUser: {
                evidenceRef: ref(target.sourceId, turn - 1),
                sourceKind: "user_input" as const,
                turnOrder: turn - 1,
                content: source.user,
                contentHash: hashTextV1(source.user),
              },
            };
          }),
        };
      },
    },
    queryAnswerOrigin: compileMemoryQueryAnswerOriginV1(query),
    signal: new AbortController().signal,
  });
}
