import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LanguageModel } from "@paw/models";

import {
  type VerificationProbeOnceResultV2,
  buildVerificationProbePromptV1,
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
  verdict: "pass" | "fail",
  command = "python -c 'assert True'",
): VerificationProbeOnceResultV2 {
  return {
    candidateInputHash: "hash-a",
    mutationRevision: 1,
    probes: [{ command, ok: verdict === "pass", exitCode: 0, output: "ok" }],
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
      expect(results[0]?.ok).toBeTrue();
      expect(results[0]?.output).toContain("boundary-ok");
      expect(results[1]?.ok).toBeFalse();
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

    const pass = evaluateVerificationProbeGateV1({
      result: probeResult("pass"),
      noRoomForAnotherTurn: false,
    });
    expect(pass.type).toBe("accept");

    const exhausted = evaluateVerificationProbeGateV1({
      result: probeResult("fail"),
      priorKey: "probe:hash-a",
      priorNudges: 1,
      noRoomForAnotherTurn: false,
    });
    expect(exhausted.type).toBe("incomplete");
    expect(exhausted.reason).toBe("feedback_exhausted");
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
      expect(results[1]?.ok).toBeTrue();
      expect(results[0]?.ok).toBeFalse();
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
