import { describe, expect, test } from "bun:test";

import {
  convergenceEvidenceKey,
  convergenceGuidance,
  convergenceToolBlockReason,
  convergenceWindow,
  implementationGuidance,
} from "../src/lifecycle/convergence.js";
import type { TaskState } from "../src/task-state.js";

function state(overrides: Partial<TaskState> = {}): TaskState {
  return {
    goal: "fix bug",
    constraints: [],
    plan: [],
    filesRead: [],
    filesChanged: ["a.py"],
    commandsRun: [],
    testResults: [],
    shellCommandRevision: 0,
    mutationRevision: 1,
    mutationShellCommandRevision: 0,
    diffInspectedRevision: 0,
    fileLockConflicts: [],
    rejectedHypotheses: [],
    pinnedFacts: [],
    knownNonGoals: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe("convergence guidance", () => {
  test("uses a proportional bounded window without changing the budget", () => {
    expect(convergenceWindow(64)).toBe(12);
    expect(convergenceWindow(32)).toBe(7);
    expect(convergenceWindow(10)).toBe(4);
    expect(convergenceGuidance(state(), 13, 64)).toBeNull();
    expect(convergenceGuidance(state(), 12, 64)).toContain(
      "Run the narrowest high-signal",
    );
  });

  test("selects the next closeout action from revision-scoped evidence", () => {
    expect(
      convergenceGuidance(
        state({
          testResults: [
            {
              command: "pytest",
              passed: false,
              summary: "failed",
              mutationRevision: 1,
            },
          ],
        }),
        6,
        32,
      ),
    ).toContain("exact current test failure");
    expect(
      convergenceGuidance(
        state({
          testResults: [
            {
              command: "pytest",
              passed: true,
              summary: "passed",
              mutationRevision: 1,
            },
          ],
        }),
        6,
        32,
      ),
    ).toContain("Inspect the final diff");
    expect(
      convergenceGuidance(
        state({
          diffInspectedRevision: 1,
          testResults: [
            {
              command: "pytest",
              passed: true,
              summary: "passed",
              mutationRevision: 1,
            },
          ],
        }),
        6,
        32,
      ),
    ).toContain("deliver final_answer now");
  });

  test("nudges implementation at mid-run only for mutation goals with evidence", () => {
    const explored = state({
      goal: "Fix the parser bug",
      filesChanged: [],
      filesRead: ["a.ts", "b.ts", "c.ts"],
      mutationRevision: 0,
    });
    expect(implementationGuidance(explored, 31, 64)).toBeNull();
    expect(implementationGuidance(explored, 32, 64)).toContain(
      "without a recorded source change",
    );
    expect(
      implementationGuidance(
        { ...explored, goal: "Explain the parser" },
        40,
        64,
      ),
    ).toBeNull();
  });

  test("keys closeout guidance by material evidence state", () => {
    expect(convergenceEvidenceKey(state())).toBe("r1:missing:stale");
    expect(
      convergenceEvidenceKey(
        state({
          testResults: [
            {
              command: "pytest",
              passed: true,
              summary: "ok",
              mutationRevision: 1,
            },
          ],
        }),
      ),
    ).toBe("r1:passed:stale");
  });

  test("keeps the no-mutation midpoint advisory-only", () => {
    const explored = state({
      goal: "Fix the parser bug",
      filesChanged: [],
      filesRead: ["a.ts", "b.ts", "c.ts"],
      mutationRevision: 0,
    });
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.read_file",
          args: { path: "d.ts" },
        },
        explored,
        32,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        { type: "tool_call", tool: "workspace.edit_file", args: {} },
        explored,
        32,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.acceptance_update",
          args: {
            add: [
              {
                text: "Keep the legacy parser branch",
                source: "repository",
              },
            ],
            updates: [],
            reason: "repository test discovered after investigation",
          },
        },
        explored,
        32,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        { type: "tool_call", tool: "workspace.git_status", args: {} },
        explored,
        32,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.symbol_search",
          args: { query: "Parser" },
        },
        explored,
        32,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: "py -3.10 -m pytest tests/test_parser.py -q" },
        },
        explored,
        32,
        64,
      ),
    ).toBeNull();
  });

  test("allows an edit-anchor recovery read while preserving post-edit verification", () => {
    const recovering = state({
      filesChanged: ["src/target.py"],
      mutationRevision: 1,
      filesRead: ["a.ts", "b.ts", "c.ts"],
      editRecoveryPath: "src/target.py",
    });
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.read_file",
          args: { path: "src/target.py" },
        },
        recovering,
        40,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.read_file",
          args: { path: "src/other.py" },
        },
        recovering,
        40,
        64,
      ),
    ).toContain("verify_current_revision");
  });

  test("allows the unseen source span from the Django 15738 failure trace", () => {
    const explored = state({
      goal: "Fix FK to M2M migration ordering",
      filesChanged: [],
      mutationRevision: 0,
      filesRead: [
        "django/db/migrations/autodetector.py",
        "tests/migrations/test_autodetector.py",
      ],
      fileReadCounts: {
        "django/db/migrations/autodetector.py": 22,
        "tests/migrations/test_autodetector.py": 4,
      },
      commandsRun: Array.from({ length: 6 }, (_, index) => ({
        command: `diagnostic-${index}`,
        ok: index === 0,
        summary: "trace evidence",
      })),
    });
    const unseenRange = {
      type: "tool_call" as const,
      tool: "workspace.read_file",
      args: {
        path: "django/db/migrations/autodetector.py",
        offset: 1189,
        limit: 60,
      },
    };
    expect(
      convergenceToolBlockReason(unseenRange, explored, 49, 96),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.symbol_search",
          args: { query: "generate_altered_fields" },
        },
        explored,
        51,
        96,
      ),
    ).toBeNull();
  });

  test("enforces verify then diff then delivery in the closeout window", () => {
    const read = {
      type: "tool_call" as const,
      tool: "workspace.grep",
      args: { pattern: "more" },
    };
    expect(convergenceToolBlockReason(read, state(), 55, 64)).toContain(
      "verify_current_revision",
    );
    const passed = state({
      testResults: [
        { command: "pytest", passed: true, summary: "ok", mutationRevision: 1 },
      ],
    });
    expect(convergenceToolBlockReason(read, passed, 55, 64)).toContain(
      "inspect_final_diff",
    );
    expect(
      convergenceToolBlockReason(
        { type: "tool_call", tool: "workspace.git_diff", args: {} },
        passed,
        55,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        read,
        { ...passed, diffInspectedRevision: 1 },
        55,
        64,
      ),
    ).toContain("LoopPolicy:deliver");
  });

  test("requires verification immediately after an edit but defers diff gating", () => {
    const read = {
      type: "tool_call" as const,
      tool: "workspace.read_file",
      args: { path: "more.ts" },
    };
    expect(convergenceToolBlockReason(read, state(), 35, 64)).toContain(
      "verify_current_revision",
    );
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: "pytest tests/test_a.py -q" },
        },
        state(),
        35,
        64,
      ),
    ).toBeNull();
    const directCheck = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: { command: "python -c \"print('acceptance')\"" },
    };
    expect(convergenceToolBlockReason(directCheck, state(), 35, 64)).toBeNull();
    expect(
      convergenceToolBlockReason(
        directCheck,
        state({ shellCommandRevision: 2 }),
        37,
        64,
      ),
    ).toContain("verify_current_revision");
    const passed = state({
      testResults: [
        {
          command: "pytest",
          passed: true,
          outcome: "passed",
          summary: "ok",
          mutationRevision: 1,
        },
      ],
    });
    expect(convergenceToolBlockReason(read, passed, 35, 64)).toBeNull();
  });

  test("allows bounded harness recovery without treating it as code failure", () => {
    const shell = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: { command: "python --version" },
    };
    const failed = {
      command: "pytest",
      passed: false,
      outcome: "harness_failed" as const,
      summary: "plugin missing",
      evidence: "Error importing plugin",
      shellCommandRevision: 1,
      mutationRevision: 1,
    };
    expect(
      convergenceToolBlockReason(
        shell,
        state({
          testResults: [failed],
          shellCommandRevision: 1,
          commandsRun: [],
        }),
        36,
        64,
      ),
    ).toBeNull();
    const fourRecoveryCommands = Array.from({ length: 5 }, (_, index) => ({
      command: `probe-${index}`,
      ok: false,
      summary: "failed",
    }));
    expect(
      convergenceToolBlockReason(
        shell,
        state({
          testResults: [failed],
          shellCommandRevision: 5,
          commandsRun: fourRecoveryCommands,
        }),
        40,
        64,
      ),
    ).toContain("recover_verification_harness");
  });

  test("external verifier redirects harness failure to diff then honest delivery", () => {
    const failed = state({
      testResults: [
        {
          command: "pytest",
          passed: false,
          outcome: "harness_failed",
          summary: "plugin missing",
          mutationRevision: 1,
        },
      ],
    });
    const read = {
      type: "tool_call" as const,
      tool: "workspace.read_file",
      args: { path: "more.py" },
    };
    expect(
      convergenceToolBlockReason(read, failed, 40, 64, {
        authority: "external",
      }),
    ).toContain("inspect_external_diff");
    const anotherTest = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: { command: "python tests/runtests.py app.tests" },
    };
    expect(
      convergenceToolBlockReason(anotherTest, failed, 40, 64, {
        authority: "external",
      }),
    ).toContain("inspect_external_diff");
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.edit_file",
          args: { path: "a.py", oldText: "old", newText: "new" },
        },
        failed,
        40,
        64,
        { authority: "external" },
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: "git --no-pager diff -- a.py" },
        },
        failed,
        40,
        64,
        { authority: "external" },
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        read,
        { ...failed, diffInspectedRevision: 1 },
        41,
        64,
        { authority: "external" },
      ),
    ).toContain("deliver_external");
    expect(
      convergenceToolBlockReason(
        anotherTest,
        { ...failed, diffInspectedRevision: 1 },
        41,
        64,
        { authority: "external" },
      ),
    ).toContain("deliver_external");
  });

  test("external verifier allows one materially simpler invocation retry", () => {
    const retryable = {
      command: "node verify-test.js 2>&1 | tail -20",
      passed: false,
      outcome: "harness_failed" as const,
      failureKind: "untrusted_exit_status" as const,
      retryability: "retryable" as const,
      summary: "pipeline exit status does not prove the test passed",
      mutationRevision: 1,
    };
    const failed = state({ testResults: [retryable] });
    const directRetry = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: { command: "node verify-test.js" },
    };
    expect(
      convergenceToolBlockReason(directRetry, failed, 20, 64, {
        authority: "external",
      }),
    ).toBeNull();
    expect(
      convergenceGuidance(failed, 10, 64, { authority: "external" }),
    ).toContain("materially simpler direct command");
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: retryable.command },
        },
        failed,
        20,
        64,
        { authority: "external" },
      ),
    ).toContain("simplify_verification_retry");
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.git_diff",
          args: {},
        },
        failed,
        20,
        64,
        { authority: "external" },
      ),
    ).toContain("retry_verification_directly");

    const exhausted = state({ testResults: [retryable, retryable] });
    expect(
      convergenceToolBlockReason(directRetry, exhausted, 21, 64, {
        authority: "external",
      }),
    ).toContain("inspect_external_diff");
  });

  test("does not accept a pytest diagnostic as the simpler verification retry", () => {
    const failed = state({
      testResults: [
        {
          command: "python -m pytest tests/test_a.py 2>&1 | tail -20",
          passed: false,
          outcome: "harness_failed",
          failureKind: "untrusted_exit_status",
          retryability: "retryable",
          summary: "pipeline exit status does not prove the test passed",
          mutationRevision: 1,
        },
      ],
    });
    const diagnostic = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: { command: "python -m pytest --version" },
    };
    expect(
      convergenceToolBlockReason(diagnostic, failed, 20, 64, {
        authority: "external",
      }),
    ).toContain("retry_verification_directly");

    const directTest = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: {
        command:
          '"C:\\Program Files\\Python310\\python.exe" -m pytest tests/test_a.py -q',
      },
    };
    expect(
      convergenceToolBlockReason(directTest, failed, 20, 64, {
        authority: "external",
      }),
    ).toBeNull();
  });

  test("allows only bounded diagnostics after a code verification failure", () => {
    const shell = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: { command: "python -c \"print('diagnose')\"" },
    };
    const failed = {
      command: "pytest",
      passed: false,
      outcome: "code_failed" as const,
      summary: "assertion failed",
      shellCommandRevision: 4,
      mutationRevision: 1,
    };
    expect(
      convergenceToolBlockReason(
        shell,
        state({ testResults: [failed], shellCommandRevision: 5 }),
        40,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        shell,
        state({ testResults: [failed], shellCommandRevision: 6 }),
        41,
        64,
      ),
    ).toContain("fix_current_failure");
  });
});
