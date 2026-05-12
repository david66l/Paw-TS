import { describe, expect, test } from "bun:test";
import { PawError, isPawError } from "../src/errors.js";

describe("PawError", () => {
  test("isPawError narrows", () => {
    const e = new PawError("VALIDATION", "bad");
    expect(isPawError(e)).toBe(true);
    expect(isPawError(new Error("x"))).toBe(false);
  });
});
