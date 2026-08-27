import { createHash } from "node:crypto";

import type {
  ToolPermissionCategoryV1,
  ValidatedRuntimeToolCallV1,
} from "../tools/registry.js";

export type PermissionLayerV1 = "hard" | "admin" | "user" | "default";
export type PermissionRuleActionV1 = "allow" | "ask" | "deny";

export interface PermissionRuleV1 {
  readonly id: string;
  readonly layer: PermissionLayerV1;
  readonly tool?: string;
  readonly category?: ToolPermissionCategoryV1;
  readonly action: PermissionRuleActionV1;
}

export interface FrozenPermissionConfigV1 {
  readonly policyVersion: string;
  readonly defaultAction: "ask" | "deny";
  readonly rules: readonly PermissionRuleV1[];
}

export interface ApprovalPromptV1 {
  readonly callId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly category: ToolPermissionCategoryV1;
  readonly policyVersion: string;
}

export type ApprovalResponseV1 =
  | Readonly<{ decision: "allow_once" }>
  | Readonly<{ decision: "allow_rule" }>
  | Readonly<{ decision: "deny"; reason?: string }>;

export type PermissionResolutionV1 = Readonly<{
  resolution: "allow_once" | "allow_rule" | "deny";
  source: "base_policy" | "user_prompt" | "run_rule";
  policyVersion: string;
  ruleId?: string;
  reason?: string;
}>;

export type PermissionApprovalModeV1 = "available" | "unavailable";

interface RunRuleV1 {
  readonly id: string;
  readonly tool: string;
  readonly category: ToolPermissionCategoryV1;
}

/**
 * 每个 run 冻结一份权限配置。硬拒绝和管理员拒绝不可被 run 内授权反转；
 * ask 只是待决状态，没有审批传输层时必须落为 deny。
 */
export class FrozenPermissionEngineV1 {
  readonly policyVersion: string;
  private readonly rules: readonly PermissionRuleV1[];
  private readonly defaultAction: "ask" | "deny";
  private readonly runRules = new Map<string, RunRuleV1>();
  private boundRunId: string | undefined;

  constructor(config: FrozenPermissionConfigV1) {
    if (
      !config ||
      typeof config !== "object" ||
      typeof config.policyVersion !== "string" ||
      !config.policyVersion.trim()
    ) {
      throw new Error("Permission policyVersion must be non-empty");
    }
    if (config.defaultAction !== "ask" && config.defaultAction !== "deny") {
      throw new Error("Permission defaultAction must be ask or deny");
    }
    if (!Array.isArray(config.rules)) {
      throw new Error("Permission rules must be an array");
    }
    const ids = new Set<string>();
    const matchKeys = new Set<string>();
    for (const rule of config.rules) {
      if (!rule || typeof rule !== "object") {
        throw new Error("Permission rule must be an object");
      }
      if (typeof rule.id !== "string" || !rule.id.trim() || ids.has(rule.id)) {
        throw new Error(`Duplicate or empty permission rule id: ${rule.id}`);
      }
      if (
        !(["hard", "admin", "user", "default"] as const).includes(rule.layer)
      ) {
        throw new Error(`Invalid permission rule layer: ${String(rule.layer)}`);
      }
      if (!(["allow", "ask", "deny"] as const).includes(rule.action)) {
        throw new Error(
          `Invalid permission rule action: ${String(rule.action)}`,
        );
      }
      if (
        rule.tool !== undefined &&
        (typeof rule.tool !== "string" || !rule.tool.trim())
      ) {
        throw new Error(`Invalid permission rule tool: ${rule.id}`);
      }
      if (
        rule.category !== undefined &&
        !(["read", "write", "shell"] as const).includes(rule.category)
      ) {
        throw new Error(`Invalid permission rule category: ${rule.id}`);
      }
      if (!rule.tool && !rule.category) {
        throw new Error(`Permission rule ${rule.id} has no match target`);
      }
      if (
        (rule.layer === "hard" || rule.layer === "admin") &&
        rule.action !== "deny"
      ) {
        throw new Error(`${rule.layer} permission rules may only deny`);
      }
      const matchKey = `${rule.layer}\0${rule.tool ?? "*"}\0${rule.category ?? "*"}`;
      if (matchKeys.has(matchKey)) {
        throw new Error(
          `Ambiguous permission rules share one layer and match target: ${rule.id}`,
        );
      }
      ids.add(rule.id);
      matchKeys.add(matchKey);
    }
    this.policyVersion = config.policyVersion;
    this.defaultAction = config.defaultAction;
    this.rules = Object.freeze(
      config.rules.map((rule) => Object.freeze({ ...rule })),
    );
  }

