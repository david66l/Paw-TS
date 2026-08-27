import { describe, expect, test } from "bun:test";

import {
  createJsonMemoryQueryExpanderV1,
  parseMemoryQueryExpansionV1,
  shouldExpandMemoryQueryV1,
} from "../src/index.js";

describe("bounded memory query expansion", () => {
  test("opens only for multi-source comparison or aggregation questions", () => {
    expect(
      shouldExpandMemoryQueryV1(
        "How much more did I spend in Hawaii compared to Tokyo?",
      ),
    ).toBe(true);
    expect(
      shouldExpandMemoryQueryV1("How many dinner parties did I attend?"),
    ).toBe(true);
    expect(shouldExpandMemoryQueryV1("What phone case did I buy?")).toBe(false);
  });

  test("accepts only a small deduplicated list of retrieval hints", () => {
    expect(
      parseMemoryQueryExpansionV1(
        JSON.stringify({
          searches: ["Maui hotel cost", "maui hotel cost", "Tokyo lodging"],
        }),
        "Compare Hawaii to Tokyo",
      ).searches,
    ).toEqual(["Maui hotel cost", "Tokyo lodging"]);
    expect(() =>
      parseMemoryQueryExpansionV1(
        JSON.stringify({ searches: ["a", "b", "c", "d", "e"] }),
        "Compare two trips",
      ),
    ).toThrow("MemoryQueryExpansionSearchesInvalid");
  });

  test("uses one strict model call and fails closed on malformed output", async () => {
    const planner = createJsonMemoryQueryExpanderV1({
      model: {
        async complete(request) {
          expect(request.system).toContain("retrieval-only hints");
          return {
            status: "completed" as const,
            text: JSON.stringify({ searches: ["Maui resort nightly rate"] }),
          };
        },
      },
    });
    expect(
      (
        await planner.expand(
          "How much more in Hawaii compared to Tokyo?",
          new AbortController().signal,
        )
      ).searches,
    ).toEqual(["Maui resort nightly rate"]);
  });
});
