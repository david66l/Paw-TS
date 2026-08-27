import { describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import {
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  buildVerifiedCanonicalPayloadIndexV1,
  createVerifiedCanonicalPayloadEvidenceV1,
  projectLatestAssistantTextV1,
} from "../src/index.js";

describe("latest canonical assistant text", () => {
  test("keeps the all-inline plain path unchanged", () => {
    const fixture = assistantFixture("completed", "inline answer", false);

    expect(
      projectLatestAssistantTextV1({
        snapshot: fixture.snapshot,
        providerProtocol: "openai-compatible",
      }),
    ).toBe("inline answer");
  });

  test("reads completed and truncated artifact text from exact issued evidence", async () => {
    for (const status of ["completed", "truncated"] as const) {
      const fixture = assistantFixture(
        status,
        status === "completed" ? "artifact answer" : "partial final text",
        true,
      );
      const evidence = await issuedAssistantEvidence(fixture);

      expect(
        projectLatestAssistantTextV1({
          snapshot: fixture.snapshot,
          providerProtocol: "openai-compatible",
          payloadEvidence: evidence,
        }),
      ).toBe(status === "completed" ? "artifact answer" : "partial final text");
    }
  });

  test("never falls back to an older assistant when the latest artifact lacks evidence", () => {
    const latest = assistantFixture("completed", "latest artifact", true);
    const oldResponse = modelResponse("old inline", "stop");
    const oldFacts: InputFactV1[] = [
      modelDispatch("model-1", 1),
      modelSettlement("model-1", 1, "completed", inline(oldResponse), "stop"),
    ];
    const latestFacts = latest.snapshot.entries.map((entry) => entry.fact);
    const second = latestFacts.map((fact) =>
      fact.type === "model.dispatch_recorded" || fact.type === "model.settled"
        ? { ...fact, modelCallId: "model-2", turn: 2 }
        : fact,
    ) as InputFactV1[];
    const snapshot = snapshotOf([...oldFacts, ...second]);

    expect(() =>
      projectLatestAssistantTextV1({
        snapshot,
        providerProtocol: "openai-compatible",
      }),
    ).toThrow("exact canonical evidence");
  });

  test("does not fall through a latest response-less settlement to older assistant text", () => {
    for (const status of ["failed", "unknown", "cancelled"] as const) {
      const oldResponse = modelResponse("older completed answer", "stop");
      const latestSettlement: InputFactV1 = {
        type: "model.settled",
        modelCallId: "model-2",
        turn: 2,
        status,
        hasToolCalls: false,
        hasVisibleOutput: false,
        ...(status === "failed" ? { errorCode: "provider_failed" } : {}),
      };
      const snapshot = snapshotOf([
        modelDispatch("model-1", 1),
        modelSettlement("model-1", 1, "completed", inline(oldResponse), "stop"),
        modelDispatch("model-2", 2),
        latestSettlement,
      ]);

      expect(
        projectLatestAssistantTextV1({
          snapshot,
          providerProtocol: "openai-compatible",
        }),
      ).toBeUndefined();
    }
  });

  test("rejects snapshot, payload, and provider drift instead of returning empty text", async () => {
    const fixture = assistantFixture("completed", "verified answer", true);
    const evidence = await issuedAssistantEvidence(fixture);

    expect(() =>
      projectLatestAssistantTextV1({
        snapshot: {
          ...fixture.snapshot,
          tailSeq: fixture.snapshot.tailSeq + 1,
        },
        providerProtocol: "openai-compatible",
        payloadEvidence: evidence,
      }),
    ).toThrow("snapshot mismatch");

    const payloadDrift = mapSnapshot(fixture.snapshot, (fact) =>
      fact.type === "model.settled" && fact.response
        ? { ...fact, response: { ...fact.response, hash: "wrong-hash" } }
        : fact,
    );
    expect(() =>
      projectLatestAssistantTextV1({
        snapshot: payloadDrift,
        providerProtocol: "openai-compatible",
        payloadEvidence: evidence,
      }),
    ).toThrow("snapshot mismatch");

    expect(() =>
      projectLatestAssistantTextV1({
        snapshot: fixture.snapshot,
        providerProtocol: "anthropic-compatible",
        payloadEvidence: evidence,
      }),
    ).toThrow("provider protocol mismatch");
  });

  test("rejects inline and artifact carrier metadata drift", async () => {
    const mutations = [
      (fact: Extract<InputFactV1, { type: "model.settled" }>) => ({
        ...fact,
        hasVisibleOutput: false,
      }),
      (fact: Extract<InputFactV1, { type: "model.settled" }>) => ({
        ...fact,
        finishReason: "drifted-finish-reason",
      }),
    ] as const;

    for (const mutate of mutations) {
      const inlineFixture = assistantFixture(
        "completed",
        "inline metadata",
        false,
      );
      const inlineDrift = mapSnapshot(inlineFixture.snapshot, (fact) =>
        fact.type === "model.settled" ? mutate(fact) : fact,
      );
      expect(() =>
        projectLatestAssistantTextV1({
          snapshot: inlineDrift,
          providerProtocol: "openai-compatible",
        }),
      ).toThrow();

      const artifactFixture = assistantFixture(
        "completed",
        "artifact metadata",
        true,
      );
      const artifactSnapshot = mapSnapshot(artifactFixture.snapshot, (fact) =>
        fact.type === "model.settled" ? mutate(fact) : fact,
      );
      await expect(
        issuedAssistantEvidence({
          ...artifactFixture,
          snapshot: artifactSnapshot,
          prefix: prefixOf(artifactSnapshot),
        }),
      ).rejects.toThrow();
    }
  });
});

interface AssistantFixture {
  readonly snapshot: SessionInputSnapshot<InputFactV1>;
  readonly prefix: readonly RunJournalEnvelopeV1[];
  readonly artifacts: ReadonlyMap<string, JsonValue>;
}

function assistantFixture(
  status: "completed" | "truncated",
  content: string,
  artifact: boolean,
): AssistantFixture {
  const finishReason = status === "truncated" ? "length" : "stop";
  const response = modelResponse(content, finishReason);
  const payload = artifact
    ? ({
        kind: "artifact_ref",
        artifactRef: "artifact:latest-assistant",
        hash: hashValue(response),
      } as const)
    : inline(response);
  const facts: InputFactV1[] = [
    modelDispatch("model-1", 1),
    modelSettlement("model-1", 1, status, payload, finishReason),
  ];
  const snapshot = snapshotOf(facts);
  return {
    snapshot,
    prefix: prefixOf(snapshot),
    artifacts: artifact
      ? new Map([["artifact:latest-assistant", response]])
      : new Map(),
  };
}

async function issuedAssistantEvidence(fixture: AssistantFixture) {
  const identity = {
    workspaceRoot: "E:/latest-assistant-fixture",
    sessionId: "session-assistant",
    runId: "run-assistant",
  } as const;
  const budget = {
    policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
    maxTotalBytes: 1_000_000,
  } as const;
  const index = await buildVerifiedCanonicalPayloadIndexV1({
    fullPrefix: fixture.prefix,
    resolver: {
      readCanonicalPayloadIdentity: () => identity,
      resolve(payload) {
        if (payload.kind !== "artifact_ref") {
          throw new Error("expected artifact response");
        }
        const value = fixture.artifacts.get(payload.artifactRef);
        if (value === undefined) throw new Error("assistant artifact missing");
        return value;
      },
      hash: hashValue,
    },
    budget,
  });
  return createVerifiedCanonicalPayloadEvidenceV1({
    index,
    fullPrefix: fixture.prefix,
    identity,
    budget,
  });
}

function modelDispatch(modelCallId: string, turn: number): InputFactV1 {
  return {
    type: "model.dispatch_recorded",
    modelCallId,
    turn,
    requestHash: `request-${turn}`,
  };
}

function modelSettlement(
  modelCallId: string,
  turn: number,
  status: "completed" | "truncated",
  response: DurableJsonPayloadV1,
  finishReason: string,
): InputFactV1 {
  return {
    type: "model.settled",
    modelCallId,
    turn,
    status,
    hasToolCalls: false,
    hasVisibleOutput: true,
    response,
    finishReason,
  };
}

function modelResponse(content: string, finishReason: string): JsonValue {
  return {
    schemaVersion: MODEL_RESPONSE_SCHEMA_VERSION_V1,
    providerProtocol: "openai-compatible",
    assistantContent: content,
    finishReason,
    toolCalls: [],
  };
}

function inline(value: JsonValue): DurableJsonPayloadV1 {
  return { kind: "inline", value, hash: hashValue(value) };
}

function snapshotOf(
  facts: readonly InputFactV1[],
): SessionInputSnapshot<InputFactV1> {
  return {
    entries: facts.map((fact, index) => ({ seq: index + 1, fact })),
    tailSeq: facts.length,
    latestInputSeq: facts.length,
  };
}

function prefixOf(
  snapshot: SessionInputSnapshot<InputFactV1>,
): readonly RunJournalEnvelopeV1[] {
  return snapshot.entries.map((entry) => ({
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-assistant",
    runId: "run-assistant",
    seq: entry.seq,
    ts: entry.seq,
    record: { kind: "input_fact" as const, fact: entry.fact },
  }));
}

function mapSnapshot(
  snapshot: SessionInputSnapshot<InputFactV1>,
  map: (fact: InputFactV1) => InputFactV1,
): SessionInputSnapshot<InputFactV1> {
  return snapshotOf(snapshot.entries.map((entry) => map(entry.fact)));
}

function hashValue(value: JsonValue): string {
  return `hash:${stableStringify(value)}`;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
