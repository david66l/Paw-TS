import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LanguageModel } from "@paw/models";

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

function probeResult(
  verdict: "pass" | "fail" | "error",
  command = "python -c 'assert True'",
): VerificationProbeOnceResultV2 {
  return {
    candidateInputHash: "hash-a",
    mutationRevision: 1,
    probes: [
      {
        command,
        status:
          verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "error",
        exitCode: 0,
        output: "ok",
      },
    ],
    verdict,
    modelCalls: 1,
  };
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
        '{"command":"python -c \'assert x(0) == 0\'","rationale":"empty input"},' +
        '{"command":"curl http://evil.example","rationale":"no"},' +
        '{"command":"pip install sneaky","rationale":"no"},' +
        '{"command":"python -c \'assert x(1) == 1\'","rationale":"one"},' +
        '{"command":"","rationale":"empty"}]}',
    );
    expect(plan).toHaveLength(2);
    expect(plan[0]?.command).toContain("assert x(0)");
    expect(plan.every((p) => !/curl|pip/.test(p.command))).toBeTrue();
  });

  test("malformed model output yields zero probes (bounded fail-open)", () => {
    expect(parseVerificationProbePlanV1("the diff looks good")).toHaveLength(0);
  });

  test("executor surfaces exit code and output for real commands", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-exec-"));
    try {
      const results = executeVerificationProbesV1({
        workspaceRoot: dir,
        probes: [
          { command: "python -c \"print('boundary-ok')\"", rationale: "" },
          {
            command: "python -c \"raise SystemExit('boundary-broken')\"",
            rationale: "",
          },
        ],
      });
      expect(results[0]?.status).toBe("pass");
      expect(results[0]?.output).toContain("boundary-ok");
      expect(results[1]?.status).toBe("fail");
      expect(results[1]?.exitCode).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate: fail blocks certification with actionable feedback; pass accepts", () => {
    const fail = evaluateVerificationProbeGateV1({
      result: probeResult("fail", "python -c 'sel.transform(empty)'"),
      noRoomForAnotherTurn: false,
    });
    expect(fail.type).toBe("feedback");
    expect(fail.message).toContain("[LoopV2Probe:fail");
    expect(fail.message).toContain("sel.transform(empty)");
    expect(fail.message).toContain("not certified");
    // 统一不变量：回弹消息必须说明相同候选重交无效
    expect(fail.message).toContain("identical resubmission");

    const pass = evaluateVerificationProbeGateV1({
      result: probeResult("pass"),
      noRoomForAnotherTurn: false,
    });
    expect(pass.type).toBe("accept");

    // 环境类失败不冒充代码缺陷：不拦截
    const errored = evaluateVerificationProbeGateV1({
      result: probeResult("error", "python -c 'anything'"),
      noRoomForAnotherTurn: false,
    });
    expect(errored.type).toBe("accept");

    // 唯一退出边界：运行预算耗尽
    const noBudget = evaluateVerificationProbeGateV1({
      result: probeResult("fail"),
      noRoomForAnotherTurn: true,
    });
    expect(noBudget.type).toBe("incomplete");
    expect(noBudget.reason).toBe("no_turn_budget");

    // 相同候选重交：不再有任何计数语义，仍然回弹（at-most-once 记录使重放免费）
    const resubmitted = evaluateVerificationProbeGateV1({
      result: probeResult("fail"),
      noRoomForAnotherTurn: false,
    });
    expect(resubmitted.type).toBe("feedback");
  });

  test("at-most-once per candidateInputHash: replayed record makes no new model call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-probe-once-"));
    try {
      const model = fakeModel([
        `{"probes":[{"command":"python -c ${JSON.stringify("assert True")}","rationale":"r"}]}`,
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
      expect(first.verdict).toBe("pass");
      expect(model.calls()).toBe(1);

      // 第二个模型（若被调用会返回必挂探针）不应被调用：命中持久化记录
      const failingProbeCommand = `python -c ${JSON.stringify("raise SystemExit(1)")}`;
      const secondModel = fakeModel([
        `{"probes":[{"command":${JSON.stringify(failingProbeCommand)},"rationale":"r"}]}`,
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
      expect(second.verdict).toBe("pass");
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
      expect(third.verdict).toBe("fail");
      expect(secondModel.calls()).toBe(1);
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
            command:
              'python -c "import selector; selector.transform([[1.0, 2.0]], [False, False])"',
            rationale:
              "k=0 with a container lacking .dtype hits the untouched downstream line",
          },
          {
            command:
              'python -c "import selector; assert selector.transform([[1.0, 2.0]], [True, False]) == [[1.0, 2.0]]"',
            rationale: "happy path already verified by the implementer",
          },
        ],
      });
      // 快乐路径通过、零特征边界失败：正是自测盲区的形状
      expect(results[1]?.status).toBe("pass");
      expect(results[0]?.status).toBe("fail");
      expect(results[0]?.output).toContain("dtype");
      const gate = evaluateVerificationProbeGateV1({
        result: {
          candidateInputHash: "sklearn-sig",
          mutationRevision: 3,
          probes: results,
          verdict: "fail",
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
