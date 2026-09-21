import { expect, test } from "bun:test";
import type { ToolObservationProjectionInputV1 } from "@paw/runtime";
import { createOutputRecallProjectorV1 } from "../src/index.js";

const signal = new AbortController().signal;
const value = {
  path: "src/main.ts",
  changed: true,
  bytes_written: 2000,
  linesAdded: 100,
  linesRemoved: 4,
  replacements: 2,
  diff: "+changed code\n".repeat(150),
  diagnostics: {
    status: "issues",
    issueCount: 1,
    files: [
      {
        path: "src/main.ts",
        issues: [{ message: "Missing closing brace", line: 17 }],
      },
    ],
  },
  futureMetadata: { preserve: true },
};
const observation: ToolObservationProjectionInputV1 = {
  callId: "write-1",
  tool: "workspace_write_file",
  carrierSeq: 6,
  status: "completed",
  isError: false,
  summary: "Wrote file; syntax issue",
  payload: {
    kind: "artifact_ref",
    artifactRef: `paw-payload:v1:${"a".repeat(64)}`,
    hash: "b".repeat(64),
  },
  value,
};
const project = (item = observation) =>
  createOutputRecallProjectorV1({ compactMutationReceipts: true }).project(item, signal);

test.each(["workspace_write_file", "workspace_edit_file"])(
  "%s keeps all non-diff metadata and recall identity without changing evidence",
  async (tool) => {
    const before = JSON.stringify(observation);
    const projected = await project({ ...observation, tool });
    const { diff, ...rest } = value;
    expect(projected).toMatchObject({
      ...rest,
      diffRecall: {
        policyVersion: "paw.mutation-receipt.v1",
        chars: diff.length,
        tool: "context_recall",
        id: observation.payload.kind === "artifact_ref" ? observation.payload.artifactRef : "",
        part: "chunk",
        offset: 0,
        limit: 8000,
      },
    });
    expect(projected).not.toHaveProperty("diff");
    expect(JSON.stringify(observation)).toBe(before);
    expect(JSON.stringify(projected).length).toBeLessThan(before.length);
  },
);

test("legacy projection stays exact and opt-in is captured at construction", async () => {
  expect(await createOutputRecallProjectorV1().project(observation, signal)).toBe(value);
  const options: { compactMutationReceipts?: true } = {
    compactMutationReceipts: true,
  };
  const projector = createOutputRecallProjectorV1(options);
  delete options.compactMutationReceipts;
  expect(await projector.project(observation, signal)).toEqual(await project());
});

test("failed, cancelled, no-op, inline, small and unrelated results remain intact", async () => {
  const cases: ToolObservationProjectionInputV1[] = [
    { ...observation, isError: true },
    { ...observation, status: "cancelled", isError: true },
    { ...observation, value: { ...value, changed: false } },
    { ...observation, value: { ...value, error: "partial write" } },
    { ...observation, value: { ...value, diff: "+one line" } },
    { ...observation, value: { ...value, diffRecall: "existing metadata" } },
    {
      ...observation,
      payload: { kind: "inline", value, hash: "b".repeat(64) },
    },
    ...["workspace_read_file", "workspace_run_shell", "context_recall"].map((tool) => ({
      ...observation,
      tool,
    })),
  ];
  for (const item of cases) expect(await project(item)).toBe(item.value);
});

test("large diagnostics survive receipt projection and an abort fails closed", async () => {
  const diagnostics = {
    status: "issues",
    issues: ["syntax failure".repeat(2000)],
  };
  const projected = await project({
    ...observation,
    value: { ...value, diagnostics },
  });
  expect(projected).toHaveProperty("diagnostics", diagnostics);
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    createOutputRecallProjectorV1({ compactMutationReceipts: true }).project(
      observation,
      controller.signal,
    ),
  ).toThrow();
});
