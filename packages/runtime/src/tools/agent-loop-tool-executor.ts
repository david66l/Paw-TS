import type { ToolExecutor, ToolSettlement } from "@paw/agent-loop";
import { requiresToolCheckpointV1 } from "@paw/core";
import {
  type HarnessContext,
  type ToolEffectPolicy,
  type ToolExecutionPolicy,
  type ToolExecutionTransactionOutcome,
  type ToolRunResult,
  executeToolTransaction,
} from "@paw/harness";
import type {
  InputFactV1,
  ToolEffectCheckpointAllocatedFactV1,
  ToolPermissionResolvedFactV1,
} from "@paw/protocol";

import type {
  ApprovalPromptV1,
  ApprovalResponseV1,
  FrozenPermissionEngineV1,
  PermissionResolutionV1,
} from "../permissions/engine.js";
import { createToolCheckpointNamespaceIdV1 } from "./checkpoint-namespace.js";
import type {
  FrozenToolRegistryV1,
  RuntimeToolCallV1,
  ValidatedRuntimeToolCallV1,
} from "./registry.js";
import {
  GLOBAL_TOOL_RESOURCE_LOCK_V1,
  type ToolResourceLeaseV1,
  type ToolResourceLockV1,
} from "./resource-lock.js";

export interface PermissionDecisionRecorderV1 {
  /** Permissions and effect-checkpoint allocations commit as one batch. */
  record(facts: readonly ToolAuthorizationRecordedFactV1[]): Promise<void>;
}

export type ToolAuthorizationRecordedFactV1 =
  | ToolPermissionResolvedFactV1
  | ToolEffectCheckpointAllocatedFactV1;

export interface CheckpointSequenceV1 {
  next(): number;
}

/** Run-owned monotonic checkpoint sequence; callers restore its value on resume. */
export class MonotonicCheckpointSequenceV1 implements CheckpointSequenceV1 {
  private current: number;

  constructor(lastAllocated = 0) {
    if (!Number.isSafeInteger(lastAllocated) || lastAllocated < 0) {
      throw new TypeError(
        "lastAllocated checkpoint sequence must be non-negative",
      );
    }
    this.current = lastAllocated;
  }

  next(): number {
    if (this.current === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("checkpoint sequence is exhausted");
    }
    this.current += 1;
    return this.current;
  }
}

/** Recover the last canonical allocation without reading checkpoint storage. */
export function projectCheckpointSequenceHighWaterV1(
  facts: readonly InputFactV1[],
): number {
  let highWater = 0;
  const allocatedCallIds = new Set<string>();
  for (const fact of facts) {
    if (fact.type !== "tool.effect_checkpoint_allocated") continue;
    if (
      !Number.isSafeInteger(fact.checkpointSeq) ||
      fact.checkpointSeq <= highWater ||
      allocatedCallIds.has(fact.callId)
    ) {
      throw new Error(
        "Canonical tool effect checkpoint allocations must be unique per call and have a positive, strictly increasing sequence",
      );
    }
    allocatedCallIds.add(fact.callId);
    highWater = fact.checkpointSeq;
  }
  return highWater;
}

export interface HarnessToolExecutorOptionsV1 {
  readonly sessionId: string;
  readonly runId: string;
  readonly registry: FrozenToolRegistryV1;
  readonly permissions: FrozenPermissionEngineV1;
  readonly permissionRecorder: PermissionDecisionRecorderV1;
  readonly context: Pick<
    HarnessContext,
    | "workspaceRoot"
    | "mcp"
    | "mcpAllowedTools"
    | "watcher"
    | "onShellChunk"
    | "shellSandbox"
    | "managedJobs"
    | "payloadRecall"
    | "taskProgress"
    | "webAccess"
    | "subAgentLauncher"
  >;
  readonly checkpointSequence: CheckpointSequenceV1;
  readonly resourceLock?: ToolResourceLockV1;
  readonly requestApproval?: (
    prompt: ApprovalPromptV1,
    signal: AbortSignal,
  ) => Promise<ApprovalResponseV1>;
  readonly executionPolicy?: ToolExecutionPolicy;
  readonly effectPolicy?: ToolEffectPolicy;
}

