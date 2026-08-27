import { describe, expect, test } from "bun:test";
import { materializeModelRequestMessagesV1 } from "@paw/core";

import {
  createMemoryPersonaContextV1,
  createMemoryPersonaSectionV1,
  projectSourceGroundedPersonaV1,
} from "../src/persona-projector.js";
import {
  createMemorySceneSnapshotContextV1,
  createMemorySceneSnapshotV1,
} from "../src/scene-navigation.js";

const snapshot = createMemorySceneSnapshotV1({
  scopeFingerprint: "scope-persona",
  projectionRevision: "revision-persona",
  sources: [
    {
      sourceId: "books",
      rank: 0,
      atoms: [
        {
          id: "book-profile",
          kind: "profile",
          statement: "User prefers relaxed reading without deadlines.",
          sourceSeqs: [3],
          confidence: 0.95,
        },
        {
          id: "book-event",
          kind: "episodic",
          statement: "User attended a book club last Tuesday.",
          sourceSeqs: [4],
        },
        {
          id: "book-old",
          kind: "semantic",
          statement: "User likes rigid reading schedules.",
          sourceSeqs: [1],
          validTo: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    {
      sourceId: "music",
      rank: 1,
      atoms: [
        {
          id: "music-profile",
          kind: "profile",
          statement: "User enjoys creating electronic music.",
          sourceSeqs: [2],
          confidence: 0.9,
        },
        {
          id: "music-low",
          kind: "semantic",
          statement: "User might like opera.",
          sourceSeqs: [5],
          confidence: 0.2,
        },
      ],
    },
  ],
});

describe("source-grounded persona projector", () => {
  test("keeps active high-confidence profile claims and source diversity", () => {
    const persona = projectSourceGroundedPersonaV1({ snapshot });
    expect(persona.claims.map((claim) => claim.atomId)).toEqual([
      "book-profile",
      "music-profile",
    ]);
    expect(persona.text).not.toContain("last Tuesday");
    expect(persona.text).not.toContain("rigid reading schedules");
    expect(persona.text).not.toContain("opera");
    expect(persona.sourceCount).toBe(2);
  });

  test("is deterministic and respects the complete character budget", () => {
    const left = projectSourceGroundedPersonaV1({
      snapshot,
      maxChars: 512,
      maxClaims: 2,
    });
    const right = projectSourceGroundedPersonaV1({
      snapshot,
      maxChars: 512,
      maxClaims: 2,
    });
    expect(left.projectionKey).toBe(right.projectionKey);
    expect(left.text.length).toBeLessThanOrEqual(512);
  });

  test("pins L3 before the L2 index without changing Runtime", async () => {
    const persona = projectSourceGroundedPersonaV1({ snapshot });
    expect(createMemoryPersonaSectionV1(persona)?.content).toContain(
      "relaxed reading",
    );
    const base = {
      async plan() {
        throw new Error("unused");
      },
      async build() {
        return {
          messages: [
            { role: "system" as const, content: "policy" },
            { role: "user" as const, content: "question" },
          ],
        };
      },
    };
    const withIndex = createMemorySceneSnapshotContextV1(base, snapshot, 2);
    const withPersona = createMemoryPersonaContextV1(withIndex, persona, 2);
    const request = await withPersona.build({} as never, {} as never);
    const messages = materializeModelRequestMessagesV1(request);
    expect(messages[1]?.content).toContain(persona.projectionKey);
    expect(messages[2]?.content).toContain(snapshot.snapshotKey);
    expect(messages[3]?.role).toBe("user");
  });
});
