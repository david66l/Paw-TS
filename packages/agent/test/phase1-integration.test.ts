/**
 * Phase 1 Orchestrator Integration Tests
 *
 * Validates:
 * 1. State-machine-driven executeTurn (model → parse → action → tool → continue)
 * 2. AgentGroup parallel child-agent launch + batch merge
 * 3. Event stream integrity (tool.call, waiting_children, merging_results, tool.result)
 * 4. AbortSignal cascade (parent → child)
 * 5. childPolicy read_only enforcement at tool layer
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunEventEnvelope } from "@paw/core";
import type { LanguageModel } from "@paw/models";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { DefaultSubAgentLauncher } from "../src/sub-agent-launcher.js";

// ─────────────────────────────────────────────────────────────
// Fake model helpers
// ─────────────────────────────────────────────────────────────

function makeFakeModel(sequence: string[]): LanguageModel {
  let idx = 0;
  return {
    label: "fake",
    capabilities: { contextWindow: 128_000 },
    async complete() {
      const text =
        sequence[idx] ?? '{"action":"final_answer","summary":"done"}';
      idx += 1;
      return { text, finishReason: "stop" };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Test 1: Basic tool execution flow (single list_dir)
// ─────────────────────────────────────────────────────────────

describe("Phase 1: basic tool execution", () => {
  it("executes list_dir and completes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-phase1-"));
    writeFileSync(path.join(dir, "hello.txt"), "world");

    const model = makeFakeModel([
      '{"tool":"workspace.list_dir","args":{"path":"."}}',
      '{"action":"final_answer","summary":"Found hello.txt"}',
    ]);

    const events: RunEventEnvelope[] = [];
    const orch = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
    });
    const result = await orch.run({
      runId: "t1",
      goal: "list files",
      workspaceRoot: dir,
      maxSteps: 4,
    });

    expect(result.status).toBe("completed");
    expect(result.message).toBe("Found hello.txt");

    const toolCalls = events.filter((e) => e.event.type === "tool.call");
    const toolResults = events.filter((e) => e.event.type === "tool.result");
    expect(toolCalls.length).toBe(1);
    expect(toolResults.length).toBe(1);
    expect((toolResults[0]?.event as { ok: boolean }).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Test 2: Sub-agent batch launch + event stream
// ─────────────────────────────────────────────────────────────

describe("Phase 1: sub-agent batch launch", () => {
  it("launches 2 children, emits waiting_children + merging_results + tool.result", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-phase1-sa-"));

    // Parent model: asks to run 2 sub-agents
    const parentModel = makeFakeModel([
      '{"tool":"workspace.run_agent","args":{"goal":"task A"}}\n{"tool":"workspace.run_agent","args":{"goal":"task B"}}',
    ]);

    // Child model: always returns final_answer
    const childModel = makeFakeModel([
      '{"action":"final_answer","summary":"child result"}',
    ]);

    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot: dir,
      model: childModel,
      maxSteps: 3,
    });

    const events: RunEventEnvelope[] = [];
    const orch = new AgentOrchestrator({
      model: parentModel,
      subAgentLauncher: launcher,
      onEvent: (e) => events.push(e),
    });

    const result = await orch.run({
      runId: "t2",
      goal: "delegate to children",
      workspaceRoot: dir,
      maxSteps: 4,
    });

    expect(result.status).toBe("completed");

    // Verify event stream
    const phases = events.filter((e) => e.event.type === "phase");
    const phaseNames = phases.map((e) => (e.event as { name: string }).name);
    expect(phaseNames).toContain("waiting_children");
    expect(phaseNames).toContain("merging_results");

    const toolCalls = events.filter(
      (e) =>
        e.event.type === "tool.call" &&
        (e.event as { tool: string }).tool === "workspace.run_agent",
    );
    const toolResults = events.filter(
      (e) =>
        e.event.type === "tool.result" &&
        (e.event as { tool: string }).tool === "workspace.run_agent",
    );
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);
    expect(toolResults.every((e) => (e.event as { ok: boolean }).ok)).toBe(
      true,
    );
  });

  it("merges child results into parent context as tool results", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-phase1-merge-"));

    const parentModel = makeFakeModel([
      '{"tool":"workspace.run_agent","args":{"goal":"find bugs"}}',
      '{"action":"final_answer","summary":"Parent done"}',
    ]);

    const childModel = makeFakeModel([
      '{"action":"final_answer","summary":"Found 3 bugs"}',
    ]);

    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot: dir,
      model: childModel,
      maxSteps: 3,
    });

    const orch = new AgentOrchestrator({
      model: parentModel,
      subAgentLauncher: launcher,
    });

    const result = await orch.run({
      runId: "t2b",
      goal: "find bugs",
      workspaceRoot: dir,
      maxSteps: 4,
    });

    expect(result.status).toBe("completed");
    expect(result.message).toBe("Parent done");
  });
});

// ─────────────────────────────────────────────────────────────
// Test 3: AbortSignal cascade
// ─────────────────────────────────────────────────────────────

describe("Phase 1: abort signal cascade", () => {
  it("parent abort stops child agents", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-phase1-abort-"));
    const ac = new AbortController();

    // Parent model: asks to run a slow child
    const parentModel = makeFakeModel([
      '{"tool":"workspace.run_agent","args":{"goal":"slow task"}}',
    ]);

    // Child model: takes 2 turns (simulated by sequence)
    let childCalls = 0;
    const childModel: LanguageModel = {
      label: "slow-child",
      capabilities: { contextWindow: 128_000 },
      async complete() {
        childCalls += 1;
        if (childCalls === 1) {
          // First turn: tool call
          ac.abort(); // Abort during child execution
          return {
            text: '{"tool":"workspace.list_dir","args":{"path":"."}}',
            finishReason: "stop",
          };
        }
        return {
          text: '{"action":"final_answer","summary":"child done"}',
          finishReason: "stop",
        };
      },
    };

    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot: dir,
      model: childModel,
      maxSteps: 5,
    });

    const orch = new AgentOrchestrator({
      model: parentModel,
      subAgentLauncher: launcher,
    });

    const result = await orch.run({
      runId: "t3",
      goal: "delegate then abort",
      workspaceRoot: dir,
      maxSteps: 6,
      abortSignal: ac.signal,
    });

    expect(result.status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────
// Test 4: childPolicy read_only enforcement
// ─────────────────────────────────────────────────────────────

describe("Phase 1: childPolicy read_only", () => {
  it("blocks write_file in child agent when childPolicy is read_only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-phase1-ro-"));

    // Child model: tries to write_file
    const childModel = makeFakeModel([
      '{"tool":"workspace.write_file","args":{"path":"test.txt","content":"hello"}}',
      '{"action":"final_answer","summary":"child done"}',
    ]);

    const events: RunEventEnvelope[] = [];

    // We need to inject childPolicy into the sharedContext.
    // The launcher reads it from sharedContext and passes to child orchestrator.
    // But the sharedContext is built inside handleRunAgent via DefaultContextSummarizer.
    // To test enforcement, we can create a child orchestrator directly with childPolicy.
    const childOrch = new AgentOrchestrator({
      model: childModel,
      childPolicy: "read_only",
      onEvent: (e) => events.push(e),
    });

    const childResult = await childOrch.run({
      runId: "child-ro",
      goal: "write test.txt",
      workspaceRoot: dir,
      maxSteps: 4,
    });

    expect(childResult.status).toBe("completed");

    // The write_file should have been blocked and emitted as tool.result with ok=false
    const writeResults = events.filter(
      (e) =>
        e.event.type === "tool.result" &&
        (e.event as { tool: string }).tool === "workspace.write_file",
    );
    expect(writeResults.length).toBe(1);
    expect((writeResults[0]?.event as { ok: boolean }).ok).toBe(false);
    const detail = (writeResults[0]?.event as { detail?: string }).detail;
    expect(detail).toContain("read_only");

    // File should NOT have been written
    const filePath = path.join(dir, "test.txt");
    expect(await Bun.file(filePath).exists()).toBe(false);
  });
});
