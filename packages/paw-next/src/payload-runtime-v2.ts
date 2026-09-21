import type { SessionInputSnapshot } from "@paw/agent-loop";
import type {
  InputFactV1,
  ModelResponseV1,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  type FileRunSessionV1,
  type FileSessionExecutionLeaseV1,
  type LocationAwarePayloadSessionV1,
  type VerifiedCanonicalPayloadEvidenceV1,
  buildVerifiedCanonicalPayloadIndexV1,
  createFileDurableJsonPayloadReaderV1,
  createFileDurableJsonPayloadWriterV1,
  createLocationAwarePayloadSessionV1,
  createVerifiedCanonicalPayloadEvidenceV1,
  freezeFileDurableJsonPayloadRuntimePolicyV1,
  projectCanonicalSessionInputSnapshotV1,
  projectLatestAssistantTextV1,
} from "@paw/runtime";

import type { PawNextTaskProfileOptionsV2 } from "./product-profile-v2.js";

type PawNextFilePayloadTaskOptionsV1 = Pick<
  PawNextTaskProfileOptionsV2,
  "workspaceRoot" | "sessionId" | "runId" | "payloadRuntime"
>;

export interface PawNextPayloadExecutionBundleV2 {
  readonly session: LocationAwarePayloadSessionV1;
  readonly loadForPrefix: (
    prefix: readonly RunJournalEnvelopeV1[],
    signal?: AbortSignal,
  ) => Promise<VerifiedCanonicalPayloadEvidenceV1>;
  readonly loadForSnapshot: (
    snapshot: SessionInputSnapshot<InputFactV1>,
    signal?: AbortSignal,
  ) => Promise<VerifiedCanonicalPayloadEvidenceV1>;
  readonly readFinalProjection: (
    providerProtocol: ModelResponseV1["providerProtocol"],
    signal?: AbortSignal,
  ) => Promise<{
    readonly snapshot: SessionInputSnapshot<InputFactV1>;
    readonly assistantText?: string;
  }>;
}

export interface PawNextPayloadReadBundleV2 {
  readonly loadForPrefix: (
    prefix: readonly RunJournalEnvelopeV1[],
    signal?: AbortSignal,
  ) => Promise<VerifiedCanonicalPayloadEvidenceV1>;
}

/** Strict read-only payload evidence for startup classification. */
export function createPawNextPayloadReadBundleV2(input: {
  readonly taskOptions: PawNextFilePayloadTaskOptionsV1;
}): PawNextPayloadReadBundleV2 {
  const policy = freezeFileDurableJsonPayloadRuntimePolicyV1(
    input.taskOptions.payloadRuntime,
  );
  const reader = createFileDurableJsonPayloadReaderV1({
    workspaceRoot: input.taskOptions.workspaceRoot,
    sessionId: input.taskOptions.sessionId,
    runId: input.taskOptions.runId,
    policy: policy.storePolicy,
  });
  const payloadIdentity = reader.readCanonicalPayloadIdentity();
  return Object.freeze({
    async loadForPrefix(
      prefix: readonly RunJournalEnvelopeV1[],
      signal?: AbortSignal,
    ) {
      const index = await buildVerifiedCanonicalPayloadIndexV1({
        fullPrefix: prefix,
        resolver: reader,
        budget: policy.readBudget,
        signal,
      });
      return createVerifiedCanonicalPayloadEvidenceV1({
        index,
        fullPrefix: prefix,
        identity: payloadIdentity,
        budget: policy.readBudget,
      });
    },
  });
}

export function createPawNextPayloadExecutionBundleV2(input: {
  readonly rawSession: FileRunSessionV1;
  readonly executionLease: FileSessionExecutionLeaseV1;
  readonly taskOptions: PawNextFilePayloadTaskOptionsV1;
  readonly signal: AbortSignal;
}): PawNextPayloadExecutionBundleV2 {
  const policy = freezeFileDurableJsonPayloadRuntimePolicyV1(
    input.taskOptions.payloadRuntime,
  );
  const identity = {
    workspaceRoot: input.taskOptions.workspaceRoot,
    sessionId: input.taskOptions.sessionId,
    runId: input.taskOptions.runId,
  };
  const writer = createFileDurableJsonPayloadWriterV1({
    ...identity,
    policy: policy.storePolicy,
    executionLease: input.executionLease,
  });
  const session = createLocationAwarePayloadSessionV1({
    source: input.rawSession,
    sessionId: identity.sessionId,
    runId: identity.runId,
    materializer: writer,
    budget: policy.readBudget,
    signal: input.signal,
  });
  const readBundle = createPawNextPayloadReadBundleV2({
    taskOptions: input.taskOptions,
  });
  const loadForPrefix = readBundle.loadForPrefix;

  const loadForSnapshot = async (
    snapshot: SessionInputSnapshot<InputFactV1>,
    signal?: AbortSignal,
  ): Promise<VerifiedCanonicalPayloadEvidenceV1> => {
    const current = await session.readCanonicalPrefix();
    if (current.length < snapshot.tailSeq) {
      throw new Error("Canonical payload snapshot is ahead of its Session");
    }
    const prefix = current.slice(0, snapshot.tailSeq);
    const evidence = await loadForPrefix(prefix, signal);
    evidence.assertSnapshot(snapshot);
    return evidence;
  };

  return Object.freeze({
    session,
    loadForPrefix,
    loadForSnapshot,
    async readFinalProjection(
      providerProtocol: ModelResponseV1["providerProtocol"],
      signal?: AbortSignal,
    ) {
      const prefix = await session.readCanonicalPrefix();
      const snapshot = projectCanonicalSessionInputSnapshotV1(prefix);
      const evidence = await loadForPrefix(prefix, signal);
      return Object.freeze({
        snapshot,
        assistantText: projectLatestAssistantTextV1({
          snapshot,
          providerProtocol,
          payloadEvidence: evidence,
        }),
      });
    },
  });
}
