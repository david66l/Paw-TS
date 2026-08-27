import {
  INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
  type InteractiveControlConfigV2,
} from "@paw/agent-loop";
import {
  AGENT_SPEC_CHILD_RUNTIME_POLICY_VERSION_V1,
  COLLABORATION_COORDINATOR_POLICY_VERSION_V1,
  COLLABORATION_DELEGATION_SCHEMA_VERSION_V1,
  COLLABORATION_POLICY_VERSION_V1,
  COLLABORATION_ROSTER_VERSION_V1,
} from "@paw/collaboration";
import {
  COMPLETION_REVIEWER_POLICY_VERSION_V1,
  COMPLETION_REVIEW_CONTINUATION_POLICY_VERSION_V2,
  COMPLETION_REVIEW_EVIDENCE_PACKET_POLICY_VERSION_V1,
  COMPLETION_REVIEW_GATE_POLICY_VERSION_V1,
  COMPLETION_REVIEW_TRIGGER_POLICY_VERSION_V1,
} from "@paw/completion-review";
import {
  CHECKPOINT_DISTILLER_POLICY_VERSION_V1,
  CHECKPOINT_EVIDENCE_POLICY_VERSION_V1,
  CHECKPOINT_SEMANTIC_VERIFIER_POLICY_VERSION_V1,
  CONTEXT_COMPACTION_LIFECYCLE_POLICY_VERSION_V1,
  CONTEXT_COMPACTION_ORCHESTRATION_POLICY_VERSION_V1,
  CONTEXT_COMPACTION_POLICY_VERSION_V1,
} from "@paw/context-compaction";
import {
  type PawNextMemoryPluginIdentityV1,
  type PawNextMemoryPluginProfileV1,
  createPawNextMemoryPluginIdentityV1,
} from "@paw/memory-plugin";
import { DEFAULT_MODEL_OUTPUT_RECOVERY_POLICY_V1 } from "@paw/model-output-recovery";
import { PROGRESS_ADVISOR_POLICY_VERSION_V1 } from "@paw/progress-advisor";
import {
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  WORK_SEGMENT_POLICY_VERSION_V1,
} from "@paw/protocol";

import {
  type CreatePawNextProductManifestInputV2,
  type PawNextProductManifestV2,
  createPawNextProductManifestV2,
} from "./product-manifest-v2.js";
import {
  hashCanonicalJsonV1,
  toFrozenJsonValueV1,
} from "./product-manifest.js";

export const PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V3 =
  "paw.product-manifest.v3" as const;
export const PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V3 =
  "paw.product-composition.v3.19" as const;

export const PAW_NEXT_MODEL_OUTPUT_RECOVERY_IDENTITY_V1 =
  DEFAULT_MODEL_OUTPUT_RECOVERY_POLICY_V1;

export const PAW_NEXT_CONTEXT_COMPACTION_IDENTITY_V1 = Object.freeze({
  plannerPolicyVersion: CONTEXT_COMPACTION_POLICY_VERSION_V1,
  lifecyclePolicyVersion: CONTEXT_COMPACTION_LIFECYCLE_POLICY_VERSION_V1,
  orchestrationPolicyVersion:
    CONTEXT_COMPACTION_ORCHESTRATION_POLICY_VERSION_V1,
  evidencePolicyVersion: CHECKPOINT_EVIDENCE_POLICY_VERSION_V1,
  distillerPolicyVersion: CHECKPOINT_DISTILLER_POLICY_VERSION_V1,
  semanticVerifierPolicyVersion: CHECKPOINT_SEMANTIC_VERIFIER_POLICY_VERSION_V1,
});

export const PAW_NEXT_COMPLETION_REVIEW_IDENTITY_V1 = Object.freeze({
  journalPolicyVersion: COMPLETION_REVIEW_POLICY_VERSION_V1,
  triggerPolicyVersion: COMPLETION_REVIEW_TRIGGER_POLICY_VERSION_V1,
  evidencePacketPolicyVersion:
    COMPLETION_REVIEW_EVIDENCE_PACKET_POLICY_VERSION_V1,
  gatePolicyVersion: COMPLETION_REVIEW_GATE_POLICY_VERSION_V1,
  reviewerPolicyVersion: COMPLETION_REVIEWER_POLICY_VERSION_V1,
  continuationPolicyVersion: COMPLETION_REVIEW_CONTINUATION_POLICY_VERSION_V2,
  maxBlocksPerRun: 2,
});

