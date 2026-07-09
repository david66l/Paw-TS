/**
 * db/modules 聚合导出。
 *
 * 目录按职责拆分（避免单目录文件过多）：
 * - task/      任务会话、Working Memory、工具执行记录
 * - write/     候选写入、治理、正式记忆存储
 * - read/      检索、ContextBuilder
 * - platform/  策略、embedding、id、outbox、索引、观测
 * - security/  安全与审计
 * - evolution/ 自进化、评估、代码索引、管理面
 */

// task
export {
  TaskSessionManager,
  RevisionConflictError,
} from "./task/taskSessionManager.js";
export { WorkingMemoryManager } from "./task/workingMemoryManager.js";
export { executionRecorder } from "./task/executionRecorder.js";
export type {
  ExecutionRecord,
  RecordExecutionInput,
} from "./task/executionRecorder.js";
export { ToolResultProcessor } from "./task/toolResultProcessor.js";
export type {
  RawToolResult,
  ProcessedToolResult,
} from "./task/toolResultProcessor.js";

// write
export { MemoryWriter } from "./write/memoryWriter.js";
export type { WriteInput } from "./write/memoryWriter.js";
export { MemoryGovernance } from "./write/memoryGovernance.js";
export type {
  EvaluateInput,
  EvaluateResult,
} from "./write/memoryGovernance.js";
export { MemoryStore } from "./write/memoryStore.js";
export type { ExecuteResult } from "./write/memoryStore.js";
export { GovernanceExecutor } from "./write/governanceExecutor.js";

// read
export { MemoryRetriever } from "./read/memoryRetriever.js";
export type {
  RetrievalRequest,
  RetrievalResult,
} from "./read/memoryRetriever.js";
export { ContextBuilder } from "./read/contextBuilder.js";
export type {
  ContextItem,
  ContextBuildInput,
  ContextBuildResult,
} from "./read/contextBuilder.js";

// platform
export { outboxManager } from "./platform/outboxManager.js";
export type { OutboxEvent } from "./platform/outboxManager.js";
export { indexManager } from "./platform/indexManager.js";
export { PolicyEngine } from "./platform/policyEngine.js";
export type {
  EffectivePolicy,
  WritePolicy,
  RetrievalPolicy,
  GovernancePolicy,
  ContextPolicy,
  ErrorPolicy,
  PolicySnapshot,
} from "./platform/policyEngine.js";
export {
  NGramEmbeddingService,
  storeEmbedding,
  cosineSimilarity,
} from "./platform/embeddingService.js";
export type { EmbeddingService } from "./platform/embeddingService.js";
export { Observability, obs } from "./platform/observability.js";
export type { LogEntry } from "./platform/observability.js";
export { generateId, isId } from "./platform/idGen.js";

// security
export { securityGuard } from "./security/securityGuard.js";
export type {
  SecurityDecision,
  SecurityFinding,
} from "./security/securityGuard.js";
export { auditRecorder } from "./security/auditRecorder.js";
export type { AuditEvent } from "./security/auditRecorder.js";

// evolution / admin
export { admin } from "./evolution/admin.js";
export { CodeIndexAdapter } from "./evolution/codeIndexAdapter.js";
export type {
  CodeIndexRecord,
  CodeIndexQuery,
  CodeIndexQueryFn,
  CodeContextBlock,
} from "./evolution/codeIndexAdapter.js";
export { CodeConsistencyValidator } from "./evolution/codeConsistencyValidator.js";
export type {
  ConsistencyStatus,
  CodeConsistencyResult,
} from "./evolution/codeConsistencyValidator.js";
export { MemoryEvaluator } from "./evolution/memoryEvaluator.js";
export type { MemoryQualityScore } from "./evolution/memoryEvaluator.js";
export { SelfEvolvingLoop } from "./evolution/selfEvolvingLoop.js";
export type {
  EvolutionCandidate,
  EvolutionBatch,
  EvolutionReport,
} from "./evolution/selfEvolvingLoop.js";
