import { describe, expect, test } from "bun:test";

import {
  isAmbDocumentVisibleAtQueryV1,
  parseAmbQueryTimeCutoffV1,
} from "./query-time-cutoff.js";

describe("AMB query-time cutoff", () => {
  test("normalizes a valid cutoff and keeps evidence at or before it", () => {
    const cutoff = parseAmbQueryTimeCutoffV1("2026-08-27T12:30:00+08:00");

    expect(cutoff?.normalizedIso).toBe("2026-08-27T04:30:00.000Z");
    expect(
      isAmbDocumentVisibleAtQueryV1("2026-08-27T04:29:59.999Z", cutoff),
    ).toBe(true);
    expect(
      isAmbDocumentVisibleAtQueryV1("2026-08-27T04:30:00.000Z", cutoff),
    ).toBe(true);
    expect(
      isAmbDocumentVisibleAtQueryV1("2026-08-27T04:30:00.001Z", cutoff),
    ).toBe(false);
  });

  test("does not filter when no point-in-time contract was supplied", () => {
    expect(parseAmbQueryTimeCutoffV1(undefined)).toBeUndefined();
    expect(isAmbDocumentVisibleAtQueryV1(undefined, undefined)).toBe(true);
  });

  test("fails closed for invalid query or document chronology", () => {
    expect(() => parseAmbQueryTimeCutoffV1("not-a-date")).toThrow(
      "queryTimestamp must be a valid timestamp string",
    );
    const cutoff = parseAmbQueryTimeCutoffV1("2026-08-27T04:30:00Z");
    expect(isAmbDocumentVisibleAtQueryV1(undefined, cutoff)).toBe(false);
    expect(isAmbDocumentVisibleAtQueryV1("not-a-date", cutoff)).toBe(false);
  });
});
