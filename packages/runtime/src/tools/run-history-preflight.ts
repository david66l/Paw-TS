import { requiresToolCheckpointV1 } from "@paw/core";
import type {
  InputFactV1,
  ToolCallObservedFactV1,
  ToolPermissionResolvedFactV1,
} from "@paw/protocol";

import {
  type FrozenPermissionEngineV1,
  type PermissionApprovalModeV1,
  createPermissionRunRuleIdV1,
} from "../permissions/engine.js";
import { projectCheckpointSequenceHighWaterV1 } from "./agent-loop-tool-executor.js";
import type {
  FrozenToolRegistryV1,
  ValidatedRuntimeToolCallV1,
} from "./registry.js";

export interface ToolHistoryPreflightInputV1 {
  readonly facts: readonly InputFactV1[];
  readonly registry: FrozenToolRegistryV1;
  readonly workspaceRoot: string;
}

export interface PermissionRunRuleHydrationInputV1
  extends ToolHistoryPreflightInputV1 {
  readonly permissions: FrozenPermissionEngineV1;
  readonly runId: string;
  readonly approvalMode: PermissionApprovalModeV1;
}

export interface CheckpointAllocationCoverageV1 {
  readonly checkpointHighWater: number;
}

interface PermissionEntryV1 {
  readonly fact: ToolPermissionResolvedFactV1;
  readonly value: ValidatedRuntimeToolCallV1;
}

interface ProjectedToolHistoryV1 {
  readonly permissions: readonly PermissionEntryV1[];
  readonly allocations: ReadonlyMap<
    string,
    Extract<InputFactV1, { type: "tool.effect_checkpoint_allocated" }>
  >;
}

/**
 * Rebuild run-scoped allow rules only from canonical permission facts.
 * Validation and classification finish before the supplied engine is mutated.
 */
export function hydratePermissionRunRulesV1(
  input: PermissionRunRuleHydrationInputV1,
): void {
  if (!input.runId.trim()) {
    throw new TypeError("Permission run-rule hydration requires runId");
  }
  const history = projectToolHistoryV1(input);
  const grants = new Map<string, PermissionEntryV1>();
  const origins: PermissionEntryV1[] = [];

  for (const entry of history.permissions) {
    const { fact, value } = entry;
    if (fact.policyVersion !== input.permissions.policyVersion) {
      throw new Error(
        `Permission policy version drift for call ${fact.callId}`,
      );
    }
    input.permissions.assertRecordedResolutionFeasible(
      value,
      {
        resolution: fact.resolution,
        source: fact.source,
        policyVersion: fact.policyVersion,
        ...(fact.ruleId ? { ruleId: fact.ruleId } : {}),
      },
      input.approvalMode,
    );
    if (fact.resolution !== "allow_rule") {
      if (fact.source === "run_rule") {
        throw new Error(`Non-allow run_rule permission: ${fact.callId}`);
      }
      continue;
    }
    if (!fact.ruleId) {
      throw new Error(`Allow-rule permission has no rule id: ${fact.callId}`);
    }
    const key = runRuleKey(value);
    if (fact.source === "user_prompt") {
      const expectedRuleId = createPermissionRunRuleIdV1({
        policyVersion: fact.policyVersion,
        tool: value.internalName,
        category: value.classification.permissionCategory,
      });
      if (fact.ruleId !== expectedRuleId) {
        throw new Error(`Permission run-rule id drift: ${fact.callId}`);
      }
      if (grants.has(key)) {
        throw new Error(`Duplicate permission run-rule grant: ${fact.callId}`);
      }
      grants.set(key, entry);
      origins.push(entry);
      continue;
    }
    if (fact.source !== "run_rule") {
      throw new Error(
        `Permission allow_rule has invalid source: ${fact.callId}`,
      );
    }
    const grant = grants.get(key);
    if (!grant || grant.fact.ruleId !== fact.ruleId) {
      throw new Error(
        `Permission run_rule has no exact earlier grant: ${fact.callId}`,
      );
    }
  }

  // No validation below this point can fail after bindRun succeeds.
  input.permissions.bindRun(input.runId);
  for (const origin of origins) {
    input.permissions.commitRecordedResolution(origin.value, {
      resolution: "allow_rule",
      source: "user_prompt",
      policyVersion: origin.fact.policyVersion,
      ruleId: origin.fact.ruleId,
    });
  }
}

/**
 * Require the allocation shape produced by the real ToolExecutor and recover
 * its high-water mark without inspecting physical checkpoint storage.
 */
export function assertCheckpointAllocationCoverageV1(
  input: ToolHistoryPreflightInputV1,
): CheckpointAllocationCoverageV1 {
  const history = projectToolHistoryV1(input);
  for (const entry of history.permissions) {
    const allocation = history.allocations.get(entry.fact.callId);
    const required =
      entry.fact.resolution !== "deny" &&
      requiresToolCheckpointV1(entry.value.internalName);
    if (required && !allocation) {
      throw new Error(
        `Allowed mutating tool lacks checkpoint allocation: ${entry.fact.callId}`,
      );
    }
    if (!required && allocation) {
      throw new Error(
        `Tool must not have checkpoint allocation: ${entry.fact.callId}`,
      );
    }
  }
  return Object.freeze({
    checkpointHighWater: projectCheckpointSequenceHighWaterV1(input.facts),
  });
}

