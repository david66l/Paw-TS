import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LanguageModel } from "@paw/models";

import { sha256Canonical } from "../src/loop-v2/canonical.js";
import {
  type VerificationProbeOnceResultV2,
  buildVerificationProbePromptV1,
  detectProtocolFallbackRisk,
  discoverRepositoryExtensionPointsV1,
  evaluateVerificationProbeGateV1,
  executeVerificationProbesV1,
  parseVerificationProbePlanV1,
  runVerificationProbeOnceV2,
} from "../src/loop-v2/verification-probe.js";

function fakeModel(responses: readonly string[]): LanguageModel & {
  readonly calls: () => number;
} {
  let calls = 0;
  const model = {
    label: "probe-fixture",
    async complete() {
      calls += 1;
      const text = responses[Math.min(calls - 1, responses.length - 1)];
      return { text: text ?? "" };
    },
  } as unknown as LanguageModel & { readonly calls: () => number };
  return Object.assign(model, { calls: () => calls });
}

function onlyProbeRunFolder(workspaceRoot: string): string {
  const folders = fs.readdirSync(
    path.join(workspaceRoot, ".paw", "loop-v2", "runs"),
  );
  expect(folders).toHaveLength(1);
  const folder = folders[0];
  if (!folder) throw new Error("missing verification probe run folder");
  return folder;
}

function probeResult(
  verdict: "clear" | "candidate_defect" | "inconclusive",
  command = "python -c 'assert True'",
): VerificationProbeOnceResultV2 {
  const disposition =
    verdict === "clear"
      ? "pass"
      : verdict === "candidate_defect"
        ? "candidate_defect"
        : "inconclusive";
  return {
    candidateInputHash: "hash-a",
    mutationRevision: 1,
    probes: [
      {
        probeId: "probe_1",
        plan: {
          probeId: "probe_1",
          command,
          rationale: "exercise the visible task contract",
          oracle: "the command must satisfy its assertion",
          kind: "inline_contract",
          groundingRefs: ["task_goal", "terminal_diff"],
        },
        execution: {
          status: "completed",
          exitCode: verdict === "candidate_defect" ? 1 : 0,
          output: "ok",
          outputHash: "output-hash",
        },
        disposition,
        adjudication: {
          source: "model",
          summary: "visible task evidence supports this disposition",
          evidenceRefs: ["task_goal", "terminal_diff"],
        },
      },
    ],
    verdict,
    modelCalls: 1,
  };
}

function inlinePlanJson(command: string, oracle = "assert visible behavior") {
  return JSON.stringify({
    probes: [
      {
        command,
        rationale: "exercise a task-and-diff grounded boundary",
        oracle,
        kind: "inline_contract",
        groundingRefs: ["task_goal", "terminal_diff"],
      },
    ],
  });
}

function adjudicationJson(
  disposition: "pass" | "candidate_defect" | "invalid_probe" | "inconclusive",
) {
  return JSON.stringify({
    dispositions: [
      {
        probeId: "probe_1",
        disposition,
        summary: "the visible task and terminal diff ground this result",
        evidenceRefs: ["task_goal", "terminal_diff"],
      },
    ],
  });
}

