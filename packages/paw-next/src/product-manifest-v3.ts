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
  MEMORY_MAINTENANCE_POLICY_VERSION_V1,
  type PawNextMemoryPluginIdentityV1,
  type PawNextMemoryPluginProfileV1,
  createPawNextMemoryPluginIdentityV1,
} from "@paw/memory-plugin";
import { DEFAULT_MODEL_OUTPUT_RECOVERY_POLICY_V1 } from "@paw/model-output-recovery";
import { MODEL_REQUEST_SUPERVISION_V1 } from "@paw/models";
import { PROGRESS_ADVISOR_POLICY_VERSION_V1 } from "@paw/progress-advisor";
import {
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  WORK_SEGMENT_POLICY_VERSION_V1,
} from "@paw/protocol";
import { AUDITED_MEMORY_POLICY_V1 } from "./audited-memory.js";
import { ENVIRONMENT_AUDIT_POLICY_VERSION_V1 } from "./environment-audit.js";
import { LONG_HORIZON_POLICY_V1 } from "./long-horizon.js";
import { STAGE_GRAPH_POLICY_V1 } from "./stage-graph.js";
import { PAW_WORKING_STATE_POLICY_V1 } from "./working-state.js";

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
  "paw.product-composition.v3.27:journal-working-state" as const;

export const PAW_NEXT_MODEL_OUTPUT_RECOVERY_IDENTITY_V1 = Object.freeze({
  ...DEFAULT_MODEL_OUTPUT_RECOVERY_POLICY_V1,
  requestSupervision: MODEL_REQUEST_SUPERVISION_V1,
});

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
  deliveryReview: "tool-free-semantic:512:no-truncation-retry" as const,
});

