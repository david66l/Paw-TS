import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_COLLABORATION_ROSTER_V1,
  createAdaptiveCollaborationLauncherV1,
  normalizeCollaborationDelegationV1,
} from "@paw/collaboration";
import type { SubAgentLauncher, SubAgentResult } from "@paw/harness";
import type { InputFactV1 } from "@paw/protocol";
import { fingerprintAuditFile } from "../src/paw-next/environment-audit.js";
import {
  createLongHorizonCollaborationPlugin,
  managerStageAdmissionAllowed,
  stageEvidenceIsCurrent,
} from "../src/paw-next/long-horizon.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function root() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-long-unit-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "file.txt"), "before");
  return root;
}
const task = (id: string, depends_on: string[] = []) => ({
  id,
  goal: id,
  kind: "investigation",
  agent_id: "investigator",
  scope: ["file.txt"],
  acceptance: ["Inspect the file content"],
  max_steps: 4,
  depends_on,
});
function verified(root: string): SubAgentResult {
  return {
    status: "completed",
    summary: "checked",
    environmentAudit: {
      status: "verified",
      inspected: [fingerprintAuditFile(root, "file.txt")],
      unmetCriteria: [],
    },
  };
}

test("manager requires an explicit stage contract and freezes a separate tool identity", () => {
  const plugin = createLongHorizonCollaborationPlugin(
    DEFAULT_COLLABORATION_ROSTER_V1,
  );
  const entry = plugin.entries[0];
  if (!entry) throw new Error("missing entry");
  expect(
    entry.validate({
      goal: "inspect",
      kind: "investigation",
      agent_id: "investigator",
    }).ok,
  ).toBe(false);
  expect(
    entry.validate({
      goal: "inspect",
      kind: "investigation",
      tasks: [task("a")],
    }).ok,
  ).toBe(true);
  expect(plugin.pluginVersion).toBe("paw.long-horizon.v1");
});

test("failed attempts consume the durable stage budget; repair feedback does not reset it", () => {
  const facts: InputFactV1[] = Array.from({ length: 12 }, (_, i) => ({
    type: "runtime.activity_started",
    activityId: `stage-${i}`,
    activityKind: "collaboration_child",
    label: "stage",
    startedAt: i,
    metadata: { callId: `call-${i}` },
  }));
  expect(managerStageAdmissionAllowed(facts, "new-call", 1)).toBe(false);
  facts.push({
    type: "input.accepted",
    inputId: "repair",
    callerId: "completion-review",
    delivery: "queue",
    content: "repair",
    contentHash: "repair",
  });
  facts.push({
    type: "input.promoted",
    inputId: "repair",
    delivery: "queue",
    content: "repair",
    contentHash: "repair",
  });
  expect(managerStageAdmissionAllowed(facts, "new-call", 1)).toBe(false);
  facts.push({
    type: "input.promoted",
    inputId: "new-work",
    delivery: "queue",
    content: "new user task",
    contentHash: "new-work",
  });
  expect(managerStageAdmissionAllowed(facts, "new-call", 1)).toBe(true);
});

test("changed evidence blocks a downstream dependency before launching it", async () => {
  const workspace = root();
  const calls: string[] = [];
  const delegate: SubAgentLauncher = {
    async launch(goal) {
      calls.push(goal);
      if (goal.startsWith("b"))
        fs.writeFileSync(path.join(workspace, "file.txt"), "changed");
      return verified(workspace);
    },
    async launchStreaming(input) {
      return this.launch(input.goal);
    },
  };
  const launcher = createAdaptiveCollaborationLauncherV1({
    delegate,
    validateDependencyResult: (result) =>
      stageEvidenceIsCurrent(workspace, result),
  });
  const plan = normalizeCollaborationDelegationV1({
    args: {
      goal: "mission",
      kind: "investigation",
      tasks: [task("a"), task("b", ["a"]), task("c", ["a", "b"])],
    },
  });
  const result = await launcher.launch("mission", 4, {
    agentId: "root-call",
    args: { delegation_plan: plan },
  });
  expect(calls.length).toBe(2);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain("Dependency evidence changed");
});

test("new user input pauses the remaining plan at a stage boundary", async () => {
  const workspace = root();
  let launched = 0;
  const delegate: SubAgentLauncher = {
    async launch() {
      launched++;
      return verified(workspace);
    },
    async launchStreaming() {
      return this.launch("");
    },
  };
  const launcher = createAdaptiveCollaborationLauncherV1({
    delegate,
    validateDependencyResult: (result) =>
      stageEvidenceIsCurrent(workspace, result),
    shouldPause: async () => launched > 0,
  });
  const plan = normalizeCollaborationDelegationV1({
    args: {
      goal: "mission",
      kind: "investigation",
      tasks: [task("a"), task("b", ["a"])],
    },
  });
  const result = await launcher.launch("mission", 4, {
    agentId: "root-call",
    args: { delegation_plan: plan },
  });
  expect(launched).toBe(1);
  expect(result.status).toBe("failed");
  expect(result.summary).toContain(
    "new user input requires Manager replanning",
  );
});

test("replaying an admitted call does not spend another slot and cannot hide earlier prefix-matching calls", () => {
  const observed: InputFactV1 = {
    type: "tool.call_observed",
    modelCallId: "model",
    turn: 1,
    order: 0,
    callId: "call",
    tool: "workspace_delegate",
    args: {},
  };
  const start = (callId: string): InputFactV1 => ({
    type: "runtime.activity_started",
    activityId: callId,
    activityKind: "collaboration_child",
    label: "stage",
    startedAt: 1,
    metadata: { callId },
  });
  const old = Array.from({ length: 11 }, (_, i) => start(`old-${i}`));
  expect(
    managerStageAdmissionAllowed(
      [...old, observed, start("call:a")],
      "call",
      1,
    ),
  ).toBe(true);
  expect(
    managerStageAdmissionAllowed(
      [...old, start("call:a"), observed],
      "call",
      1,
    ),
  ).toBe(false);
});