interface PreparedCallV1 {
  readonly sourceIndex: number;
  readonly value: ValidatedRuntimeToolCallV1;
  readonly permission: PermissionResolutionV1;
  readonly checkpointSeq?: number;
}

/**
 * Paw Next 的真实工具适配器。它只负责注册表、权限、资源锁、安全事务和
 * 结算映射；不写聊天历史、不发旧 RunEvent，也不判断任务是否完成。
 */
export function createHarnessToolExecutorV1(
  options: HarnessToolExecutorOptionsV1,
): ToolExecutor<RuntimeToolCallV1, ToolSettlement<ToolRunResult>> {
  const runId = options.runId;
  const sessionId = options.sessionId;
  if (!runId.trim()) throw new Error("Runtime tool executor requires runId");
  if (!sessionId.trim())
    throw new Error("Runtime tool executor requires sessionId");
  options.permissions.bindRun(runId);
  const workspaceRoot = options.context.workspaceRoot;
  options.registry.assertCompatibleShellSandbox(options.context.shellSandbox);
  const executionContext: HarnessContext = {
    workspaceRoot,
    ...(options.context.mcp ? { mcp: options.context.mcp } : {}),
    ...(options.context.mcpAllowedTools
      ? { mcpAllowedTools: options.context.mcpAllowedTools }
      : {}),
    ...(options.context.watcher ? { watcher: options.context.watcher } : {}),
    ...(options.context.onShellChunk
      ? { onShellChunk: options.context.onShellChunk }
      : {}),
    ...(options.context.managedJobs
      ? { managedJobs: options.context.managedJobs }
      : {}),
    ...(options.context.payloadRecall
      ? { payloadRecall: options.context.payloadRecall }
      : {}),
    ...(options.context.taskProgress
      ? { taskProgress: options.context.taskProgress }
      : {}),
    ...(options.context.webAccess
      ? { webAccess: options.context.webAccess }
      : {}),
    ...(options.context.subAgentLauncher
      ? { subAgentLauncher: options.context.subAgentLauncher }
      : {}),
    ...(options.registry.shellSandbox
      ? { shellSandbox: options.registry.shellSandbox }
      : {}),
  };
  const executionOptions: HarnessToolExecutorOptionsV1 = {
    ...options,
    sessionId,
    runId,
    context: executionContext,
  };
  const checkpointNamespaceId = createToolCheckpointNamespaceIdV1({
    workspaceRoot,
    sessionId,
    runId,
  });
  const lock = options.resourceLock ?? GLOBAL_TOOL_RESOURCE_LOCK_V1;
  let authorizationTail: Promise<void> = Promise.resolve();

  return {
    async executeSettled(callsInModelOrder, batchOptions) {
      if (batchOptions.signal.aborted) {
        return callsInModelOrder.map((call) =>
          cancelled(call, batchOptions.signal),
        );
      }

      const settlements: Array<ToolSettlement<ToolRunResult> | undefined> =
        callsInModelOrder.map(() => undefined);
      const prepared: PreparedCallV1[] = [];
      const authorizationFacts: ToolAuthorizationRecordedFactV1[] = [];
      const previousAuthorization = authorizationTail;
      let releaseAuthorization!: () => void;
      authorizationTail = new Promise<void>((resolve) => {
        releaseAuthorization = resolve;
      });
      await previousAuthorization;

      try {
        if (batchOptions.signal.aborted) {
          return callsInModelOrder.map((call) =>
            cancelled(call, batchOptions.signal),
          );
        }
        // Resolve names and validate every call before any permission prompt or effect.
        for (const [sourceIndex, call] of callsInModelOrder.entries()) {
          const validation = options.registry.validateAndClassify(
            call,
            workspaceRoot,
          );
          if (!validation.ok) {
            settlements[sourceIndex] = failedWithEvidence(
              call.id,
              "ToolValidationFailed",
              validation.result.summary,
              validation.result,
            );
            continue;
          }
          const stagedRule = prepared.find(
            (item) =>
              item.permission.resolution === "allow_rule" &&
              item.value.internalName === validation.value.internalName &&
              item.value.classification.permissionCategory ===
                validation.value.classification.permissionCategory,
          );
          let permission: PermissionResolutionV1;
          if (stagedRule?.permission.ruleId) {
            permission = {
              resolution: "allow_rule",
              source: "run_rule",
              policyVersion: stagedRule.permission.policyVersion,
              ruleId: stagedRule.permission.ruleId,
            };
          } else {
            try {
              permission = await options.permissions.resolve(
                validation.value,
                options.requestApproval,
                batchOptions.signal,
              );
            } catch (error) {
              permission = {
                resolution: "deny",
                source: "user_prompt",
                policyVersion: options.permissions.policyVersion,
                reason: `Approval channel failed: ${describeError(error).message}`,
              };
            }
          }
          const fact = permissionFact(
            batchOptions.turn,
            sourceIndex,
            validation.value,
            permission,
          );
          authorizationFacts.push(fact);
          let checkpointSeq: number | undefined;
          if (
            permission.resolution !== "deny" &&
            requiresToolCheckpointV1(validation.value.internalName)
          ) {
            try {
              checkpointSeq = options.checkpointSequence.next();
              if (!Number.isSafeInteger(checkpointSeq) || checkpointSeq <= 0) {
                throw new TypeError(
                  "Allocated checkpoint sequence must be a positive safe integer",
                );
              }
            } catch (error) {
              const detail = describeError(error);
              return callsInModelOrder.map(
                (call, index) =>
                  settlements[index] ?? {
                    status: "failed" as const,
                    callId: call.id,
                    error: {
                      name: "CheckpointAllocationFailed",
                      message: detail.message,
                    },
                  },
              );
            }
            authorizationFacts.push({
              type: "tool.effect_checkpoint_allocated",
              callId: validation.value.call.id,
              turn: batchOptions.turn,
              sourceIndex,
              checkpointSeq,
            });
          }
          prepared.push({
            sourceIndex,
            value: validation.value,
            permission,
            ...(checkpointSeq === undefined ? {} : { checkpointSeq }),
          });
        }

        // Authorization and allocation become canonical before any real tool body runs.
        if (authorizationFacts.length > 0) {
          try {
            await options.permissionRecorder.record(authorizationFacts);
          } catch (error) {
            const detail = describeError(error);
            return callsInModelOrder.map(
              (call, sourceIndex) =>
                settlements[sourceIndex] ?? {
                  status: "failed" as const,
                  callId: call.id,
                  error: {
                    name: "PermissionFactCommitFailed",
                    message: detail.message,
                  },
                },
            );
          }
          for (const item of prepared) {
            options.permissions.commitRecordedResolution(
              item.value,
              item.permission,
            );
          }
        }
      } finally {
        releaseAuthorization();
      }

      if (batchOptions.signal.aborted) {
        return callsInModelOrder.map(
          (call, sourceIndex) =>
            settlements[sourceIndex] ?? cancelled(call, batchOptions.signal),
        );
      }

      // All calls may start together, but the shared lock is the sole authority for
      // overlap. Exclusive/unknown calls form a workspace-wide barrier.
      await Promise.all(
        prepared.map(async (item) => {
          if (item.permission.resolution === "deny") {
            settlements[item.sourceIndex] = deniedSettlement(
              item.value,
              item.permission,
            );
            return;
          }
          try {
            settlements[item.sourceIndex] = await executePrepared(
              item.value,
              item.checkpointSeq,
              checkpointNamespaceId,
              executionOptions,
              lock,
              batchOptions.signal,
            );
          } catch (error) {
            const detail = describeError(error);
            settlements[item.sourceIndex] = {
              status: "unknown",
              callId: item.value.call.id,
              reason: `${detail.name}: ${detail.message}`,
              evidence: toolEvidence(false, detail.message, {
                code: "E_TOOL_EXECUTOR_BOUNDARY",
                executed: "unknown",
              }),
            };
          }
        }),
      );

      return callsInModelOrder.map(
        (call, sourceIndex) =>
          settlements[sourceIndex] ?? {
            status: "unknown" as const,
            callId: call.id,
            reason: "Runtime tool executor did not produce a settlement",
          },
      );
    },
  };
}