export const PAW_NEXT_PROGRESS_ADVISOR_IDENTITY_V1 = Object.freeze({
  policyVersion: PROGRESS_ADVISOR_POLICY_VERSION_V1,
  mode: "journal_anchored_advice_with_budgeted_active_fallback" as const,
  workingStatePolicyVersion: PAW_WORKING_STATE_POLICY_V1,
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
  readonly memoryMaintenance: typeof MEMORY_MAINTENANCE_POLICY_VERSION_V1;
  readonly environmentAudit?: typeof ENVIRONMENT_AUDIT_POLICY_VERSION_V1;
  readonly environmentAuditRetry?: "paw.environment-audit-retry.v1";
  readonly environmentAuditSinglePass?: "paw.environment-audit-single-pass.v1";
  readonly environmentAuditEvidenceRepair?: "paw.environment-audit-evidence-repair.v1";
  readonly compactMutationReceipts?: "paw.mutation-receipt.v1";
  readonly auditedMemory?: typeof AUDITED_MEMORY_POLICY_V1;
  readonly stageGraph?: typeof STAGE_GRAPH_POLICY_V1;
  readonly browserAudit?: "paw.browser-audit.v1";
  readonly visualAudit?: "paw.visual-audit.v1";
  readonly longHorizon?: {
    readonly policyVersion: typeof LONG_HORIZON_POLICY_V1;
    readonly role: "manager" | "executor";
  };
  readonly memory?: PawNextMemoryPluginIdentityV1;
}

export interface CreatePawNextProductManifestInputV3
  extends Omit<
    CreatePawNextProductManifestInputV2,
    "reducerVersion" | "runConfig"
  > {
  readonly workSegmentPolicyVersion: typeof WORK_SEGMENT_POLICY_VERSION_V1;
  readonly runConfig: InteractiveControlConfigV2;
  readonly environmentAudit?: true;
  readonly environmentAuditRetry?: true;
  readonly environmentAuditSinglePass?: true;
  readonly environmentAuditEvidenceRepair?: true;
  readonly compactMutationReceipts?: true;
  readonly auditedMemory?: true;
  readonly stageGraph?: true;
  readonly browserAudit?: true;
  readonly visualAudit?: true;
  readonly longHorizon?: "manager" | "executor";
  readonly memory?: PawNextMemoryPluginProfileV1;
}

export function createPawNextProductManifestV3(
  input: CreatePawNextProductManifestInputV3,
): PawNextProductManifestV3 {
  if (input.workSegmentPolicyVersion !== WORK_SEGMENT_POLICY_VERSION_V1) {
    throw new Error("Unsupported Paw Next work-segment policy version");
  }
  if (
    input.compactMutationReceipts !== undefined &&
    input.compactMutationReceipts !== true
  )
    throw new Error("Unsupported mutation receipt policy");
  if (
    input.environmentAuditRetry !== undefined &&
    (input.environmentAuditRetry !== true || input.environmentAudit !== true)
  )
    throw new Error("Audit retry requires environment auditing");
  if (
    input.environmentAuditEvidenceRepair !== undefined &&
    (input.environmentAuditEvidenceRepair !== true ||
      input.environmentAuditSinglePass !== true)
  )
    throw new Error("Audit evidence repair requires single-pass auditing");
  if (
    input.environmentAuditSinglePass !== undefined &&
    (input.environmentAuditSinglePass !== true ||
      input.environmentAudit !== true)
  )
    throw new Error("Single-pass audit requires environment auditing");
  if (input.environmentAudit !== undefined && input.environmentAudit !== true)
    throw new Error("Invalid environment audit policy");
  if (
    input.longHorizon !== undefined &&
    (!["manager", "executor"].includes(input.longHorizon) ||
      input.environmentAudit !== true)
  )
    throw new Error("Invalid long-task policy");
  if (
    input.auditedMemory !== undefined &&
    (input.auditedMemory !== true || input.environmentAudit !== true)
  )
    throw new Error("Invalid audited memory policy");
  if (
    input.stageGraph !== undefined &&
    (input.stageGraph !== true || input.longHorizon !== "manager")
  )
    throw new Error("Stage graph requires long-task Manager mode");
  if (
    input.browserAudit !== undefined &&
    (input.browserAudit !== true || input.environmentAudit !== true)
  )
    throw new Error("Browser audit requires environment auditing");
  if (
    input.visualAudit !== undefined &&
    (input.visualAudit !== true || input.browserAudit !== true)
  )
    throw new Error("Visual audit requires browser auditing");
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
    ...(input.longHorizon
      ? {
          longHorizon: {
            policyVersion: LONG_HORIZON_POLICY_V1,
            role: input.longHorizon,
          },
        }
      : {}),
    runConfig,
    contextCompaction: PAW_NEXT_CONTEXT_COMPACTION_IDENTITY_V1,
    completionReview: PAW_NEXT_COMPLETION_REVIEW_IDENTITY_V1,
    ...(input.environmentAudit
      ? { environmentAudit: ENVIRONMENT_AUDIT_POLICY_VERSION_V1 }
      : {}),
    ...(input.environmentAuditRetry
      ? { environmentAuditRetry: "paw.environment-audit-retry.v1" as const }
      : {}),
    ...(input.environmentAuditSinglePass
      ? {
          environmentAuditSinglePass:
            "paw.environment-audit-single-pass.v1" as const,
        }
      : {}),
    ...(input.environmentAuditEvidenceRepair
      ? {
          environmentAuditEvidenceRepair:
            "paw.environment-audit-evidence-repair.v1" as const,
        }
      : {}),
    ...(input.compactMutationReceipts
      ? { compactMutationReceipts: "paw.mutation-receipt.v1" as const }
      : {}),
    ...(input.auditedMemory ? { auditedMemory: AUDITED_MEMORY_POLICY_V1 } : {}),
    ...(input.stageGraph ? { stageGraph: STAGE_GRAPH_POLICY_V1 } : {}),
    ...(input.visualAudit
      ? { visualAudit: "paw.visual-audit.v1" as const }
      : {}),
    ...(input.browserAudit
      ? { browserAudit: "paw.browser-audit.v1" as const }
      : {}),
    progressAdvisor: PAW_NEXT_PROGRESS_ADVISOR_IDENTITY_V1,
    collaboration: PAW_NEXT_COLLABORATION_IDENTITY_V1,
    modelOutputRecovery: PAW_NEXT_MODEL_OUTPUT_RECOVERY_IDENTITY_V1,
    memoryMaintenance: MEMORY_MAINTENANCE_POLICY_VERSION_V1,
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
  if (value.liveSteering !== undefined && value.liveSteering !== true)
    throw new Error("Paw Next live steering config is invalid");
  if (
    value.recoverReasoningTimeout !== undefined &&
    value.recoverReasoningTimeout !== true
  )
    throw new Error("Paw Next reasoning recovery config is invalid");
  if (
    value.settleFinalToolBatch !== undefined &&
    value.settleFinalToolBatch !== true
  )
    throw new Error("Paw Next final tool batch config is invalid");
  const keys = Object.keys(value)
    .filter(
      (key) =>
        key !== "liveSteering" &&
        key !== "settleFinalToolBatch" &&
        key !== "recoverReasoningTimeout",
    )
    .sort()
    .join("\0");
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
    ...(value.recoverReasoningTimeout
      ? { recoverReasoningTimeout: true as const }
      : {}),
    maxModelTurns: value.maxModelTurns,
    naturalStop: value.naturalStop,
    ...(value.liveSteering === true ? { liveSteering: true as const } : {}),
    ...(value.settleFinalToolBatch === true
      ? { settleFinalToolBatch: true as const }
      : {}),
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
