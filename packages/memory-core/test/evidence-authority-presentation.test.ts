import { describe, expect, test } from "bun:test";

import {
  classifyMemoryEvidenceRefsUseV1,
  renderMemoryEvidenceAuthorityHeaderV1,
} from "../src/index.js";

describe("typed evidence authority presentation", () => {
  test("derives reported use only from typed requirement coverage", () => {
    const common = {
      coverage: [
        {
          requirementId: "reported",
          selectedEvidenceRefs: ["session#turn-1"],
        },
      ],
      evidenceRefs: ["session#turn-1"],
    };
    expect(
      classifyMemoryEvidenceRefsUseV1({
        ...common,
        requirements: [
          {
            requirementId: "reported",
            evidenceUse: "reported_assistant_assertion",
          },
        ],
      }),
    ).toBe("reported_assistant_assertion");
    expect(
      classifyMemoryEvidenceRefsUseV1({
        ...common,
        requirements: [{ requirementId: "reported", evidenceUse: "fact" }],
      }),
    ).toBe("fact");
  });

  test("presents a reported assistant assertion before user role labels", () => {
    const header = renderMemoryEvidenceAuthorityHeaderV1({
      evidenceUse: "reported_assistant_assertion",
      roleConstraint: "user",
      answerRole: "supporting",
    });
    expect(header).toContain("[Reported assistant assertion]");
    expect(header).toContain("only what the assistant previously stated");
    expect(header).not.toContain("user-grounded evidence");
  });

  test("preserves fact and artifact authority labels", () => {
    expect(
      renderMemoryEvidenceAuthorityHeaderV1({
        evidenceUse: "fact",
        roleConstraint: "user",
        answerRole: "supporting",
      }),
    ).toBe("[Supporting user-grounded evidence]");
    expect(
      renderMemoryEvidenceAuthorityHeaderV1({
        evidenceUse: "fact",
        roleConstraint: "assistant",
        answerRole: "supporting",
      }),
    ).toContain("[Assistant-output evidence]");
  });
});