export const PAW_NEXT_PROGRESS_ADVISOR_IDENTITY_V1 = Object.freeze({
  policyVersion: PROGRESS_ADVISOR_POLICY_VERSION_V1,
  mode: "journal_timeline_anchored_advice_only" as const,
});

export const PAW_NEXT_COLLABORATION_IDENTITY_V1 = Object.freeze({
  policyVersion: COLLABORATION_POLICY_VERSION_V1,
  coordinatorPolicyVersion: COLLABORATION_COORDINATOR_POLICY_VERSION_V1,
  delegationSchemaVersion: COLLABORATION_DELEGATION_SCHEMA_VERSION_V1,
  rosterVersion: COLLABORATION_ROSTER_VERSION_V1,
  childRuntimePolicyVersion: AGENT_SPEC_CHILD_RUNTIME_POLICY_VERSION_V1,
  mode: "adaptive_durable_paw_next_v3_orchestration" as const,
  dispatchInterface: "explicit_agent_delegate" as const,
  missionScheduling: "dependency_graph_single_downgrade" as const,
  childPolicy: "agent_effect_profile_enforced" as const,
  childJournal: "independent_file_session" as const,
  rosterSource: "defaults_plus_workspace_agent_registry" as const,
  writeConflictPolicy:
    "mission_mutator_serialization_plus_v3_global_lock" as const,
  maxConcurrentChildren: 3,
  maxChildDepth: 1,
});

type PawNextProductManifestCommonV2 = Omit<
  PawNextProductManifestV2,
  "schemaVersion" | "compositionVersion" | "reducerVersion" | "runConfig"
>;

/** Additive file-payload product identity for replayable work segments. */
export interface PawNextProductManifestV3
  extends PawNextProductManifestCommonV2 {
  readonly schemaVersion: typeof PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V3;
  readonly compositionVersion: typeof PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V3;
  readonly reducerVersion: typeof INTERACTIVE_CONTROL_REDUCER_VERSION_V2;
  readonly workSegmentPolicyVersion: typeof WORK_SEGMENT_POLICY_VERSION_V1;
  readonly runConfig: InteractiveControlConfigV2;
  readonly contextCompaction: typeof PAW_NEXT_CONTEXT_COMPACTION_IDENTITY_V1;
  readonly completionReview: typeof PAW_NEXT_COMPLETION_REVIEW_IDENTITY_V1;
  readonly progressAdvisor: typeof PAW_NEXT_PROGRESS_ADVISOR_IDENTITY_V1;
  readonly collaboration: typeof PAW_NEXT_COLLABORATION_IDENTITY_V1;
  readonly modelOutputRecovery: typeof PAW_NEXT_MODEL_OUTPUT_RECOVERY_IDENTITY_V1;
  readonly memory?: PawNextMemoryPluginIdentityV1;
}

export interface CreatePawNextProductManifestInputV3
  extends Omit<
    CreatePawNextProductManifestInputV2,
    "reducerVersion" | "runConfig"
  > {
  readonly workSegmentPolicyVersion: typeof WORK_SEGMENT_POLICY_VERSION_V1;
  readonly runConfig: InteractiveControlConfigV2;
  readonly memory?: PawNextMemoryPluginProfileV1;
}

