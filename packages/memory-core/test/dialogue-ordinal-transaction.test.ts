import { describe, expect, test } from "bun:test";
import {
  createJsonMemoryDialogueOrdinalSelectorV1,
  createMemoryDialogueOrdinalCohortV1,
  reduceMemoryDialogueOrdinalSourcesV1,
  settleMemoryDialogueOrdinalSourceV1,
} from "../src/dialogue-ordinal-transaction.js";
import { compileMemoryDialogueOrdinalConstraintV1 } from "../src/dialogue-ordinal.js";

const constraint = compileMemoryDialogueOrdinalConstraintV1(
  "You created two songs. What was the second song you created?",
);
if (!constraint) throw new Error("fixture compiler");
const cohort = (sourceId: string) =>
  createMemoryDialogueOrdinalCohortV1({
    constraintRevision: constraint.constraintRevision,
    fullLockedSourceIds: ["a", "b"],
    activeSourceId: sourceId,
    sourceAcquisitionRevision: "acq",
    evidenceTimeUpperBound: null,
    episodeOrder: sourceId === "a" ? 1 : 2,
    sourceBlockRevision: "a".repeat(64),
    dialoguePairRevision: "b".repeat(64),
    items: [2, 4].map((turnOrder) => ({
      evidenceRef: `${sourceId}#${turnOrder}`,
      contentHash: "c".repeat(64),
      turnOrder,
      predecessorEvidenceRef: `${sourceId}#${turnOrder - 1}`,
      predecessorContentHash: "d".repeat(64),
      predecessorTurnOrder: turnOrder - 1,
    })),
  });