async function executePrepared(
  value: ValidatedRuntimeToolCallV1,
  checkpointSeq: number | undefined,
  checkpointNamespaceId: string,
  options: HarnessToolExecutorOptionsV1,
  lock: ToolResourceLockV1,
  signal: AbortSignal,
): Promise<ToolSettlement<ToolRunResult>> {
  if (signal.aborted) return cancelled(value.call, signal);
  let lease: ToolResourceLeaseV1;
  try {
    lease = await lock.acquire(value.classification, signal);
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return cancelled(value.call, signal);
    }
    const detail = describeError(error);
    return {
      status: "failed",
      callId: value.call.id,
      error: { name: detail.name, message: detail.message },
    };
  }
  try {
    if (signal.aborted) return cancelled(value.call, signal);
    const outcome = await executeToolTransaction({
      callId: value.call.id,
      runId: options.runId,
      checkpointNamespaceId,
      tool: value.internalName,
      args: value.args,
      context: options.context,
      approval: { approved: true },
      signal,
      ...(checkpointSeq === undefined ? {} : { checkpointSeq }),
      ...(options.executionPolicy
        ? { executionPolicy: options.executionPolicy }
        : {}),
      ...(options.effectPolicy ? { effectPolicy: options.effectPolicy } : {}),
    });
    return mapTransactionOutcome(outcome);
  } finally {
    lease.release();
  }
}