export function createPawNextProductManifestV3(
  input: CreatePawNextProductManifestInputV3,
): PawNextProductManifestV3 {
  if (input.workSegmentPolicyVersion !== WORK_SEGMENT_POLICY_VERSION_V1) {
    throw new Error("Unsupported Paw Next work-segment policy version");
  }
  const runConfig = freezeInteractiveControlConfigV2(input.runConfig);
  const v2 = createPawNextProductManifestV2({
    toolEffectCheckpointPolicyVersion: input.toolEffectCheckpointPolicyVersion,
    reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
    runConfig,
    model: input.model,
    providerProtocol: input.providerProtocol,
    transport: input.transport,
    registryHash: input.registryHash,
    shellSandboxHash: input.shellSandboxHash,
    permissionPolicy: input.permissionPolicy,
    approvalMode: input.approvalMode,
    systemPromptHash: input.systemPromptHash,
    contextBudget: input.contextBudget,
    modelRuntimeProfile: input.modelRuntimeProfile,
    modelCapabilities: input.modelCapabilities,
    sessionLeaseHeartbeat: input.sessionLeaseHeartbeat,
    ...(input.profileIdentity === undefined
      ? {}
      : { profileIdentity: input.profileIdentity }),
    ...(input.credentialBindingHash === undefined
      ? {}
      : { credentialBindingHash: input.credentialBindingHash }),
    payloadRuntime: input.payloadRuntime,
  });
  const {
    schemaVersion: _schemaVersion,
    compositionVersion: _compositionVersion,
    reducerVersion: _reducerVersion,
    runConfig: _runConfig,
    ...common
  } = v2;
  return toFrozenJsonValueV1({
    schemaVersion: PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V3,
    compositionVersion: PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V3,
    reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    runConfig,
    contextCompaction: PAW_NEXT_CONTEXT_COMPACTION_IDENTITY_V1,
    completionReview: PAW_NEXT_COMPLETION_REVIEW_IDENTITY_V1,
    progressAdvisor: PAW_NEXT_PROGRESS_ADVISOR_IDENTITY_V1,
    collaboration: PAW_NEXT_COLLABORATION_IDENTITY_V1,
    modelOutputRecovery: PAW_NEXT_MODEL_OUTPUT_RECOVERY_IDENTITY_V1,
    ...(input.memory === undefined
      ? {}
      : { memory: createPawNextMemoryPluginIdentityV1(input.memory) }),
    ...common,
  }) as unknown as PawNextProductManifestV3;
}

export function hashPawNextProductManifestV3(
  manifest: PawNextProductManifestV3,
): string {
  return hashCanonicalJsonV1(manifest);
}

function freezeInteractiveControlConfigV2(
  value: InteractiveControlConfigV2,
): InteractiveControlConfigV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Paw Next V3 interactive control config is invalid");
  }
  const keys = Object.keys(value).sort().join("\0");
  const baseKeys =
    "maxModelTurns\0maxSegments\0maxTotalModelTurns\0mode\0naturalStop";
  const softKeys =
    "maxModelTurns\0maxSegments\0maxTotalModelTurns\0mode\0naturalStop\0renewalModelTurns\0softModelTurns\0softNoProgressTurns";
  if (keys !== baseKeys && keys !== softKeys) {
    throw new Error("Paw Next V3 interactive control config is invalid");
  }
  if (
    value.mode !== "interactive" ||
    !Number.isSafeInteger(value.maxModelTurns) ||
    value.maxModelTurns <= 0 ||
    (value.naturalStop !== "complete" && value.naturalStop !== "await_user") ||
    !Number.isSafeInteger(value.maxSegments) ||
    value.maxSegments <= 0 ||
    !Number.isSafeInteger(value.maxTotalModelTurns) ||
    value.maxTotalModelTurns < value.maxModelTurns ||
    (keys === softKeys &&
      (!Number.isSafeInteger(value.softModelTurns) ||
        (value.softModelTurns as number) <= 0 ||
        (value.softModelTurns as number) >= value.maxModelTurns ||
        !Number.isSafeInteger(value.renewalModelTurns) ||
        (value.renewalModelTurns as number) <= 0 ||
        !Number.isSafeInteger(value.softNoProgressTurns) ||
        (value.softNoProgressTurns as number) <= 0))
  ) {
    throw new Error("Paw Next V3 interactive control config is invalid");
  }
  return Object.freeze({
    mode: "interactive",
    maxModelTurns: value.maxModelTurns,
    naturalStop: value.naturalStop,
    maxSegments: value.maxSegments,
    maxTotalModelTurns: value.maxTotalModelTurns,
    ...(keys === softKeys
      ? {
          softModelTurns: value.softModelTurns as number,
          renewalModelTurns: value.renewalModelTurns as number,
          softNoProgressTurns: value.softNoProgressTurns as number,
        }
      : {}),
  });
}
