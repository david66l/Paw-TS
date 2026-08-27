import { describe, expect, test } from "bun:test";

import { projectSourceGroundedMemoryScenesV1 } from "../src/scene-projector.js";

describe("source-grounded memory scene projector", () => {
  test("keeps atoms source-local and orders them by evidence sequence", () => {
    const scenes = projectSourceGroundedMemoryScenesV1({
      maxChars: 2_048,
      sources: [
        {
          sourceId: "document-b",
          rank: 1,
          atoms: [
            {
              id: "b-2",
              kind: "semantic",
              statement: "Later preference",
              sourceSeqs: [8],
            },
            {
              id: "b-1",
              kind: "profile",
              statement: "Earlier preference",
              sourceSeqs: [3],
            },
          ],
        },
        {
          sourceId: "document-a",
          rank: 0,
          atoms: [
            {
              id: "a-1",
              kind: "episodic",
              statement: "Independent event",
              sourceSeqs: [2],
            },
          ],
        },
      ],
    });
    expect(scenes.map((scene) => scene.sourceId)).toEqual([
      "document-a",
      "document-b",
    ]);
    expect(scenes[1]?.atomIds).toEqual(["b-1", "b-2"]);
    expect(scenes[1]?.sourceSeqs).toEqual([3, 8]);
    expect(scenes[1]?.text.indexOf("Earlier")).toBeLessThan(
      scenes[1]?.text.indexOf("Later") ?? 0,
    );
  });

  test("allocates a fair bounded scene budget per selected source", () => {
    const scenes = projectSourceGroundedMemoryScenesV1({
      maxChars: 1_024,
      sources: [
        {
          sourceId: "a",
          rank: 0,
          atoms: Array.from({ length: 10 }, (_, index) => ({
            id: `a-${index}`,
            kind: "semantic" as const,
            statement: "a".repeat(180),
            sourceSeqs: [index + 1],
          })),
        },
        {
          sourceId: "b",
          rank: 1,
          atoms: [
            {
              id: "b-1",
              kind: "profile",
              statement: "short second source",
              sourceSeqs: [1],
            },
          ],
        },
      ],
    });
    expect(scenes).toHaveLength(2);
    expect(scenes[1]?.text).toContain("short second source");
    expect(
      scenes.reduce((sum, scene) => sum + scene.text.length, 0),
    ).toBeLessThanOrEqual(1_024);
  });

  test("rejects duplicate atom identity inside one source", () => {
    expect(() =>
      projectSourceGroundedMemoryScenesV1({
        maxChars: 1_024,
        sources: [
          {
            sourceId: "a",
            rank: 0,
            atoms: [
              {
                id: "same",
                kind: "semantic",
                statement: "one",
                sourceSeqs: [1],
              },
              {
                id: "same",
                kind: "semantic",
                statement: "two",
                sourceSeqs: [2],
              },
            ],
          },
        ],
      }),
    ).toThrow("MemorySceneAtomInvalid");
  });
});