function mapTransactionOutcome(
  outcome: ToolExecutionTransactionOutcome,
): ToolSettlement<ToolRunResult> {
  switch (outcome.status) {
    case "completed": {
      const normalized = normalizeToolRunResult(outcome.result);
      return !normalized.ok
        ? {
            status: "unknown",
            callId: outcome.callId,
            reason: normalized.error,
            evidence: toolEvidence(false, normalized.error, {
              code: "E_TOOL_RESULT_INVALID",
              executed: true,
              normalizationError: normalized.error,
              ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
            }),
          }
        : {
            status: "success",
            callId: outcome.callId,
            result: normalized.result,
          };
    }
    case "denied": {
      const evidence = toolEvidence(false, outcome.message, {
        code: "E_TOOL_DENIED",
        reason: outcome.reason,
        executed: false,
      });
      return {
        status: "denied",
        callId: outcome.callId,
        reason: outcome.message,
        evidence,
      };
    }
    case "rejected": {
      const evidence = toolEvidence(false, outcome.message, {
        code: "E_TOOL_EFFECT_REJECTED",
        reason: outcome.reason,
        executed: true,
        recovered: outcome.recovered,
        originalResult: outcome.originalResult,
        ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
      });
      return failedWithEvidence(
        outcome.callId,
        "ToolEffectRejected",
        outcome.message,
        evidence,
      );
    }
    case "cancelled": {
      const evidence = toolEvidence(false, outcome.reason, {
        code: "E_TOOL_CANCELLED",
        executed: false,
        ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
      });
      return {
        status: "cancelled",
        callId: outcome.callId,
        reason: outcome.reason,
        evidence,
      };
    }
    case "failed": {
      const evidence = toolEvidence(false, outcome.error.message, {
        code: "E_TOOL_INFRASTRUCTURE",
        phase: outcome.phase,
        executed: false,
        ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
      });
      return failedWithEvidence(
        outcome.callId,
        outcome.error.name,
        outcome.error.message,
        evidence,
      );
    }
    case "unknown": {
      const evidence = toolEvidence(false, outcome.error.message, {
        code: "E_TOOL_RESULT_UNKNOWN",
        phase: outcome.phase,
        executed: true,
        ...(outcome.originalResult
          ? { originalResult: outcome.originalResult }
          : {}),
        ...(outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {}),
      });
      return {
        status: "unknown",
        callId: outcome.callId,
        reason: `${outcome.error.name}: ${outcome.error.message}`,
        evidence,
      };
    }
  }
}

