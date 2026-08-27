export const COLLABORATION_POLICY_VERSION_V1 =
  "paw.collaboration.v1.8:boundaries:mission-budget:soft-renewal16:n8:c3:m8:d24:s96:t240:g4000:r6000" as const;

export const COLLABORATION_RENEWAL_STEPS_V1 = 16;
export const COLLABORATION_RENEWAL_NO_PROGRESS_TURNS_V1 = 8;

export const COLLABORATION_COORDINATOR_POLICY_VERSION_V1 =
  "paw.collaboration-coordinator.v1:runtime-activity:stable-call-id" as const;

export interface CollaborationPolicyV1 {
  readonly maxConcurrentChildren: number;
  readonly maxMissionTasks: number;
  /** Initial soft window when max_steps is omitted. */
  readonly defaultMaxSteps: number;
  /** Absolute per-child hard cap. */
  readonly maxChildSteps: number;
  /** Sum of reserved child model turns across one delegation plan. */
  readonly maxMissionSteps: number;
  readonly maxGoalChars: number;
  readonly maxSummaryChars: number;
}

export const DEFAULT_COLLABORATION_POLICY_V1: CollaborationPolicyV1 =
  Object.freeze({
    maxConcurrentChildren: 3,
    maxMissionTasks: 8,
    defaultMaxSteps: 24,
    maxChildSteps: 96,
    maxMissionSteps: 240,
    maxGoalChars: 4_000,
    maxSummaryChars: 6_000,
  });

export function freezeCollaborationPolicyV1(
  value: CollaborationPolicyV1,
): CollaborationPolicyV1 {
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new TypeError(`Collaboration policy ${key} must be positive`);
    }
  }
  if (value.defaultMaxSteps > value.maxChildSteps) {
    throw new TypeError(
      "Collaboration defaultMaxSteps cannot exceed maxChildSteps",
    );
  }
  if (value.maxChildSteps > value.maxMissionSteps) {
    throw new TypeError(
      "Collaboration maxChildSteps cannot exceed maxMissionSteps",
    );
  }
  return Object.freeze({ ...value });
}
