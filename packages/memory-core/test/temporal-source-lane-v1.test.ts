import { describe, expect, test } from "bun:test";
import {
  type MemoryTemporalSourceLaneRequestV1,
  buildMemoryTemporalSourceLaneV1,
  validateMemoryTemporalSourceLaneCertificateV1,
} from "../src/temporal-source-lane-v1.js";

function request(
  overrides: Partial<MemoryTemporalSourceLaneRequestV1> = {},
): MemoryTemporalSourceLaneRequestV1 {
  return {
    query: "How long was the project active?",
    queryTimeCutoff: "2025-02-01T00:00:00.000Z",
    maxSources: 2,
    candidates: [
      {
        sourceId: "session-1",
        evidenceRef: "session-1#source-2",
        rank: 2,
        observedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        sourceId: "session-2",
        evidenceRef: "session-2#source-1",
        rank: 1,
        observedAt: "2025-01-02T00:00:00.000Z",
      },
      {
        sourceId: "session-1",
        evidenceRef: "session-1#source-4",
        rank: 3,
        observedAt: "2025-01-01T00:00:00.000Z",
      },
      {
        sourceId: "session-3",
        evidenceRef: "session-3#source-1",
        rank: 4,
        observedAt: "2025-01-03T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("temporal source lane v1", () => {
  test("locks distinct sources by rank without changing an evidence packet", () => {
    const result = buildMemoryTemporalSourceLaneV1(request());
    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(result.certificate.selectedSources).toEqual([
      {
        sourceId: "session-2",
        firstEvidenceRef: "session-2#source-1",
        firstCandidateRank: 1,
        observedAt: "2025-01-02T00:00:00.000Z",
      },
      {
        sourceId: "session-1",
        firstEvidenceRef: "session-1#source-2",
        firstCandidateRank: 2,
        observedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
    expect(
      validateMemoryTemporalSourceLaneCertificateV1({
        request: request(),
        certificate: result.certificate,
      }),
    ).toBe(true);
  });

  test("is rank deterministic when the retriever returns an unordered array", () => {
    const input = request({
      candidates: [...request().candidates].reverse(),
    });
    const result = buildMemoryTemporalSourceLaneV1(input);
    expect(result.status).toBe("selected");
    if (result.status !== "selected") return;
    expect(
      result.certificate.selectedSources.map((source) => source.sourceId),
    ).toEqual(["session-2", "session-1"]);
  });

  test("rejects a future source instead of silently widening the cutoff", () => {
    const result = buildMemoryTemporalSourceLaneV1(
      request({
        candidates: [
          {
            sourceId: "session-1",
            evidenceRef: "session-1#source-1",
            rank: 1,
            observedAt: "2025-02-02T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(result).toEqual({
      status: "rejected",
      rejectedReason: "candidate_postdates_cutoff",
    });
  });

  test("rejects duplicate ranks and a tampered source-lock certificate", () => {
    const duplicateRank = buildMemoryTemporalSourceLaneV1(
      request({
        candidates: request().candidates.map((candidate) => ({
          ...candidate,
          rank: 1,
        })),
      }),
    );
    expect(duplicateRank).toEqual({
      status: "rejected",
      rejectedReason: "candidate_set_mismatch",
    });
    const valid = buildMemoryTemporalSourceLaneV1(request());
    expect(valid.status).toBe("selected");
    if (valid.status !== "selected") return;
    expect(
      validateMemoryTemporalSourceLaneCertificateV1({
        request: request(),
        certificate: { ...valid.certificate, sourceLockRevision: "tampered" },
      }),
    ).toBe(false);
  });

  test("keeps the candidate aperture bounded before source de-duplication", () => {
    const result = buildMemoryTemporalSourceLaneV1(
      request({
        candidates: Array.from({ length: 257 }, (_, index) => ({
          sourceId: `session-${index + 1}`,
          evidenceRef: `session-${index + 1}#source-1`,
          rank: index + 1,
          observedAt: "2025-01-01T00:00:00.000Z",
        })),
      }),
    );
    expect(result).toEqual({
      status: "rejected",
      rejectedReason: "candidate_set_mismatch",
    });
  });
});
