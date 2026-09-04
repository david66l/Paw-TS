import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { projectRecommendationUserAuthorityV1 } from "./preference-session-projection-v1.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const makeTurns = (sourceId: string, text: string, sessionOrder = 0) => [
  {
    sourceId,
    evidenceRef: `${sourceId}#source-1`,
    sessionOrder,
    turnOrder: 1,
    observedAt: "2025-01-01T00:00:00Z",
    content: text,
    contentHash: hash(text),
  },
];

describe("recommendation user-authority projection", () => {
  const lock = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const turns = lock.flatMap((source, sessionOrder) =>
    makeTurns(
      source,
      source === "f" ? "I prefer quiet hiking trails" : `memory ${source}`,
      sessionOrder,
    ),
  );

  it("keeps baseline four and rescues two locked BM25 sessions", () => {
    const result = projectRecommendationUserAuthorityV1({
      query: "quiet hiking",
      queryCutoff: "2025-01-10T00:00:00Z",
      sourceLock: lock,
      turns,
      legacyChars: 10_000,
    });
    expect(result.status).toBe("projected");
    expect(result.sourceIds).toEqual(["a", "b", "c", "d", "f"]);
  });

  it("is deterministic and insensitive to excluded assistant noise", () => {
    const first = projectRecommendationUserAuthorityV1({
      query: "quiet hiking",
      queryCutoff: "2025-01-10T00:00:00Z",
      sourceLock: lock,
      turns,
      legacyChars: 10_000,
    });
    const second = projectRecommendationUserAuthorityV1({
      query: "quiet hiking",
      queryCutoff: "2025-01-10T00:00:00Z",
      sourceLock: lock,
      turns: [...turns],
      legacyChars: 10_000,
    });
    expect(first).toEqual(second);
  });

  it("uses the frozen session tie-break after equal BM25 scores", () => {
    const tied = lock.flatMap((source, sessionOrder) =>
      makeTurns(source, "unrelated", sessionOrder),
    );
    const result = projectRecommendationUserAuthorityV1({
      query: "no lexical overlap",
      queryCutoff: "2025-01-10T00:00:00Z",
      sourceLock: lock,
      turns: tied,
      legacyChars: 10_000,
    });
    expect(result.status).toBe("projected");
    expect(result.sourceIds).toEqual(["a", "b", "c", "d"]);
  });

  it("fails closed for tampered content and future evidence", () => {
    const tampered = turns.map((turn, index) =>
      index === 0 ? { ...turn, content: `${turn.content}!` } : turn,
    );
    expect(
      projectRecommendationUserAuthorityV1({
        query: "quiet hiking",
        queryCutoff: "2025-01-10T00:00:00Z",
        sourceLock: lock,
        turns: tampered,
        legacyChars: 10_000,
      }),
    ).toMatchObject({ status: "fallback", reason: "invalid_turn" });
    const future = turns.map((turn, index) =>
      index === 0 ? { ...turn, observedAt: "2025-01-11T00:00:00Z" } : turn,
    );
    expect(
      projectRecommendationUserAuthorityV1({
        query: "quiet hiking",
        queryCutoff: "2025-01-10T00:00:00Z",
        sourceLock: lock,
        turns: future,
        legacyChars: 10_000,
      }),
    ).toMatchObject({ status: "fallback", reason: "invalid_turn" });
  });

  it("renders every user turn from every selected session", () => {
    const extended = turns.flatMap((turn) =>
      turn.sourceId === "f"
        ? [
            turn,
            {
              ...turn,
              evidenceRef: "f#source-2",
              turnOrder: 2,
              content: "Steep terrain is fine",
              contentHash: hash("Steep terrain is fine"),
            },
          ]
        : [turn],
    );
    const result = projectRecommendationUserAuthorityV1({
      query: "quiet hiking",
      queryCutoff: "2025-01-10T00:00:00Z",
      sourceLock: lock,
      turns: extended,
      legacyChars: 10_000,
    });
    expect(result.status).toBe("projected");
    expect(result.evidenceRefs).toContain("f#source-1");
    expect(result.evidenceRefs).toContain("f#source-2");
    expect(result.content).toContain("Steep terrain is fine");
  });

  it("fails atomically when complete sessions exceed the legacy budget", () => {
    const result = projectRecommendationUserAuthorityV1({
      query: "quiet hiking",
      queryCutoff: "2025-01-10T00:00:00Z",
      sourceLock: lock,
      turns,
      legacyChars: 10,
    });
    expect(result).toMatchObject({
      status: "fallback",
      reason: "budget_exceeded",
      content: undefined,
    });
  });

  it("does not confuse source-id prefixes and rejects missing closure", () => {
    const result = projectRecommendationUserAuthorityV1({
      query: "x",
      queryCutoff: "2025-01-10T00:00:00Z",
      sourceLock: lock,
      turns: turns
        .filter((turn) => turn.sourceId !== "a")
        .concat(makeTurns("aa", "forged")),
      legacyChars: 10_000,
    });
    expect(result).toMatchObject({ status: "fallback" });
  });
});
