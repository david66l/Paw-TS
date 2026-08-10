import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runStubRun } from "../src/stub-run.js";

describe("runStubRun runSession", () => {
  test("invokes begin, run, then end in order", async () => {
    const order: string[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "paw-cli-rs-"));
    // .paw 锚点：否则 findPawRoot 会一路解析到用户 HOME（真实环境拖慢 run）
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
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
