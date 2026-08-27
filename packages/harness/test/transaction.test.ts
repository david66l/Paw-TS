import { describe, expect, test } from "bun:test";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeToolTransaction, validateToolArguments } from "../src/index.js";

function workspace(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("validateToolArguments", () => {
  test("uses the canonical builtin schema", () => {
    expect(
      validateToolArguments("workspace.read_file", { path: "x.txt" }),
    ).toBeNull();

    const invalid = validateToolArguments("workspace.read_file", {
      path: 42,
    });
    expect(invalid?.ok).toBe(false);
    expect(JSON.stringify(invalid?.payload)).toContain("E_SCHEMA_INVALID");
  });
});

describe("executeToolTransaction", () => {
  test("runs policy, checkpoint, effect inspection, execution, and finalization", async () => {
    const root = workspace("paw-transaction-order-");
    const file = path.join(root, "x.txt");
    writeFileSync(file, "before\n", "utf8");
    const order: string[] = [];

    const outcome = await executeToolTransaction({
      callId: "call-order",
      runId: "run-order",
      checkpointNamespaceId: "testns_order",
      tool: "workspace.edit_file",
      args: {
        path: "x.txt",
        old_string: "before",
        new_string: "after",
      },
      context: { workspaceRoot: root },
      approval: { approved: true },
      signal: new AbortController().signal,
      checkpointSeq: 1,
      executionPolicy: () => {
        order.push("policy");
        expect(fs.readFileSync(file, "utf8")).toBe("before\n");
        return { allowed: true };
      },
      effectPolicy: {
        prepare: () => {
          order.push("effect.prepare");
          expect(fs.readFileSync(file, "utf8")).toBe("before\n");
          expect(
            fs.existsSync(
              path.join(root, ".paw", "checkpoints", "testns_order", "1"),
            ),
          ).toBe(true);
          return "prepared";
        },
        settle: (_input, prepared) => {
          order.push("effect.settle");
          expect(prepared).toBe("prepared");
          expect(fs.readFileSync(file, "utf8")).toBe("after\n");
          return { allowed: true };
        },
      },
    });

    expect(order).toEqual(["policy", "effect.prepare", "effect.settle"]);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unexpected outcome");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.checkpoint).toMatchObject({
      seq: 1,
      prepared: true,
      finalized: true,
    });
  });

  test("keeps a normal ok:false result as completed evidence", async () => {
    const root = workspace("paw-transaction-result-");
    const outcome = await executeToolTransaction({
      callId: "call-missing",
      runId: "run-missing",
      checkpointNamespaceId: "testns_missing",
      tool: "workspace.read_file",
      args: { path: "missing.txt" },
      context: { workspaceRoot: root },
      approval: { approved: true },
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") throw new Error("unexpected outcome");
    expect(outcome.executed).toBe(true);
    expect(outcome.result.ok).toBe(false);
  });

  test("safe undo resolves the same physical namespace without confusing it with runId", async () => {
    const root = workspace("paw-transaction-namespace-undo-");
    const file = path.join(root, "x.txt");
    writeFileSync(file, "before", "utf8");
    const common = {
      runId: "product-run",
      checkpointNamespaceId: "pawnextv1_test_undo",
      context: { workspaceRoot: root },
      approval: { approved: true } as const,
      signal: new AbortController().signal,
    };

    const edited = await executeToolTransaction({
      ...common,
      callId: "edit",
      tool: "workspace.edit_file",
      args: {
        path: "x.txt",
        old_string: "before",
        new_string: "after",
      },
      checkpointSeq: 1,
    });
    expect(edited.status).toBe("completed");
    expect(fs.readFileSync(file, "utf8")).toBe("after");

    const undone = await executeToolTransaction({
      ...common,
      callId: "undo",
      tool: "workspace.undo_last_edit",
      args: {},
    });
    expect(undone.status).toBe("completed");
    expect(fs.readFileSync(file, "utf8")).toBe("before");
  });

  test("pre-execution denial neither executes nor creates a checkpoint", async () => {
    const root = workspace("paw-transaction-deny-");
    const file = path.join(root, "x.txt");
    writeFileSync(file, "before\n", "utf8");
    const outcome = await executeToolTransaction({
      callId: "call-denied",
      runId: "run-denied",
      checkpointNamespaceId: "testns_denied",
      tool: "workspace.edit_file",
      args: {
        path: "x.txt",
        old_string: "before",
        new_string: "after",
      },
      context: { workspaceRoot: root },
      approval: { approved: true },
      signal: new AbortController().signal,
      checkpointSeq: 1,
      executionPolicy: () => ({
        allowed: false,
        reason: "read_only",
        message: "read-only runtime",
      }),
    });

    expect(outcome).toMatchObject({
      status: "denied",
      executed: false,
      reason: "read_only",
    });
    expect(fs.readFileSync(file, "utf8")).toBe("before\n");
    expect(fs.existsSync(path.join(root, ".paw", "checkpoints"))).toBe(false);
  });

  test("explicit approval denial neither executes nor checkpoints", async () => {
    const root = workspace("paw-transaction-approval-");
    const file = path.join(root, "x.txt");
    writeFileSync(file, "before\n", "utf8");
    const outcome = await executeToolTransaction({
      callId: "call-approval-denied",
      runId: "run-approval-denied",
      checkpointNamespaceId: "testns_approval_denied",
      tool: "workspace.edit_file",
      args: {
        path: "x.txt",
        old_string: "before",
        new_string: "after",
      },
      context: { workspaceRoot: root },
      approval: {
        approved: false,
        reason: "user_denied",
        message: "user denied the edit",
      },
      signal: new AbortController().signal,
      checkpointSeq: 1,
    });

    expect(outcome.status).toBe("denied");
    expect(fs.readFileSync(file, "utf8")).toBe("before\n");
    expect(fs.existsSync(path.join(root, ".paw", "checkpoints"))).toBe(false);
  });

  test("post-effect rejection preserves execution, recovery, and raw result", async () => {
    const root = workspace("paw-transaction-reject-");
    const file = path.join(root, "x.txt");
    writeFileSync(file, "before\n", "utf8");
    const outcome = await executeToolTransaction({
      callId: "call-rejected",
      runId: "run-rejected",
      checkpointNamespaceId: "testns_rejected",
      tool: "workspace.edit_file",
      args: {
        path: "x.txt",
        old_string: "before",
        new_string: "after",
      },
      context: { workspaceRoot: root },
      approval: { approved: true },
      signal: new AbortController().signal,
      checkpointSeq: 1,
      effectPolicy: {
        prepare: () => fs.readFileSync(file, "utf8"),
        settle: (_input, before) => {
          writeFileSync(file, String(before), "utf8");
          return {
            allowed: false,
            reason: "effect_rejected",
            message: "effect was rolled back",
            recovered: true,
          };
        },
      },
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unexpected outcome");
    expect(outcome.executed).toBe(true);
    expect(outcome.recovered).toBe(true);
    expect(outcome.originalResult.ok).toBe(true);
    expect(outcome.checkpoint?.finalized).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("before\n");
  });

  test("foreground shell abort becomes honest unknown after dispatch", async () => {
    const root = workspace("paw-transaction-abort-");
    const controller = new AbortController();
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(function(){},10000)"`;
    const started = Date.now();
    const pending = executeToolTransaction({
      callId: "call-abort",
      runId: "run-abort",
      checkpointNamespaceId: "testns_abort",
      tool: "workspace.run_shell",
      args: { command, timeout_sec: 20 },
      context: { workspaceRoot: root },
      approval: { approved: true },
      signal: controller.signal,
      checkpointSeq: 1,
    });
    setTimeout(() => controller.abort("test cancellation"), 100);

    const outcome = await pending;
    expect(outcome.status).toBe("unknown");
    if (outcome.status !== "unknown") throw new Error("unexpected outcome");
    expect(outcome.phase).toBe("execute");
    expect(outcome.error.name).toBe("AbortError");
    expect(outcome.executed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 8_000);
});
