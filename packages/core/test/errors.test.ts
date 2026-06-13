import { describe, expect, test } from "bun:test";
import { PawError, isPawError, makeToolError } from "../src/errors.js";

describe("PawError", () => {
  test("isPawError narrows", () => {
    const e = new PawError("VALIDATION", "bad");
    expect(isPawError(e)).toBe(true);
    expect(isPawError(new Error("x"))).toBe(false);
  });

  test("makeToolError creates structured payload", () => {
    const e = makeToolError("E_POLICY_DENIED", "blocked", {
      policy: "shell_guard",
    });
    expect(e.error_code).toBe("E_POLICY_DENIED");
    expect(e.error).toBe("blocked");
    expect(e.message).toBe("blocked");
    expect(e.policy).toBe("shell_guard");
  });
});
