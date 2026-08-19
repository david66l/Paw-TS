import { describe, expect, test } from "bun:test";
import {
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Envelope,
  type LoopV2Event,
  type ProgressAdvisorActionV2,
  type ProgressAdvisorConfigV2,
  type ProgressAdvisorStateV2,
  type WorkingDecisionStateV2,
  advanceProgressAdvisorV2,
  createProgressAdvisorStateV2,
  createWorkingDecisionStateV2,
  projectLoopV2Event,
} from "../src/loop-v2/index.js";

const RUN_ID = "progress-advisor-replay";

function envelope(seq: number, event: LoopV2Event): LoopV2Envelope {
  return {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    runId: RUN_ID,
    seq,
    ts: 2_000 + seq,
    event,
  };
}

function bootstrap(): WorkingDecisionStateV2 {
  return projectLoopV2Event(
    createWorkingDecisionStateV2(RUN_ID),
    envelope(1, {
      type: "task.started",
      goal: "Find and fix the bug using materially new evidence.",
      sourceHash: "goal-hash",
    }),
  ).state;
}

function action(
  tool: string,
  args: Record<string, unknown>,
): ProgressAdvisorActionV2 {
  return { tool, args, repeatTracking: "tracked" };
}

function advance(
  advisor: ProgressAdvisorStateV2,
  cycle: number,
  projected: ReturnType<typeof projectLoopV2Event>,
  actions: readonly ProgressAdvisorActionV2[],
) {
  return advanceProgressAdvisorV2(
    advisor,
    {
      cycle,
      projectedThroughSeq: projected.state.lastSeq,
      actions,
      deltas: [projected.delta],
    },
    projected.state,
  );
}

