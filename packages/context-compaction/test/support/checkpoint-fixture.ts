import {
  type InputFactV1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
  type TaskCheckpointV1,
} from "@paw/protocol";

export function sourceEntries(): readonly {
  readonly seq: number;
  readonly fact: InputFactV1;
}[] {
  return [
    {
      seq: 1,
      fact: {
        type: "input.promoted",
        inputId: "input-1",
        delivery: "initial",
        content: "Fix src/a.ts and run bun test",
        contentHash: "input-hash",
      },
    },
    {
      seq: 2,
      fact: {
        type: "tool.call_observed",
        callId: "edit-1",
        modelCallId: "model-1",
        turn: 1,
        tool: "workspace_edit_file",
        args: { path: "src/a.ts", old_string: "a", new_string: "b" },
        order: 0,
      },
    },
    {
      seq: 3,
      fact: {
        type: "tool.settled",
        callId: "edit-1",
        status: "completed",
        result: { path: "src/a.ts", changed: true },
        resultHash: "edit-hash",
        observation: {
          schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION_V1,
          summary: "updated src/a.ts",
          isError: false,
        },
      },
    },
    {
      seq: 4,
      fact: {
        type: "tool.call_observed",
        callId: "test-1",
        modelCallId: "model-1",
        turn: 1,
        tool: "workspace_run_shell",
        args: { command: "bun test" },
        order: 1,
      },
    },
    {
      seq: 5,
      fact: {
        type: "tool.settled",
        callId: "test-1",
        status: "completed",
        result: { exitCode: 0 },
        resultHash: "test-hash",
        observation: {
          schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION_V1,
          summary: "bun test exited with code 0",
          isError: false,
        },
      },
    },
  ];
}

export function validCheckpoint(
  override: Partial<TaskCheckpointV1> = {},
): TaskCheckpointV1 {
  return {
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION_V1,
    goal: item("Fix src/a.ts and run bun test", [1]),
    confirmedFacts: [item("User requested the src/a.ts fix", [1])],
    currentHypotheses: [],
    ruledOut: [],
    changedFiles: [item("Changed src/a.ts", [2, 3])],
    verification: [item("bun test completed successfully", [4, 5])],
    unresolved: [],
    nextAction: item("Report the verified result", [1]),
    ...override,
  };
}

export function item(statement: string, sourceSeqs: readonly number[]) {
  return { statement, sourceSeqs };
}
