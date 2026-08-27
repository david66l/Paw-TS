import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCheckpoint } from "@paw/core";

import { createToolCheckpointNamespaceIdV1 } from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next tool checkpoint physical namespace", () => {
  test("is stable for one canonical workspace/session/run owner", () => {
    const root = workspace();
    const input = {
      workspaceRoot: root,
      sessionId: "session-a",
      runId: "run-a",
    };

    expect(createToolCheckpointNamespaceIdV1(input)).toBe(
      createToolCheckpointNamespaceIdV1({
        ...input,
        workspaceRoot: path.join(root, "."),
      }),
    );
    expect(createToolCheckpointNamespaceIdV1(input)).toMatch(
      /^pawnextv1_[0-9a-f]{64}$/,
    );
  });

  test("separates equal run ids owned by different sessions", () => {
    const root = workspace();
    const first = createToolCheckpointNamespaceIdV1({
      workspaceRoot: root,
      sessionId: "session-a",
      runId: "same-run",
    });
    const second = createToolCheckpointNamespaceIdV1({
      workspaceRoot: root,
      sessionId: "session-b",
      runId: "same-run",
    });
    expect(first).not.toBe(second);

    saveCheckpoint(root, first, 1, "workspace.run_shell", {
      command: "echo first",
    });
    saveCheckpoint(root, second, 1, "workspace.run_shell", {
      command: "echo second",
    });
    expect(checkpointMeta(root, first, 1)).toBe(true);
    expect(checkpointMeta(root, second, 1)).toBe(true);
  });

  test("binds the namespace to the canonical workspace and run identity", () => {
    const firstRoot = workspace();
    const secondRoot = workspace();
    const base = { sessionId: "session", runId: "run" };

    expect(
      createToolCheckpointNamespaceIdV1({
        workspaceRoot: firstRoot,
        ...base,
      }),
    ).not.toBe(
      createToolCheckpointNamespaceIdV1({
        workspaceRoot: secondRoot,
        ...base,
      }),
    );
    expect(
      createToolCheckpointNamespaceIdV1({
        workspaceRoot: firstRoot,
        sessionId: "session",
        runId: "run-a",
      }),
    ).not.toBe(
      createToolCheckpointNamespaceIdV1({
        workspaceRoot: firstRoot,
        sessionId: "session",
        runId: "run-b",
      }),
    );
  });
});

function checkpointMeta(root: string, namespace: string, seq: number): boolean {
  return fs.existsSync(
    path.join(
      root,
      ".paw",
      "checkpoints",
      namespace,
      String(seq),
      "_meta.json",
    ),
  );
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-checkpoint-ns-"));
  roots.push(root);
  return root;
}
