import { describe, expect, test } from "bun:test";
import { materializeModelRequestMessagesV1 } from "@paw/core";

import {
  createMemorySceneIndexSectionV1,
  createMemorySceneSnapshotContextV1,
  createMemorySceneSnapshotV1,
  routeMemoryQueryV1,
  selectMemorySceneEvidenceV1,
} from "../src/scene-navigation.js";

const sources = [
  {
    sourceId: "document-a",
    rank: 0,
    atoms: [
      {
        id: "a-profile",
        kind: "profile" as const,
        statement: "User likes quiet independent reading.",
        sourceSeqs: [1],
      },
      {
        id: "a-event",
        kind: "episodic" as const,
        statement: "A rigid book club made reading feel pressured.",
        sourceSeqs: [7],
      },
      {
        id: "a-change",
        kind: "semantic" as const,
        statement:
          "User stopped structured book clubs because deadlines removed the joy.",
        sourceSeqs: [8],
      },
    ],
  },
  {
    sourceId: "document-b",
    rank: 1,
    atoms: [
      {
        id: "b-profile",
        kind: "profile" as const,
        statement: "User enjoys outdoor running.",
        sourceSeqs: [2],
      },
    ],
  },
];

describe("memory scene navigation", () => {
  test("creates a stable bounded index separately from bodies", () => {
    const left = createMemorySceneSnapshotV1({
      scopeFingerprint: "scope-1",
      projectionRevision: "revision-1",
      sources,
      maxIndexChars: 1_024,
      summaryMaxChars: 96,
    });
    const right = createMemorySceneSnapshotV1({
      scopeFingerprint: "scope-1",
      projectionRevision: "revision-1",
      sources: [...sources].reverse(),
      maxIndexChars: 1_024,
      summaryMaxChars: 96,
    });
    expect(left.snapshotKey).toBe(right.snapshotKey);
    expect(left.indexText.length).toBeLessThanOrEqual(1_024);
    expect(left.indexText).not.toContain("deadlines removed the joy");
    expect(Object.keys(left.bodies)).toHaveLength(2);
  });

  test("routes ambiguous facts to L0/L1 and explicit reasons to L2", () => {
    expect(routeMemoryQueryV1("What sport does the user enjoy?").route).toBe(
      "l0_fallback",
    );
    expect(
      routeMemoryQueryV1("Why did the user stop attending the book club?")
        .route,
    ).toBe("scene_causal");
    expect(
      routeMemoryQueryV1(
        "Recommend an activity that fits the user's preferences.",
      ).route,
    ).toBe("l0_fallback");
    expect(
      routeMemoryQueryV1(
        "Recommend an activity that fits the user's preferences.",
        { allowExploratoryScenes: true },
      ).route,
    ).toBe("scene_exploratory");
    expect(
      routeMemoryQueryV1(
        "Which statement matches the user?\n\n(a) They changed because of pressure.\n(b) They run.",
      ).route,
    ).toBe("l0_fallback");
  });

  test("reads only bounded relevant scene atoms and reports telemetry", () => {
    const snapshot = createMemorySceneSnapshotV1({
      scopeFingerprint: "scope-1",
      projectionRevision: "revision-1",
      sources,
    });
    const selection = selectMemorySceneEvidenceV1({
      snapshot,
      query: "Why did the user stop structured book clubs?",
    });
    expect(selection.reads).toHaveLength(2);
    expect(selection.reads[0]?.sourceId).toBe("document-a");
    expect(selection.reads[0]?.text).toContain("book club");
    expect(selection.telemetry.selectedAtomCount).toBeLessThanOrEqual(4);
    expect(selection.telemetry.stablePrefixHash).toBe(snapshot.snapshotKey);
    expect(selection.telemetry.fallback).toBe(false);
  });

  test("pins the index before dynamic memory sections without Runtime changes", async () => {
    const snapshot = createMemorySceneSnapshotV1({
      scopeFingerprint: "scope-1",
      projectionRevision: "revision-1",
      sources,
    });
    const section = createMemorySceneIndexSectionV1(snapshot, 3);
    expect(section?.content).toContain("deadlines removed the joy");
    expect(section?.content).not.toContain("made reading feel pressured");
    const base = {
      async plan() {
        throw new Error("unused");
      },
      async build() {
        return {
          messages: [
            { role: "system" as const, content: "stable policy" },
            { role: "user" as const, content: "question" },
          ],
        };
      },
    };
    const context = createMemorySceneSnapshotContextV1(base, snapshot, 3);
    const request = await context.build({} as never, {} as never);
    const messages = materializeModelRequestMessagesV1(request);
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toContain(snapshot.snapshotKey);
    expect(messages[2]?.role).toBe("user");
  });
});
