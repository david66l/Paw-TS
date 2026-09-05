import { describe, expect, test } from "bun:test";

import {
  buildAmbDialogueOrdinalAdmissionVersionV1,
  isStrictAmbDialogueOrdinalAdmissionReplyV1,
} from "./dialogue-ordinal-admission-runtime-contract.js";

describe("dialogue ordinal admission replay contract", () => {
  test("only persists the exact enum envelope", () => {
    expect(
      isStrictAmbDialogueOrdinalAdmissionReplyV1(
        '{"classification":"artifact_itself"}',
      ),
    ).toBe(true);
    expect(
      isStrictAmbDialogueOrdinalAdmissionReplyV1(
        '{"classification":"artifact_internal_content"}',
      ),
    ).toBe(true);
    expect(
      isStrictAmbDialogueOrdinalAdmissionReplyV1(
        '{"classification":"non_direct_or_ambiguous"}',
      ),
    ).toBe(true);
    for (const malformed of [
      "not json",
      '{"classification":"artifact_itself","ordinal":2}',
      '{"classification":"unrecognized"}',
      "[]",
    ]) {
      expect(isStrictAmbDialogueOrdinalAdmissionReplyV1(malformed)).toBe(false);
    }
  });

  test("binds replay/request policy into the admission identity", () => {
    const baseline = buildAmbDialogueOrdinalAdmissionVersionV1({
      model: "glm-5.3-flash",
      reasoningEffort: "low",
    });
    expect(baseline).toContain("replay=paw.amb-memory-llm-replay-cache.v2");
    expect(baseline).toContain("response_format=json_object");
    expect(baseline).toContain("max_tokens=64");
    expect(
      buildAmbDialogueOrdinalAdmissionVersionV1({
        model: "glm-5.3-flash",
        reasoningEffort: "max",
      }),
    ).not.toBe(baseline);
    expect(
      buildAmbDialogueOrdinalAdmissionVersionV1({
        model: "another-model",
        reasoningEffort: "low",
      }),
    ).not.toBe(baseline);
  });
});
