import { describe, expect, test } from "bun:test";
import {
  buildMemoryEvidenceNotebookV1,
  classifyMemoryEvidenceUseV1,
} from "../src/evidence-first.js";

describe("typed evidence origin", () => {
  test("keeps assistant output separate from user facts", () => {
    const common = {
      sourceKind: "assistant_output" as const,
      authority: "context_only" as const,
    };

    expect(
      classifyMemoryEvidenceUseV1({
        ...common,
        roleConstraint: "assistant",
      }),
    ).toBe("assistant_report");
    expect(
      classifyMemoryEvidenceUseV1({ ...common, roleConstraint: "any" }),
    ).toBeUndefined();
    expect(
      classifyMemoryEvidenceUseV1({
        ...common,
        roleConstraint: "any",
        dialogueCertified: true,
      }),
    ).toBe("shared_dialogue_artifact");
    expect(
      classifyMemoryEvidenceUseV1({
        ...common,
        roleConstraint: "user",
        dialogueCertified: true,
      }),
    ).toBe("shared_dialogue_artifact");
    expect(
      classifyMemoryEvidenceUseV1({ ...common, roleConstraint: "user" }),
    ).toBeUndefined();
    expect(
      classifyMemoryEvidenceUseV1({
        roleConstraint: "assistant",
        sourceKind: "user_input",
        authority: "user_asserted",
      }),
    ).toBeUndefined();
  });

  test("renders the permitted use on every selected evidence item", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "prior-answer",
          label: "prior assistant answer",
          searchText: "recommended train",
          roleConstraint: "assistant",
          hits: [
            {
              sourceId: "session-1",
              evidenceRef: "session-1#assistant-2",
              content: "I recommended taking the train.",
              authority: "context_only",
              sourceKind: "assistant_output",
            },
          ],
        },
      ],
      allowedSourceIds: ["session-1"],
      allowContextOnly: true,
      maxHitsPerRequirement: 1,
      maxChars: 1_024,
    });

    expect(notebook.sources[0]?.evidenceUses).toEqual(["assistant_report"]);
    expect(notebook.sources[0]?.evidenceBindings).toEqual([
      {
        evidenceRef: "session-1#assistant-2",
        evidenceUse: "assistant_report",
      },
    ]);
    expect(notebook.sources[0]?.text).toContain(
      "evidence_use=assistant_report",
    );
    expect(notebook.sources[0]?.text).toContain("authority=context_only");
  });

  test("keeps ref-to-use bindings when one source contains mixed evidence", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "user-request",
          label: "user request",
          searchText: "project label request",
          roleConstraint: "user",
          hits: [
            {
              sourceId: "session-1",
              evidenceRef: "session-1#user-1",
              content: "Please propose a project label.",
              authority: "user_asserted",
              sourceKind: "user_input",
            },
          ],
        },
        {
          requirementId: "shared-answer",
          label: "shared answer",
          searchText: "project label Northstar",
          roleConstraint: "user",
          certifiedDialogueEvidenceRefs: ["session-1#assistant-2"],
          hits: [
            {
              sourceId: "session-1",
              evidenceRef: "session-1#assistant-2",
              content: "The proposed project label was Northstar.",
              authority: "context_only",
              sourceKind: "assistant_output",
            },
          ],
        },
      ],
      allowedSourceIds: ["session-1"],
      allowContextOnly: true,
      maxHitsPerRequirement: 1,
      maxChars: 2_048,
    });

    expect(notebook.sources[0]?.evidenceBindings).toEqual([
      {
        evidenceRef: "session-1#user-1",
        evidenceUse: "user_fact",
      },
      {
        evidenceRef: "session-1#assistant-2",
        evidenceUse: "shared_dialogue_artifact",
      },
    ]);
  });
});
