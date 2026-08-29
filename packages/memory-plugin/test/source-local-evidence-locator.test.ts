import { afterAll, describe, expect, test } from "bun:test";

import { closeSql, getSql, ping } from "@paw/memory/db";

import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  createPostgresMemoryRawEvidenceArchiveV1,
  hydrateMemorySourceLocalEvidenceResultV1,
  validateMemorySourceLocalEvidenceResultV1,
} from "../src/index.js";

process.env.DATABASE_URL ??=
  "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;
const scope = Object.freeze({
  tenantId: "source-local-test",
  userId: "assistant-recall",
  workspaceId: "source-local-workspace",
  repositoryId: "source-local-repository",
});

afterAll(async () => {
  if (dbOk) {
    const sql = getSql();
    await sql`
      DELETE FROM memory_raw_evidence_spans
      WHERE scope->>'tenantId' = ${scope.tenantId}
        AND scope->>'userId' = ${scope.userId}
        AND scope->>'workspaceId' = ${scope.workspaceId}
        AND scope->>'repositoryId' = ${scope.repositoryId}
    `;
  }
  await closeSql();
});

describe("postgres source-local assistant locator", () => {
  it("filters before ranking, preserves neighbor refs and replays from cache", async () => {
    const events: Array<{ type: string; cacheHit?: boolean }> = [];
    const archive = createPostgresMemoryRawEvidenceArchiveV1({
      scope,
      onEvent: (event) => events.push(event),
    });
    const controller = new AbortController();
    await archive.put(
      [
        {
          evidenceRef: "journal:session-1#turn-1",
          sourceKind: "user_input",
          sourceSeq: 1,
          content: "Please give me a memorable color answer.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          evidenceRef: "journal:session-1#turn-2",
          sourceKind: "assistant_output",
          sourceSeq: 2,
          content: "The memorable color answer was cobalt.",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
        {
          evidenceRef: "journal:session-1#turn-3",
          sourceKind: "user_input",
          sourceSeq: 3,
          content: "Correct, cobalt is the answer.",
          createdAt: "2026-01-01T00:02:00.000Z",
        },
        {
          evidenceRef: "journal:session-2#turn-1",
          sourceKind: "assistant_output",
          sourceSeq: 1,
          content: "A distracting cobalt answer from another source.",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
        ...Array.from({ length: 33 }, (_, index) => ({
          evidenceRef: `journal:session-1#turn-${index + 4}`,
          sourceKind: "assistant_output" as const,
          sourceSeq: index + 4,
          content: `A newer cobalt filler answer ${index + 1}.`,
          createdAt: `2026-01-01T00:${String(index + 3).padStart(2, "0")}:00.000Z`,
        })),
      ],
      controller.signal,
    );
    expect(archive.locate).toBeFunction();
    expect(archive.locatorVersion).toBeString();
    expect(archive.hydrate).toBeFunction();
    expect(archive.hydratorVersion).toBeString();
    if (
      !archive.locate ||
      !archive.locatorVersion ||
      !archive.hydrate ||
      !archive.hydratorVersion
    ) {
      throw new Error("Postgres source-local evidence ports are unavailable");
    }
    const request = {
      requirement: {
        requirementId: "assistant-answer",
        label: "prior answer",
        searchText: "memorable color cobalt answer",
        temporalMode: "any" as const,
        roleConstraint: "any" as const,
        relation: "direct" as const,
        coverageMode: "any" as const,
        minimumEvidence: 1,
      },
      lockedSourceIds: ["journal:session-1"],
      evidenceTimeUpperBound: "2026-01-02T00:00:00.000Z",
      budget: {
        ...DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
        maxAnchors: 1,
        maxAnchorsPerSource: 1,
      },
    };
    const locator = {
      locatorVersion: archive.locatorVersion,
      locate: archive.locate.bind(archive),
    };
    const first = await locator.locate(request, controller.signal);
    const hits = validateMemorySourceLocalEvidenceResultV1({
      locator,
      request,
      result: first,
    });
    expect(hits.map((hit) => hit.evidenceRef)).toEqual([
      "journal:session-1#turn-2",
    ]);
    expect(hits[0]?.includedTurns.map((turn) => turn.evidenceRef)).toEqual([
      "journal:session-1#turn-1",
      "journal:session-1#turn-2",
      "journal:session-1#turn-3",
    ]);
    expect(first.telemetry.cacheHit).toBe(false);
    const hydrated = await hydrateMemorySourceLocalEvidenceResultV1({
      hydrator: {
        hydratorVersion: archive.hydratorVersion,
        hydrate: archive.hydrate.bind(archive),
      },
      request,
      result: first,
      signal: controller.signal,
    });
    expect(hydrated.hits[0]?.content).toContain(
      "The memorable color answer was cobalt.",
    );
    expect(events.some((event) => event.type === "hydrate")).toBe(true);

    const replay = await locator.locate(request, controller.signal);
    expect(replay.telemetry.cacheHit).toBe(true);
    expect(replay.locatorRevision).toBe(first.locatorRevision);
    expect(events.filter((event) => event.type === "locate")).toEqual([
      expect.objectContaining({ cacheHit: false }),
      expect.objectContaining({ cacheHit: true }),
    ]);
  });
});
