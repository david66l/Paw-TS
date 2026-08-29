import { describe, expect, test } from "bun:test";

import {
  type MemoryStateObservationV1,
  inferMemoryStateSemanticsV1,
  resolveMemoryStateObservationsV1,
} from "../src/legacy.js";

function observation(
  content: string,
  overrides: Partial<MemoryStateObservationV1> = {},
): MemoryStateObservationV1 {
  return {
    sourceId: "session",
    evidenceRef: `ref-${content}`,
    content,
    authority: "user_asserted",
    stateKey: "instagram.followers",
    observedAt: "2023-05-25T00:00:00.000Z",
    episodeOrder: 1,
    turnOrder: 1,
    ...inferMemoryStateSemanticsV1(content),
    ...overrides,
  };
}

describe("memory state reducer v1", () => {
  test("lets a later approximate observation replace an older exact value", () => {
    const exact = observation("I have 1,250 followers.", { turnOrder: 1 });
    const approximate = observation(
      "I think I am now close to 1,300 followers.",
      {
        turnOrder: 2,
      },
    );
    const result = resolveMemoryStateObservationsV1({
      observations: [exact, approximate],
      mode: "latest",
    });
    expect(result.current.map((item) => item.evidenceRef)).toEqual([
      approximate.evidenceRef,
    ]);
    expect(result.current[0]?.valueQualifier).toBe("approximate");
    expect(result.current[0]?.epistemicStatus).toBe("uncertain");
    expect(result.history.map((item) => item.evidenceRef)).toEqual([
      exact.evidenceRef,
    ]);
  });

  test("uses turn order inside one episode and does not let plans replace observations", () => {
    const observed = observation("My bike count is 2.", { turnOrder: 3 });
    const plan = observation("I plan to buy 4 bikes.", { turnOrder: 4 });
    const result = resolveMemoryStateObservationsV1({
      observations: [plan, observed],
      mode: "latest",
    });
    expect(result.current[0]?.evidenceRef).toBe(observed.evidenceRef);
    expect(result.history[0]?.stateKind).toBe("plan");
  });

  test("keeps different units in independent state groups", () => {
    const kilograms = observation("The package is 10 kg.", { unit: "kg" });
    const pounds = observation("The package is 22 lb.", {
      unit: "lb",
      turnOrder: 2,
    });
    const result = resolveMemoryStateObservationsV1({
      observations: [kilograms, pounds],
      mode: "latest",
    });
    expect(result.current).toHaveLength(2);
  });

  test("filters observations newer than an as-of boundary", () => {
    const old = observation("I have 1,000 followers.", {
      observedAt: "2023-05-01T00:00:00.000Z",
    });
    const future = observation("I have 1,500 followers.", {
      observedAt: "2023-06-01T00:00:00.000Z",
    });
    const result = resolveMemoryStateObservationsV1({
      observations: [old, future],
      mode: "as_of",
      asOf: "2023-05-15T00:00:00.000Z",
    });
    expect(result.current[0]?.evidenceRef).toBe(old.evidenceRef);
  });

  test("does not let context-only assistant text overwrite user state", () => {
    const user = observation("I have 1,250 followers.");
    const assistant = observation("You now have 2,000 followers.", {
      authority: "context_only",
      turnOrder: 2,
    });
    const result = resolveMemoryStateObservationsV1({
      observations: [user, assistant],
      mode: "latest",
    });
    expect(result.current[0]?.evidenceRef).toBe(user.evidenceRef);
  });
});
