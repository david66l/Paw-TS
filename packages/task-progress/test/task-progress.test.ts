import { describe, expect, test } from "bun:test";
import {
  PROGRESS_READ,
  TODO_WRITE,
  type TaskProgressServiceV1,
  executeTool,
} from "@paw/harness";
import type {
  InputFactV1,
  JsonValue,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import { createFrozenToolRegistryV1 } from "@paw/runtime";

import {
  TASK_PROGRESS_TOOL_PLUGIN_VERSION_V1,
  createTaskProgressServiceV1,
  createTaskProgressToolPluginV1,
  normalizeTaskProgressItemsV1,
  projectTaskProgressSnapshotV1,
} from "../src/index.js";

const signal = new AbortController().signal;

describe("durable task progress plugin", () => {
  test("validates one bounded, unambiguous task list", () => {
    expect(() =>
      normalizeTaskProgressItemsV1(
        [
          { id: "same", content: "one", status: "pending" },
          { id: "same", content: "two", status: "pending" },
        ],
        { maxItems: 10, maxItemIdChars: 20, maxItemContentChars: 100 },
      ),
    ).toThrow("duplicate");
    expect(() =>
      normalizeTaskProgressItemsV1(
        [
          { id: "one", content: "one", status: "in_progress" },
          { id: "two", content: "two", status: "in_progress" },
        ],
        { maxItems: 10, maxItemIdChars: 20, maxItemContentChars: 100 },
      ),
    ).toThrow("only one");
  });

  test("rebuilds only from a committed tool observation and merges live jobs", async () => {
    const prefix: RunJournalEnvelopeV1[] = [];
    const options = {
      readCanonicalPrefix: async () => prefix,
      loadPayloadEvidence: async () => {
        throw new Error("inline progress must not load artifact evidence");
      },
      listActivities: () => [
        {
          schemaVersion: "paw.managed-job.v1" as const,
          id: "shell-1",
          ownerId: "run-1",
          kind: "shell",
          label: "bun test",
          status: "running" as const,
          startedAt: 100,
          reported: false,
        },
      ],
      clock: () => 160,
    };
    const writer = createTaskProgressServiceV1(options);
    const first = await writer.write(
      [
        { id: "inspect", content: "Inspect code", status: "done" },
        {
          id: "test",
          content: "Run tests",
          status: "in_progress",
          priority: "high",
        },
      ],
      signal,
    );
    expect(first).toMatchObject({
      ok: true,
      value: {
        revision: 1,
        total: 2,
        completed: 1,
        percent: 50,
        status: "in_progress",
        current: "Run tests",
      },
    });
    if (!first.ok) throw new Error(first.reason);

    const beforeCommit =
      await createTaskProgressServiceV1(options).read(signal);
    expect(beforeCommit).toMatchObject({
      ok: true,
      value: { activities: [{ id: "shell-1", elapsedMs: 60 }] },
    });
    if (beforeCommit.ok) expect(beforeCommit.value.snapshot).toBeUndefined();

    prefix.push(
      envelope(1, {
        type: "tool.call_observed",
        turn: 1,
        modelCallId: "model-1",
        order: 0,
        callId: "call-progress-1",
        tool: "workspace_todo_write",
        args: inline({ todos: first.value.items }),
      }),
      envelope(2, {
        type: "tool.settled",
        callId: "call-progress-1",
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "todo_write: 2 task(s), 50% complete",
          isError: false,
          payload: inline(first.value),
        },
      }),
    );

    const recovered = createTaskProgressServiceV1(options);
    expect(await recovered.read(signal)).toMatchObject({
      ok: true,
      value: {
        snapshot: { revision: 1, percent: 50, current: "Run tests" },
        activities: [{ status: "running", elapsedMs: 60 }],
      },
    });
    expect(
      await recovered.write(
        [
          { id: "inspect", content: "Inspect code", status: "done" },
          { id: "test", content: "Run tests", status: "done" },
        ],
        signal,
      ),
    ).toMatchObject({ ok: true, value: { revision: 2, percent: 100 } });
  });

  test("ignores failed updates and rejects forged derived fields", async () => {
    const valid = {
      schemaVersion: "paw.task-progress.v1" as const,
      revision: 1,
      items: [{ id: "one", content: "One", status: "done" as const }],
      total: 1,
      completed: 1,
      percent: 100,
      status: "completed" as const,
    };
    const prefix = [
      envelope(1, {
        type: "tool.call_observed",
        turn: 1,
        modelCallId: "model-1",
        order: 0,
        callId: "ok",
        tool: "workspace_todo_write",
        args: inline({ todos: valid.items }),
      }),
      envelope(2, {
        type: "tool.settled",
        callId: "ok",
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "ok",
          isError: false,
          payload: inline(valid),
        },
      }),
      envelope(3, {
        type: "tool.call_observed",
        turn: 2,
        modelCallId: "model-2",
        order: 0,
        callId: "failed",
        tool: "workspace_todo_write",
        args: inline({ todos: [] }),
      }),
      envelope(4, {
        type: "tool.settled",
        callId: "failed",
        status: "failed",
        errorCode: "E_TEST",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "failed",
          isError: true,
        },
      }),
    ];
    const load = async () => {
      throw new Error("not used");
    };
    expect(await projectTaskProgressSnapshotV1(prefix, load)).toEqual(valid);

    const forged = prefix.slice(0, 2);
    const settled = forged[1];
    if (!settled || settled.record.kind !== "input_fact") throw new Error();
    forged[1] = envelope(2, {
      ...settled.record.fact,
      type: "tool.settled",
      callId: "ok",
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        summary: "forged",
        isError: false,
        payload: inline({ ...valid, percent: 5 }),
      },
    });
    await expect(projectTaskProgressSnapshotV1(forged, load)).rejects.toThrow(
      "derived fields",
    );
  });

  test("rejects ambiguous parallel progress writes before issuing a revision", async () => {
    const prefix = [
      envelope(1, {
        type: "tool.call_observed",
        turn: 1,
        modelCallId: "model-1",
        order: 0,
        callId: "first",
        tool: "workspace_todo_write",
        args: inline({ todos: [] }),
      }),
      envelope(2, {
        type: "tool.call_observed",
        turn: 1,
        modelCallId: "model-1",
        order: 1,
        callId: "second",
        tool: "workspace_todo_write",
        args: inline({ todos: [] }),
      }),
    ];
    const service = createTaskProgressServiceV1({
      readCanonicalPrefix: async () => prefix,
      loadPayloadEvidence: async () => {
        throw new Error("not used");
      },
    });
    expect(await service.write([], signal)).toEqual({
      ok: false,
      reason: "only one todo_write may be pending in a tool batch",
    });
  });

  test("installs exact read-only model tools and delegates through Harness", async () => {
    const plugin = createTaskProgressToolPluginV1();
    const registry = createFrozenToolRegistryV1({
      tools: [],
      plugins: [plugin],
    });
    expect(registry.plugins).toEqual([
      {
        pluginId: "paw.task-progress",
        pluginVersion: TASK_PROGRESS_TOOL_PLUGIN_VERSION_V1,
      },
    ]);
    expect(registry.entries.map((entry) => entry.providerName)).toEqual([
      "workspace_progress_read",
      "workspace_todo_write",
    ]);
    const write = registry.validateAndClassify(
      {
        id: "write",
        name: "workspace_todo_write",
        arguments: {
          todos: [{ id: "one", content: "One", status: "in_progress" }],
        },
      },
      process.cwd(),
    );
    expect(write).toMatchObject({
      ok: true,
      value: {
        classification: {
          effectClass: "read",
          permissionCategory: "read",
          concurrencyMode: "exclusive",
          resources: [{ access: "write" }],
        },
      },
    });

    const taskProgress: TaskProgressServiceV1 = {
      async write(items) {
        return {
          ok: true,
          value: {
            schemaVersion: "paw.task-progress.v1",
            revision: 1,
            items,
            total: 1,
            completed: 0,
            percent: 0,
            status: "in_progress",
            current: "One",
          },
        };
      },
      async read() {
        return { ok: true, value: { activities: [] } };
      },
    };
    expect(
      await executeTool(
        { workspaceRoot: process.cwd(), taskProgress, abortSignal: signal },
        TODO_WRITE,
        { todos: [{ id: "one", content: "One", status: "in_progress" }] },
      ),
    ).toMatchObject({ ok: true, payload: { revision: 1 } });
    expect(
      await executeTool(
        { workspaceRoot: process.cwd(), taskProgress, abortSignal: signal },
        PROGRESS_READ,
        {},
      ),
    ).toMatchObject({ ok: true, payload: { activities: [] } });
  });
});

function inline(value: unknown) {
  return {
    kind: "inline" as const,
    value: JSON.parse(JSON.stringify(value)) as JsonValue,
    hash: "inline-hash",
  };
}

function envelope(seq: number, fact: InputFactV1): RunJournalEnvelopeV1 {
  return {
    schemaVersion: "paw.run-journal.v1",
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: seq,
    record: { kind: "input_fact", fact },
  };
}
