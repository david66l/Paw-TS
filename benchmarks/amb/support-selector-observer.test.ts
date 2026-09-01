import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import type {
  MemoryEvidenceSupportSelectionInputV1,
  MemoryEvidenceSupportSelectionV1,
  MemoryEvidenceSupportSelectorV1,
} from "@paw/memory-plugin";

import {
  type AmbSupportSelectorObservationV1,
  observeAmbEvidenceSupportSelectorV1,
  projectAmbEvidenceSupportAssessmentsV1,
} from "./support-selector-observer.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);

function fixture(): {
  selection: MemoryEvidenceSupportSelectionInputV1;
  result: MemoryEvidenceSupportSelectionV1;
} {
  const candidates = [
    {
      sourceId: "doc-a",
      evidenceRef: "doc-a#source-2",
      content: "assistant answer",
      sourceKind: "assistant_output" as const,
      authority: "context_only" as const,
      contextEvidenceRefs: ["doc-a#source-1"],
    },
    {
      sourceId: "doc-b",
      evidenceRef: "doc-b#source-3",
      content: "related context",
      sourceKind: "user_input" as const,
      authority: "user_authored" as const,
    },
    {
      sourceId: "doc-c",
      evidenceRef: "doc-c#source-4",
      content: "unused context",
      sourceKind: "user_input" as const,
      authority: "user_authored" as const,
    },
  ];
  const selection: MemoryEvidenceSupportSelectionInputV1 = {
    query: "What did the assistant say?",
    requirements: [
      {
        requirementId: "answer-slot",
        label: "prior answer",
        searchText: "assistant answer",
        temporalMode: "any",
        roleConstraint: "assistant",
      },
    ],
    candidates,
    candidateScopes: [
      {
        requirementId: "answer-slot",
        evidenceRefs: candidates.map((candidate) => candidate.evidenceRef),
      },
    ],
    certifiedAssistantDialogueEvidenceRefs: ["doc-a#source-2"],
  };
  const result: MemoryEvidenceSupportSelectionV1 = {
    selectorVersion: "selector-v1",
    selectionRevision: "revision-v1",
    assessments: [
      {
        requirementId: "answer-slot",
        supportingEvidenceRefs: ["doc-a#source-2"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: ["doc-b#source-3"],
      },
    ],
  };
  return { selection, result };
}

describe("AMB support selector observer", () => {
  test("observes the selector funnel without changing the request or result", async () => {
    const { selection, result } = fixture();
    let delegatedInput: MemoryEvidenceSupportSelectionInputV1 | undefined;
    let observation: AmbSupportSelectorObservationV1 | undefined;
    const delegate: MemoryEvidenceSupportSelectorV1 = {
      selectorVersion: "selector-v1",
      async select(input) {
        delegatedInput = input;
        return result;
      },
    };
    const observer = observeAmbEvidenceSupportSelectorV1({
      selector: delegate,
      observe(value) {
        observation = value;
      },
    });

    const returned = await observer.select(
      selection,
      new AbortController().signal,
    );

    expect(observer.selectorVersion).toBe(delegate.selectorVersion);
    expect(delegatedInput).toBe(selection);
    expect(returned).toBe(result);
    expect(observation?.status).toBe("completed");
    expect(observation?.candidateCount).toBe(3);
    expect(observation?.duplicateNormalizedRefCount).toBe(0);
    expect(observation?.inputIssueCodes).toEqual([]);
    expect(observation?.certifiedAssistantDialogueRefHashes).toEqual([
      hash("doc-a#source-2"),
    ]);
    expect(observation?.candidates).toContainEqual({
      evidenceRefHash: hash("doc-a#source-2"),
      evidenceRefNormalizedChars: "doc-a#source-2".length,
      sourceIdNormalizedChars: "doc-a".length,
      contentNormalizedChars: "assistant answer".length,
      eventKeyNormalizedChars: null,
      contextEvidenceRefCount: 1,
      sourceKind: "assistant_output",
      authority: "context_only",
      certifiedAssistantDialogue: true,
    });
    expect(observation?.assessments[0]).toEqual({
      requirementIdHash: hash("answer-slot"),
      supportingEvidenceRefHashes: [hash("doc-a#source-2")],
      contradictingEvidenceRefHashes: [],
      unknownEvidenceRefHashes: [hash("doc-b#source-3")],
      omittedEvidenceRefHashes: [hash("doc-c#source-4")],
    });
  });

  test("forwards one-call grouped settlement and reports a partial commit", async () => {
    const { selection } = fixture();
    let strictCalls = 0;
    let groupedCalls = 0;
    let observation: AmbSupportSelectorObservationV1 | undefined;
    const delegate: MemoryEvidenceSupportSelectorV1 = {
      selectorVersion: "selector-v1",
      async select() {
        strictCalls += 1;
        throw new Error("strict path must not run");
      },
      async selectGrouped(_selection, groups) {
        groupedCalls += 1;
        return {
          selectorVersion: "selector-v1",
          selectionRevision: "grouped-revision-v1",
          groups: [
            {
              groupId: groups[0]?.groupId ?? "missing",
              status: "fallback",
              assessments: [],
              failureCodes: ["MemoryEvidenceSupportAddressInvalid"],
            },
          ],
        };
      },
    };
    const observer = observeAmbEvidenceSupportSelectorV1({
      selector: delegate,
      observe(value) {
        observation = value;
      },
    });
    const returned = await observer.selectGrouped?.(
      selection,
      [{ groupId: "answer-group", requirementIds: ["answer-slot"] }],
      new AbortController().signal,
    );

    expect(strictCalls).toBe(0);
    expect(groupedCalls).toBe(1);
    expect(returned?.groups[0]?.status).toBe("fallback");
    expect(observation?.status).toBe("partial");
    expect(observation?.failureCode).toBe(
      "MemoryEvidenceSupportAddressInvalid",
    );
    expect(observation?.assessments).toEqual([]);
  });

  test("isolates observer failures from successful selection", async () => {
    const { selection, result } = fixture();
    const observer = observeAmbEvidenceSupportSelectorV1({
      selector: {
        selectorVersion: "selector-v1",
        async select() {
          return result;
        },
      },
      observe() {
        throw new Error("telemetry unavailable");
      },
    });

    await expect(
      observer.select(selection, new AbortController().signal),
    ).resolves.toBe(result);
  });

  test("preserves selector failures and reports only a stable failure class", async () => {
    const { selection } = fixture();
    const failure = new Error("private provider detail");
    failure.name = "ProviderUnavailable";
    let observation: AmbSupportSelectorObservationV1 | undefined;
    const observer = observeAmbEvidenceSupportSelectorV1({
      selector: {
        selectorVersion: "selector-v1",
        async select() {
          throw failure;
        },
      },
      observe(value) {
        observation = value;
      },
    });

    await expect(
      observer.select(selection, new AbortController().signal),
    ).rejects.toBe(failure);
    expect(observation?.status).toBe("failed");
    expect(observation?.failureCode).toBe("ProviderUnavailable");
    expect(JSON.stringify(observation)).not.toContain(
      "private provider detail",
    );
  });

  test("collapses an untrusted error name to a content-free failure code", async () => {
    const { selection } = fixture();
    const failure = new Error("private provider detail");
    failure.name = "provider secret detail";
    let observation: AmbSupportSelectorObservationV1 | undefined;
    const observer = observeAmbEvidenceSupportSelectorV1({
      selector: {
        selectorVersion: "selector-v1",
        async select() {
          throw failure;
        },
      },
      observe(value) {
        observation = value;
      },
    });

    await expect(
      observer.select(selection, new AbortController().signal),
    ).rejects.toBe(failure);
    expect(observation?.failureCode).toBe("UnknownFailure");
    expect(JSON.stringify(observation)).not.toContain("secret detail");
  });

  test("classifies an overlong raw candidate without recording its content", async () => {
    const { selection } = fixture();
    const privateContent = `private-${"x".repeat(8_193)}`;
    const overlongSelection = {
      ...selection,
      candidates: selection.candidates.map((candidate, index) =>
        index === 0 ? { ...candidate, content: privateContent } : candidate,
      ),
    };
    const failure = new Error("MemoryEvidenceSupportCandidateInvalid");
    failure.name = "MemoryEvidenceSupportCandidateInvalid";
    let observation: AmbSupportSelectorObservationV1 | undefined;
    const observer = observeAmbEvidenceSupportSelectorV1({
      selector: {
        selectorVersion: "selector-v1",
        async select() {
          throw failure;
        },
      },
      observe(value) {
        observation = value;
      },
    });

    await expect(
      observer.select(overlongSelection, new AbortController().signal),
    ).rejects.toBe(failure);
    expect(observation?.inputIssueCodes).toEqual(["content_too_long"]);
    expect(
      Math.max(
        ...(observation?.candidates.map(
          (candidate) => candidate.contentNormalizedChars,
        ) ?? []),
      ),
    ).toBe(privateContent.length);
    expect(JSON.stringify(observation)).not.toContain("private-");
  });

  test("projects post-authority assessments with the same content-free address", () => {
    const { result } = fixture();
    expect(projectAmbEvidenceSupportAssessmentsV1(result.assessments)).toEqual([
      {
        requirementIdHash: hash("answer-slot"),
        supportingEvidenceRefHashes: [hash("doc-a#source-2")],
        contradictingEvidenceRefHashes: [],
        unknownEvidenceRefHashes: [hash("doc-b#source-3")],
      },
    ]);
  });
});
