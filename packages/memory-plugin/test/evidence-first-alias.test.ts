import { describe, expect, test } from "bun:test";

import {
  createMemoryEvidenceResolverV1 as fromCore,
} from "@paw/memory-core";
import {
  createMemoryEvidenceResolverV1 as fromPlugin,
} from "@paw/memory-plugin/evidence-first";

describe("evidence-first plugin alias", () => {
  test("delegates to the standalone memory core", () => {
    expect(fromPlugin).toBe(fromCore);
  });
});