  /** Prevent one run's in-memory allow_rule from leaking into another run. */
  bindRun(runId: string): void {
    if (typeof runId !== "string" || !runId.trim()) {
      throw new Error("Permission engine runId must be non-empty");
    }
    if (this.boundRunId !== undefined && this.boundRunId !== runId) {
      throw new Error("Permission engine is already bound to another run");
    }
    this.boundRunId = runId;
  }

  /**
   * Validate that a durable permission fact could have been emitted by this
   * frozen base policy. This is intentionally pure: run-rule ancestry is
   * checked by the journal history projector before the engine is hydrated.
   */
  assertRecordedResolutionFeasible(
    value: ValidatedRuntimeToolCallV1,
    resolution: PermissionResolutionV1,
    approvalMode: PermissionApprovalModeV1,
  ): void {
    if (approvalMode !== "available" && approvalMode !== "unavailable") {
      throw new TypeError("Permission approval mode is invalid");
    }
    if (resolution.policyVersion !== this.policyVersion) {
      throw new Error("Recorded permission policy version drift");
    }

    const blocking = this.rules.find(
      (rule) =>
        (rule.layer === "hard" || rule.layer === "admin") &&
        rule.action === "deny" &&
        matches(rule, value),
    );
    if (blocking) {
      assertResolutionIdentity(resolution, {
        resolution: "deny",
        source: "base_policy",
        ruleId: blocking.id,
      });
      return;
    }

    if (resolution.source === "run_rule") {
      assertResolutionIdentity(resolution, {
        resolution: "allow_rule",
        source: "run_rule",
        ruleId: resolution.ruleId,
      });
      if (!resolution.ruleId) {
        throw new Error("Recorded run-rule permission has no rule id");
      }
      return;
    }

    const base = firstBaseRule(this.rules, value);
    const action = base?.action ?? this.defaultAction;
    if (action === "allow") {
      assertResolutionIdentity(resolution, {
        resolution: "allow_once",
        source: "base_policy",
        ruleId: base?.id,
      });
      return;
    }
    if (action === "deny" || approvalMode === "unavailable") {
      assertResolutionIdentity(resolution, {
        resolution: "deny",
        source: "base_policy",
        ruleId: base?.id,
      });
      return;
    }

    if (resolution.source !== "user_prompt") {
      throw new Error(
        "Recorded permission did not use the required user prompt",
      );
    }
    if (
      resolution.resolution !== "allow_once" &&
      resolution.resolution !== "allow_rule" &&
      resolution.resolution !== "deny"
    ) {
      throw new Error("Recorded user permission resolution is invalid");
    }
    if (resolution.resolution === "allow_rule") {
      const expectedRuleId = createPermissionRunRuleIdV1({
        policyVersion: this.policyVersion,
        tool: value.internalName,
        category: value.classification.permissionCategory,
      });
      if (resolution.ruleId !== expectedRuleId) {
        throw new Error("Recorded permission run-rule id drift");
      }
    } else if (resolution.ruleId !== undefined) {
      throw new Error("Recorded prompted permission has an unexpected rule id");
    }
  }

  async resolve(
    value: ValidatedRuntimeToolCallV1,
    requestApproval:
      | ((
          prompt: ApprovalPromptV1,
          signal: AbortSignal,
        ) => Promise<ApprovalResponseV1>)
      | undefined,
    signal: AbortSignal,
  ): Promise<PermissionResolutionV1> {
    const blocking = this.rules.find(
      (rule) =>
        (rule.layer === "hard" || rule.layer === "admin") &&
        rule.action === "deny" &&
        matches(rule, value),
    );
    if (blocking) {
      return {
        resolution: "deny",
        source: "base_policy",
        policyVersion: this.policyVersion,
        ruleId: blocking.id,
        reason: `${blocking.layer} permission rule denied the call`,
      };
    }

    const runRule = this.runRules.get(runRuleKey(value));
    if (runRule) {
      return {
        resolution: "allow_rule",
        source: "run_rule",
        policyVersion: this.policyVersion,
        ruleId: runRule.id,
      };
    }

    const base = firstBaseRule(this.rules, value);
    const action = base?.action ?? this.defaultAction;
    if (action === "allow") {
      return {
        resolution: "allow_once",
        source: "base_policy",
        policyVersion: this.policyVersion,
        ...(base ? { ruleId: base.id } : {}),
      };
    }
    if (action === "deny" || !requestApproval) {
      return {
        resolution: "deny",
        source: "base_policy",
        policyVersion: this.policyVersion,
        ...(base ? { ruleId: base.id } : {}),
        reason:
          action === "deny"
            ? "Frozen permission policy denied the call"
            : "Permission requires approval but no approval channel is configured",
      };
    }
    if (signal.aborted) {
      return {
        resolution: "deny",
        source: "user_prompt",
        policyVersion: this.policyVersion,
        reason: "Permission request was cancelled",
      };
    }
    const response = await requestApproval(
      {
        callId: value.call.id,
        tool: value.internalName,
        args: value.args,
        category: value.classification.permissionCategory,
        policyVersion: this.policyVersion,
      },
      signal,
    );
    assertApprovalResponseV1(response);
    if (signal.aborted || response.decision === "deny") {
      return {
        resolution: "deny",
        source: "user_prompt",
        policyVersion: this.policyVersion,
        ...(response.decision === "deny" && response.reason
          ? { reason: response.reason }
          : { reason: "Permission request was cancelled" }),
      };
    }
    if (response.decision === "allow_once") {
      return {
        resolution: "allow_once",
        source: "user_prompt",
        policyVersion: this.policyVersion,
      };
    }
    const ruleId = createPermissionRunRuleIdV1({
      policyVersion: this.policyVersion,
      tool: value.internalName,
      category: value.classification.permissionCategory,
    });
    return {
      resolution: "allow_rule",
      source: "user_prompt",
      policyVersion: this.policyVersion,
      ruleId,
    };
  }

