import { describe, expect, test } from "bun:test";
import type { SubAgentLauncher, SubAgentResult } from "@paw/harness";
import {
  parseMeaAuditReportV1,
  renderMeaAuditProtocolV1,
} from "../src/mea/audit-report.js";
import {
  checkMeaAuditGate,
  resolveMeaAuditorConfig,
} from "../src/mea/auditor-gate.js";
import { runMeaAuditor } from "../src/mea/auditor.js";
import { TaskStateManager } from "../src/task-state.js";

const VALID_REPORT_JSON = JSON.stringify({
  completion: "complete",
  integrity: "clean",
  unmetCriteria: [],
  verifiedFacts: [
    {
      statement: "src/index.ts 存在且导出 run",
      evidence: { files: ["src/index.ts"] },
    },
  ],
  summary: "全部验收标准已核实。",
});

function fakeLauncher(
  summary: string,
  status: SubAgentResult["status"] = "completed",
  onLaunch?: (goal: string) => void,
): SubAgentLauncher {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    launch: (async (goal: string) => {
      onLaunch?.(goal);
      return {
        status,
        summary,
      } as SubAgentResult;
    }) as SubAgentLauncher["launch"],
    launchStreaming: (() => {
      throw new Error("not used in tests");
    }) as unknown as SubAgentLauncher["launchStreaming"],
  };
}

function mutatedState(): TaskStateManager {
  const manager = new TaskStateManager("demo goal", {
    goal: "demo goal",
    filesRead: [],
    filesChanged: ["src/index.ts"],
    commandsRun: [{ command: "bun test", exitCode: 0 }],
    testResults: [],
  } as never);
  return manager;
}

function cleanState(): TaskStateManager {
  return new TaskStateManager("demo goal");
}

const emitted: unknown[] = [];
function emitRecorder(): (event: unknown) => void {
  emitted.length = 0;
  return (event) => emitted.push(event);
}

describe("mea audit report parsing", () => {
  test("parses fenced json report", () => {
    const { ok, report } = parseMeaAuditReportV1(
      `结论如下\n\`\`\`json\n${VALID_REPORT_JSON}\n\`\`\``,
    );
    expect(ok).toBe(true);
    expect(report.completion).toBe("complete");
    expect(report.integrity).toBe("clean");
    expect(report.verifiedFacts.length).toBe(1);
  });

  test("missing enums degrade conservatively to incomplete+suspect", () => {
    const { ok, report } = parseMeaAuditReportV1(
      '```json\n{"completion":"complete"}\n```',
    );
    expect(ok).toBe(false);
    expect(report.completion).toBe("incomplete");
    expect(report.integrity).toBe("suspect");
  });

  test("protocol renders machine-readable schema", () => {
    expect(renderMeaAuditProtocolV1()).toContain('"completion"');
  });
});

describe("runMeaAuditor", () => {
  test("returns parsed report from launcher summary", async () => {
    const result = await runMeaAuditor({
      launcher: fakeLauncher(`\`\`\`json\n${VALID_REPORT_JSON}\n\`\`\``),
      parentRunId: "p1",
      goal: "修复测试",
      acceptanceCriteria: [{ text: "测试通过", status: "pending" }],
      executorSummary: "我已完成修复",
    });
    expect(result.parseOk).toBe(true);
    expect(result.report.completion).toBe("complete");
    expect(result.childStatus).toBe("completed");
  });

  test("launcher failure degrades to conservative report", async () => {
    const launcher = fakeLauncher("", "failed");
    // 让 launch 抛错以模拟基础设施故障
    (launcher.launch as unknown as () => Promise<never>) = async () => {
      throw new Error("bridge down");
    };
    const result = await runMeaAuditor({
      launcher,
      parentRunId: "p1",
      goal: "g",
      acceptanceCriteria: [],
      executorSummary: "s",
    });
    expect(result.parseOk).toBe(false);
    expect(result.report.completion).toBe("incomplete");
    expect(result.report.integrity).toBe("suspect");
  });
});

