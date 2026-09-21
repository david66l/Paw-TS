/** Version constants for the run journal wire format and its policies. */
/**
 * Paw Next's canonical, append-only run journal protocol.
 *
 * This module contains wire values and strict validation only. It deliberately
 * has no storage, reducer, provider, workspace, or UI dependencies.
 */

export const RUN_JOURNAL_SCHEMA_VERSION_V1 = "paw.run-journal.v1" as const;

export const WORK_SEGMENT_POLICY_VERSION_V1 = "paw.work-segment.v1" as const;

export const MEMORY_RETRIEVAL_POLICY_VERSION_V1 = "paw.memory-retrieval.v1" as const;

export const MEMORY_WRITE_POLICY_VERSION_V1 = "paw.memory-writer.v1" as const;

export const MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1 = "paw.memory-atom-proposal.v1" as const;

export const MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1 =
  "paw.memory-topic-organization.v1" as const;

export const MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1 = "paw.memory-topic-proposal.v1" as const;

export const MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1 =
  "paw.memory-topic-evidence-planner.v1" as const;

export const MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1 =
  "paw.memory-persona-evidence-projector.v1" as const;

export const MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1 = "paw.memory-raw-evidence-resolver.v1" as const;

export const MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1 =
  "paw.memory-evidence-coverage-planner.v1" as const;

export const COMPLETION_REVIEW_POLICY_VERSION_V1 = "paw.completion-review.v1" as const;

export const MODEL_RESPONSE_SCHEMA_VERSION_V1 = "paw.model-response.v1" as const;

export const TOOL_OBSERVATION_SCHEMA_VERSION_V1 = "paw.tool-observation.v1" as const;

export const TASK_CHECKPOINT_SCHEMA_VERSION_V1 = "paw.task-checkpoint.v1" as const;