function projectToolHistoryV1(
  input: ToolHistoryPreflightInputV1,
): ProjectedToolHistoryV1 {
  if (!input.workspaceRoot.trim()) {
    throw new TypeError("Tool history preflight requires workspaceRoot");
  }
  const observed = new Map<string, ToolCallObservedFactV1>();
  const dispatched = new Map<
    string,
    Extract<InputFactV1, { type: "tool.dispatch_recorded" }>
  >();
  const permissionByCall = new Map<string, PermissionEntryV1>();
  const permissions: PermissionEntryV1[] = [];
  const allocations = new Map<
    string,
    Extract<InputFactV1, { type: "tool.effect_checkpoint_allocated" }>
  >();
  const settled = new Set<string>();

  for (const fact of input.facts) {
    switch (fact.type) {
      case "tool.call_observed":
        if (observed.has(fact.callId)) {
          throw new Error(`Duplicate observed tool call: ${fact.callId}`);
        }
        observed.set(fact.callId, fact);
        break;
      case "tool.dispatch_recorded": {
        const call = observed.get(fact.callId);
        if (!call) {
          throw new Error(`Tool dispatch has no observation: ${fact.callId}`);
        }
        if (
          dispatched.has(fact.callId) ||
          settled.has(fact.callId) ||
          call.turn !== fact.turn ||
          call.order !== fact.sourceIndex
        ) {
          throw new Error(`Tool dispatch identity drift: ${fact.callId}`);
        }
        dispatched.set(fact.callId, fact);
        break;
      }
      case "tool.permission_resolved": {
        const call = observed.get(fact.callId);
        if (!call || !dispatched.has(fact.callId)) {
          throw new Error(
            `Tool permission lacks observed dispatch: ${fact.callId}`,
          );
        }
        if (
          permissionByCall.has(fact.callId) ||
          settled.has(fact.callId) ||
          call.turn !== fact.turn ||
          call.order !== fact.sourceIndex ||
          call.tool !== fact.tool
        ) {
          throw new Error(`Tool permission identity drift: ${fact.callId}`);
        }
        assertPermissionShape(fact);
        const classified = input.registry.validateAndClassify(
          {
            id: call.callId,
            name: call.tool,
            arguments: asArgumentRecord(call.args, call.callId),
            argumentsValid: true,
            sourceIndex: call.order,
          },
          input.workspaceRoot,
        );
        if (!classified.ok) {
          throw new Error(
            `Recorded tool permission cannot be revalidated: ${fact.callId}: ${classified.result.summary}`,
          );
        }
        const entry = { fact, value: classified.value };
        permissionByCall.set(fact.callId, entry);
        permissions.push(entry);
        break;
      }
      case "tool.effect_checkpoint_allocated": {
        const call = observed.get(fact.callId);
        const permission = permissionByCall.get(fact.callId);
        if (
          !call ||
          !permission ||
          allocations.has(fact.callId) ||
          settled.has(fact.callId) ||
          call.turn !== fact.turn ||
          call.order !== fact.sourceIndex
        ) {
          throw new Error(
            `Tool checkpoint allocation identity drift: ${fact.callId}`,
          );
        }
        allocations.set(fact.callId, fact);
        break;
      }
      case "tool.settled":
        if (!observed.has(fact.callId) || settled.has(fact.callId)) {
          throw new Error(`Tool settlement identity drift: ${fact.callId}`);
        }
        settled.add(fact.callId);
        break;
      default:
        break;
    }
  }
  return { permissions, allocations };
}

function assertPermissionShape(fact: ToolPermissionResolvedFactV1): void {
  if (!fact.policyVersion.trim()) {
    throw new Error(`Tool permission policy is empty: ${fact.callId}`);
  }
  if (
    fact.resolution !== "allow_once" &&
    fact.resolution !== "allow_rule" &&
    fact.resolution !== "deny"
  ) {
    throw new Error(`Tool permission resolution is invalid: ${fact.callId}`);
  }
  if (
    fact.source !== "base_policy" &&
    fact.source !== "user_prompt" &&
    fact.source !== "run_rule"
  ) {
    throw new Error(`Tool permission source is invalid: ${fact.callId}`);
  }
  if (fact.source === "run_rule" && fact.resolution !== "allow_rule") {
    throw new Error(`run_rule source must allow_rule: ${fact.callId}`);
  }
  if (fact.source === "base_policy" && fact.resolution === "allow_rule") {
    throw new Error(`base policy cannot create run rule: ${fact.callId}`);
  }
}

function asArgumentRecord(
  value: ToolCallObservedFactV1["args"],
  callId: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Observed tool arguments are not an object: ${callId}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function runRuleKey(value: ValidatedRuntimeToolCallV1): string {
  return `${value.internalName}\0${value.classification.permissionCategory}`;
}
