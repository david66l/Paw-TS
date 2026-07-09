/**
 * Ch7 数据模型 —— 核心类型定义
 *
 * 所有持久化实体使用 snake_case（数据库列名），
 * 模块内部使用 camelCase（TS 惯例），DAO 层负责转换。
 */

// ══════════════════════════════════════════════════════════
// 公共枚举
// ══════════════════════════════════════════════════════════

export type MemoryType =
  | "rule"
  | "project_knowledge"
  | "task_summary"
  | "decision"
  | "user_preference"
  | "skill"
  | "failure";

export type MemoryStatus =
  | "active"
  | "suspected_stale"
  | "stale"
  | "conflicted"
  | "superseded"
  | "archived"
  | "deleted";

export type CandidateStatus =
  | "draft"
  | "evaluating"
  | "approved"
  | "rejected"
  | "promoted";

export type GovernanceAction =
  | "APPROVE_CREATE"
  | "APPROVE_UPDATE"
  | "APPROVE_REPLACE"
  | "APPROVE_MERGE"
  | "REJECT"
  | "REQUEST_REVIEW"
  | "DEFER";

export type GovernanceDecisionStatus =
  | "PROPOSED"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTING"
  | "EXECUTED"
  | "STALE"
  | "FAILED"
  | "EXPIRED";

export type TaskSessionStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type VerificationLevel =
  | "CLAIMED"
  | "EXECUTED"
  | "VERIFIED"
  | "USER_CONFIRMED";

export type ContextPlacement = "hot" | "warm" | "cold_pointer" | "excluded";

// ══════════════════════════════════════════════════════════
// 标识符前缀
// ══════════════════════════════════════════════════════════

export const ID_PREFIX = {
  task: "tsk",
  workingMemory: "wm",
  workingMemorySnapshot: "wmsnap",
  memoryItem: "mem",
  memoryCandidate: "cand",
  governanceDecision: "gov",
} as const;

// ══════════════════════════════════════════════════════════
// Scope
// ══════════════════════════════════════════════════════════

export interface ScopeDescriptor {
  lifecycleScope?: "task" | "session" | "persistent";
  organizationId?: string;
  userId?: string;
  workspaceId?: string;
  repositoryId?: string;
  branchPatterns?: string[];
  directoryPath?: string;
  pathPatterns?: string[];
  symbolIds?: string[];
  taskTypes?: string[];
  environment?: "local" | "development" | "test" | "staging" | "production";
  validFrom?: string;
  validUntil?: string;
}

// ══════════════════════════════════════════════════════════
// Actor
// ══════════════════════════════════════════════════════════

export interface ActorRef {
  actorType: "user" | "human_reviewer" | "agent" | "subagent" | "system" | "tool" | "importer";
  actorId: string;
  modelId?: string;
  runtimeVersion?: string;
}

// ══════════════════════════════════════════════════════════
// TaskSession
// ══════════════════════════════════════════════════════════