describe("Loop Kernel v2 progress advisor", () => {
  test("R01 a new span resets no-delta state and is never vetoed", () => {
    let state = bootstrap();
    let advisor = createProgressAdvisorStateV2(RUN_ID);
    const first = projectLoopV2Event(
      state,
      envelope(2, {
        type: "evidence.observed",
        observation: {
          kind: "read",
          path: "django/db/migrations/autodetector.py",
          start: 0,
          endExclusive: 130,
          contentHash: "django-r0",
          repositoryRevision: "r0",
        },
      }),
    );
    const firstAdvice = advance(advisor, 1, first, [
      action("workspace.read_file", {
        path: "django/db/migrations/autodetector.py",
        offset: 1,
        limit: 130,
      }),
    ]);
    state = first.state;
    advisor = firstAdvice.state;

    const unseen = projectLoopV2Event(
      state,
      envelope(3, {
        type: "evidence.observed",
        observation: {
          kind: "read",
          path: "django/db/migrations/autodetector.py",
          start: 1188,
          endExclusive: 1288,
          contentHash: "django-r0",
          repositoryRevision: "r0",
        },
      }),
    );
    const result = advance(advisor, 2, unseen, [
      action("workspace.read_file", {
        path: "django/db/migrations/autodetector.py",
        offset: 1189,
        limit: 100,
      }),
    ]);

    expect(unseen.delta.meaningful).toBeTrue();
    expect(result.state.consecutiveNoDeltaCycles).toBe(0);
    expect(result.state.repeat?.count).toBe(1);
    expect(result.advice).toEqual([]);
  });

  test("R02 the third exact read is observed with advice and never blocked", () => {
    let state = bootstrap();
    let advisor = createProgressAdvisorStateV2(RUN_ID);
    const deltas: boolean[] = [];
    const advice = [] as ReturnType<
      typeof advanceProgressAdvisorV2
    >["advice"][number][];
    const repeatedAction = action("workspace.read_file", {
      path: "src/worker.ts",
      offset: 11,
      limit: 30,
    });

    for (let index = 0; index < 3; index += 1) {
      const projected = projectLoopV2Event(
        state,
        envelope(index + 2, {
          type: "evidence.observed",
          observation: {
            kind: "read",
            path: "src/worker.ts",
            start: 10,
            endExclusive: 40,
            contentHash: "worker-r0",
            repositoryRevision: "r0",
          },
        }),
      );
      const observed = advance(advisor, index + 1, projected, [repeatedAction]);
      deltas.push(projected.delta.meaningful);
      advice.push(...observed.advice);
      state = projected.state;
      advisor = observed.state;
    }

    expect(deltas).toEqual([true, false, false]);
    expect(advisor.repeat?.count).toBe(3);
    expect(advisor.consecutiveNoDeltaCycles).toBe(2);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({
      kind: "repeat_observed",
      priority: "info",
    });
    expect(advice[0]?.evidenceRefs).toHaveLength(1);
    expect("allowed" in (advice[0] ?? {})).toBeFalse();
    expect("blocked" in (advice[0] ?? {})).toBeFalse();
  });

  test("R03 changed repository results reset no-delta despite identical tool args", () => {
    let state = bootstrap();
    let advisor = createProgressAdvisorStateV2(RUN_ID);
    const repeatedAction = action("workspace.grep", {
      path: "src",
      pattern: "resolvePartial",
    });
    for (const [index, revision] of ["r0", "r1"].entries()) {
      const projected = projectLoopV2Event(
        state,
        envelope(index + 2, {
          type: "evidence.observed",
          observation: {
            kind: "search",
            root: "src",
            query: "resolvePartial",
            resultHash: `matches-${revision}`,
            repositoryRevision: revision,
          },
        }),
      );
      const observed = advance(advisor, index + 1, projected, [repeatedAction]);
      expect(projected.delta.meaningful).toBeTrue();
      expect(observed.state.consecutiveNoDeltaCycles).toBe(0);
      expect(observed.advice).toEqual([]);
      state = projected.state;
      advisor = observed.state;
    }
    expect(advisor.repeat?.count).toBe(2);
  });

  test("exact repeat advice escalates at the frozen 3/5/8 thresholds", () => {
    let state = bootstrap();
    let advisor = createProgressAdvisorStateV2(RUN_ID);
    const priorities: string[] = [];
    const repeatedAction = action("workspace.read_file", {
      path: "src/repeat.ts",
      offset: 1,
      limit: 20,
    });

    for (let cycle = 1; cycle <= 8; cycle += 1) {
      const projected = projectLoopV2Event(
        state,
        envelope(cycle + 1, {
          type: "evidence.observed",
          observation: {
            kind: "read",
            path: "src/repeat.ts",
            start: 0,
            endExclusive: 20,
            contentHash: "repeat-r0",
            repositoryRevision: "r0",
          },
        }),
      );
      const observed = advance(advisor, cycle, projected, [repeatedAction]);
      priorities.push(
        ...observed.advice
          .filter((item) => item.kind === "repeat_observed")
          .map((item) => item.priority),
      );
      state = projected.state;
      advisor = observed.state;
    }

    expect(priorities).toEqual(["info", "warning", "urgent"]);
    expect(advisor.repeat?.count).toBe(8);
  });

  test("versioned no-delta stages continue every eight cycles after 16 without gaining authority", () => {
    let state = projectLoopV2Event(
      bootstrap(),
      envelope(2, {
        type: "hypothesis.upserted",
        hypothesis: {
          id: "hypothesis-active",
          statement: "The parser loses the terminal token.",
          status: "candidate",
          supports: ["evidence-parser"],
          contradicts: [],
          falsifier: "Compare the token stream before and after parsing.",
          proposedAtSeq: 2,
        },
      }),
    ).state;
    let advisor = createProgressAdvisorStateV2(RUN_ID);
    const observedKinds: string[] = [];

    for (let cycle = 1; cycle <= 40; cycle += 1) {
      const projected = projectLoopV2Event(
        state,
        envelope(cycle + 2, {
          type: "context.compacted",
          summarizedSeqThrough: state.lastSeq,
          artifactRefs: [`artifact://compact-${cycle}`],
        }),
      );
      const observed = advance(advisor, cycle, projected, []);
      for (const item of observed.advice) {
        observedKinds.push(item.kind);
        expect("allowed" in item).toBeFalse();
        expect("blocked" in item).toBeFalse();
      }
      state = projected.state;
      advisor = observed.state;
    }

    expect(observedKinds).toEqual([
      "evidence_gap",
      "hypothesis_stale",
      "cost_warning",
      "cost_warning",
      "cost_warning",
      "cost_warning",
    ]);
    expect(advisor.consecutiveNoDeltaCycles).toBe(40);
  });

  test("canonical action keys and policy configuration fail closed", () => {
    const state = bootstrap();
    const projected = projectLoopV2Event(
      state,
      envelope(2, {
        type: "context.compacted",
        summarizedSeqThrough: 1,
        artifactRefs: [],
      }),
    );
    const first = advanceProgressAdvisorV2(
      createProgressAdvisorStateV2(RUN_ID),
      {
        cycle: 1,
        projectedThroughSeq: 2,
        actions: [action("workspace.grep", { path: "src", pattern: "x" })],
        deltas: [projected.delta],
      },
      projected.state,
    );
    const second = advanceProgressAdvisorV2(
      first.state,
      {
        cycle: 2,
        projectedThroughSeq: 2,
        actions: [
          {
            tool: "workspace.todo_write",
            args: { todos: [] },
            repeatTracking: "transparent",
          },
          action("workspace.grep", { pattern: "x", path: "src" }),
        ],
        deltas: [],
      },
      projected.state,
    );
    expect(second.state.repeat?.count).toBe(2);

    const invalid: ProgressAdvisorConfigV2 = {
      policyVersion: "paw-progress-advisor-v2",
      repeatThresholds: [5, 3],
      noDeltaThresholds: {
        inspectGap: 4,
        changeHypothesis: 8,
        safetyWarning: 16,
      },
    };
    expect(() =>
      advanceProgressAdvisorV2(
        createProgressAdvisorStateV2(RUN_ID),
        {
          cycle: 1,
          projectedThroughSeq: 2,
          actions: [],
          deltas: [],
        },
        projected.state,
        invalid,
      ),
    ).toThrow("repeat thresholds must strictly increase");
  });
});