describe("Loop v2 adversarial verification probe", () => {
  test("prompt is fresh-context, diff-anchored, and forbids network/writes", () => {
    const prompt = buildVerificationProbePromptV1({
      goal: "Preserve DataFrame output for selectors",
      diff: "+ cast_to_ndarray=not preserve_X",
      changedFiles: ["sklearn/base.py"],
    });
    expect(prompt).toContain("adversarial");
    expect(prompt).toContain("cast_to_ndarray");
    expect(prompt).toContain("sklearn/base.py");
    expect(prompt).toContain("no network");
    expect(prompt).toContain("unchanged downstream code");
    expect(prompt).toContain('{"probes"');
  });

  test("protocol fallback risk requests handler ownership and input/out counterexamples", () => {
    const diff = [
      "@@ -10,2 +10,6 @@",
      "+        try:",
      "+            converted = value.to(unit, out=out)",
      "+        except Exception:",
      "+            return NotImplemented",
    ].join("\n");
    const risk = detectProtocolFallbackRisk(diff);
    const prompt = buildVerificationProbePromptV1({
      goal: "Support duck quantities without stealing another ufunc handler",
      diff,
      changedFiles: ["astropy/units/quantity.py"],
    });

    expect(risk).toEqual({
      broadCatch: "except Exception:",
      fallback: "return NotImplemented",
    });
    expect(prompt).toContain("Protocol fallback ownership risk");
    expect(prompt).toContain("really implements the competing protocol");
    expect(prompt).toContain(
      "similar metadata but no explicit protocol handler",
    );
    expect(prompt).toContain("out/output");
    expect(
      detectProtocolFallbackRisk(
        "+        except (TypeError, ValueError):\n+            return NotImplemented",
      ),
    ).toBeUndefined();

    expect(
      detectProtocolFallbackRisk(
        [
          "diff --git a/a.py b/a.py",
          "@@ -1 +1 @@",
          "+except Exception:",
          "+    log_error()",
          "diff --git a/b.py b/b.py",
          "@@ -1 +1 @@",
          "+return NotImplemented",
        ].join("\n"),
      ),
    ).toBeUndefined();

    const equalityPrompt = buildVerificationProbePromptV1({
      goal: "Implement Python equality fallback",
      diff: "+except Exception:\n+    return NotImplemented",
      changedFiles: ["pkg/equality.py"],
    });
    expect(equalityPrompt).toContain("Protocol fallback ownership risk");
    expect(equalityPrompt).not.toContain("out/output");
  });

  test("nearby handler directories trigger extension-point comparison for base behavior", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-extension-"));
    try {
      fs.mkdirSync(path.join(dir, "sympy", "sets", "handlers"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(dir, "sympy", "sets", "sets.py"),
        "class Set: pass\n",
      );
      const hints = discoverRepositoryExtensionPointsV1(dir, [
        "sympy/sets/sets.py",
      ]);
      const prompt = buildVerificationProbePromptV1({
        goal: "Make ProductSet equality evaluate correctly",
        diff: [
          "@@ class Set:",
          "+    def equals(self, other):",
          "+        return all(item in other for item in self)",
          "+    def _eval_simplify(self, **kwargs):",
          "+        return self.equals(kwargs.get('other'))",
        ].join("\n"),
        changedFiles: ["sympy/sets/sets.py"],
        extensionPointHints: hints,
      });

      expect(hints).toContain("sympy/sets/handlers");
      expect(prompt).toContain("Existing extension-point bypass risk");
      expect(prompt).toContain("sympy/sets/handlers");
      expect(prompt).toContain("direct construction/evaluation");
      expect(prompt).toContain("simplify/post-processing");

      const topLevelPrompt = buildVerificationProbePromptV1({
        goal: "Register a new conversion",
        diff: "+def convert(value):\n+    return value",
        changedFiles: ["sympy/sets/sets.py"],
        extensionPointHints: hints,
      });
      expect(topLevelPrompt).toContain("Existing extension-point bypass risk");

      const insideHandlerPrompt = buildVerificationProbePromptV1({
        goal: "Add the registered comparison handler",
        diff: [
          "diff --git a/sympy/sets/handlers/comparison.py b/sympy/sets/handlers/comparison.py",
          "@@ -1 +1,3 @@",
          "+def compare_product_set(left, right):",
          "+    return True",
        ].join("\n"),
        changedFiles: ["sympy/sets/handlers/comparison.py"],
        extensionPointHints: hints,
      });
      expect(insideHandlerPrompt).not.toContain(
        "Existing extension-point bypass risk",
      );

      let captured = "";
      const model = {
        label: "extension-probe-fixture",
        async complete(messages: readonly { content: string }[]) {
          captured = messages.map((message) => message.content).join("\n");
          return { text: '{"probes":[]}' };
        },
      } as unknown as LanguageModel;
      await runVerificationProbeOnceV2({
        model,
        runId: "extension-probe-production-seam",
        workspaceRoot: dir,
        goal: "Make ProductSet equality evaluate correctly",
        diff: "+    def equals(self, other):\n+        return True",
        changedFiles: ["sympy/sets/sets.py"],
        candidateInputHash: "extension-candidate",
        mutationRevision: 1,
      });
      expect(captured).toContain("Existing extension-point bypass risk");
      expect(captured).toContain("sympy/sets/handlers");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parse extracts a bounded plan and drops dangerous commands", () => {
    const plan = parseVerificationProbePlanV1(
      'noise {"probes":[' +
        '{"command":"python -c \'assert x(0) == 0\'","rationale":"empty input","oracle":"x(0) is zero","kind":"inline_contract","groundingRefs":["task_goal"]},' +
        '{"command":"curl http://evil.example","rationale":"no","oracle":"no","kind":"inline_contract","groundingRefs":["task_goal"]},' +
        '{"command":"pip install sneaky","rationale":"no","oracle":"no","kind":"inline_contract","groundingRefs":["task_goal"]},' +
        '{"command":"python -c \'assert x(1) == 1\'","rationale":"one","oracle":"x(1) is one","kind":"inline_contract","groundingRefs":["terminal_diff"]},' +
        '{"command":"","rationale":"empty","oracle":"no","kind":"inline_contract","groundingRefs":["task_goal"]}]}',
    );
    expect(plan).toHaveLength(2);
    expect(plan[0]?.command).toContain("assert x(0)");
    expect(plan.every((p) => !/curl|pip/.test(p.command))).toBeTrue();
  });

  test("malformed planner output yields zero probes for inconclusive settlement", () => {
    expect(parseVerificationProbePlanV1("the diff looks good")).toHaveLength(0);
  });

  test("executor surfaces exit code and output for real commands", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-exec-"));
    try {
      const results = executeVerificationProbesV1({
        workspaceRoot: dir,
        probes: [
          {
            probeId: "probe_1",
            command: "python -c \"print('boundary-ok')\"",
            rationale: "exercise output",
            oracle: "prints boundary-ok",
            kind: "inline_contract",
            groundingRefs: ["task_goal"],
          },
          {
            probeId: "probe_2",
            command: "python -c \"raise SystemExit('boundary-broken')\"",
            rationale: "exercise failure",
            oracle: "exits successfully",
            kind: "inline_contract",
            groundingRefs: ["terminal_diff"],
          },
        ],
      });
      expect(results[0]?.execution.status).toBe("completed");
      expect(results[0]?.execution.output).toContain("boundary-ok");
      expect(results[1]?.execution.status).toBe("completed");
      expect(results[1]?.execution.exitCode).not.toBe(0);
      expect(
        results.every((result) => result.disposition === "inconclusive"),
      ).toBeTrue();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate: fail blocks certification with actionable feedback; pass accepts", () => {
    const fail = evaluateVerificationProbeGateV1({
      result: probeResult(
        "candidate_defect",
        "python -c 'sel.transform(empty)'",
      ),
      noRoomForAnotherTurn: false,
    });
    expect(fail.type).toBe("feedback");
    expect(fail.message).toContain("[LoopV2Probe:fail");
    expect(fail.message).toContain("sel.transform(empty)");
    expect(fail.message).toContain("not certified");
    // 统一不变量：回弹消息必须说明相同候选重交无效
    expect(fail.message).toContain("identical resubmission");

    const pass = evaluateVerificationProbeGateV1({
      result: probeResult("clear"),
      noRoomForAnotherTurn: false,
    });
    expect(pass.type).toBe("accept");

    // 环境类失败不冒充代码缺陷：不拦截
    const errored = evaluateVerificationProbeGateV1({
      result: probeResult("inconclusive", "python -c 'anything'"),
      noRoomForAnotherTurn: false,
    });
    expect(errored.type).toBe("accept");

    // 唯一退出边界：运行预算耗尽
    const noBudget = evaluateVerificationProbeGateV1({
      result: probeResult("candidate_defect"),
      noRoomForAnotherTurn: true,
    });
    expect(noBudget.type).toBe("incomplete");
    expect(noBudget.reason).toBe("no_turn_budget");

    // 相同候选重交：不再有任何计数语义，仍然回弹（at-most-once 记录使重放免费）
    const resubmitted = evaluateVerificationProbeGateV1({
      result: probeResult("candidate_defect"),
      noRoomForAnotherTurn: false,
    });
    expect(resubmitted.type).toBe("feedback");
  });

  test("at-most-once per candidateInputHash: replayed record makes no new model call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-once-"));
    try {
      const model = fakeModel([
        inlinePlanJson(`python -c ${JSON.stringify("assert True")}`),
        adjudicationJson("pass"),
      ]);
      const first = await runVerificationProbeOnceV2({
        model,
        runId: "probe-once",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-x",
        mutationRevision: 1,
      });
      expect(first.verdict).toBe("clear");
      expect(model.calls()).toBe(2);

      // 第二个模型（若被调用会返回必挂探针）不应被调用：命中持久化记录
      const failingProbeCommand = `python -c ${JSON.stringify("raise SystemExit(1)")}`;
      const secondModel = fakeModel([
        inlinePlanJson(failingProbeCommand),
        adjudicationJson("candidate_defect"),
      ]);
      const second = await runVerificationProbeOnceV2({
        model: secondModel,
        runId: "probe-once",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-x",
        mutationRevision: 1,
      });
      expect(second.verdict).toBe("clear");
      expect(secondModel.calls()).toBe(0);

      const evidenceDrift = await runVerificationProbeOnceV2({
        model: secondModel,
        runId: "probe-once",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-evidence-drift",
        mutationRevision: 1,
      });
      expect(evidenceDrift.verdict).toBe("clear");
      expect(evidenceDrift.candidateInputHash).toBe("hash-evidence-drift");
      expect(evidenceDrift.modelCalls).toBe(0);
      expect(secondModel.calls()).toBe(0);

      // 新候选（不同 hash）会重新探针
      const third = await runVerificationProbeOnceV2({
        model: secondModel,
        runId: "probe-once",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+2",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-y",
        mutationRevision: 2,
      });
      expect(third.verdict).toBe("candidate_defect");
      expect(secondModel.calls()).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("durable claim prevents model and shell replay after an interrupted probe", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-claim-"));
    try {
      let crashingCalls = 0;
      const crashingModel = {
        label: "probe-crash-fixture",
        async complete() {
          crashingCalls += 1;
          const runFolder = onlyProbeRunFolder(dir);
          expect(
            JSON.parse(
              fs.readFileSync(
                path.join(
                  dir,
                  ".paw",
                  "loop-v2",
                  "runs",
                  runFolder,
                  "verification-probe-claim-v2.json",
                ),
                "utf8",
              ),
            ).kind,
          ).toBe("paw.loop-v2-verification-probe-claim");
          throw new Error("simulated crash after durable claim");
        },
      } as unknown as LanguageModel;
      await expect(
        runVerificationProbeOnceV2({
          model: crashingModel,
          runId: "probe-claim",
          workspaceRoot: dir,
          goal: "goal",
          diff: "+1",
          changedFiles: ["a.py"],
          candidateInputHash: "hash-claim",
          mutationRevision: 1,
        }),
      ).rejects.toThrow("simulated crash");
      expect(crashingCalls).toBe(1);

      const replayModel = fakeModel([
        inlinePlanJson(`python -c ${JSON.stringify("raise SystemExit(1)")}`),
      ]);
      const replay = await runVerificationProbeOnceV2({
        model: replayModel,
        runId: "probe-claim",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-claim",
        mutationRevision: 1,
      });
      expect(replay.interrupted).toBe(true);
      expect(replay.modelCalls).toBe(0);
      expect(replayModel.calls()).toBe(0);
      expect(
        evaluateVerificationProbeGateV1({
          result: replay,
          noRoomForAnotherTurn: false,
        }).type,
      ).toBe("feedback");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy v1 pass/fail/error records migrate without model or shell replay", async () => {
    for (const legacyStatus of ["pass", "fail", "error"] as const) {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), `paw-probe-legacy-${legacyStatus}-`),
      );
      try {
        const runId = `legacy-${legacyStatus}`;
        const runFolder = path.join(
          dir,
          ".paw",
          "loop-v2",
          "runs",
          sha256Canonical({ runId }),
        );
        fs.mkdirSync(runFolder, { recursive: true });
        fs.writeFileSync(
          path.join(runFolder, "verification-probe-v1.json"),
          JSON.stringify({
            schemaVersion: 1,
            kind: "paw.loop-v2-verification-probe",
            candidateInputHash: "legacy-candidate",
            mutationRevision: 1,
            result: {
              candidateInputHash: "legacy-candidate",
              mutationRevision: 1,
              probes: [
                {
                  command: "python -c 'must not replay'",
                  status: legacyStatus,
                  ...(legacyStatus === "pass" ? { exitCode: 0 } : {}),
                  ...(legacyStatus === "fail" ? { exitCode: 1 } : {}),
                  output: legacyStatus,
                },
              ],
              verdict: legacyStatus,
              modelCalls: 1,
            },
          }),
        );
        const neverModel = fakeModel(["{}"]);
        const migrated = await runVerificationProbeOnceV2({
          model: neverModel,
          runId,
          workspaceRoot: dir,
          goal: "goal",
          diff: "+candidate",
          changedFiles: ["a.py"],
          candidateInputHash: "legacy-candidate",
          mutationRevision: 1,
        });
        expect(neverModel.calls()).toBe(0);
        expect(migrated.modelCalls).toBe(0);
        expect(migrated.verdict).toBe(
          legacyStatus === "pass" ? "clear" : "inconclusive",
        );
        expect(migrated.probes[0]?.adjudication.source).toBe("legacy");
        if (legacyStatus === "fail") {
          expect(migrated.probes[0]?.disposition).toBe("inconclusive");
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("corrupt claim or settled record fails closed without another model call", async () => {
    const claimDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-probe-corrupt-claim-"),
    );
    try {
      const crashModel = {
        label: "probe-corrupt-claim",
        async complete() {
          throw new Error("crash");
        },
      } as unknown as LanguageModel;
      await expect(
        runVerificationProbeOnceV2({
          model: crashModel,
          runId: "corrupt-claim",
          workspaceRoot: claimDir,
          goal: "goal",
          diff: "+1",
          changedFiles: ["a.py"],
          candidateInputHash: "hash-corrupt",
          mutationRevision: 1,
        }),
      ).rejects.toThrow("crash");
      const runFolder = onlyProbeRunFolder(claimDir);
      fs.writeFileSync(
        path.join(
          claimDir,
          ".paw",
          "loop-v2",
          "runs",
          runFolder,
          "verification-probe-claim-v2.json",
        ),
        "{broken",
      );
      const neverModel = fakeModel(["{}"]);
      const interrupted = await runVerificationProbeOnceV2({
        model: neverModel,
        runId: "corrupt-claim",
        workspaceRoot: claimDir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-corrupt",
        mutationRevision: 1,
      });
      expect(interrupted.interrupted).toBe(true);
      expect(neverModel.calls()).toBe(0);
    } finally {
      fs.rmSync(claimDir, { recursive: true, force: true });
    }

    const recordDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-probe-corrupt-record-"),
    );
    try {
      const model = fakeModel(['{"probes":[]}']);
      await runVerificationProbeOnceV2({
        model,
        runId: "corrupt-record",
        workspaceRoot: recordDir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-record",
        mutationRevision: 1,
      });
      const runFolder = onlyProbeRunFolder(recordDir);
      fs.writeFileSync(
        path.join(
          recordDir,
          ".paw",
          "loop-v2",
          "runs",
          runFolder,
          "verification-probe-v2.json",
        ),
        JSON.stringify({
          schemaVersion: 2,
          kind: "paw.loop-v2-verification-probe",
          policyVersion: "paw.loop-v2-verification-probe-v2",
          verificationAuthority: "local",
          candidateInputHash: "hash-record",
          mutationRevision: 1,
          result: {
            candidateInputHash: "hash-record",
            mutationRevision: 1,
          },
        }),
      );
      const neverModel = fakeModel(["{}"]);
      const interrupted = await runVerificationProbeOnceV2({
        model: neverModel,
        runId: "corrupt-record",
        workspaceRoot: recordDir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "hash-record",
        mutationRevision: 1,
      });
      expect(interrupted.interrupted).toBe(true);
      expect(neverModel.calls()).toBe(0);
    } finally {
      fs.rmSync(recordDir, { recursive: true, force: true });
    }
  });

  test("semantically inconsistent settled JSON fails closed instead of upgrading a probe", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-tamper-"));
    try {
      const model = fakeModel([
        inlinePlanJson(`python -c ${JSON.stringify("assert True")}`),
        adjudicationJson("pass"),
      ]);
      const first = await runVerificationProbeOnceV2({
        model,
        runId: "tampered-record",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+candidate",
        changedFiles: ["a.py"],
        candidateInputHash: "tampered-record",
        mutationRevision: 1,
      });
      expect(first.verdict).toBe("clear");
      const runFolder = onlyProbeRunFolder(dir);
      const recordPath = path.join(
        dir,
        ".paw",
        "loop-v2",
        "runs",
        runFolder,
        "verification-probe-v2.json",
      );
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      record.result.verdict = "candidate_defect";
      record.result.probes[0].disposition = "candidate_defect";
      fs.writeFileSync(recordPath, JSON.stringify(record));

      const neverModel = fakeModel(["{}"]);
      const replay = await runVerificationProbeOnceV2({
        model: neverModel,
        runId: "tampered-record",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+candidate",
        changedFiles: ["a.py"],
        candidateInputHash: "tampered-record",
        mutationRevision: 1,
      });
      expect(replay.verdict).toBe("interrupted");
      expect(replay.interrupted).toBeTrue();
      expect(neverModel.calls()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("planner and adjudicator use bounded output caps and invalid Matplotlib probes do not demand mutation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-invalid-"));
    try {
      const options: Array<{ maxOutputTokens?: number }> = [];
      const responses = [
        inlinePlanJson(
          `python -c ${JSON.stringify("from matplotlib.dates import DateFormatter; assert DateFormatter.nonexistent_probe_api()")}`,
          "the nonexistent API should report a balanced dollar-sign count",
        ),
        adjudicationJson("invalid_probe"),
      ];
      let calls = 0;
      const model = {
        label: "matplotlib-invalid-probe",
        async complete(
          _messages: unknown,
          callOptions?: { maxOutputTokens?: number },
        ) {
          options.push(callOptions ?? {});
          const text = responses[calls] ?? "{}";
          calls += 1;
          return { text };
        },
      } as unknown as LanguageModel;
      const result = await runVerificationProbeOnceV2({
        model,
        runId: "matplotlib-invalid-probe",
        workspaceRoot: dir,
        goal: "Escape TeX date labels without breaking existing formatters",
        diff: "+ return label.replace(':', '{:}')",
        changedFiles: ["lib/matplotlib/dates.py"],
        candidateInputHash: "matplotlib-candidate",
        mutationRevision: 1,
        verificationAuthority: "external",
      });
      expect(options).toEqual([
        { maxOutputTokens: 4_096 },
        { maxOutputTokens: 2_048 },
      ]);
      expect(result.verdict).toBe("inconclusive");
      expect(result.probes[0]?.disposition).toBe("invalid_probe");
      expect(
        evaluateVerificationProbeGateV1({
          result,
          noRoomForAnotherTurn: false,
        }).type,
      ).toBe("accept");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("truncated planner settles inconclusive without executing shell", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-truncated-"));
    try {
      const sentinel = path.join(dir, "must-not-exist.txt");
      let calls = 0;
      const model = {
        label: "truncated-planner",
        async complete() {
          calls += 1;
          return {
            text: inlinePlanJson(
              `python -c ${JSON.stringify(`from pathlib import Path; Path(${JSON.stringify(sentinel)}).write_text('ran')`)}`,
            ),
            finishReason: "length",
          };
        },
      } as unknown as LanguageModel;
      const result = await runVerificationProbeOnceV2({
        model,
        runId: "truncated-planner",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+1",
        changedFiles: ["a.py"],
        candidateInputHash: "truncated",
        mutationRevision: 1,
      });
      expect(calls).toBe(1);
      expect(result.verdict).toBe("inconclusive");
      expect(result.probes).toHaveLength(0);
      expect(result.note).toContain("truncated");
      expect(fs.existsSync(sentinel)).toBeFalse();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("truncated adjudicator cannot turn an ambiguous failure into a defect", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-judge-cut-"));
    try {
      let calls = 0;
      const model = {
        label: "truncated-adjudicator",
        async complete() {
          calls += 1;
          return calls === 1
            ? {
                text: inlinePlanJson(
                  `python -c ${JSON.stringify("raise AssertionError('ambiguous')")}`,
                ),
                finishReason: "stop",
              }
            : {
                text: adjudicationJson("candidate_defect"),
                finishReason: "max_tokens",
              };
        },
      } as unknown as LanguageModel;
      const result = await runVerificationProbeOnceV2({
        model,
        runId: "truncated-adjudicator",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+candidate",
        changedFiles: ["a.py"],
        candidateInputHash: "truncated-adjudicator",
        mutationRevision: 1,
      });
      expect(calls).toBe(2);
      expect(result.verdict).toBe("inconclusive");
      expect(result.probes[0]?.disposition).toBe("inconclusive");
      expect(result.probes[0]?.adjudication.summary).toContain("truncated");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("local tracked repository regression is host-hard, while external authority adjudicates it", async () => {
    const makeRepository = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-tracked-"));
      fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "tests", "test_contract.js"),
        "throw new Error('visible regression');\n",
      );
      fs.writeFileSync(
        path.join(dir, "tests", "test_discovery.js"),
        "process.exit(5);\n",
      );
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      Bun.spawnSync(["git", "add", "tests"], { cwd: dir });
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Paw Test",
          "-c",
          "user.email=paw@example.invalid",
          "commit",
          "-qm",
          "baseline",
        ],
        { cwd: dir },
      );
      return dir;
    };
    const repositoryPlan = JSON.stringify({
      probes: [
        {
          command: "node tests/test_contract.js",
          rationale: "run the impacted tracked contract test",
          oracle: "the tracked contract test exits zero",
          kind: "repository_test",
          groundingRefs: ["repository_test:tests/test_contract.js"],
        },
      ],
    });

    const localDir = makeRepository();
    try {
      const localModel = fakeModel([repositoryPlan]);
      const local = await runVerificationProbeOnceV2({
        model: localModel,
        runId: "local-tracked",
        workspaceRoot: localDir,
        goal: "preserve the tracked contract",
        diff: "+candidate",
        changedFiles: ["product.py"],
        impactedTests: ["tests/test_contract.js"],
        candidateInputHash: "local-tracked",
        mutationRevision: 1,
        verificationAuthority: "local",
      });
      expect(localModel.calls()).toBe(1);
      expect(local.verdict).toBe("candidate_defect");
      expect(local.probes[0]?.adjudication.source).toBe("host");

      const repositoryProbe = (
        probeId: string,
        command: string,
        repositoryPath: string,
      ) => ({
        probeId,
        command,
        rationale: "run a tracked repository contract",
        oracle: "the tracked contract exits zero",
        kind: "repository_test" as const,
        groundingRefs: [`repository_test:${repositoryPath}`],
      });
      const spoofed = executeVerificationProbesV1({
        workspaceRoot: localDir,
        impactedTests: ["tests/test_contract.js"],
        probes: [
          repositoryProbe(
            "probe_spoof",
            `python -c ${JSON.stringify("raise SystemExit(7)")} tests/test_contract.js`,
            "tests/test_contract.js",
          ),
        ],
      });
      expect(spoofed[0]?.execution.status).toBe("not_run");
      expect(spoofed[0]?.disposition).toBe("invalid_probe");

      fs.writeFileSync(
        path.join(localDir, "smoke-test.js"),
        "throw new Error('candidate-owned runner');\n",
      );
      const nodeArgumentSpoof = executeVerificationProbesV1({
        workspaceRoot: localDir,
        impactedTests: ["tests/test_contract.js"],
        probes: [
          repositoryProbe(
            "probe_node_argument_spoof",
            "node smoke-test.js tests/test_contract.js",
            "tests/test_contract.js",
          ),
        ],
      });
      expect(nodeArgumentSpoof[0]?.execution.status).toBe("not_run");
      expect(nodeArgumentSpoof[0]?.disposition).toBe("invalid_probe");

      const pytestMultiTargetSpoof = executeVerificationProbesV1({
        workspaceRoot: localDir,
        impactedTests: ["tests/test_contract.js"],
        probes: [
          repositoryProbe(
            "probe_pytest_multi_target",
            "pytest candidate_owned_failing_test.py tests/test_contract.js",
            "tests/test_contract.js",
          ),
        ],
      });
      expect(pytestMultiTargetSpoof[0]?.execution.status).toBe("not_run");
      expect(pytestMultiTargetSpoof[0]?.disposition).toBe("invalid_probe");

      const pytestSemanticOptionSpoof = executeVerificationProbesV1({
        workspaceRoot: localDir,
        impactedTests: ["tests/test_contract.js"],
        probes: [
          repositoryProbe(
            "probe_pytest_semantic_option",
            "pytest tests/test_contract.js --runxfail",
            "tests/test_contract.js",
          ),
        ],
      });
      expect(pytestSemanticOptionSpoof[0]?.execution.status).toBe("not_run");
      expect(pytestSemanticOptionSpoof[0]?.disposition).toBe("invalid_probe");

      const discovery = executeVerificationProbesV1({
        workspaceRoot: localDir,
        impactedTests: ["tests/test_discovery.js"],
        probes: [
          repositoryProbe(
            "probe_discovery",
            "node tests/test_discovery.js",
            "tests/test_discovery.js",
          ),
        ],
      });
      expect(discovery[0]?.disposition).toBe("environment_error");
      expect(discovery[0]?.adjudication.summary).toContain("test_discovery");

      fs.writeFileSync(
        path.join(localDir, "tests", "test_contract.js"),
        "process.exit(0);\n",
      );
      const modified = executeVerificationProbesV1({
        workspaceRoot: localDir,
        impactedTests: ["tests/test_contract.js"],
        probes: [
          repositoryProbe(
            "probe_modified",
            "node tests/test_contract.js",
            "tests/test_contract.js",
          ),
        ],
      });
      expect(modified[0]?.execution.status).toBe("not_run");
      expect(modified[0]?.disposition).toBe("invalid_probe");

      fs.writeFileSync(
        path.join(localDir, "tests", "test_candidate_added.js"),
        "throw new Error('candidate-owned test');\n",
      );
      Bun.spawnSync(["git", "add", "tests/test_candidate_added.js"], {
        cwd: localDir,
      });
      const staged = executeVerificationProbesV1({
        workspaceRoot: localDir,
        impactedTests: ["tests/test_candidate_added.js"],
        probes: [
          repositoryProbe(
            "probe_staged",
            "node tests/test_candidate_added.js",
            "tests/test_candidate_added.js",
          ),
        ],
      });
      expect(staged[0]?.execution.status).toBe("not_run");
      expect(staged[0]?.disposition).toBe("invalid_probe");
    } finally {
      fs.rmSync(localDir, { recursive: true, force: true });
    }

    const externalDir = makeRepository();
    try {
      const externalModel = fakeModel([
        repositoryPlan,
        adjudicationJson("inconclusive"),
      ]);
      const external = await runVerificationProbeOnceV2({
        model: externalModel,
        runId: "external-tracked",
        workspaceRoot: externalDir,
        goal: "the configured external verifier owns the final contract",
        diff: "+candidate",
        changedFiles: ["product.py"],
        impactedTests: ["tests/test_contract.js"],
        candidateInputHash: "external-tracked",
        mutationRevision: 1,
        verificationAuthority: "external",
      });
      expect(externalModel.calls()).toBe(2);
      expect(external.verdict).toBe("inconclusive");
      expect(external.probes[0]?.disposition).toBe("inconclusive");
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("malformed adjudication cannot upgrade an inline failure to candidate defect", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-bad-judge-"));
    try {
      const model = fakeModel([
        inlinePlanJson(
          `python -c ${JSON.stringify("raise AssertionError('ambiguous')")}`,
        ),
        '{"dispositions":[{"probeId":"probe_1","disposition":"candidate_defect","summary":"trust me","evidenceRefs":["invented:hidden-test"]}]}',
      ]);
      const result = await runVerificationProbeOnceV2({
        model,
        runId: "bad-adjudication",
        workspaceRoot: dir,
        goal: "goal",
        diff: "+candidate",
        changedFiles: ["a.py"],
        candidateInputHash: "bad-adjudication",
        mutationRevision: 1,
      });
      expect(result.verdict).toBe("inconclusive");
      expect(result.probes[0]?.disposition).toBe("inconclusive");
      expect(result.probes[0]?.adjudication.source).toBe("protocol");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sklearn signature: boundary probe on unchanged downstream code blocks a certified candidate", () => {
    // sklearn-25102 签名场景：补丁让 transform 保留 DataFrame（类型变化），
    // 但未改的下游 np.empty(0, dtype=X.dtype) 在零特征分支崩溃。
    // 实施者自测只覆盖 happy path；对抗探针选中 k=0 边界并真实执行。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-sklearn-"));
    try {
      fs.writeFileSync(
        path.join(dir, "selector.py"),
        [
          "def transform(X, mask):",
          "    # 候选补丁的行为：保留输入容器（模拟 DataFrame：list，无 .dtype）",
          "    if not any(mask):",
          "        # 未被补丁修改的下游代码，假设输入仍有 .dtype",
          "        return X.dtype",
          "    return [row for row, keep in zip(X, mask) if keep]",
        ].join("\n"),
        "utf8",
      );
      const results = executeVerificationProbesV1({
        workspaceRoot: dir,
        probes: [
          {
            probeId: "probe_1",
            command:
              'python -c "import selector; selector.transform([[1.0, 2.0]], [False, False])"',
            rationale:
              "k=0 with a container lacking .dtype hits the untouched downstream line",
            oracle: "zero selected features must not access a missing dtype",
            kind: "inline_contract",
            groundingRefs: ["task_goal", "terminal_diff"],
          },
          {
            probeId: "probe_2",
            command:
              'python -c "import selector; assert selector.transform([[1.0, 2.0]], [True, False]) == [[1.0, 2.0]]"',
            rationale: "happy path already verified by the implementer",
            oracle: "selected rows remain unchanged",
            kind: "inline_contract",
            groundingRefs: ["task_goal"],
          },
        ],
      });
      // 快乐路径通过、零特征边界失败：正是自测盲区的形状
      expect(results[1]?.execution.exitCode).toBe(0);
      expect(results[0]?.execution.exitCode).not.toBe(0);
      expect(results[0]?.execution.output).toContain("dtype");
      const gate = evaluateVerificationProbeGateV1({
        result: {
          candidateInputHash: "sklearn-sig",
          mutationRevision: 3,
          probes: results.map((result, index) =>
            index === 0
              ? {
                  ...result,
                  disposition: "candidate_defect" as const,
                  adjudication: {
                    source: "model" as const,
                    summary:
                      "the zero-feature task contract reaches unchanged downstream dtype access",
                    evidenceRefs: ["task_goal", "terminal_diff"],
                  },
                }
              : {
                  ...result,
                  disposition: "pass" as const,
                  adjudication: {
                    source: "model" as const,
                    summary: "happy path passed",
                    evidenceRefs: ["task_goal"],
                  },
                },
          ),
          verdict: "candidate_defect",
          modelCalls: 1,
        },
        noRoomForAnotherTurn: false,
      });
      expect(gate.type).toBe("feedback");
      expect(gate.message).toContain("not certified");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
