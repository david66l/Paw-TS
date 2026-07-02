import { describe, expect, it } from "bun:test";
import { ContextManager } from "@paw/core";
import { CONTEXT_SUMMARY_PREFIX } from "@paw/core";
import { DefaultContextSummarizer } from "../src/orchestrator/context-summarizer.js";
import {
  buildMinimalSharedContext,
  parseAgentType,
  parseChildPolicy,
  parseRunAgentMaxSteps,
} from "../src/orchestrator/agent-args.js";

describe("parseRunAgentMaxSteps", () => {
  it("reads max_steps from args", () => {
    expect(parseRunAgentMaxSteps({ max_steps: 7 })).toBe(7);
    expect(parseRunAgentMaxSteps({ maxSteps: 4 })).toBe(4);
    expect(parseRunAgentMaxSteps({ max_steps: "9" })).toBe(9);
    expect(parseRunAgentMaxSteps({})).toBeUndefined();
  });
});

describe("parseAgentType", () => {
  it("defaults to simple", () => {
    expect(parseAgentType({})).toBe("simple");
    expect(parseAgentType({ agent_type: "coding" })).toBe("coding");
    expect(parseAgentType({ agentType: "research" })).toBe("research");
    expect(parseAgentType({ agent_type: "invalid" })).toBe("simple");
  });
});

describe("parseChildPolicy", () => {
  it("reads child_policy", () => {
    expect(parseChildPolicy({ child_policy: "read_write" })).toBe("read_write");
    expect(parseChildPolicy({ childPolicy: "read_only" })).toBe("read_only");
    expect(parseChildPolicy({})).toBeUndefined();
  });
});

describe("buildMinimalSharedContext", () => {
  it("defaults childPolicy to read_only", () => {
    const ctx = buildMinimalSharedContext("Do something");
    expect(ctx.childPolicy).toBe("read_only");
  });

  it("honors agent_type and child_policy from args", () => {
    const ctx = buildMinimalSharedContext("Fix bug", {
      agent_type: "coding",
      child_policy: "read_write",
    });
    expect(ctx.role).toContain("coding sub-agent");
    expect(ctx.childPolicy).toBe("read_write");
  });
});

describe("DefaultContextSummarizer", () => {
  it("builds per-call context with goal, agent type, and policy", () => {
    const ctx = new ContextManager();
    ctx.addUser("Fix the auth bug in login.ts");
    ctx.addAssistant("## Key Decisions\n- Use JWT instead of sessions");

    const summarizer = new DefaultContextSummarizer();
    const shared = summarizer.summarizeForCall(ctx, {
      type: "tool_call",
      tool: "workspace.run_agent",
      args: {
        goal: "Write unit tests for login.ts",
        agent_type: "coding",
        child_policy: "read_write",
      },
    });

    expect(shared.task).toBe("Write unit tests for login.ts");
    expect(shared.role).toContain("coding sub-agent");
    expect(shared.childPolicy).toBe("read_write");
    expect(shared.facts.some((f) => f.includes("Parent goal"))).toBe(true);
    expect(
      shared.parentConclusions?.some((c) => c.conclusion.includes("JWT")),
    ).toBe(true);
  });

  it("extracts file artifacts from inline XML", () => {
    const ctx = new ContextManager();
    ctx.addUser(
      'Review this:\n<file path="src/auth.ts">\nexport function login() {}\n</file>',
    );

    const shared = new DefaultContextSummarizer().summarize(
      ctx,
      "Refactor auth.ts",
      "coding",
    );

    expect(shared.artifacts.length).toBe(1);
    expect(shared.artifacts[0]?.path).toBe("src/auth.ts");
    expect(shared.artifacts[0]?.content).toContain("export function login");
    expect(shared.artifacts[0]?.relevance).toBe("critical");
  });

  it("filters tool noise from facts", () => {
    const ctx = new ContextManager();
    ctx.addUser("Run the full test suite and report failures");
    ctx.addToolResult("workspace.run_shell", true, "ok");

    const shared = new DefaultContextSummarizer().summarize(
      ctx,
      "Analyze test output",
      "simple",
    );

    expect(shared.facts.some((f) => f.includes("[Tool "))).toBe(false);
    expect(shared.facts.some((f) => f.includes("Parent goal"))).toBe(true);
  });

  it("includes session context summary in facts", () => {
    const ctx = new ContextManager();
    ctx.addUser(`${CONTEXT_SUMMARY_PREFIX}\nPrior work: migrated DB schema`);

    const shared = new DefaultContextSummarizer().summarize(
      ctx,
      "Continue migration",
      "relay",
    );

    expect(shared.facts.some((f) => f.includes("Session summary"))).toBe(true);
    expect(shared.role).toContain("relay sub-agent");
  });

  it("produces distinct contexts for parallel calls", () => {
    const ctx = new ContextManager();
    ctx.addUser("Parent task: ship feature X");

    const summarizer = new DefaultContextSummarizer();
    const a = summarizer.summarizeForCall(ctx, {
      type: "tool_call",
      tool: "workspace.run_agent",
      args: { goal: "Task A", agent_type: "research" },
    });
    const b = summarizer.summarizeForCall(ctx, {
      type: "tool_call",
      tool: "workspace.run_agent",
      args: { goal: "Task B", agent_type: "coding" },
    });

    expect(a.task).toBe("Task A");
    expect(b.task).toBe("Task B");
    expect(a.role).not.toBe(b.role);
  });
});
