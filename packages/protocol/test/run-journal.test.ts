import { describe, expect, test } from "bun:test";

import {
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  assertRunJournalEnvelopeCanFollowV1,
  isRunJournalEnvelopeV1,
  parseRunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "../src/index.js";

function factEnvelope(fact: unknown, seq = 1): unknown {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: 1_750_000_000_000,
    record: { kind: "input_fact", fact },
  };
}

function decisionEnvelope(inputThroughSeq: number, seq: number): unknown {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: 1_750_000_000_000 + seq,
    record: {
      kind: "derived_decision",
      decision: {
        type: "control.decided",
        reducerVersion: "v1",
        inputThroughSeq,
        stateHash: `state-hash-${seq}`,
        action: { kind: "continue", reasonCode: "next-turn" },
      },
    },
  };
}

function actionEnvelope(
  inputThroughSeq: number,
  seq: number,
  action: Record<string, unknown>,
): unknown {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: 1_750_000_000_000 + seq,
    record: {
      kind: "derived_decision",
      decision: {
        type: "control.decided",
        reducerVersion: "v1",
        inputThroughSeq,
        stateHash: `state-hash-${seq}`,
        action,
      },
    },
  };
}

function durableModelResponse(input?: {
  readonly assistantContent?: string;
  readonly toolCalls?: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    schemaVersion: "paw.model-response.v1",
    providerProtocol: "openai-compatible",
    assistantContent: input?.assistantContent ?? "",
    finishReason: input?.toolCalls?.length ? "tool_calls" : "stop",
    toolCalls: input?.toolCalls ?? [],
  };
}

function modelPrelude(
  turn = 1,
  hasToolCalls = true,
  modelCallId = "model-call-1",
): readonly unknown[] {
  return [
    factEnvelope(
      {
        type: "model.dispatch_recorded",
        modelCallId,
        turn,
        requestHash: "request-hash",
      },
      1,
    ),
    factEnvelope(
      {
        type: "model.settled",
        modelCallId,
        turn,
        status: "completed",
        hasToolCalls,
        hasVisibleOutput: !hasToolCalls,
        response: {
          kind: "inline",
          value: durableModelResponse({
            assistantContent: hasToolCalls ? "" : "done",
          }),
          hash: "response-hash",
        },
      },
      2,
    ),
  ];
}

function toolPrelude(): readonly unknown[] {
  return [
    ...modelPrelude(),
    factEnvelope(
      {
        type: "tool.call_observed",
        callId: "call-1",
        modelCallId: "model-call-1",
        turn: 1,
        tool: "read_file",
        args: { path: "src/a.ts" },
        order: 0,
      },
      3,
    ),
    factEnvelope(
      {
        type: "tool.dispatch_recorded",
        callId: "call-1",
        turn: 1,
        sourceIndex: 0,
        batchId: "batch-1",
        mode: "serial",
      },
      4,
    ),
  ];
}

function permissionFact(
  overrides: Record<string, unknown> = {},
  seq = 5,
): unknown {
  return factEnvelope(
    {
      type: "tool.permission_resolved",
      turn: 1,
      sourceIndex: 0,
      callId: "call-1",
      tool: "read_file",
      policyVersion: "permission-v1",
      resolution: "allow_once",
      source: "base_policy",
      ...overrides,
    },
    seq,
  );
}

