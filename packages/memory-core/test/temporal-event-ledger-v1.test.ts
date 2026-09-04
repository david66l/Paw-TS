import { describe, expect, test } from "bun:test";
import {
  type MemoryTemporalEventLedgerRequestV1,
  buildMemoryTemporalEventLedgerCertificateV1,
  validateMemoryTemporalEventLedgerCertificateV1,
} from "../src/temporal-event-ledger-v1.js";

const sourceId = "session-1";
const earlier = "I started the project.";
const later = "I shipped the project.";

function address(evidenceRef: string, content: string) {
  return {
    evidenceRef,
    sourceId,
    span: { start: 0, end: content.length, text: content },
  } as const;
}

function request(
  overrides: Partial<MemoryTemporalEventLedgerRequestV1> = {},
): MemoryTemporalEventLedgerRequestV1 {
  return {
    query: "How long did the project take?",
    queryTimeCutoff: "2025-01-12T00:00:00.000Z",
    lockedSourceIds: [sourceId],
    timePolicy: {
      kind: "source_observation_timeline",
      timelinePolicyRevision: "test-session-timeline.v1",
    },
    candidates: [
      {
        evidenceRef: "e1",
        sourceId,
        content: earlier,
        observedAt: "2025-01-01T00:00:00.000Z",
        episodeOrder: 1,
        turnOrder: 1,
      },
      {
        evidenceRef: "e2",
        sourceId,
        content: later,
        observedAt: "2025-01-11T00:00:00.000Z",
        episodeOrder: 2,
        turnOrder: 1,
      },
    ],
    proposal: {
      operator: "duration_between",
      operands: [address("e1", earlier), address("e2", later)],
      unit: "day",
    },
    ...overrides,
  };
}

describe("temporal event ledger v1", () => {
  test("certifies source-session timeline duration without a notebook", () => {
    const input = request();
    const result = buildMemoryTemporalEventLedgerCertificateV1(input);
    expect(result.status).toBe("certified");
    if (result.status !== "certified") return;
    expect(result.certificate.derived).toEqual({
      kind: "duration",
      unit: "day",
      value: 10,
    });
    expect(
      validateMemoryTemporalEventLedgerCertificateV1({
        request: input,
        certificate: result.certificate,
      }),
    ).toBe(true);
  });

  test("uses source order when a declared session timeline has equal timestamps", () => {
    const input = request({
      candidates: [
        {
          evidenceRef: "e1",
          sourceId,
          content: earlier,
          observedAt: "2025-01-01T00:00:00.000Z",
          episodeOrder: 2,
          turnOrder: 1,
        },
        {
          evidenceRef: "e2",
          sourceId,
          content: later,
          observedAt: "2025-01-01T00:00:00.000Z",
          episodeOrder: 3,
          turnOrder: 1,
        },
      ],
      proposal: {
        operator: "latest_event",
        operands: [address("e2", later), address("e1", earlier)],
      },
    });
    const result = buildMemoryTemporalEventLedgerCertificateV1(input);
    expect(result.status).toBe("certified");
    if (result.status !== "certified") return;
    expect(result.certificate.derived).toEqual({
      kind: "ordering",
      orderedEvidenceRefs: ["e1", "e2"],
      selectedEvidenceRef: "e2",
    });
  });

  test("refuses observed timestamps when semantic event time is required", () => {
    const result = buildMemoryTemporalEventLedgerCertificateV1(
      request({ timePolicy: { kind: "semantic_event_time" } }),
    );
    expect(result).toEqual({
      status: "rejected",
      rejectedReason: "time_basis_unavailable",
    });
  });

  test("refuses an event candidate that postdates the host query cutoff", () => {
    const result = buildMemoryTemporalEventLedgerCertificateV1(
      request({ queryTimeCutoff: "2025-01-10T00:00:00.000Z" }),
    );
    expect(result).toEqual({
      status: "rejected",
      rejectedReason: "candidate_set_mismatch",
    });
  });

  test("refuses a tampered span and a tampered certificate", () => {
    const invalid = buildMemoryTemporalEventLedgerCertificateV1(
      request({
        proposal: {
          operator: "duration_between",
          operands: [
            address("e1", earlier),
            { ...address("e2", later), span: { start: 0, end: 1, text: "x" } },
          ],
          unit: "day",
        },
      }),
    );
    expect(invalid).toEqual({
      status: "rejected",
      rejectedReason: "invalid_evidence_address",
    });
    const valid = buildMemoryTemporalEventLedgerCertificateV1(request());
    expect(valid.status).toBe("certified");
    if (valid.status !== "certified") return;
    expect(
      validateMemoryTemporalEventLedgerCertificateV1({
        request: request(),
        certificate: { ...valid.certificate, certificateRevision: "tampered" },
      }),
    ).toBe(false);
  });
});