function permissionFact(
  turn: number,
  sourceIndex: number,
  value: ValidatedRuntimeToolCallV1,
  resolution: PermissionResolutionV1,
): ToolPermissionResolvedFactV1 {
  return {
    type: "tool.permission_resolved",
    turn,
    sourceIndex,
    callId: value.call.id,
    tool: value.call.name,
    policyVersion: resolution.policyVersion,
    resolution: resolution.resolution,
    source: resolution.source,
    ...(resolution.ruleId ? { ruleId: resolution.ruleId } : {}),
  };
}

function deniedSettlement(
  value: ValidatedRuntimeToolCallV1,
  resolution: PermissionResolutionV1,
): ToolSettlement<ToolRunResult> {
  const reason = resolution.reason ?? "Runtime permission denied the tool call";
  return {
    status: "denied",
    callId: value.call.id,
    reason,
    evidence: toolEvidence(false, reason, {
      code: "E_TOOL_PERMISSION_DENIED",
      executed: false,
      policyVersion: resolution.policyVersion,
      source: resolution.source,
      ...(resolution.ruleId ? { ruleId: resolution.ruleId } : {}),
    }),
  };
}

function cancelled(
  call: Pick<RuntimeToolCallV1, "id">,
  signal: AbortSignal,
): ToolSettlement<ToolRunResult> {
  const reason =
    typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "Tool batch was cancelled";
  return { status: "cancelled", callId: call.id, reason };
}

function failedWithEvidence(
  callId: string,
  name: string,
  message: string,
  evidence: ToolRunResult,
): ToolSettlement<ToolRunResult> {
  return {
    status: "failed",
    callId,
    error: { name, message },
    evidence,
  };
}

function toolEvidence(
  ok: boolean,
  summary: string,
  payload: Readonly<Record<string, unknown>>,
): ToolRunResult {
  return { ok, summary, payload };
}

function normalizeToolRunResult(
  result: ToolRunResult,
):
  | { readonly ok: true; readonly result: ToolRunResult }
  | { readonly ok: false; readonly error: string } {
  if (typeof result.ok !== "boolean" || typeof result.summary !== "string") {
    return { ok: false, error: "Tool result has an invalid envelope" };
  }
  try {
    const payload = normalizeJsonValue(result.payload, "payload", new Set());
    const newMessages =
      result.newMessages === undefined
        ? undefined
        : normalizeJsonValue(result.newMessages, "newMessages", new Set());
    return {
      ok: true,
      result: {
        ok: result.ok,
        summary: result.summary,
        payload,
        ...(newMessages !== undefined
          ? { newMessages: newMessages as ToolRunResult["newMessages"] }
          : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${path} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} is not JSON-serializable`);
  }
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    normalized = value.map((item, index) => {
      if (item === undefined) {
        throw new Error(`${path}[${index}] is not JSON-serializable`);
      }
      return normalizeJsonValue(item, `${path}[${index}]`, seen);
    });
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} contains a non-plain object`);
    }
    const object: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      // JSON.stringify omits undefined object properties. Normalize them away
      // once here so journal/context consumers see one deterministic payload.
      if (item === undefined) continue;
      object[key] = normalizeJsonValue(item, `${path}.${key}`, seen);
    }
    normalized = object;
  }
  seen.delete(value);
  return normalized;
}

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
