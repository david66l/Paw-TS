import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "@paw/core";

import {
  LOOP_AUTHORITY_SCHEMA_V1,
  resolveLoopAuthorityPolicyV1,
} from "../src/loop-authority.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

describe("LoopAuthorityPolicyV1", () => {
  test("v1 and shadow preserve legacy behavior for controlled ablation", () => {
    expect(resolveLoopAuthorityPolicyV1()).toMatchObject({
      schemaVersion: LOOP_AUTHORITY_SCHEMA_V1,
      kernel: "v1",
      behavior: "legacy_guarded",
      planning: "legacy_completion_veto",
      completion: "completion_policy_only",
    });
    expect(resolveLoopAuthorityPolicyV1("v2-shadow")).toMatchObject({
      kernel: "v2-shadow",
      behavior: "legacy_guarded",
      planning: "legacy_completion_veto",
    });
  });

  test("explicit v2 makes behavior and planning advisory projections", () => {
    const policy = resolveLoopAuthorityPolicyV1("v2");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy).toEqual({
      schemaVersion: LOOP_AUTHORITY_SCHEMA_V1,
      kernel: "v2",
      safety: "trusted_policy_can_deny",
      effects: "executor_settles_observed_result",
      evidence: "host_projects_append_only_facts",
      behavior: "advisory_only",
      planning: "projection_only",
      review: "candidate_bound_semantic_veto",
      completion: "completion_policy_only",
    });
  });

  test("explicit v2 does not let legacy convergence deny a post-edit read", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-authority-v2-"));
    writeFileSync(path.join(workspaceRoot, "source.txt"), "before\n", "utf8");
    const events: RunEventEnvelope[] = [];
    let modelCalls = 0;
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model: {
        label: "loop-authority-v2-fixture",
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
            };
          }
          if (modelCalls === 2) {
            return {
              text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}',
            };
          }
          return {
            text: '{"action":"final_answer","summary":"Implemented and inspected. [skip_verify: authority fixture]"}',
          };
        },
      },
      onEvent: (event) => events.push(event),
    });

    const result = await orchestrator.run({
      runId: "loop-authority-v2",
      goal: "Change source.txt and inspect it.\n[allow_skip_verify]",
      workspaceRoot,
      maxSteps: 5,
    });

    expect(result.status).toBe("completed");
    expect(readFileSync(path.join(workspaceRoot, "source.txt"), "utf8")).toBe(
      "after\n",
    );
    const readResult = events.find(
      (event) =>
        event.event.type === "tool.result" &&
        event.event.tool === "workspace.read_file",
    );
    expect(readResult).toMatchObject({ event: { ok: true } });
    expect(
      events.some(
        (event) =>
          event.event.type === "tool.result" &&
          event.event.summary.includes("LoopPolicy:"),
      ),
    ).toBe(false);
  });

  test("explicit v2 does not let a stale model plan veto certified completion", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-plan-v2-"));
    let modelCalls = 0;
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model: {
        label: "loop-authority-plan-fixture",
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              text: '{"action":"plan_update","reason":"track optional follow-up","new_items":[{"id":"plan-001","task_id":"optional follow-up","status":"pending","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return {
            text: '{"action":"final_answer","summary":"The requested analysis is complete."}',
          };
        },
      },
      onEvent: (event) => events.push(event),
    });

    const result = await orchestrator.run({
      runId: "loop-authority-plan-v2",
      goal: "Explain the current architecture without changing files.",
      workspaceRoot,
      maxSteps: 4,
    });

    expect(modelCalls).toBe(2);
    expect(result).toMatchObject({
      status: "completed",
      completionReason: "final_answer_dialogue",
    });
    expect(
      events.filter((event) => event.event.type === "plan.updated"),
    ).toHaveLength(1);
  });
});