  /** Activate an allow-rule only after its canonical permission fact committed. */
  commitRecordedResolution(
    value: ValidatedRuntimeToolCallV1,
    resolution: PermissionResolutionV1,
  ): void {
    if (
      resolution.resolution !== "allow_rule" ||
      resolution.source !== "user_prompt" ||
      !resolution.ruleId
    ) {
      return;
    }
    this.runRules.set(runRuleKey(value), {
      id: resolution.ruleId,
      tool: value.internalName,
      category: value.classification.permissionCategory,
    });
  }
}

/** Stable identity for one run-scoped user approval grant. */
export function createPermissionRunRuleIdV1(input: {
  readonly policyVersion: string;
  readonly tool: string;
  readonly category: ToolPermissionCategoryV1;
}): string {
  if (!input.policyVersion.trim() || !input.tool.trim()) {
    throw new TypeError("Permission run-rule identity is invalid");
  }
  return createHash("sha256")
    .update(`${input.policyVersion}\0${input.tool}\0${input.category}`)
    .digest("hex");
}

function matches(
  rule: PermissionRuleV1,
  value: ValidatedRuntimeToolCallV1,
): boolean {
  return (
    (rule.tool === undefined || rule.tool === value.internalName) &&
    (rule.category === undefined ||
      rule.category === value.classification.permissionCategory)
  );
}

function firstBaseRule(
  rules: readonly PermissionRuleV1[],
  value: ValidatedRuntimeToolCallV1,
): PermissionRuleV1 | undefined {
  for (const layer of ["user", "default"] as const) {
    const matching = rules.filter(
      (rule) => rule.layer === layer && matches(rule, value),
    );
    const exact = matching.find(
      (rule) =>
        rule.tool === value.internalName &&
        rule.category === value.classification.permissionCategory,
    );
    if (exact) return exact;
    const tool = matching.find(
      (rule) => rule.tool === value.internalName && rule.category === undefined,
    );
    if (tool) return tool;
    const category = matching.find(
      (rule) => rule.tool === undefined && rule.category !== undefined,
    );
    if (category) return category;
  }
  return undefined;
}

function runRuleKey(value: ValidatedRuntimeToolCallV1): string {
  return `${value.internalName}\0${value.classification.permissionCategory}`;
}

function assertApprovalResponseV1(
  value: unknown,
): asserts value is ApprovalResponseV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Approval response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.decision !== "allow_once" &&
    record.decision !== "allow_rule" &&
    record.decision !== "deny"
  ) {
    throw new TypeError("Approval response has an invalid decision");
  }
  if (
    record.decision === "deny" &&
    record.reason !== undefined &&
    typeof record.reason !== "string"
  ) {
    throw new TypeError("Approval denial reason must be a string");
  }
  const allowedKeys =
    record.decision === "deny"
      ? new Set(["decision", "reason"])
      : new Set(["decision"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new TypeError("Approval response contains unknown fields");
  }
}

function assertResolutionIdentity(
  actual: PermissionResolutionV1,
  expected: Readonly<{
    resolution: PermissionResolutionV1["resolution"];
    source: PermissionResolutionV1["source"];
    ruleId?: string;
  }>,
): void {
  if (
    actual.resolution !== expected.resolution ||
    actual.source !== expected.source ||
    actual.ruleId !== expected.ruleId
  ) {
    throw new Error("Recorded permission does not match frozen base policy");
  }
}
