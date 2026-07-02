import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runStubRun } from "../src/stub-run.js";

describe("runStubRun runSession", () => {
  test("invokes begin, run, then end in order", async () => {
    const order: string[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "paw-cli-rs-"));
    const runSession = {
      begin: () => {
        order.push("begin");
        return new AbortController().signal;
      },
      end: () => {
        order.push("end");
      },
    };
    await runStubRun("say hello only", {
      workspaceRoot: dir,
      runSession,
    });
    expect(order).toEqual(["begin", "end"]);
  });
});
