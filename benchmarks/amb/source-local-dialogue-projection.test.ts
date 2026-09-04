import { describe, expect, test } from "bun:test";

import { logicalSourceLocalEvidenceRefV1 } from "./immutable-evidence-address.js";
import {
  type AmbDialogueAnchorV1,
  classifyAmbSourceLocalChannelHealthV1,
  rankAmbDialogueEvidenceAnchorsV1,
  selectAmbSourceFairPromptAnchorsV1,
} from "./source-local-dialogue-projection.js";

function anchor(
  documentId: string,
  sourceSeq: number,
  sourceKind: "user_input" | "assistant_output",
  physicalFragment: "source" | "atom" = "source",
): AmbDialogueAnchorV1 {
  const evidenceRef = logicalSourceLocalEvidenceRefV1(
    `amb:document/${documentId}#${physicalFragment}-${sourceSeq}`,
  );
  if (!evidenceRef) throw new Error("invalid dialogue test address");
  return {
    documentId,
    sourceSeq,
    sourceKind,
    evidenceRef,
  };
}

describe("source-local dialogue-pair projection", () => {
  test("uses the same logical evidence address shape as the production bridge", () => {
    expect(anchor("session-1", 3, "user_input").evidenceRef).toBe(
      "session-1#source-3",
    );
  });

  test("canonicalizes adjacent atom addresses before certifiable dialogue pairing", () => {
    const user = anchor("atom-session", 1, "user_input", "atom");
    const assistant = anchor("atom-session", 2, "assistant_output", "atom");
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "assistant",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: [],
      projections: [{ discovery: user, answer: assistant }],
      maxAnchors: 2,
    });

    expect(user.evidenceRef).toBe("atom-session#source-1");
    expect(assistant.evidenceRef).toBe("atom-session#source-2");
    expect(result.promotedAssistantEvidenceRefs).toEqual([
      "atom-session#source-2",
    ]);
  });

  test("uses a user discovery only to return its adjacent assistant answer", () => {
    const user = anchor("session-1", 3, "user_input");
    const assistant = anchor("session-1", 4, "assistant_output");
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "assistant",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: [],
      projections: [{ discovery: user, answer: assistant }],
      maxAnchors: 4,
    });

    expect(result.anchors).toEqual([assistant]);
    expect(result.promotedAssistantEvidenceRefs).toEqual([
      assistant.evidenceRef,
    ]);
    expect(
      result.anchors.some((item) => item.evidenceRef === user.evidenceRef),
    ).toBe(false);
    expect(result.telemetry.promotedAssistantCount).toBe(1);
  });

  test("rejects missing, non-adjacent, cross-source, and unavailable answers", () => {
    const user = anchor("session-1", 3, "user_input");
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "assistant",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: [],
      projections: [
        { discovery: user },
        { discovery: user, answer: anchor("session-1", 5, "assistant_output") },
        { discovery: user, answer: anchor("session-2", 4, "assistant_output") },
        // The adapter represents an over-cutoff or otherwise invisible turn as absent.
        { discovery: user, answer: undefined },
      ],
      maxAnchors: 4,
    });

    expect(result.anchors).toEqual([]);
    expect(result.telemetry.promotionDroppedNoAdjacentAssistant).toBe(4);
  });

  test("rejects a candidate whose logical address disagrees with its turn", () => {
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "assistant",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: [
        {
          ...anchor("session-1", 4, "assistant_output"),
          evidenceRef: "session-1#source-99",
        },
      ],
      projections: [],
      maxAnchors: 4,
    });

    expect(result.anchors).toEqual([]);
    expect(result.promotedAssistantEvidenceRefs).toEqual([]);
  });

  test("deduplicates direct and promoted assistant signals before budgeting", () => {
    const assistant = anchor("session-1", 2, "assistant_output");
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "assistant",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: [assistant, anchor("session-2", 2, "assistant_output")],
      projections: [
        {
          discovery: anchor("session-1", 1, "user_input"),
          answer: assistant,
        },
        {
          discovery: anchor("session-3", 1, "user_input"),
          answer: anchor("session-3", 2, "assistant_output"),
        },
      ],
      maxAnchors: 2,
    });

    expect(result.anchors).toHaveLength(2);
    expect(result.anchors[0]).toEqual(assistant);
    expect(new Set(result.anchors.map((item) => item.evidenceRef)).size).toBe(
      2,
    );
    expect(result.telemetry.dedupedAssistantCount).toBe(1);
  });

  test("reserves the old direct assistant top hit", () => {
    const direct = anchor("direct", 2, "assistant_output");
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "assistant",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: [direct],
      projections: Array.from({ length: 4 }, (_, index) => ({
        discovery: anchor(`promoted-${index}`, 1, "user_input"),
        answer: anchor(`promoted-${index}`, 2, "assistant_output"),
      })),
      maxAnchors: 2,
    });

    expect(result.anchors[0]).toEqual(direct);
    expect(result.telemetry.directCandidateDisplacedCount).toBe(0);
  });

  test("allocates prompt anchors per source before sources compete", () => {
    const noisyTopSource = [
      anchor("source-1", 1, "user_input"),
      anchor("source-1", 3, "user_input"),
      anchor("source-1", 5, "user_input"),
    ];
    const noisyWinner = noisyTopSource[0];
    if (!noisyWinner) throw new Error("missing noisy-source fixture");
    const goldLowerSource = anchor("source-3", 7, "user_input");
    const selected = selectAmbSourceFairPromptAnchorsV1({
      sourcePriority: ["source-1", "source-2", "source-3"],
      rankingsBySource: new Map([
        ["source-1", [{ lane: "requirement", anchors: noisyTopSource }]],
        ["source-2", [{ lane: "requirement", anchors: [] }]],
        ["source-3", [{ lane: "original_query", anchors: [goldLowerSource] }]],
      ]),
      maxPromptAnchorsPerSource: 1,
    });

    expect(selected).toEqual([noisyWinner, goldLowerSource]);
  });

  test("uses the strongest prompt lane and RRF as a deterministic tie break", () => {
    const plannerOnly = anchor("source-1", 1, "user_input");
    const corroborated = anchor("source-1", 3, "user_input");
    const selected = selectAmbSourceFairPromptAnchorsV1({
      sourcePriority: ["source-1"],
      rankingsBySource: new Map([
        [
          "source-1",
          [
            {
              lane: "requirement",
              anchors: [plannerOnly, corroborated],
            },
            {
              lane: "original_query",
              anchors: [corroborated],
            },
          ],
        ],
      ]),
      maxPromptAnchorsPerSource: 1,
    });

    expect(selected).toEqual([corroborated]);
  });

  test("keeps the mandatory direct anchor before source-fair successors", () => {
    const direct = anchor("source-1", 8, "assistant_output");
    const fair = ["source-1", "source-2", "source-3"].map((source) => ({
      discovery: anchor(source, 1, "user_input"),
      answer: anchor(source, 2, "assistant_output"),
    }));
    const firstFairAnswer = fair[0]?.answer;
    const secondFairAnswer = fair[1]?.answer;
    if (!firstFairAnswer || !secondFairAnswer) {
      throw new Error("missing source-fair fixtures");
    }
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "any",
      certifiedAssistantDialogueCandidate: true,
      directAnchors: [direct],
      projections: [],
      sourceFairProjections: fair,
      maxAnchors: 3,
    });

    expect(result.anchors).toEqual([direct, firstFairAnswer, secondFairAnswer]);
    expect(result.telemetry.sourceFairSourceCount).toBe(3);
    expect(result.telemetry.directCandidateDisplacedCount).toBe(0);
  });

  test("keeps any-role direct user authority while adding assistant evidence", () => {
    const directUser = anchor("session-1", 1, "user_input");
    const directAssistant = anchor("session-2", 2, "assistant_output");
    const promotedAssistant = anchor("session-1", 2, "assistant_output");
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "any",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: [directUser, directAssistant],
      projections: [{ discovery: directUser, answer: promotedAssistant }],
      maxAnchors: 3,
    });

    expect(result.anchors).toContainEqual(directUser);
    expect(result.anchors).toContainEqual(directAssistant);
    expect(result.anchors).toContainEqual(promotedAssistant);
  });

  test("leaves an uncertified user-only lane byte-for-byte unchanged", () => {
    const direct = [
      anchor("session-1", 1, "user_input"),
      anchor("session-2", 1, "user_input"),
    ];
    const result = rankAmbDialogueEvidenceAnchorsV1({
      roleConstraint: "user",
      certifiedAssistantDialogueCandidate: false,
      directAnchors: direct,
      projections: [
        {
          discovery: direct[0] as AmbDialogueAnchorV1,
          answer: anchor("session-1", 2, "assistant_output"),
        },
      ],
      maxAnchors: 4,
    });

    expect(result.anchors).toEqual(direct);
    expect(result.telemetry.promotedAssistantCount).toBe(0);
  });

  test("keeps optional discovery failure from degrading a healthy direct lane", () => {
    expect(
      classifyAmbSourceLocalChannelHealthV1({
        directLexicalFailed: false,
        directDenseFailed: false,
        discoveryLexicalFailed: true,
        discoveryDenseFailed: true,
      }),
    ).toEqual({
      resultDegradedChannels: [],
      discoveryChannelDegraded: true,
    });
    expect(
      classifyAmbSourceLocalChannelHealthV1({
        directLexicalFailed: true,
        directDenseFailed: false,
        discoveryLexicalFailed: false,
        discoveryDenseFailed: false,
      }).resultDegradedChannels,
    ).toEqual(["lexical"]);
  });
});
