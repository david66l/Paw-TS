import { describe, expect, test } from "bun:test";
import {
  TaskStateManager,
  acceptanceReadiness,
  formatCompletionReadiness,
  formatTaskStateForContext,
  hasVerificationRetryAvailable,
  isVerificationCommand,
} from "../src/task-state.js";

describe("TaskStateManager", () => {
  test("keeps a durable acceptance ledger with stable ids", () => {
    const state = new TaskStateManager("change route output");
    state.registerAcceptanceCriteria(
      [
        {
          text: "  Keep the legacy three-column output when no host is configured. ",
          source: "repository",
          ref: "tests/test_cli.py::test_simple",
        },
        {
          text: "Use Host as the heading in host-matching mode.",
          source: "repository",
          ref: "tests/test_cli.py::test_host",
        },
      ],
      3,
    );
    state.registerAcceptanceCriteria(
      [
        {
          text: "Keep the legacy three-column output when no host is configured.",
          source: "repository",
        },
      ],
      4,
    );

    expect(state.acceptanceCriteria().map((item) => item.id)).toEqual([
      "acceptance-001",
      "acceptance-002",
    ]);
    expect(state.acceptanceCriteria()[0]?.source).toEqual({
      kind: "repository",
      turn: 3,
      ref: "tests/test_cli.py::test_simple",
    });

    const restored = new TaskStateManager("ignored", state.snapshot());
    restored.registerAcceptanceCriteria(
      [{ text: "Show Subdomain in subdomain mode.", source: "user" }],
      5,
    );
    expect(restored.acceptanceCriteria().at(-1)?.id).toBe("acceptance-003");
    expect(formatTaskStateForContext(restored.snapshot())).toContain(
      "acceptance-001 [pending]",
    );
  });

  test("applies acceptance updates atomically", () => {
    const state = new TaskStateManager("preserve compatibility");
    state.registerAcceptanceCriteria(
      [{ text: "Keep old output", source: "repository" }],
      1,
    );
    const before = state.snapshot();
    const rejected = state.applyAcceptanceUpdate(
      {
        reason: "mixed valid and invalid transaction",
        add: [{ text: "New branch", source: "verification" }],
        updates: [
          {
            id: "acceptance-missing",
            status: "satisfied",
            evidence: "test passed",
          },
        ],
      },
      2,
    );
    expect(rejected.ok).toBe(false);
    expect(state.snapshot()).toEqual(before);

    const accepted = state.applyAcceptanceUpdate(
      {
        reason: "direct test passed",
        add: [],
        updates: [
          {
            id: "acceptance-001",
            status: "satisfied",
            evidence: "tests/test_cli.py passed",
          },
        ],
      },
      2,
    );
    expect(accepted.ok).toBe(true);
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe(
      "satisfied",
    );
  });

  test("makes satisfied acceptance evidence stale after a source mutation", () => {
    const state = new TaskStateManager("change route output");
    state.registerAcceptanceCriteria(
      [
        {
          text: "Existing route formatting remains compatible.",
          source: "repository",
          ref: "tests/test_cli.py",
        },
      ],
      1,
    );
    expect(() =>
      state.setAcceptanceCriterionStatus("acceptance-001", "satisfied"),
    ).toThrow("requires evidence");
    state.setAcceptanceCriterionStatus(
      "acceptance-001",
      "satisfied",
      "tests/test_cli.py passed",
    );
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe(
      "satisfied",
    );

    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/flask/cli.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "src/flask/cli.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe("stale");
    expect(formatTaskStateForContext(state.snapshot())).toContain(
      "acceptance-001 [stale]",
    );
    state.setAcceptanceCriterionStatus(
      "acceptance-001",
      "satisfied",
      "pytest tests/test_cli.py: 57 passed",
    );
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe(
      "satisfied",
    );
  });

  test("restores legacy snapshots with an empty acceptance ledger", () => {
    const current = new TaskStateManager("fix bug").snapshot();
    const { acceptanceCriteria: _removed, ...legacy } = current;
    const restored = new TaskStateManager("ignored", legacy);
    expect(restored.acceptanceCriteria()).toEqual([]);
  });

  test("retains trusted external acceptance without making the model self-certify it", () => {
    const state = new TaskStateManager("fix bug");
    state.registerAcceptanceCriteria(
      [
        {
          text: "FAIL_TO_PASS must pass: tests/test_bug.py::test_fix",
          source: "verification",
          ref: "tests/test_bug.py::test_fix",
          verificationAuthority: "external",
        },
      ],
      0,
    );
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe(
      "external",
    );
    expect(formatTaskStateForContext(state.snapshot())).toContain(
      "acceptance-001 [external]",
    );
    expect(
      state.applyAcceptanceUpdate(
        {
          reason: "self certify",
          add: [],
          updates: [
            {
              id: "acceptance-001",
              status: "satisfied",
              evidence: "I think it passes",
            },
          ],
        },
        1,
      ),
    ).toEqual({
      ok: false,
      error:
        "Criterion acceptance-001 is owned by a trusted external verifier and cannot be resolved by the model.",
    });
  });

  test("does not record control-plane rejections as task failures", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "src/a.ts" },
      },
      {
        ok: false,
        payload: { code: "E_LOOP_POLICY" },
        summary: "[LoopPolicy:implementation_required] edit now",
      },
    );
    expect(state.snapshot().filesRead).toEqual([]);
    expect(state.snapshot().pinnedFacts).toEqual([]);

    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python helper.py" },
      },
      {
        ok: false,
        summary: "effect rejected",
        payload: { code: "E_TOOL_EFFECT_POLICY" },
      },
    );
    expect(state.snapshot().commandsRun).toEqual([]);
    expect(state.snapshot().pinnedFacts).toEqual([]);
  });

  test("records file and test tool facts", () => {
    const state = new TaskStateManager("must keep changes minimal");

    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "src/a.ts" },
      },
      { ok: true, summary: "read_file: src/a.ts", payload: {} },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.ts" },
      },
      {
        ok: true,
        summary: "edit_file: src/a.ts +1/-1",
        payload: {
          path: "src/a.ts",
          linesAdded: 1,
          linesRemoved: 1,
          diagnostics: {
            schemaVersion: "paw.post-edit-diagnostics.v1",
            authority: "syntax_only_not_verification",
            status: "clean",
            issueCount: 0,
            files: [
              {
                path: "src/a.ts",
                engine: "bun_syntax",
                status: "clean",
                issues: [],
              },
            ],
          },
        },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bun test packages/agent/test/task-state.test.ts" },
      },
      { ok: true, summary: "run_shell: exit 0", payload: {} },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bun run bad" },
      },
      { ok: false, summary: "run_shell: exit 1", payload: {} },
    );

    const snapshot = state.snapshot();
    expect(
      snapshot.constraints.some((c) => c.text === "must keep changes minimal"),
    ).toBe(true);
    expect(state.activeConstraints()[0]?.text).toBe(
      "must keep changes minimal",
    );
    expect(snapshot.filesRead).toContain("src/a.ts");
    expect(snapshot.filesChanged).toContain("src/a.ts");
    expect(snapshot.commandsRun).toHaveLength(2);
    expect(snapshot.shellCommandRevision).toBe(2);
    expect(snapshot.mutationShellCommandRevision).toBe(0);
    expect(snapshot.testResults[0]?.passed).toBe(true);
    expect(snapshot.postEditDiagnostics).toMatchObject({
      mutationRevision: 1,
      status: "clean",
      issueCount: 0,
    });
    expect(snapshot.pinnedFacts[0]).toContain("workspace.run_shell failed");

    const restored = new TaskStateManager("ignored", snapshot);
    expect(restored.snapshot().filesChanged).toContain("src/a.ts");
    expect(formatTaskStateForContext(snapshot)).toContain("Files changed");
  });

  test("tracks verification and diff against the exact mutation revision", () => {
    const state = new TaskStateManager("fix bug");
    const edit = () =>
      state.recordToolResult(
        {
          type: "tool_call",
          tool: "workspace.edit_file",
          args: { path: "a.py" },
        },
        {
          ok: true,
          summary: "edited",
          payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
        },
      );
    edit();
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "py -3.10 -m pytest tests/test_a.py -q" },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: { exit_code: 0, stdout: "1 passed in 0.12s" },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "git --no-pager diff -- a.py" },
      },
      { ok: true, summary: "diff", payload: {} },
    );
    expect(formatCompletionReadiness(state.snapshot())).toEqual([
      "Completion readiness:",
      "- Verification: passed for r1",
      "- Final diff: inspected for r1",
    ]);
    expect(state.snapshot().testResults.at(-1)?.evidence).toBe(
      "1 passed in 0.12s",
    );
    edit();
    expect(formatCompletionReadiness(state.snapshot())).toEqual([
      "Completion readiness:",
      "- Verification: stale (verified r1)",
      "- Final diff: stale (inspected r1)",
    ]);
    expect(isVerificationCommand("py -3.10 -m pytest tests -q")).toBe(true);
    expect(
      isVerificationCommand(
        "python -m unittest forms_tests.tests.test_media.FormsMediaTestCase -v",
      ),
    ).toBe(true);
    expect(isVerificationCommand("python3.11 -m unittest discover -v")).toBe(
      true,
    );
    expect(
      isVerificationCommand(
        "python tests/runtests.py expressions.tests.BasicExpressionsTests",
      ),
    ).toBe(true);
    expect(
      isVerificationCommand(
        "set PYTHONPATH=.&&python tests\\runtests.py queries.test_q.QCheckTests",
      ),
    ).toBe(true);
    expect(isVerificationCommand("python manage.py test app.tests")).toBe(true);
    expect(isVerificationCommand("python -m django test app.tests")).toBe(true);
    expect(isVerificationCommand("python scripts/contest.py")).toBe(false);
    expect(isVerificationCommand("pip install pytest")).toBe(false);
  });

  test("records SymPy's native runner and treats missing pytest as harness failure", () => {
    const state = new TaskStateManager("fix SymPy bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "sympy/utilities/iterables.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "sympy/utilities/iterables.py" },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: {
          command: "python -m pytest sympy/utilities/tests/test_iterables.py",
        },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: {
          exit_code: 1,
          stderr: "/opt/python: No module named pytest",
        },
      },
    );
    expect(state.snapshot().testResults.at(-1)?.outcome).toBe("harness_failed");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: {
          command: "python bin/test sympy/utilities/tests/test_iterables.py",
        },
      },
      {
        ok: true,
        summary: "43 passed",
        payload: { exit_code: 0, stdout: "43 passed, 0 failed" },
      },
    );
    expect(state.snapshot().testResults.at(-1)).toMatchObject({
      family: "python-runner",
      outcome: "passed",
      passed: true,
    });
  });

  test("separates verification harness failures from code failures", () => {
    const harness = new TaskStateManager("fix bug");
    harness.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    harness.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "pytest tests/test_a.py -q" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: {
          exit_code: 1,
          stderr:
            "Error importing plugin x: ModuleNotFoundError: No module named 'project' token=secret-value",
        },
      },
    );
    const harnessResult = harness.snapshot().testResults.at(-1);
    expect(harnessResult?.outcome).toBe("harness_failed");
    expect(harnessResult?.failureKind).toBe("missing_dependency");
    expect(harnessResult?.evidence).toContain("Error importing plugin");
    expect(harnessResult?.evidence).not.toContain("secret-value");
    expect(formatCompletionReadiness(harness.snapshot())[1]).toContain(
      "harness failed",
    );

    const code = new TaskStateManager("fix bug");
    code.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    code.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "pytest tests/test_a.py -q" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: { exit_code: 1, stdout: "FAILED test_value - assert 1 == 2" },
      },
    );
    expect(code.snapshot().testResults.at(-1)?.outcome).toBe("code_failed");
  });

  test("records absolute-path pytest evidence but ignores pytest diagnostics", () => {
    const state = new TaskStateManager("fix a Python regression");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "src/a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: {
          command:
            "C:\\Users\\Rain\\AppData\\Local\\Programs\\Python\\Python310\\python.exe -m pytest --version",
        },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: { exit_code: 0, stdout: "pytest 9.0.0" },
      },
    );
    expect(state.snapshot().testResults).toHaveLength(0);

    const command =
      '"C:\\Program Files\\Python310\\python.exe" -m pytest tests/test_a.py -q';
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: { exit_code: 0, stdout: "1 passed in 0.12s" },
      },
    );

    expect(state.snapshot().testResults).toEqual([
      expect.objectContaining({
        command,
        passed: true,
        outcome: "passed",
        mutationRevision: 1,
        evidence: "1 passed in 0.12s",
      }),
    ]);
  });

  test("does not accept a downstream pipeline exit code as test pass evidence", () => {
    const state = new TaskStateManager("fix a masked test failure");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "src/a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    const command = "python -m pytest tests/test_a.py -q | findstr passed";
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: {
          exit_code: 0,
          stdout: "FAILED tests/test_a.py::test_value - assert 1 == 2\npassed",
        },
      },
    );

    expect(state.snapshot().testResults.at(-1)).toMatchObject({
      command,
      passed: false,
      outcome: "harness_failed",
      failureKind: "untrusted_exit_status",
      retryability: "retryable",
      mutationRevision: 1,
      summary:
        "verification ran in shell control flow whose final exit status does not prove the test runner passed",
    });
    expect(hasVerificationRetryAvailable(state.snapshot())).toBe(true);
    expect(formatCompletionReadiness(state.snapshot())).toContain(
      "- Verification: harness failed for r1 (test pass not proven: untrusted_exit_status/retryable)",
    );
  });

  test("classifies repository-runner dependency failures without hiding candidate imports", () => {
    const unavailable = new TaskStateManager("fix Django query validation");
    unavailable.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "django/db/models/sql/query.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: {
          path: "django/db/models/sql/query.py",
          linesAdded: 1,
          linesRemoved: 1,
        },
      },
    );
    unavailable.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: {
          command:
            "set PYTHONPATH=.&&python tests\\runtests.py queries.test_q.QCheckTests",
        },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: {
          exit_code: 1,
          stderr:
            "Traceback (most recent call last): File 'django/__init__.py', line 1, in <module> ModuleNotFoundError: No module named 'asgiref'",
        },
      },
    );
    expect(unavailable.snapshot().testResults.at(-1)).toMatchObject({
      outcome: "harness_failed",
      failureKind: "missing_dependency",
      retryability: "terminal",
      mutationRevision: 1,
    });
    expect(hasVerificationRetryAvailable(unavailable.snapshot())).toBe(false);

    const wrapperFailure = new TaskStateManager("verify a candidate");
    wrapperFailure.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.js" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "src/a.js", linesAdded: 1, linesRemoved: 1 },
      },
    );
    wrapperFailure.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "node verify-test.js | tail -20" },
      },
      {
        ok: false,
        summary: "run_shell: exit 255",
        payload: {
          exit_code: 255,
          stderr:
            "'tail' is not recognized as an internal or external command, operable program or batch file.",
        },
      },
    );
    expect(wrapperFailure.snapshot().testResults.at(-1)).toMatchObject({
      outcome: "harness_failed",
      failureKind: "untrusted_exit_status",
      retryability: "retryable",
    });
    expect(hasVerificationRetryAvailable(wrapperFailure.snapshot())).toBe(true);

    const candidateImport = new TaskStateManager("fix import");
    candidateImport.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "src/a.py", linesAdded: 1, linesRemoved: 0 },
      },
    );
    candidateImport.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "pytest tests/test_a.py -q" },
      },
      {
        ok: false,
        summary: "run_shell: exit 2",
        payload: {
          exit_code: 2,
          stderr:
            "ImportError while importing test module. File 'src/a.py', line 2, in <module> ModuleNotFoundError: No module named 'new_dependency'",
        },
      },
    );
    expect(candidateImport.snapshot().testResults.at(-1)).toMatchObject({
      outcome: "code_failed",
      failureKind: "test_failure",
    });
  });

  test("treats a conftest broken installation as terminal environment setup failure", () => {
    const state = new TaskStateManager("fix Astropy mask propagation");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "astropy/nddata/mixins/ndarithmetic.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: {
          path: "astropy/nddata/mixins/ndarithmetic.py",
          linesAdded: 1,
          linesRemoved: 1,
        },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: {
          command:
            "python -m pytest astropy/nddata/mixins/tests/test_ndarithmetic.py -q",
        },
      },
      {
        ok: false,
        summary: "run_shell: exit 4",
        payload: {
          exit_code: 4,
          stderr:
            "ImportError while loading conftest 'astropy/conftest.py'. astropy/version.py: UserWarning: could not determine astropy package version; this indicates a broken installation",
        },
      },
    );

    expect(state.snapshot().testResults.at(-1)).toMatchObject({
      outcome: "harness_failed",
      failureKind: "environment_setup",
      retryability: "terminal",
      mutationRevision: 1,
    });
    expect(hasVerificationRetryAvailable(state.snapshot())).toBe(false);

    const candidateFault = new TaskStateManager("fix conftest initialization");
    candidateFault.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "tests/conftest.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: {
          path: "tests/conftest.py",
          linesAdded: 1,
          linesRemoved: 1,
        },
      },
    );
    candidateFault.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python -m pytest tests -q" },
      },
      {
        ok: false,
        summary: "run_shell: exit 4",
        payload: {
          exit_code: 4,
          stderr:
            "ImportError while loading conftest 'tests/conftest.py'. tests/conftest.py: broken installation",
        },
      },
    );
    expect(candidateFault.snapshot().testResults.at(-1)).toMatchObject({
      outcome: "harness_failed",
      failureKind: "invocation_error",
      retryability: "retryable",
    });
  });

  test("keeps a monotonic shell revision when retained command history rolls over", () => {
    const state = new TaskStateManager("fix bug");
    for (let index = 0; index < 25; index += 1) {
      state.recordToolResult(
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: `echo ${index}` },
        },
        { ok: true, summary: "ok", payload: {} },
      );
    }
    expect(state.snapshot().commandsRun).toHaveLength(20);
    expect(state.snapshot().shellCommandRevision).toBe(25);
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    expect(state.snapshot().mutationShellCommandRevision).toBe(25);
  });

  test("does not advance mutation state for a successful-looking no-op edit", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py", old_string: "same", new_string: "same" },
      },
      {
        ok: true,
        summary: "edit_file: a.py +0/-0",
        payload: {
          path: "a.py",
          changed: false,
          linesAdded: 0,
          linesRemoved: 0,
        },
      },
    );
    expect(state.snapshot().mutationRevision).toBe(0);
    expect(state.snapshot().filesChanged).toEqual([]);
  });

  test("records a trusted shell workspace effect as a source mutation", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python rewrite.py" },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: {
          workspaceEffect: { changed: true, paths: ["src/a.py"] },
        },
      },
    );
    expect(state.snapshot().mutationRevision).toBe(1);
    expect(state.snapshot().mutationShellCommandRevision).toBe(1);
    expect(state.snapshot().filesChanged).toEqual(["src/a.py"]);
  });

  test("records a shell mutation even when the process exits unsuccessfully", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python rewrite_then_fail.py" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: {
          workspaceEffect: { changed: true, paths: ["src/a.py"] },
        },
      },
    );
    expect(state.snapshot().mutationRevision).toBe(1);
    expect(state.snapshot().filesChanged).toEqual(["src/a.py"]);
    expect(state.snapshot().pinnedFacts).toEqual([
      "workspace.run_shell failed: run_shell: exit 1",
    ]);
  });

  test("retains an unrecovered effect-policy failure as task evidence", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bad command" },
      },
      {
        ok: false,
        summary: "[ToolEffectPolicy:settle_failed] rollback failed",
        payload: {
          code: "E_TOOL_EFFECT_POLICY",
          recovered: false,
        },
      },
    );
    expect(state.snapshot().commandsRun).toHaveLength(1);
    expect(state.snapshot().pinnedFacts[0]).toContain("rollback failed");
  });

  test("retains one exact target after an edit anchor failure", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.py", old_string: "old", new_string: "new" },
      },
      {
        ok: false,
        summary: "edit_file: E_USER old_string not found in src/a.py",
        payload: { error_code: "E_USER" },
      },
    );
    expect(state.snapshot().editRecoveryPath).toBe("src/a.py");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "src/a.py" },
      },
      { ok: true, summary: "read", payload: {} },
    );
    expect(state.snapshot().editRecoveryPath).toBeUndefined();
  });
});
