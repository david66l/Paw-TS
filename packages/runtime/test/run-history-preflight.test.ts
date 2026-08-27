import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { InputFactV1, ToolPermissionResolvedFactV1 } from "@paw/protocol";

import {
  FrozenPermissionEngineV1,
  type FrozenToolRegistryV1,
  type RuntimeToolCallV1,
  assertCheckpointAllocationCoverageV1,
  createFrozenToolRegistryV1,
  createPermissionRunRuleIdV1,
  hydratePermissionRunRulesV1,
} from "../src/index.js";

const POLICY_VERSION = "product-permissions-v1";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("canonical tool history preflight", () => {
  test("hydrates an exact earlier user grant and reuses it without approval", async () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    const ruleId = editRuleId();
    const facts = [
      ...authorizationFacts({
        callId: "edit-1",
        turn: 1,
        tool: "workspace_edit_file",
        args: editArgs("a.txt"),
        permission: permission("user_prompt", "allow_rule", ruleId),
      }),
      {
        type: "work.segment_started" as const,
        segmentIndex: 1,
        inputId: "segment-root",
        reducerVersion: "paw.interactive-control.v2",
        previousDecisionStateHash: "segment-terminal-state",
        previousAction: {
          kind: "complete" as const,
          reasonCode: "interactive-natural-stop",
        },
        policyVersion: "paw.work-segment.v1" as const,
      },
      {
        type: "input.promoted" as const,
        inputId: "segment-root",
        delivery: "queue" as const,
        content: "continue with the next edit",
        contentHash: "segment-root-hash",
      },
      ...authorizationFacts({
        callId: "edit-2",
        turn: 2,
        tool: "workspace_edit_file",
        args: editArgs("b.txt"),
        permission: permission("run_rule", "allow_rule", ruleId),
      }),
    ];
    const permissions = permissionEngine();

    hydratePermissionRunRulesV1({
      facts,
      registry,
      permissions,
      workspaceRoot: root,
      runId: "run-hydrate",
      approvalMode: "available",
    });

    let approvalCalls = 0;
    const resolution = await permissions.resolve(
      validatedCall(
        registry,
        root,
        call("edit-3", "workspace_edit_file", editArgs("c.txt")),
      ),
      async () => {
        approvalCalls += 1;
        return { decision: "deny" };
      },
      new AbortController().signal,
    );
    expect(resolution).toEqual({
      resolution: "allow_rule",
      source: "run_rule",
      policyVersion: POLICY_VERSION,
      ruleId,
    });
    expect(approvalCalls).toBe(0);
  });

  test("rejects orphan, drifting, and misclassified permission history", () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    const ruleId = editRuleId();
    const validOrigin = authorizationFacts({
      callId: "edit-origin",
      turn: 1,
      tool: "workspace_edit_file",
      args: editArgs("a.txt"),
      permission: permission("user_prompt", "allow_rule", ruleId),
    });
    const cases: readonly InputFactV1[][] = [
      authorizationFacts({
        callId: "orphan",
        turn: 1,
        tool: "workspace_edit_file",
        args: editArgs("a.txt"),
        permission: permission("run_rule", "allow_rule", ruleId),
      }),
      authorizationFacts({
        callId: "bad-policy",
        turn: 1,
        tool: "workspace_edit_file",
        args: editArgs("a.txt"),
        permission: {
          ...permission("user_prompt", "allow_rule", ruleId),
          policyVersion: "other-policy",
        },
      }),
      mutatePermission(validOrigin, { tool: "workspace_read_file" }),
      mutatePermission(validOrigin, { sourceIndex: 1 }),
      authorizationFacts({
        callId: "escaped",
        turn: 1,
        tool: "workspace_edit_file",
        args: editArgs("../escape.txt"),
        permission: permission("user_prompt", "allow_rule", ruleId),
      }),
      authorizationFacts({
        callId: "bad-rule-id",
        turn: 1,
        tool: "workspace_edit_file",
        args: editArgs("a.txt"),
        permission: permission("user_prompt", "allow_rule", "wrong-rule"),
      }),
    ];

    for (const facts of cases) {
      expect(() =>
        hydratePermissionRunRulesV1({
          facts,
          registry,
          permissions: permissionEngine(),
          workspaceRoot: root,
          runId: "run-invalid",
          approvalMode: "available",
        }),
      ).toThrow();
    }
  });

  test("late corruption leaves the permission engine completely unhydrated", async () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    const ruleId = editRuleId();
    const facts = [
      ...authorizationFacts({
        callId: "edit-origin",
        turn: 1,
        tool: "workspace_edit_file",
        args: editArgs("a.txt"),
        permission: permission("user_prompt", "allow_rule", ruleId),
      }),
      ...authorizationFacts({
        callId: "edit-corrupt",
        turn: 2,
        tool: "workspace_edit_file",
        args: editArgs("b.txt"),
        permission: permission("run_rule", "allow_rule", "wrong-rule"),
      }),
    ];
    const permissions = permissionEngine();
    expect(() =>
      hydratePermissionRunRulesV1({
        facts,
        registry,
        permissions,
        workspaceRoot: root,
        runId: "run-atomic",
        approvalMode: "available",
      }),
    ).toThrow("exact earlier grant");

    let approvalCalls = 0;
    const resolution = await permissions.resolve(
      validatedCall(
        registry,
        root,
        call("edit-next", "workspace_edit_file", editArgs("c.txt")),
      ),
      async () => {
        approvalCalls += 1;
        return { decision: "allow_once" };
      },
      new AbortController().signal,
    );
    expect(resolution.source).toBe("user_prompt");
    expect(resolution.resolution).toBe("allow_once");
    expect(approvalCalls).toBe(1);
  });

  test("rejects prompted history that the frozen channel or base policy could not emit", async () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    const ruleId = editRuleId();
    const prompted = (resolution: ToolPermissionResolvedFactV1["resolution"]) =>
      authorizationFacts({
        callId: `forged-${resolution}`,
        turn: 1,
        tool: "workspace_edit_file",
        args: editArgs("a.txt"),
        permission: permission(
          "user_prompt",
          resolution,
          resolution === "allow_rule" ? ruleId : undefined,
        ),
      });

    for (const resolution of ["allow_once", "allow_rule", "deny"] as const) {
      expect(() =>
        hydratePermissionRunRulesV1({
          facts: prompted(resolution),
          registry,
          permissions: permissionEngine(),
          workspaceRoot: root,
          runId: `run-unavailable-${resolution}`,
          approvalMode: "unavailable",
        }),
      ).toThrow("frozen base policy");
    }

    const deniedEngine = permissionEngine("deny");
    expect(() =>
      hydratePermissionRunRulesV1({
        facts: prompted("allow_rule"),
        registry,
        permissions: deniedEngine,
        workspaceRoot: root,
        runId: "run-base-deny",
        approvalMode: "available",
      }),
    ).toThrow("frozen base policy");

    const resolution = await deniedEngine.resolve(
      validatedCall(
        registry,
        root,
        call("edit-after-rejection", "workspace_edit_file", editArgs("b.txt")),
      ),
      async () => ({ decision: "allow_rule" }),
      new AbortController().signal,
    );
    expect(resolution.source).toBe("base_policy");
    expect(resolution.resolution).toBe("deny");
  });

  test("accepts only the real executor allocation shape and returns its canonical high-water", () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    fs.mkdirSync(path.join(root, ".paw", "checkpoints", "foreign", "999"), {
      recursive: true,
    });
    expect(
      assertCheckpointAllocationCoverageV1({
        facts: [],
        registry,
        workspaceRoot: root,
      }),
    ).toEqual({ checkpointHighWater: 0 });

    const facts = [
      ...authorizationFacts({
        callId: "read",
        turn: 1,
        tool: "workspace_read_file",
        args: { path: "a.txt" },
        permission: permission("base_policy", "allow_once"),
      }),
      ...authorizationFacts({
        callId: "denied-edit",
        turn: 2,
        tool: "workspace_edit_file",
        args: editArgs("a.txt"),
        permission: permission("user_prompt", "deny"),
      }),
      ...authorizationFacts({
        callId: "allowed-edit",
        turn: 3,
        tool: "workspace_edit_file",
        args: editArgs("b.txt"),
        permission: permission("base_policy", "allow_once"),
      }),
      allocation("allowed-edit", 3, 0, 7),
    ];
    expect(
      assertCheckpointAllocationCoverageV1({
        facts,
        registry,
        workspaceRoot: root,
      }),
    ).toEqual({ checkpointHighWater: 7 });
  });

  test("fails closed for missing or forbidden allocations and damaged sequence identity", () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    const allowedEdit = authorizationFacts({
      callId: "edit",
      turn: 1,
      tool: "workspace_edit_file",
      args: editArgs("a.txt"),
      permission: permission("base_policy", "allow_once"),
    });
    const allowedRead = authorizationFacts({
      callId: "read",
      turn: 1,
      tool: "workspace_read_file",
      args: { path: "a.txt" },
      permission: permission("base_policy", "allow_once"),
    });
    const cases: readonly InputFactV1[][] = [
      allowedEdit,
      [...allowedRead, allocation("read", 1, 0, 1)],
      [
        ...allowedEdit,
        allocation("edit", 1, 0, 1),
        allocation("edit", 1, 0, 2),
      ],
      [...allowedEdit, allocation("edit", 1, 1, 1)],
      [
        allowedRead[0] as InputFactV1,
        settled("read"),
        allowedRead[1] as InputFactV1,
      ],
    ];
    for (const facts of cases) {
      expect(() =>
        assertCheckpointAllocationCoverageV1({
          facts,
          registry,
          workspaceRoot: root,
        }),
      ).toThrow();
    }

    expect(
      assertCheckpointAllocationCoverageV1({
        facts: authorizationFacts({
          callId: "undo",
          turn: 1,
          tool: "workspace_undo_last_edit",
          args: {},
          permission: permission("base_policy", "allow_once"),
        }),
        registry: undoRegistry(registry),
        workspaceRoot: root,
      }),
    ).toEqual({ checkpointHighWater: 0 });
  });
});

