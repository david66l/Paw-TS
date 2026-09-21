import { expect, test } from "bun:test";
import { applyProbeRequest } from "./model-probe-options.js";

test("control preserves actual native request and does not mutate it", () => {
  const body = {
    model: "glm-5.3-flash",
    reasoning_effort: "max",
    max_tokens: 8192,
    thinking: { type: "enabled", clear_thinking: false },
    tools: [{ type: "function" }],
  };
  expect(applyProbeRequest(body, "max-native")).toEqual(body);
  expect(applyProbeRequest(body, "high-native")).toEqual({
    ...body,
    reasoning_effort: "high",
  });
  expect(body.reasoning_effort).toBe("max");
});

test("output experiment raises main allowance but preserves auxiliary caps and recovery increases", () => {
  const body = {
    model: "glm-5.3-flash",
    reasoning_effort: "high",
    max_tokens: 2048,
  };
  expect(applyProbeRequest(body, "max-32768")).toEqual(body);
  expect(
    applyProbeRequest(
      { ...body, max_tokens: 8192, reasoning_effort: "max" },
      "max-32768",
    ).max_tokens,
  ).toBe(32768);
  expect(
    applyProbeRequest({ ...body, max_tokens: 65536 }, "max-32768").max_tokens,
  ).toBe(65536);
  expect(
    applyProbeRequest(
      { model: "glm-5.3-flash", reasoning_effort: "max" },
      "max-32768",
    ).max_tokens,
  ).toBeUndefined();
});

test("cannot silently experiment on another model", () => {
  expect(() => applyProbeRequest({ model: "other" }, "high-native")).toThrow();
});
