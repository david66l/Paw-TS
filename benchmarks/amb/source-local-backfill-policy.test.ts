import { describe, expect, test } from "bun:test";

import {
  ambSourceLocalBackfillScoreV1,
  hasAmbSourceLocalBackfillFailureV1,
} from "./source-local-backfill-policy.js";

describe("AMB source-local backfill policy", () => {
  test("fails closed when a required backfill loses every configured channel", () => {
    expect(
      hasAmbSourceLocalBackfillFailureV1({
        denseConfigured: true,
        attempts: [
          { lexicalFailed: false, denseFailed: true },
          { lexicalFailed: true, denseFailed: true },
        ],
      }),
    ).toBe(true);
    expect(
      hasAmbSourceLocalBackfillFailureV1({
        denseConfigured: true,
        attempts: [{ lexicalFailed: true, denseFailed: false }],
      }),
    ).toBe(false);
  });

  test("keeps fallback scores below global hybrid evidence", () => {
    expect(ambSourceLocalBackfillScoreV1(0, 1)).toBeLessThan(0);
    expect(ambSourceLocalBackfillScoreV1(0, 1)).toBeGreaterThan(
      ambSourceLocalBackfillScoreV1(1, 1),
    );
  });
});