function authorizationFacts(input: {
  readonly callId: string;
  readonly turn: number;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly permission: Omit<
    ToolPermissionResolvedFactV1,
    "type" | "callId" | "tool" | "turn" | "sourceIndex"
  >;
}): InputFactV1[] {
  return [
    {
      type: "tool.call_observed",
      callId: input.callId,
      modelCallId: `model-${input.turn}`,
      turn: input.turn,
      tool: input.tool,
      args: input.args as never,
      order: 0,
    },
    {
      type: "tool.dispatch_recorded",
      callId: input.callId,
      turn: input.turn,
      sourceIndex: 0,
      batchId: `batch-${input.turn}`,
      mode: "parallel",
    },
    {
      type: "tool.permission_resolved",
      callId: input.callId,
      turn: input.turn,
      sourceIndex: 0,
      tool: input.tool,
      ...input.permission,
    },
  ];
}

function permission(
  source: ToolPermissionResolvedFactV1["source"],
  resolution: ToolPermissionResolvedFactV1["resolution"],
  ruleId?: string,
) {
  return {
    policyVersion: POLICY_VERSION,
    resolution,
    source,
    ...(ruleId ? { ruleId } : {}),
  };
}

function allocation(
  callId: string,
  turn: number,
  sourceIndex: number,
  checkpointSeq: number,
): InputFactV1 {
  return {
    type: "tool.effect_checkpoint_allocated",
    callId,
    turn,
    sourceIndex,
    checkpointSeq,
  };
}