describe("canonical run journal protocol", () => {
  test("validates bounded, scope-bound memory retrieval receipts", () => {
    const validFact = {
      type: "memory.retrieval_settled",
      queryId: "query-1",
      trigger: "task_start",
      providerVersion: "memory-provider-v1",
      policyVersion: "paw.memory-retrieval.v1",
      status: "completed",
      cards: [
        {
          id: "memory-1",
          revision: 1,
          kind: "episodic",
          statement: "verify the current workspace before applying this lesson",
          applicability: "reference",
          scope: { repositoryId: "repo-1" },
          sources: [
            { kind: "memory_store_evidence", ref: "memory:item/memory-1" },
          ],
          confidence: 0.8,
          contentHash: "card-hash",
        },
      ],
    };
    const valid = factEnvelope(validFact);
    expect(parseRunJournalEnvelopeV1(valid)).toBe(
      valid as RunJournalEnvelopeV1,
    );
    expect(() =>
      parseRunJournalEnvelopeV1(
        factEnvelope({
          ...validFact,
          status: "failed",
        }),
      ),
    ).toThrow("failed memory retrieval cannot contain cards");
    expect(() =>
      parseRunJournalEnvelopeV1(
        factEnvelope({
          ...validFact,
          cards: [
            {
              id: "memory-1",
              revision: 1,
              kind: "episodic",
              statement: "unscoped evidence",
              applicability: "reference",
              scope: { repositoryId: "repo-1" },
              sources: [],
              confidence: 0.8,
              contentHash: "card-hash",
            },
          ],
        }),
      ),
    ).toThrow("sources must be a non-empty bounded array");
  });

  test("binds topic evidence plans to a prior retrieval query and index", () => {
    const retrieval = factEnvelope(
      {
        type: "memory.retrieval_settled",
        queryId: "query-1",
        trigger: "task_start",
        providerVersion: "memory-provider-v1",
        policyVersion: "paw.memory-retrieval.v1",
        status: "completed",
        cards: [],
      },
      1,
    );
    const topicEvidencePayload = {
      type: "memory.topic_evidence_settled",
      queryId: "query-1",
      plannerVersion: "paw.memory-topic-evidence-planner.v1",
      scopeFingerprint: "scope-fingerprint",
      status: "completed",
      indexRevision: "index-revision-1",
      indexEntries: [
        {
          topicId: "topic-1",
          snapshotId: "snapshot-1",
          family: "profile",
          canonicalName: "Response style",
          normalizedName: "response style",
          memberCount: 2,
          trajectoryCount: 1,
          projectionHash: "projection-hash-1",
        },
      ],
      evidenceStates: [
        {
          topicId: "topic-1",
          snapshotId: "snapshot-1",
          trajectoryId: "trajectory-1",
          memoryId: "memory-1",
          state: "current",
          statement: "The user prefers concise answers.",
          validFrom: "2026-08-25T00:00:00.000Z",
          evidenceRefs: ["journal:run-1#input-fact-2"],
        },
      ],
      settledAt: 1_750_000_000_000,
    } as const;
    const topicEvidence = factEnvelope(topicEvidencePayload, 2);
    expect(parseRunJournalPrefixV1([retrieval, topicEvidence])).toHaveLength(2);
    expect(() =>
      parseRunJournalPrefixV1([factEnvelope(topicEvidencePayload, 1)]),
    ).toThrow("requires a retrieval query");
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        factEnvelope(
          {
            ...topicEvidencePayload,
            evidenceStates: [
              {
                topicId: "topic-outside-index",
                snapshotId: "snapshot-1",
                trajectoryId: "trajectory-1",
                memoryId: "memory-1",
                state: "current",
                statement: "Outside index.",
                validFrom: "2026-08-25T00:00:00.000Z",
                evidenceRefs: [],
              },
            ],
          },
          2,
        ),
      ]),
    ).toThrow("outside the settled index");
  });

  test("binds one source-grounded persona projection to a retrieval query", () => {
    const retrieval = factEnvelope(
      {
        type: "memory.retrieval_settled",
        queryId: "query-persona-1",
        trigger: "task_start",
        providerVersion: "memory-provider-v1",
        policyVersion: "paw.memory-retrieval.v1",
        status: "completed",
        cards: [],
      },
      1,
    );
    const projectionPayload = {
      type: "memory.persona_projection_settled",
      queryId: "query-persona-1",
      projectorVersion: "paw.memory-persona-evidence-projector.v1",
      scopeFingerprint: "scope-fingerprint",
      status: "completed",
      projectionRevision: "persona-revision-1",
      projectionKey: "persona-key-1",
      claims: [
        {
          memoryId: "memory-profile-1",
          kind: "profile",
          statement: "The user prefers concise answers.",
          confidence: 0.95,
          validFrom: "2026-08-25T00:00:00.000Z",
          evidenceRefs: ["journal:run-1#input-fact-2"],
        },
      ],
      sourceCount: 1,
      settledAt: 1_750_000_000_000,
    } as const;
    const projection = factEnvelope(projectionPayload, 2);
    expect(parseRunJournalPrefixV1([retrieval, projection])).toHaveLength(2);
    expect(() =>
      parseRunJournalPrefixV1([factEnvelope(projectionPayload, 1)]),
    ).toThrow("requires a retrieval query");
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        projection,
        factEnvelope(projectionPayload, 3),
      ]),
    ).toThrow("duplicate memory persona projection query");
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        factEnvelope(
          { ...projectionPayload, status: "noop", sourceCount: 0 },
          2,
        ),
      ]),
    ).toThrow("non-completed memory persona projection cannot contain claims");
  });

  test("binds bounded raw evidence hydration to a retrieval query", () => {
    const retrieval = factEnvelope(
      {
        type: "memory.retrieval_settled",
        queryId: "query-raw-1",
        trigger: "task_start",
        providerVersion: "memory-provider-v1",
        policyVersion: "paw.memory-retrieval.v1",
        status: "completed",
        cards: [],
      },
      1,
    );
    const rawEvidencePayload = {
      type: "memory.raw_evidence_settled",
      queryId: "query-raw-1",
      resolverVersion: "paw.memory-raw-evidence-resolver.v1",
      scopeFingerprint: "scope-fingerprint",
      status: "completed",
      resolutionRevision: "resolution-revision-1",
      spans: [
        {
          evidenceRef: "journal:run-1#input-fact-2",
          memoryIds: ["memory-1"],
          content: "Original bounded user evidence.",
          contentHash: "content-hash-1",
        },
      ],
      settledAt: 1_750_000_000_000,
    } as const;
    const rawEvidence = factEnvelope(rawEvidencePayload, 2);
    expect(parseRunJournalPrefixV1([retrieval, rawEvidence])).toHaveLength(2);
    expect(() =>
      parseRunJournalPrefixV1([factEnvelope(rawEvidencePayload, 1)]),
    ).toThrow("requires a retrieval query");
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        rawEvidence,
        factEnvelope(rawEvidencePayload, 3),
      ]),
    ).toThrow("duplicate memory raw evidence query");
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        factEnvelope({ ...rawEvidencePayload, status: "noop" }, 2),
      ]),
    ).toThrow("non-completed memory raw evidence cannot contain spans");
  });

  test("binds dynamic evidence coverage after topic and raw evidence", () => {
    const retrieval = factEnvelope(
      {
        type: "memory.retrieval_settled",
        queryId: "query-coverage-1",
        trigger: "task_start",
        providerVersion: "memory-provider-v1",
        policyVersion: "paw.memory-retrieval.v1",
        status: "completed",
        cards: [],
      },
      1,
    );
    const topic = factEnvelope(
      {
        type: "memory.topic_evidence_settled",
        queryId: "query-coverage-1",
        plannerVersion: "paw.memory-topic-evidence-planner.v1",
        scopeFingerprint: "scope-fingerprint",
        status: "noop",
        indexRevision: "index-revision-1",
        indexEntries: [],
        evidenceStates: [],
        reasonCode: "no-topic-evidence",
        settledAt: 1_750_000_000_000,
      },
      2,
    );
    const raw = factEnvelope(
      {
        type: "memory.raw_evidence_settled",
        queryId: "query-coverage-1",
        resolverVersion: "paw.memory-raw-evidence-resolver.v1",
        scopeFingerprint: "scope-fingerprint",
        status: "completed",
        resolutionRevision: "raw-revision-1",
        spans: [
          {
            evidenceRef: "journal:run-1#input-fact-2",
            memoryIds: ["memory-1"],
            content: "The user explicitly prefers quiet hotels.",
            contentHash: "content-hash-1",
          },
        ],
        settledAt: 1_750_000_000_001,
      },
      3,
    );
    const coveragePayload = {
      type: "memory.evidence_coverage_settled",
      queryId: "query-coverage-1",
      plannerVersion: "paw.memory-evidence-coverage-planner.v1",
      scopeFingerprint: "scope-fingerprint",
      status: "completed",
      planRevision: "coverage-revision-1",
      requirements: [
        {
          requirementId: "requirement-1",
          description: "The user's accommodation preference",
          priority: "required",
          minimumEvidence: 1,
        },
      ],
      coverage: [
        {
          requirementId: "requirement-1",
          status: "covered",
          memoryIds: ["memory-1"],
          topicIds: [],
        },
      ],
      supplementalStates: [],
      spans: [
        {
          evidenceRef: "journal:run-1#input-fact-2",
          memoryIds: ["memory-1"],
          content: "The user explicitly prefers quiet hotels.",
          contentHash: "content-hash-1",
        },
      ],
      settledAt: 1_750_000_000_002,
    } as const;
    const coverage = factEnvelope(coveragePayload, 4);
    expect(
      parseRunJournalPrefixV1([retrieval, topic, raw, coverage]),
    ).toHaveLength(4);
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        topic,
        factEnvelope(coveragePayload, 3),
      ]),
    ).toThrow("requires prior topic and raw evidence");
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        topic,
        raw,
        coverage,
        factEnvelope(coveragePayload, 5),
      ]),
    ).toThrow("duplicate memory evidence coverage query");
    expect(() =>
      parseRunJournalPrefixV1([
        retrieval,
        topic,
        raw,
        factEnvelope(
          {
            ...coveragePayload,
            coverage: [
              {
                ...coveragePayload.coverage[0],
                status: "missing",
              },
            ],
          },
          4,
        ),
      ]),
    ).toThrow("missing memory evidence coverage cannot contain memoryIds");
  });

  test("binds two-phase memory writes to a prior journal source range", () => {
    const started = factEnvelope(
      { type: "attempt.started", goalHash: "goal", configHash: "config" },
      1,
    );
    const claim = factEnvelope(
      {
        type: "memory.write_claimed",
        writeId: "write-1",
        trigger: "task_terminal",
        policyVersion: "paw.memory-writer.v1",
        extractorVersion: "paw.memory-atom-extractor.json.v1",
        scopeFingerprint: "scope-fingerprint",
        sourceFromSeq: 1,
        sourceThroughSeq: 1,
        sourceInputHash: "source-hash",
        claimedAt: 1_750_000_000_000,
      },
      2,
    );
    const atom = {
      schemaVersion: "paw.memory-atom-proposal.v1",
      atomId: "atom-1",
      kind: "instruction",
      action: "store",
      statement: "Use Chinese documentation by default.",
      keywords: ["language", "documentation"],
      authority: "user_asserted",
      confidence: 0.95,
      priority: 90,
      sourceSeqs: [1],
      targetIds: [],
      contentHash: "atom-hash",
    };
    const staged = factEnvelope(
      {
        type: "memory.candidate_staged",
        writeId: "write-1",
        proposalHash: "proposal-hash",
        atoms: [atom],
      },
      3,
    );
    const settled = factEnvelope(
      {
        type: "memory.write_settled",
        writeId: "write-1",
        status: "completed",
        proposalHash: "proposal-hash",
        storedIds: ["semantic-1"],
        invalidatedIds: [],
        skippedAtomIds: [],
        settledAt: 1_750_000_000_100,
      },
      4,
    );
    expect(
      parseRunJournalPrefixV1([started, claim, staged, settled]),
    ).toHaveLength(4);
    expect(() =>
      parseRunJournalPrefixV1([
        started,
        claim,
        factEnvelope(
          {
            type: "memory.candidate_staged",
            writeId: "write-1",
            proposalHash: "proposal-hash",
            atoms: [{ ...atom, sourceSeqs: [2] }],
          },
          3,
        ),
      ]),
    ).toThrow("outside claimed range");
    expect(() =>
      parseRunJournalPrefixV1([
        started,
        claim,
        factEnvelope(
          {
            type: "memory.write_settled",
            writeId: "write-1",
            status: "completed",
            storedIds: [],
            invalidatedIds: [],
            skippedAtomIds: [],
            settledAt: 1_750_000_000_100,
          },
          3,
        ),
      ]),
    ).toThrow("requires staged candidates");
  });

  test("binds topic organization to a settled memory write and staged proposal", () => {
    const started = factEnvelope(
      { type: "attempt.started", goalHash: "goal", configHash: "config" },
      1,
    );
    const writeClaim = factEnvelope(
      {
        type: "memory.write_claimed",
        writeId: "write-1",
        trigger: "task_terminal",
        policyVersion: "paw.memory-writer.v1",
        extractorVersion: "paw.memory-atom-extractor.json.v1",
        scopeFingerprint: "scope-fingerprint",
        sourceFromSeq: 1,
        sourceThroughSeq: 1,
        sourceInputHash: "source-hash",
        claimedAt: 1_750_000_000_000,
      },
      2,
    );
    const writeStage = factEnvelope(
      {
        type: "memory.candidate_staged",
        writeId: "write-1",
        proposalHash: "write-proposal-hash",
        atoms: [],
      },
      3,
    );
    const writeSettlement = factEnvelope(
      {
        type: "memory.write_settled",
        writeId: "write-1",
        status: "completed",
        proposalHash: "write-proposal-hash",
        storedIds: ["memory-1"],
        invalidatedIds: [],
        skippedAtomIds: [],
        settledAt: 1_750_000_000_100,
      },
      4,
    );
    const organizationClaimPayload = {
      type: "memory.topic_organization_claimed" as const,
      organizationId: "organization-1",
      policyVersion: "paw.memory-topic-organization.v1" as const,
      extractorVersion: "paw.memory-topic-extractor.json.v1",
      scopeFingerprint: "scope-fingerprint",
      sourceWriteId: "write-1",
      sourceProposalHash: "write-proposal-hash",
      sourceMemoryIds: ["memory-1"],
      sourceRevision: "source-revision-1",
      claimedAt: 1_750_000_000_200,
    };
    const organizationClaim = factEnvelope(organizationClaimPayload, 5);
    const topic = {
      schemaVersion: "paw.memory-topic-proposal.v1",
      proposalId: "topic-proposal-1",
      scopeFingerprint: "scope-fingerprint",
      family: "instruction",
      canonicalName: "Documentation language",
      normalizedName: "documentation-language",
      members: [
        {
          memoryId: "memory-1",
          role: "primary",
          confidence: 0.96,
          basis: "model_proposed",
        },
      ],
      confidence: 0.94,
    };
    const topicStage = factEnvelope(
      {
        type: "memory.topic_candidate_staged",
        organizationId: "organization-1",
        proposalHash: "topic-proposal-hash",
        topics: [topic],
      },
      6,
    );
    const topicSettlement = factEnvelope(
      {
        type: "memory.topic_organization_settled",
        organizationId: "organization-1",
        status: "completed",
        proposalHash: "topic-proposal-hash",
        topicIds: ["topic-1"],
        snapshotIds: ["snapshot-1"],
        settledAt: 1_750_000_000_300,
      },
      7,
    );

    expect(
      parseRunJournalPrefixV1([
        started,
        writeClaim,
        writeStage,
        writeSettlement,
        organizationClaim,
        topicStage,
        topicSettlement,
      ]),
    ).toHaveLength(7);
    expect(() =>
      parseRunJournalPrefixV1([
        started,
        writeClaim,
        writeStage,
        writeSettlement,
        factEnvelope(
          {
            ...organizationClaimPayload,
            sourceMemoryIds: ["memory-outside-source-write"],
          },
          5,
        ),
      ]),
    ).toThrow("source mismatch");
    expect(() =>
      parseRunJournalPrefixV1([
        started,
        writeClaim,
        writeStage,
        writeSettlement,
        organizationClaim,
        factEnvelope(
          {
            type: "memory.topic_organization_settled",
            organizationId: "organization-1",
            status: "completed",
            topicIds: [],
            snapshotIds: [],
            settledAt: 1_750_000_000_300,
          },
          6,
        ),
      ]),
    ).toThrow("requires stage");
  });

  test("a durable runtime activity closes and reopens an external wait boundary", () => {
    const started = factEnvelope(
      {
        type: "runtime.activity_started",
        activityId: "shell-1",
        activityKind: "managed_job",
        label: "build",
        startedAt: 42,
        metadata: { pid: 123, cwd: "C:/workspace" },
      },
      1,
    );
    const waiting = actionEnvelope(1, 2, {
      kind: "wait",
      waitFor: "external",
      reasonCode: "runtime-activities-pending",
    });
    const settled = factEnvelope(
      {
        type: "runtime.activity_settled",
        activityId: "shell-1",
        status: "completed",
        settledAt: 84,
        summary: "exit code 0",
      },
      3,
    );
    expect(() =>
      parseRunJournalPrefixV1([
        started,
        waiting,
        settled,
        actionEnvelope(3, 4, {
          kind: "continue",
          reasonCode: "activity-settled",
        }),
      ]),
    ).not.toThrow();

    expect(() =>
      parseRunJournalPrefixV1([
        started,
        actionEnvelope(1, 2, {
          kind: "complete",
          reasonCode: "done",
        }),
      ]),
    ).toThrow("active activities");
    expect(() =>
      parseRunJournalPrefixV1([started, waiting, settled, settled]),
    ).toThrow();
  });
  test("binds durable input admission to exactly one identical promotion", () => {
    const accepted = {
      type: "input.accepted",
      inputId: "input-1",
      delivery: "steer",
      content: "new direction",
      contentHash: "content-hash",
      callerId: "desktop-user",
    };
    const promoted = {
      type: "input.promoted",
      inputId: "input-1",
      delivery: "steer",
      content: "new direction",
      contentHash: "content-hash",
    };

    expect(
      parseRunJournalPrefixV1([
        factEnvelope(accepted, 1),
        factEnvelope(promoted, 2),
      ]),
    ).toHaveLength(2);
    expect(() =>
      parseRunJournalPrefixV1([
        factEnvelope(accepted, 1),
        factEnvelope({ ...promoted, content: "tampered" }, 2),
      ]),
    ).toThrow("identity mismatch");
    expect(() =>
      parseRunJournalPrefixV1([
        factEnvelope(accepted, 1),
        factEnvelope(promoted, 2),
        factEnvelope(promoted, 3),
      ]),
    ).toThrow("duplicate promoted input");
    expect(() =>
      parseRunJournalPrefixV1([
        factEnvelope({ ...promoted, inputId: "orphan-steer" }, 1),
      ]),
    ).toThrow("no durable admission");
  });

  test("accepts a valid fact in the single canonical envelope", () => {
    const value = factEnvelope({
      type: "tool.call_observed",
      callId: "call-1",
      modelCallId: "model-call-1",
      turn: 1,
      tool: "read_file",
      args: { path: "src/main.ts", lines: [1, 20] },
      order: 0,
    });

    const parsed = parseRunJournalEnvelopeV1(value);
    expect(parsed.schemaVersion).toBe("paw.run-journal.v1");
    expect(parsed.record.kind).toBe("input_fact");
    expect(isRunJournalEnvelopeV1(value)).toBe(true);
  });

  test("accepts a derived decision in the same envelope and sequence domain", () => {
    const value: RunJournalEnvelopeV1 = {
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
      sessionId: "session-1",
      runId: "run-1",
      seq: 2,
      ts: 1_750_000_000_001,
      record: {
        kind: "derived_decision",
        decision: {
          type: "control.decided",
          reducerVersion: "reducer-v1",
          inputThroughSeq: 1,
          stateHash: "state-hash-1",
          action: { kind: "continue", reasonCode: "turn-boundary" },
        },
      },
    };

    expect(parseRunJournalEnvelopeV1(value)).toBe(value);
  });

  test("keeps waiting and terminal outcomes explicit", () => {
    const actions = [
      { kind: "continue", reasonCode: "more-work" },
      { kind: "wait", waitFor: "user", reasonCode: "needs-answer" },
      { kind: "wait", waitFor: "external", reasonCode: "verification" },
      { kind: "complete", reasonCode: "done" },
      { kind: "incomplete", reasonCode: "budget" },
      { kind: "failed", reasonCode: "runtime-error" },
      { kind: "abort", reasonCode: "cancelled" },
    ];

    for (const action of actions) {
      expect(
        isRunJournalEnvelopeV1({
          schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
          sessionId: "session-1",
          runId: "run-1",
          seq: 2,
          ts: 1,
          record: {
            kind: "derived_decision",
            decision: {
              type: "control.decided",
              reducerVersion: "v1",
              inputThroughSeq: 1,
              stateHash: "hash",
              action,
            },
          },
        }),
      ).toBe(true);
    }

    expect(
      isRunJournalEnvelopeV1({
        schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
        sessionId: "session-1",
        runId: "run-1",
        seq: 2,
        ts: 1,
        record: {
          kind: "derived_decision",
          decision: {
            type: "control.decided",
            reducerVersion: "v1",
            inputThroughSeq: 1,
            stateHash: "hash",
            action: { kind: "wait", reasonCode: "ambiguous" },
          },
        },
      }),
    ).toBe(false);
  });

  test("requires contiguous sequence numbers within the same session and run", () => {
    const previous = parseRunJournalEnvelopeV1(
      factEnvelope({
        type: "abort.requested",
        source: "host",
      }),
    );
    const next = parseRunJournalEnvelopeV1({
      ...(factEnvelope(
        {
          type: "runtime.failed",
          area: "context",
          errorCode: "context-build-failed",
          message: "Context assembly did not complete.",
          retryable: true,
        },
        2,
      ) as object),
      ts: 1_750_000_000_001,
    });

    expect(() =>
      assertRunJournalEnvelopeCanFollowV1(previous, next),
    ).not.toThrow();
    expect(() =>
      assertRunJournalEnvelopeCanFollowV1(previous, { ...next, seq: 3 }),
    ).toThrow("contiguous");
    expect(() =>
      assertRunJournalEnvelopeCanFollowV1(previous, {
        ...next,
        sessionId: "session-2",
      }),
    ).toThrow("sessionId");
    expect(() =>
      assertRunJournalEnvelopeCanFollowV1(previous, {
        ...next,
        runId: "run-2",
      }),
    ).toThrow("runId");
  });

  test("validates every explicit model and tool settlement status", () => {
    for (const status of [
      "completed",
      "truncated",
      "failed",
      "cancelled",
      "unknown",
      "rejected",
    ] as const) {
      expect(
        isRunJournalEnvelopeV1(
          factEnvelope({
            type: "model.settled",
            modelCallId: "model-call-1",
            turn: 1,
            status,
            hasToolCalls: false,
            hasVisibleOutput: status === "completed",
            ...(status === "completed" || status === "truncated"
              ? {
                  response:
                    status === "completed"
                      ? {
                          kind: "inline",
                          value: durableModelResponse({
                            assistantContent: "complete provider response",
                          }),
                          hash: "response-hash",
                        }
                      : {
                          kind: "artifact_ref",
                          artifactRef: "artifact:response-1",
                          hash: "response-hash",
                        },
                }
              : {}),
            ...(status === "failed" || status === "rejected"
              ? { errorCode: "provider-error" }
              : {}),
          }),
        ),
      ).toBe(true);
    }

    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "unknown",
      "rejected",
    ] as const) {
      expect(
        isRunJournalEnvelopeV1(
          factEnvelope({
            type: "tool.settled",
            callId: "call-1",
            status,
            ...(status === "completed" ? { result: { ok: true } } : {}),
            ...(status === "failed" || status === "rejected"
              ? { errorCode: "tool-error" }
              : {}),
          }),
        ),
      ).toBe(true);
    }
  });

  test("persists a complete native response and separate parallel call facts", () => {
    const prefix = [
      factEnvelope(
        {
          type: "model.dispatch_recorded",
          modelCallId: "model-call-1",
          turn: 1,
          requestHash: "request-hash",
        },
        1,
      ),
      factEnvelope(
        {
          type: "model.settled",
          modelCallId: "model-call-1",
          turn: 1,
          status: "completed",
          hasToolCalls: true,
          hasVisibleOutput: true,
          finishReason: "tool_calls",
          response: {
            kind: "inline",
            hash: "native-response-hash",
            value: durableModelResponse({
              assistantContent: "Inspect both files.",
              toolCalls: [
                {
                  callId: "call-1",
                  name: "read_file",
                  rawArguments: '{"path":"src/a.ts"}',
                  args: { path: "src/a.ts" },
                  sourceIndex: 0,
                  argumentsValid: true,
                },
                {
                  callId: "call-2",
                  name: "read_file",
                  rawArguments: '{"path":"src/b.ts"}',
                  args: { path: "src/b.ts" },
                  sourceIndex: 1,
                  argumentsValid: true,
                },
              ],
            }),
          },
        },
        2,
      ),
      factEnvelope(
        {
          type: "tool.call_observed",
          callId: "call-1",
          modelCallId: "model-call-1",
          turn: 1,
          tool: "read_file",
          args: { path: "src/a.ts" },
          order: 0,
        },
        3,
      ),
      factEnvelope(
        {
          type: "tool.call_observed",
          callId: "call-2",
          modelCallId: "model-call-1",
          turn: 1,
          tool: "read_file",
          args: { path: "src/b.ts" },
          order: 1,
        },
        4,
      ),
      factEnvelope(
        {
          type: "tool.dispatch_recorded",
          callId: "call-1",
          turn: 1,
          sourceIndex: 0,
          batchId: "batch-1",
          mode: "parallel",
        },
        5,
      ),
      factEnvelope(
        {
          type: "tool.dispatch_recorded",
          callId: "call-2",
          turn: 1,
          sourceIndex: 1,
          batchId: "batch-1",
          mode: "parallel",
        },
        6,
      ),
      permissionFact({ tool: "read_file" }, 7),
      permissionFact(
        {
          callId: "call-2",
          sourceIndex: 1,
          tool: "read_file",
        },
        8,
      ),
      factEnvelope(
        {
          type: "tool.settled",
          callId: "call-1",
          status: "completed",
          result: { content: "a" },
          resultHash: "result-1",
        },
        9,
      ),
      factEnvelope(
        {
          type: "tool.settled",
          callId: "call-2",
          status: "completed",
          result: { content: "b" },
          resultHash: "result-2",
        },
        10,
      ),
      decisionEnvelope(10, 11),
    ];

    expect(parseRunJournalPrefixV1(prefix)).toHaveLength(11);
  });

  test("allows an observed call to settle as rejected without dispatch", () => {
    const prefix = [
      ...modelPrelude(),
      factEnvelope(
        {
          type: "tool.call_observed",
          callId: "call-unsafe",
          modelCallId: "model-call-1",
          turn: 1,
          tool: "shell",
          args: { command: "blocked" },
          order: 0,
        },
        3,
      ),
      factEnvelope(
        {
          type: "tool.settled",
          callId: "call-unsafe",
          status: "rejected",
          errorCode: "permission-denied",
        },
        4,
      ),
      decisionEnvelope(4, 5),
    ];

    expect(parseRunJournalPrefixV1(prefix)).toHaveLength(5);
  });

  test("rejects stale and consecutive derived decisions in a prefix", () => {
    const first = factEnvelope({ type: "abort.requested", source: "host" }, 1);
    const latest = factEnvelope(
      {
        type: "runtime.failed",
        area: "input",
        errorCode: "input-invalid",
        message: "Input could not be promoted.",
        retryable: false,
      },
      2,
    );

    expect(() =>
      parseRunJournalPrefixV1([first, latest, decisionEnvelope(1, 3)]),
    ).toThrow("stale");
    expect(() =>
      parseRunJournalPrefixV1([
        first,
        decisionEnvelope(1, 2),
        decisionEnvelope(2, 3),
      ]),
    ).toThrow("immediately follow");
  });

  test("binds model settlement identity across intervening decisions", () => {
    const dispatch = factEnvelope(
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-call-1",
        turn: 1,
        requestHash: "request-hash",
      },
      1,
    );
    const settlement = (modelCallId: string, turn: number, seq: number) =>
      factEnvelope(
        {
          type: "model.settled",
          modelCallId,
          turn,
          status: "cancelled",
          hasToolCalls: false,
          hasVisibleOutput: false,
        },
        seq,
      );

    expect(
      parseRunJournalPrefixV1([
        dispatch,
        decisionEnvelope(1, 2),
        settlement("model-call-1", 1, 3),
      ]),
    ).toHaveLength(3);
    expect(() =>
      parseRunJournalPrefixV1([
        dispatch,
        decisionEnvelope(1, 2),
        settlement("model-call-wrong", 1, 3),
      ]),
    ).toThrow("no dispatch");
    expect(() =>
      parseRunJournalPrefixV1([
        dispatch,
        decisionEnvelope(1, 2),
        settlement("model-call-1", 2, 3),
      ]),
    ).toThrow("turn mismatch");
    expect(() =>
      parseRunJournalPrefixV1([
        dispatch,
        settlement("model-call-1", 1, 2),
        decisionEnvelope(2, 3),
        settlement("model-call-1", 1, 4),
      ]),
    ).toThrow("duplicate model settlement");
  });

  test("binds every observed tool call to a settled tool-bearing model turn", () => {
    const observed = (
      turn: number,
      order: number,
      seq: number,
      callId = `call-${order}`,
    ) =>
      factEnvelope(
        {
          type: "tool.call_observed",
          callId,
          modelCallId: "model-call-1",
          turn,
          tool: "read_file",
          args: { path: `src/${order}.ts` },
          order,
        },
        seq,
      );

    expect(() => parseRunJournalPrefixV1([observed(1, 0, 1)])).toThrow(
      "no model dispatch",
    );
    expect(() =>
      parseRunJournalPrefixV1([
        factEnvelope(
          {
            type: "model.dispatch_recorded",
            modelCallId: "model-call-1",
            turn: 1,
            requestHash: "request-hash",
          },
          1,
        ),
        observed(1, 0, 2),
      ]),
    ).toThrow("precedes model settlement");
    expect(() =>
      parseRunJournalPrefixV1([...modelPrelude(), observed(2, 0, 3)]),
    ).toThrow("turn mismatch");
    expect(() =>
      parseRunJournalPrefixV1([...modelPrelude(1, false), observed(1, 0, 3)]),
    ).toThrow("contradicts model settlement");
    expect(() =>
      parseRunJournalPrefixV1([
        ...modelPrelude(),
        observed(1, 0, 3, "call-0"),
        observed(1, 0, 4, "call-duplicate-order"),
      ]),
    ).toThrow("order is not contiguous");
    expect(() =>
      parseRunJournalPrefixV1([...modelPrelude(), observed(1, 1, 3)]),
    ).toThrow("order is not contiguous");
  });

  test("rejects ghost and mismatched tool dispatches and settlements", () => {
    const prelude = modelPrelude(2);
    const observed = factEnvelope(
      {
        type: "tool.call_observed",
        callId: "call-1",
        modelCallId: "model-call-1",
        turn: 2,
        tool: "read_file",
        args: { path: "src/a.ts" },
        order: 0,
      },
      3,
    );
    const dispatch = (turn: number, sourceIndex: number, seq: number) =>
      factEnvelope(
        {
          type: "tool.dispatch_recorded",
          callId: "call-1",
          turn,
          sourceIndex,
          batchId: "batch-1",
          mode: "serial",
        },
        seq,
      );

    expect(() =>
      parseRunJournalPrefixV1([...prelude, dispatch(2, 0, 3)]),
    ).toThrow("no observed call");
    expect(() =>
      parseRunJournalPrefixV1([...prelude, observed, dispatch(3, 0, 4)]),
    ).toThrow("identity mismatch");
    expect(() =>
      parseRunJournalPrefixV1([...prelude, observed, dispatch(2, 1, 4)]),
    ).toThrow("identity mismatch");
    expect(() =>
      parseRunJournalPrefixV1([
        factEnvelope(
          {
            type: "tool.settled",
            callId: "ghost-call",
            status: "rejected",
            errorCode: "not-allowed",
          },
          1,
        ),
      ]),
    ).toThrow("no observed call");
    expect(() =>
      parseRunJournalPrefixV1([
        ...prelude,
        observed,
        factEnvelope(
          {
            type: "tool.settled",
            callId: "call-1",
            status: "completed",
            result: { ok: true },
          },
          4,
        ),
      ]),
    ).toThrow("no dispatch");
  });

  test("rejects duplicate tool dispatch and settlement", () => {
    const prelude = modelPrelude();
    const observed = factEnvelope(
      {
        type: "tool.call_observed",
        callId: "call-1",
        modelCallId: "model-call-1",
        turn: 1,
        tool: "read_file",
        args: { path: "src/a.ts" },
        order: 0,
      },
      3,
    );
    const dispatch = (seq: number) =>
      factEnvelope(
        {
          type: "tool.dispatch_recorded",
          callId: "call-1",
          turn: 1,
          sourceIndex: 0,
          batchId: "batch-1",
          mode: "serial",
        },
        seq,
      );
    const settlement = (seq: number) =>
      factEnvelope(
        {
          type: "tool.settled",
          callId: "call-1",
          status: "cancelled",
        },
        seq,
      );

    expect(() =>
      parseRunJournalPrefixV1([...prelude, observed, dispatch(4), dispatch(5)]),
    ).toThrow("duplicate tool dispatch");
    expect(() =>
      parseRunJournalPrefixV1([
        ...prelude,
        observed,
        settlement(4),
        decisionEnvelope(4, 5),
        settlement(6),
      ]),
    ).toThrow("duplicate tool settlement");
  });

  test("binds tool permission identity to one dispatched unsettled call", () => {
    expect(() =>
      parseRunJournalPrefixV1([
        ...toolPrelude().slice(0, -1),
        permissionFact({}, 4),
      ]),
    ).toThrow("no dispatch");
    expect(() =>
      parseRunJournalPrefixV1([...toolPrelude(), permissionFact({ turn: 2 })]),
    ).toThrow("identity mismatch");
    expect(() =>
      parseRunJournalPrefixV1([
        ...toolPrelude(),
        permissionFact({ callId: "ghost-call" }),
      ]),
    ).toThrow("no observed call");
    expect(() =>
      parseRunJournalPrefixV1([
        ...toolPrelude(),
        permissionFact({ tool: "shell" }),
      ]),
    ).toThrow("identity mismatch");
    expect(() =>
      parseRunJournalPrefixV1([
        ...toolPrelude(),
        permissionFact(),
        permissionFact(
          {
            resolution: "allow_rule",
            source: "run_rule",
            ruleId: "rule-1",
          },
          6,
        ),
      ]),
    ).toThrow("duplicate tool permission");
    expect(() =>
      parseRunJournalPrefixV1([
        ...toolPrelude(),
        factEnvelope(
          { type: "tool.settled", callId: "call-1", status: "cancelled" },
          5,
        ),
        permissionFact({}, 6),
      ]),
    ).toThrow("follows settlement");
  });

  test("a denied permission can only be followed by a rejected settlement", () => {
    expect(() =>
      parseRunJournalPrefixV1([
        ...toolPrelude(),
        permissionFact({ resolution: "deny", source: "user_prompt" }),
        factEnvelope(
          {
            type: "tool.settled",
            callId: "call-1",
            status: "completed",
            result: { unsafe: true },
          },
          6,
        ),
      ]),
    ).toThrow("requires rejected settlement");
  });

  test("completed and unknown settlements require an allowed permission fact", () => {
    for (const settlement of [
      {
        type: "tool.settled",
        callId: "call-1",
        status: "completed",
        result: { ok: true },
      },
      {
        type: "tool.settled",
        callId: "call-1",
        status: "unknown",
        errorCode: "result-lost",
      },
    ] as const) {
      expect(() =>
        parseRunJournalPrefixV1([
          ...toolPrelude(),
          factEnvelope(settlement, 5),
        ]),
      ).toThrow("requires allowed permission");
    }

    for (const status of ["completed", "unknown"] as const) {
      const settlement =
        status === "completed"
          ? {
              type: "tool.settled" as const,
              callId: "call-1",
              status,
              result: { ok: true },
            }
          : {
              type: "tool.settled" as const,
              callId: "call-1",
              status,
              errorCode: "result-lost",
            };
      expect(
        parseRunJournalPrefixV1([
          ...toolPrelude(),
          permissionFact(),
          factEnvelope(settlement, 6),
        ]),
      ).toHaveLength(6);
    }
  });

  test("accepts canonical allow-once, allow-rule, and deny permission facts", () => {
    const cases = [
      {
        permission: permissionFact(),
        settlement: {
          type: "tool.settled",
          callId: "call-1",
          status: "completed",
          result: { ok: true },
        },
      },
      {
        permission: permissionFact({
          resolution: "allow_rule",
          source: "run_rule",
          ruleId: "rule-1",
        }),
        settlement: {
          type: "tool.settled",
          callId: "call-1",
          status: "completed",
          result: { ok: true },
        },
      },
      {
        permission: permissionFact({
          resolution: "deny",
          source: "user_prompt",
        }),
        settlement: {
          type: "tool.settled",
          callId: "call-1",
          status: "rejected",
          errorCode: "permission-denied",
        },
      },
    ];

    for (const item of cases) {
      expect(
        parseRunJournalPrefixV1([
          ...toolPrelude(),
          item.permission,
          factEnvelope(item.settlement, 6),
        ]),
      ).toHaveLength(6);
    }
  });

  test("rejects impossible permission source and resolution combinations", () => {
    for (const permission of [
      permissionFact({ resolution: "allow_rule", source: "user_prompt" }),
      permissionFact({ resolution: "deny", source: "run_rule" }),
      permissionFact({ resolution: "allow_once", source: "run_rule" }),
      permissionFact({
        resolution: "allow_rule",
        source: "base_policy",
        ruleId: "rule-1",
      }),
    ]) {
      expect(() =>
        parseRunJournalPrefixV1([...toolPrelude(), permission]),
      ).toThrow();
    }
  });

  test("rejects missing or malformed ids and sequence metadata", () => {
    const valid = factEnvelope({
      type: "model.dispatch_recorded",
      modelCallId: "model-call-1",
      turn: 1,
      requestHash: "request-hash",
    }) as Record<string, unknown>;

    for (const invalid of [
      { ...valid, sessionId: "" },
      { ...valid, runId: "contains spaces" },
      { ...valid, seq: 0 },
      { ...valid, seq: 1.5 },
      { ...valid, ts: -1 },
      factEnvelope({
        type: "model.dispatch_recorded",
        modelCallId: "",
        turn: 1,
        requestHash: "request-hash",
      }),
      factEnvelope({
        type: "tool.settled",
        callId: "",
        status: "completed",
      }),
      factEnvelope({
        type: "abort.requested",
        source: "host",
        reason: undefined,
      }),
      factEnvelope({
        type: "model.settled",
        modelCallId: "model-call-1",
        turn: 1,
        status: "completed",
        hasToolCalls: false,
        hasVisibleOutput: false,
      }),
    ]) {
      expect(isRunJournalEnvelopeV1(invalid)).toBe(false);
      expect(() => parseRunJournalEnvelopeV1(invalid)).toThrow();
    }
  });

  test("strictly separates facts from decisions and rejects extra keys", () => {
    expect(
      isRunJournalEnvelopeV1({
        ...(factEnvelope({
          type: "abort.requested",
          source: "user",
        }) as object),
        extra: true,
      }),
    ).toBe(false);

    expect(
      isRunJournalEnvelopeV1({
        schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
        sessionId: "session-1",
        runId: "run-1",
        seq: 2,
        ts: 1,
        record: {
          kind: "derived_decision",
          fact: { type: "abort.requested", source: "user" },
        },
      }),
    ).toBe(false);

    expect(
      isRunJournalEnvelopeV1({
        schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
        sessionId: "session-1",
        runId: "run-1",
        seq: 1,
        ts: 1,
        record: {
          kind: "derived_decision",
          decision: {
            type: "control.decided",
            reducerVersion: "v1",
            inputThroughSeq: 1,
            stateHash: "hash",
            action: { kind: "complete", reasonCode: "done" },
          },
        },
      }),
    ).toBe(false);
  });

  test("rejects non-general fact and action discriminants", () => {
    for (const type of [
      "candidate.proposed",
      "benchmark.resolved",
      "loop.safe_boundary",
    ] as const) {
      expect(isRunJournalEnvelopeV1(factEnvelope({ type }))).toBe(false);
    }

    expect(
      isRunJournalEnvelopeV1({
        schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
        sessionId: "session-1",
        runId: "run-1",
        seq: 2,
        ts: 1,
        record: {
          kind: "derived_decision",
          decision: {
            type: "control.decided",
            reducerVersion: "v1",
            inputThroughSeq: 1,
            stateHash: "hash",
            action: { kind: "certify", reasonCode: "done" },
          },
        },
      }),
    ).toBe(false);
  });

  test("the protocol source has no core, agent, or Node runtime dependency", async () => {
    const source = await Bun.file(
      new URL("../src/run-journal.ts", import.meta.url),
    ).text();
    const manifest = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();

    expect(source).not.toContain("@paw/core");
    expect(source).not.toContain("@paw/agent");
    expect(source).not.toMatch(/from ["']node:/);
    expect(manifest.dependencies).toBeUndefined();
  });
});