export interface TaskSession {
  id: string;
  schemaVersion: number;
  organizationId?: string;
  userId?: string;
  workspaceId?: string;
  repositoryId?: string;
  parentTaskId?: string;
  rootTaskId: string;
  title?: string;
  initialUserRequest: string;
  status: TaskSessionStatus;
  branch?: string;
  baseCommit?: string;
  headCommit?: string;
  currentWorkingMemoryId?: string;
  latestCheckpointId?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

// ══════════════════════════════════════════════════════════
// WorkingMemory
// ══════════════════════════════════════════════════════════

export interface WorkingMemory {
  id: string;
  taskId: string;
  revision: number;
  goal: string;
  constraints: WorkingConstraint[];
  plan: PlanStep[];
  todos: TodoItem[];
  completedSteps: CompletedStep[];
  readFiles: FileActivity[];
  modifiedFiles: FileActivity[];
  executedTools: ToolExecutionSummary[];
  diffSummary?: DiffSummary;
  testRunIds: string[];
  currentTestSummary?: TestSummary;
  activeHypotheses: Hypothesis[];
  rejectedHypotheses: Hypothesis[];
  openQuestions: OpenQuestion[];
  nextAction?: NextAction;
  contextPointers: ContextPointer[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkingConstraint {
  id: string;
  text: string;
  source: "current_user_request" | "user_followup" | "active_rule" | "runtime" | "tool_result";
  sourceRefId?: string;
  priority: number;
  scope?: ScopeDescriptor;
  confirmed: boolean;
  temporary: boolean;
  createdAt: string;
}

export interface PlanStep {
  id: string;
  order: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "skipped";
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

export interface CompletedStep {
  id: string;
  planStepId?: string;
  summary: string;
  toolCallIds: string[];
  completedAt: string;
}

export interface FileActivity {
  filePath: string;
  action: "read" | "modified" | "created" | "deleted";
  timestamp: string;
}

export interface ToolExecutionSummary {
  toolCallId: string;
  toolName: string;
  status: "success" | "failure" | "timeout";
  summary: string;
  executedAt: string;
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: { testName: string; message: string }[];
}

export interface Hypothesis {
  id: string;
  statement: string;
  status: "proposed" | "testing" | "supported" | "rejected" | "inconclusive";
  evidenceFor: string[];
  evidenceAgainst: string[];
  relatedFiles: string[];
  relatedSymbols: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OpenQuestion {
  id: string;
  question: string;
  priority: "high" | "medium" | "low";
  createdAt: string;
}

export interface NextAction {
  description: string;
  toolName?: string;
  reason: string;
}

export interface ContextPointer {
  id: string;
  pointerType: "file" | "log" | "history" | "external";
  uri: string;
  description: string;
  createdAt: string;
}

// ══════════════════════════════════════════════════════════
// WorkingMemorySnapshot (用于持久化到 working_memory_snapshots)
// ══════════════════════════════════════════════════════════

export interface WorkingMemorySnapshot {
  id: string;
  taskId: string;
  workingMemoryId: string;
  workingMemoryRevision: number;
  reason: "manual" | "before_compaction" | "after_plan" | "before_risky_action"
    | "after_tool_batch" | "pause" | "recovery" | "task_complete";
  snapshot: WorkingMemory;
  createdBy: ActorRef;
  createdAt: string;
}

// ══════════════════════════════════════════════════════════
// MemoryItem (discriminated union by type)
// ══════════════════════════════════════════════════════════

export interface MemoryItemBase {
  id: string;
  schemaVersion: number;
  type: MemoryType;
  subjectKey: string;
  subjectKeyVersion: number;
  title: string;
  summary: string;
  status: MemoryStatus;
  scope: ScopeDescriptor;
  confidence: number;
  verificationStatus: "unverified" | "partially_verified" | "verified" | "invalidated";
  tags: string[];
  relatedFiles: string[];
  relatedSymbols: string[];
  relatedTestRunIds: string[];
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  version: number;
  createdBy: ActorRef;
  updatedBy: ActorRef;
  createdAt: string;
  updatedAt: string;
}

export interface RuleMemoryItem extends MemoryItemBase {
  type: "rule";
  payload: RulePayload;
}

export interface ProjectKnowledgeMemoryItem extends MemoryItemBase {
  type: "project_knowledge";
  payload: ProjectKnowledgePayload;
}

export interface TaskSummaryMemoryItem extends MemoryItemBase {
  type: "task_summary";
  payload: TaskSummaryPayload;
}

export interface DecisionMemoryItem extends MemoryItemBase {
  type: "decision";
  payload: DecisionPayload;
}

export interface UserPreferenceMemoryItem extends MemoryItemBase {
  type: "user_preference";
  payload: UserPreferencePayload;
}

export interface SkillMemoryItem extends MemoryItemBase {
  type: "skill";
  payload: SkillPayload;
}

export interface FailureMemoryItem extends MemoryItemBase {
  type: "failure";
  payload: FailurePayload;
}

export type MemoryItem =
  | RuleMemoryItem
  | ProjectKnowledgeMemoryItem
  | TaskSummaryMemoryItem
  | DecisionMemoryItem
  | UserPreferenceMemoryItem
  | SkillMemoryItem
  | FailureMemoryItem;

// ══════════════════════════════════════════════════════════
// Typed Payloads
// ══════════════════════════════════════════════════════════

export interface RulePayload {
  statement: string;
  ruleKind: "required" | "prohibited" | "conditional" | "approval_required";
  trigger?: { event: string; condition?: string };
  enforcement: "hard" | "strong" | "advisory";
  violationAction: "block" | "ask_user" | "warn" | "record_only";
  precedence: number;
  rationale?: string;
  relatedSkillId?: string;
}

export interface ProjectKnowledgePayload {
  assertion: string;
  knowledgeKind: "architecture" | "module_responsibility" | "domain_concept"
    | "business_flow" | "technology" | "convention" | "configuration"
    | "repository_structure" | "other";
  stability: "stable" | "evolving" | "version_bound" | "inferred";
  applicability?: string;
  assumptions?: string[];
  limitations?: string[];
}

export interface TaskSummaryPayload {
  taskId: string;
  goal: string;
  outcome: "success" | "partial" | "failed" | "cancelled";
  summary: string;
  modifiedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  toolCallIds: string[];
  testRunIds: string[];
  keyActions: string[];
  decisionMemoryIds: string[];
  unresolvedQuestions: string[];
  unresolvedRisks: string[];
}

export interface DecisionPayload {
  decision: string;
  context: string;
  constraints: string[];
  alternatives: { description: string; pros: string[]; cons: string[] }[];
  rationale: string[];
  consequences: string[];
  risks: string[];
  decisionStatus: "proposed" | "accepted" | "implemented" | "validated" | "superseded" | "reverted" | "deprecated";
  implementedAt?: string;
  validatedAt?: string;
  supersedesDecisionIds?: string[];
  supersededByDecisionId?: string;
}

export interface UserPreferencePayload {
  preferenceKey: string;
  value: unknown;
  origin: "explicit" | "confirmed_inference" | "repeated_inference" | "single_observation";
  strength: "hard" | "default" | "soft" | "inferred";
  appliesTo: "communication" | "coding_style" | "technology" | "testing"
    | "documentation" | "workflow" | "risk_handling" | "other";
  observationCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  confirmedAt?: string;
  overridePolicy: "current_request_wins" | "ask_on_conflict" | "hard_unless_revoked";
}

export interface SkillPayload {
  name: string;
  purpose: string;
  triggers: { event: string; condition?: string }[];
  preconditions: { condition: string }[];
  inputs: { name: string; description: string; required: boolean }[];
  steps: {
    id: string;
    order?: number;
    title: string;
    instruction: string;
    toolName?: string;
    required: boolean;
    approvalRequired: boolean;
    dependsOn: string[];
  }[];
  outputs: { name: string; description: string }[];
  riskLevel: "low" | "medium" | "high" | "critical";
  executionMode: "guidance_only" | "agent_executable" | "approval_required";
  successfulExecutionCount: number;
  failedExecutionCount: number;
  lastExecutedAt?: string;
  implementationVersion: string;
}

export interface FailurePayload {
  errorPattern: string;
  symptoms: string[];
  triggeringConditions: string[];
  rootCause?: string;
  ineffectiveAttempts: { description: string; whyFailed: string }[];
  resolution?: string;
  failureStatus: "hypothesis" | "observed" | "root_cause_confirmed" | "fixed" | "fix_verified" | "recurring" | "invalidated";
  affectedScopeDescription?: string;
  prevention?: string[];
}

// ══════════════════════════════════════════════════════════
// MemoryCandidate
// ══════════════════════════════════════════════════════════

export interface MemoryCandidate {
  id: string;
  schemaVersion: number;
  status: CandidateStatus;
  proposedType: MemoryType;
  proposedSubjectKey?: string;
  subjectKeyVersion: number;
  proposedTitle: string;
  proposedSummary: string;
  proposedPayload: Record<string, unknown>;
  proposedScope: ScopeDescriptor;
  proposedConfidence: number;
  sourceTaskIds: string[];
  sourceRefs: { sourceType: string; sourceId?: string; taskId?: string; uri?: string; capturedAt: string }[];
  evidenceRefs: { evidenceType: string; uri?: string; filePath?: string; strength: string; capturedAt: string }[];
  possibleDuplicateIds: string[];
  possibleConflictIds: string[];
  riskLevel: "low" | "medium" | "high" | "critical";
  reviewRequired: boolean;
  generatedBy: ActorRef;
  generationReason: string;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

// ══════════════════════════════════════════════════════════
// GovernanceDecision
// ══════════════════════════════════════════════════════════

export interface GovernanceDecision {
  id: string;
  schemaVersion: number;
  candidateId: string;
  decision: GovernanceAction;
  reasons: { code: string; description: string }[];
  resultingMemoryId?: string;
  resultingStatus?: MemoryStatus;
  adjustedType?: MemoryType;
  adjustedScope?: ScopeDescriptor;
  adjustedConfidence?: number;
  adjustedPayload?: Record<string, unknown>;
  requiredActions: { actionType: string; description: string }[];
  policyVersion: string;
  decidedBy: ActorRef;
  status: GovernanceDecisionStatus;
  targetMemoryId?: string;
  expectedVersion?: number;
  executedAt?: string;
  decidedAt: string;
  createdAt: string;
}