describe("atomic dialogue ordinal transaction", () => {
  test("accumulates multi-artifact output counts and returns within-output ordinal", () => {
    const result = settleMemoryDialogueOrdinalSourceV1({
      constraint,
      cohort: cohort("a"),
      occurrences: [
        { evidenceRef: "a#2", occurrenceCount: 0 },
        { evidenceRef: "a#4", occurrenceCount: 2 },
      ],
    });
    expect(result).toMatchObject({
      status: "winner",
      evidenceRef: "a#4",
      withinOutputOrdinal: 2,
    });
  });
  test("unknown before the target and a second satisfying source close globally", () => {
    const unknown = settleMemoryDialogueOrdinalSourceV1({
      constraint,
      cohort: cohort("a"),
      occurrences: [
        { evidenceRef: "a#2", occurrenceCount: null },
        { evidenceRef: "a#4", occurrenceCount: 2 },
      ],
    });
    const winner = settleMemoryDialogueOrdinalSourceV1({
      constraint,
      cohort: cohort("b"),
      occurrences: [
        { evidenceRef: "b#2", occurrenceCount: 1 },
        { evidenceRef: "b#4", occurrenceCount: 1 },
      ],
    });
    expect(reduceMemoryDialogueOrdinalSourcesV1([unknown, winner])).toEqual({
      status: "unknown",
    });
    expect(reduceMemoryDialogueOrdinalSourcesV1([winner, winner])).toEqual({
      status: "ambiguous",
    });
  });
  test("permits one winner at any position of an eight-source lock only when every peer is below", () => {
    const sources = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const settlements = sources.map((sourceId, index) => {
      const sourceCohort = createMemoryDialogueOrdinalCohortV1({
        constraintRevision: constraint.constraintRevision,
        fullLockedSourceIds: sources,
        activeSourceId: sourceId,
        sourceAcquisitionRevision: "acq",
        evidenceTimeUpperBound: null,
        episodeOrder: index,
        sourceBlockRevision: "a".repeat(64),
        dialoguePairRevision: "b".repeat(64),
        items: [2, 4].map((turnOrder) => ({
          evidenceRef: `${sourceId}#${turnOrder}`,
          contentHash: "c".repeat(64),
          turnOrder,
          predecessorEvidenceRef: `${sourceId}#${turnOrder - 1}`,
          predecessorContentHash: "d".repeat(64),
          predecessorTurnOrder: turnOrder - 1,
        })),
      });
      return settleMemoryDialogueOrdinalSourceV1({
        constraint,
        cohort: sourceCohort,
        occurrences: sourceCohort.items.map((item, itemIndex) => ({
          evidenceRef: item.evidenceRef,
          occurrenceCount: sourceId === "d" && itemIndex === 1 ? 2 : 0,
        })),
      });
    });
    expect(reduceMemoryDialogueOrdinalSourcesV1(settlements)).toMatchObject({
      status: "winner",
      sourceId: "d",
      evidenceRef: "d#4",
    });
  });
  test("rejects caps above eight and selector output that omits a cohort address", async () => {
    expect(() =>
      createMemoryDialogueOrdinalCohortV1({
        constraintRevision: constraint.constraintRevision,
        fullLockedSourceIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        activeSourceId: "a",
        sourceAcquisitionRevision: "acq",
        evidenceTimeUpperBound: null,
        episodeOrder: 1,
        sourceBlockRevision: "a".repeat(64),
        dialoguePairRevision: "b".repeat(64),
        items: [
          {
            evidenceRef: "a#2",
            contentHash: "c".repeat(64),
            turnOrder: 2,
            predecessorEvidenceRef: "a#1",
            predecessorContentHash: "d".repeat(64),
            predecessorTurnOrder: 1,
          },
        ],
      }),
    ).toThrow("MemoryDialogueOrdinalCohortInvalid");
    const selector = createJsonMemoryDialogueOrdinalSelectorV1({
      model: {
        complete: async () => ({
          status: "completed" as const,
          text: JSON.stringify({
            occurrences: [{ evidenceRef: "e1", occurrenceCount: 1 }],
          }),
        }),
      },
    });
    await expect(
      selector.selectCohort(
        {
          constraint,
          cohort: cohort("a"),
          query: "You created two songs. What was the second song you created?",
          outputs: [
            {
              evidenceRef: "a#2",
              assistantOutput: "first",
              predecessorUserPrompt: "write one song",
            },
            {
              evidenceRef: "a#4",
              assistantOutput: "second",
              predecessorUserPrompt: "write another song",
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("MemoryDialogueOrdinalSelectorOutputInvalid");
  });

  test("binds each identical assistant output to its verified predecessor prompt", async () => {
    let modelInput = "";
    const selector = createJsonMemoryDialogueOrdinalSelectorV1({
      model: {
        complete: async ({ user }) => {
          modelInput = user;
          const parsed = JSON.parse(user) as {
            outputs: Array<{
              evidenceRef: string;
              predecessorUserPrompt: string;
            }>;
          };
          return {
            status: "completed" as const,
            text: JSON.stringify({
              occurrences: parsed.outputs.map((output) => ({
                evidenceRef: output.evidenceRef,
                occurrenceCount: output.predecessorUserPrompt.includes(
                  "another",
                )
                  ? 2
                  : 0,
              })),
            }),
          };
        },
      },
    });
    await expect(
      selector.selectCohort(
        {
          constraint,
          cohort: cohort("a"),
          query: "You created two songs. What was the second song you created?",
          outputs: [
            {
              evidenceRef: "a#2",
              assistantOutput: "Here is a song.",
              predecessorUserPrompt: "write one song",
            },
            {
              evidenceRef: "a#4",
              assistantOutput: "Here is a song.",
              predecessorUserPrompt: "write another song",
            },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      { evidenceRef: "a#2", occurrenceCount: 0 },
      { evidenceRef: "a#4", occurrenceCount: 2 },
    ]);
    expect(modelInput).toContain('"predecessorUserPrompt":"write one song"');
    expect(modelInput).toContain(
      '"predecessorUserPrompt":"write another song"',
    );
  });

  test("rejects selector envelopes and items with additional keys", async () => {
    const selector = createJsonMemoryDialogueOrdinalSelectorV1({
      model: {
        complete: async () => ({
          status: "completed" as const,
          text: JSON.stringify({
            occurrences: [
              { evidenceRef: "e1", occurrenceCount: 0, forged: true },
              { evidenceRef: "e2", occurrenceCount: 2 },
            ],
            extra: true,
          }),
        }),
      },
    });
    await expect(
      selector.selectCohort(
        {
          constraint,
          cohort: cohort("a"),
          query: "You created two songs. What was the second song you created?",
          outputs: [
            {
              evidenceRef: "a#2",
              assistantOutput: "first",
              predecessorUserPrompt: "write one song",
            },
            {
              evidenceRef: "a#4",
              assistantOutput: "second",
              predecessorUserPrompt: "write another song",
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("MemoryDialogueOrdinalSelectorOutputInvalid");
  });
});