function settled(callId: string): InputFactV1 {
  return {
    type: "tool.settled",
    callId,
    status: "cancelled",
    errorCode: "CancelledBeforeDispatch",
  };
}

function mutatePermission(
  facts: readonly InputFactV1[],
  patch: Partial<ToolPermissionResolvedFactV1>,
): InputFactV1[] {
  return facts.map((fact) =>
    fact.type === "tool.permission_resolved" ? { ...fact, ...patch } : fact,
  );
}

function permissionEngine(
  defaultAction: "ask" | "deny" = "ask",
): FrozenPermissionEngineV1 {
  return new FrozenPermissionEngineV1({
    policyVersion: POLICY_VERSION,
    defaultAction,
    rules: [],
  });
}

function editRuleId(): string {
  return createPermissionRunRuleIdV1({
    policyVersion: POLICY_VERSION,
    tool: "workspace.edit_file",
    category: "write",
  });
}

function editArgs(filePath: string) {
  return { path: filePath, old_string: "before", new_string: "after" };
}

function call(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): RuntimeToolCallV1 {
  return { id, name, arguments: args, argumentsValid: true };
}

function validatedCall(
  registry: FrozenToolRegistryV1,
  root: string,
  toolCall: RuntimeToolCallV1,
) {
  const result = registry.validateAndClassify(toolCall, root);
  if (!result.ok) throw new Error(result.result.summary);
  return result.value;
}

function undoRegistry(base: FrozenToolRegistryV1): FrozenToolRegistryV1 {
  return {
    ...base,
    validateAndClassify(toolCall) {
      const entry = base.entries[0];
      if (!entry) throw new Error("test registry has no entry");
      return {
        ok: true,
        value: {
          call: toolCall,
          entry,
          internalName: "workspace.undo_last_edit",
          args: toolCall.arguments,
          classification: {
            lockDomain: "test",
            effectClass: "write",
            permissionCategory: "write",
            concurrencyMode: "exclusive",
            resources: [],
          },
        },
      };
    },
  };
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-history-preflight-"));
  roots.push(root);
  return root;
}
