import { describe, expect, test } from "bun:test";

import { selectToolGuidanceV1 } from "../src/lifecycle/tool-guidance.js";

describe("tool guidance v1", () => {
  test("selects one candidate by fixed internal priority", () => {
    expect(
      selectToolGuidanceV1({
        recoveryMessage: "recover",
        idleFuseTripped: true,
        codingPhaseNudges: ["edit now"],
        repeatToolReminders: ["stop repeating"],
      }),
    ).toEqual({
      kind: "tool_guidance",
      topic: "idle_fuse",
      text: "recover",
    });
    expect(
      selectToolGuidanceV1({
        recoveryMessage: "recover",
        codingPhaseNudges: ["edit now"],
        repeatToolReminders: ["stop repeating"],
      }),
    ).toMatchObject({ topic: "coding_phase", text: "edit now" });
    expect(
      selectToolGuidanceV1({
        recoveryMessage: "recover",
        repeatToolReminders: ["stop repeating"],
      }),
    ).toMatchObject({ topic: "tool_recovery", text: "recover" });
    expect(
      selectToolGuidanceV1({
        repeatToolReminders: ["first", "last"],
      }),
    ).toMatchObject({ topic: "repeat_tool", text: "last" });
  });

  test("does not create an empty control", () => {
    expect(selectToolGuidanceV1({})).toBeUndefined();
    expect(
      selectToolGuidanceV1({ repeatToolReminders: [" ", ""] }),
    ).toBeUndefined();
  });
});
