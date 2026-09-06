import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_COLLABORATION_ROSTER_V1 } from "@paw/collaboration";
import type { InputFactV1 } from "@paw/protocol";
import { fingerprintAuditFile } from "../src/paw-next/environment-audit.js";
import { createLongHorizonCollaborationPlugin } from "../src/paw-next/long-horizon.js";
import {
  guardStageDependencies,
  projectStageGraph,
  stageRef,
} from "../src/paw-next/stage-graph.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-stage-graph-"));
  roots.push(root);
  const facts: InputFactV1[] = [];
  const context = {
    workspaceRoot: root,
    sessionId: "session",
    runId: "run",
    roster: DEFAULT_COLLABORATION_ROSTER_V1,
    async readFacts() {
      return facts;
    },
  };
  function add(
    callId: string,
    file: string,
    requires: string[] = [],
    replaces?: string,
    settled = true,
  ) {
    fs.writeFileSync(path.join(root, file), "verified");
    const args = {
      goal: `Check ${file}`,
      kind: "investigation",
      agent_id: "investigator",
      scope: [file],
      acceptance: [`${file} is correct`],
      max_steps: 4,
      stage_links: [
        { task_id: "task", requires, ...(replaces ? { replaces } : {}) },
      ],
    };
    facts.push(
      {
        type: "tool.call_observed",
        modelCallId: callId,
        turn: 1,
        callId,
        tool: "workspace_delegate",
        args,
        order: 0,
      },
      {
        type: "tool.dispatch_recorded",
        callId,
        turn: 1,
        sourceIndex: 0,
        batchId: callId,
        mode: "serial",
      },
      {
        type: "runtime.activity_started",
        activityId: callId,
        activityKind: "collaboration_child",
        label: file,
        startedAt: 1,
        metadata: { callId },
      },
    );
    if (settled) {
      const key = createHash("sha256")
        .update(JSON.stringify(["session", "run", callId]))
        .digest("hex")
        .slice(0, 32);
      facts.push({
        type: "runtime.activity_settled",
        activityId: callId,
        status: "completed",
        settledAt: 2,
        summary: "checked",
        result: {
          schemaVersion: "paw.stage-result.v1",
          callId,
          childSessionId: `child-session-${key}`,
          childRunId: `child-run-${key}`,
          audit: {
            status: "verified",
            reviewId: `audit-${callId}`,
            inspected: [{ ...fingerprintAuditFile(root, file) }],
            unmetCriteria: [],
          },
        },
      });
    }
    return stageRef(callId, "task");
  }
  return {
    root,
    facts,
    context,
    add,
    graph: () => projectStageGraph(facts, context),
  };
}
test("file version changes invalidate transitive cross-plan consumers but not unrelated work", () => {
  const f = fixture();
  const a = f.add("a", "a.txt");
  const b = f.add("b", "b.txt", [a]);
  f.add("c", "c.txt", [b]);
  f.add("d", "d.txt");
  expect(f.graph().blockers).toEqual([]);
  fs.writeFileSync(path.join(f.root, "a.txt"), "changed");
  expect(f.graph().nodes.map((n) => n.status)).toEqual([
    "stale",
    "stale",
    "stale",
    "verified",
  ]);
  expect(f.graph().nodes[1]?.reason).toContain(a);
  expect(
    projectStageGraph(JSON.parse(JSON.stringify(f.facts)), f.context),
  ).toEqual(f.graph());
});
test("replacement pins a new version and does not silently revalidate old consumers", () => {
  const f = fixture();
  const a = f.add("a", "a.txt");
  const b = f.add("b", "b.txt", [a]);
  const a2 = f.add("a2", "a.txt", [], a);
  expect(f.graph().nodes.map((n) => n.status)).toEqual([
    "superseded",
    "stale",
    "verified",
  ]);
  f.add("b2", "b.txt", [a2], b);
  expect(f.graph().blockers).toEqual([]);
  expect(f.graph().nodes.map((n) => n.status)).toEqual([
    "superseded",
    "superseded",
    "verified",
    "verified",
  ]);
});
test("replacements cannot discard prerequisite versions, acceptance or introduce supersession cycles", async () => {
  const f = fixture();
  const a = f.add("a", "a.txt");
  const b = f.add("b", "b.txt", [a]);
  f.add("bad", "b.txt", [], b, false);
  let launches = 0;
  const guarded = guardStageDependencies(
    {
      async launch() {
        launches++;
        return { status: "completed", summary: "bad" };
      },
      async launchStreaming() {
        throw new Error("unused");
      },
    },
    f.context,
  );
  expect((await guarded.launch("bad", 4, { agentId: "bad" })).status).toBe(
    "failed",
  );
  expect(launches).toBe(0);
  f.add("cycle", "a.txt", [b], a);
  expect(f.graph().nodes.find((n) => n.callId === "cycle")?.status).toBe(
    "unverified",
  );
  f.add("wrong-scope", "different.txt", [], a);
  expect(f.graph().nodes.find((n) => n.callId === "wrong-scope")?.status).toBe(
    "unverified",
  );
});
test("stage evidence is tied to the dispatched child identity", () => {
  const f = fixture();
  f.add("a", "a.txt");
  const last = f.facts.at(-1);
  if (last?.type !== "runtime.activity_settled") throw new Error("fixture");
  f.facts[f.facts.length - 1] = {
    ...last,
    result: { ...(last.result as object), callId: "forged" },
  };
  expect(f.graph().nodes[0]?.status).toBe("unverified");
});
test("new tool contracts reject malformed graph links without changing the legacy schema", () => {
  const args = {
    goal: "inspect",
    kind: "investigation",
    agent_id: "investigator",
    scope: ["a"],
    acceptance: ["check a"],
  };
  const legacy = createLongHorizonCollaborationPlugin(
    DEFAULT_COLLABORATION_ROSTER_V1,
  ).entries[0];
  const graph = createLongHorizonCollaborationPlugin(
    DEFAULT_COLLABORATION_ROSTER_V1,
    true,
  ).entries[0];
  const links = [{ task_id: "task", requires: [stageRef("a", "task")] }];
  expect(legacy?.validate({ ...args, stage_links: links }).ok).toBeFalse();
  expect(graph?.validate({ ...args, stage_links: links }).ok).toBeTrue();
  expect(
    graph?.validate({
      ...args,
      stage_links: [{ task_id: "ghost", requires: [] }],
    }).ok,
  ).toBeFalse();
});