describe("checkMeaAuditGate", () => {
  const base = {
    parentRunId: "p1",
    goal: "修复测试",
    executorSummary: "我已完成",
    emit: emitRecorder(),
  };

  test("mode off allows without launching", async () => {
    let launched = false;
    const result = await checkMeaAuditGate({
      ...base,
      launcher: fakeLauncher("x", "completed", () => {
        launched = true;
      }),
      config: { mode: "off" },
      taskState: mutatedState(),
      meaNudges: 0,
      noRoomForAnotherTurn: false,
    });
    expect(result.action).toBe("allow");
    expect(launched).toBe(false);
  });

  test("non-mutation tasks skip audit entirely", async () => {
    let launched = false;
    const result = await checkMeaAuditGate({
      ...base,
      launcher: fakeLauncher("x", "completed", () => {
        launched = true;
      }),
      config: { mode: "enforce" },
      taskState: cleanState(),
      meaNudges: 0,
      noRoomForAnotherTurn: false,
    });
    expect(result.action).toBe("allow");
    expect(launched).toBe(false);
  });

  test("shadow audits and emits but never blocks", async () => {
    const result = await checkMeaAuditGate({
      ...base,
      launcher: fakeLauncher(
        '```json\n{"completion":"incomplete","integrity":"clean","unmetCriteria":["测试未通过"],"verifiedFacts":[],"summary":"缺口"}\n```',
      ),
      config: { mode: "shadow" },
      taskState: mutatedState(),
      meaNudges: 0,
      noRoomForAnotherTurn: false,
    });
    expect(result.action).toBe("allow");
    expect(emitted.length).toBe(1);
  });

  test("enforce nudges on incomplete audit", async () => {
    const result = await checkMeaAuditGate({
      ...base,
      launcher: fakeLauncher(
        '```json\n{"completion":"incomplete","integrity":"clean","unmetCriteria":["测试未通过"],"verifiedFacts":[],"summary":"缺口"}\n```',
      ),
      config: { mode: "enforce" },
      taskState: mutatedState(),
      meaNudges: 0,
      noRoomForAnotherTurn: false,
    });
    expect(result.action).toBe("nudge");
    if (result.action === "nudge") {
      expect(result.nextNudges).toBe(1);
      expect(result.text).toContain("MEA 独立审计未通过");
      expect(result.text).toContain("测试未通过");
    }
  });

  test("enforce forces incomplete after nudge budget", async () => {
    const result = await checkMeaAuditGate({
      ...base,
      launcher: fakeLauncher(
        '```json\n{"completion":"incomplete","integrity":"clean","unmetCriteria":[],"verifiedFacts":[],"summary":"缺口"}\n```',
      ),
      config: { mode: "enforce" },
      taskState: mutatedState(),
      meaNudges: 2,
      noRoomForAnotherTurn: false,
    });
    expect(result.action).toBe("force_incomplete");
    if (result.action === "force_incomplete") {
      expect(result.decision.status).toBe("incomplete");
      expect(result.decision.reason).toBe("mea_audit_incomplete");
    }
  });

  test("enforce allows complete+clean audit", async () => {
    const result = await checkMeaAuditGate({
      ...base,
      launcher: fakeLauncher(`\`\`\`json\n${VALID_REPORT_JSON}\n\`\`\``),
      config: { mode: "enforce" },
      taskState: mutatedState(),
      meaNudges: 0,
      noRoomForAnotherTurn: false,
    });
    expect(result.action).toBe("allow");
  });
});

describe("resolveMeaAuditorConfig", () => {
  test("explicit config wins over env", () => {
    expect(
      resolveMeaAuditorConfig(
        { mode: "shadow" },
        {
          PAW_AGENT_MEA_AUDITOR: "enforce",
        },
      ).mode,
    ).toBe("shadow");
  });
  test("env fallback accepted only for known modes", () => {
    expect(resolveMeaAuditorConfig(undefined, {}).mode).toBe("off");
    expect(
      resolveMeaAuditorConfig(undefined, { PAW_AGENT_MEA_AUDITOR: "enforce" })
        .mode,
    ).toBe("enforce");
    expect(
      resolveMeaAuditorConfig(undefined, { PAW_AGENT_MEA_AUDITOR: "yes" }).mode,
    ).toBe("off");
  });
});
