import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  PAW_NEXT_NEW_WORK_CLI_REPORT_SCHEMA_V1,
  PAW_NEXT_NEW_WORK_STDIN_MAX_BYTES_V1,
  runPawNextNewWorkCliV3,
} from "../src/paw-next/new-work-cli-v3.js";

const roots: string[] = [];
const encoder = new TextEncoder();
const USAGE =
  "Usage: paw-ts paw-next --new-work-v3 --root <absolute-workspace> --session-id <id> --run-id <id> --input-id <id> --caller-id <id> --stdin-json";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next explicit V3 new-work CLI", () => {
  test("rejects non-exact argv and unavailable roots before reading stdin or touching a workspace", async () => {
    const root = workspace();
    const invalid: readonly (readonly string[])[] = [
      [],
      args(root).slice(0, -1),
      [...args(root), "extra"],
      ["--new-work-v3", "--root", ".", ...args(root).slice(3)],
      swap(args(root), 3, 5),
      replace(args(root), 8, "bad input with spaces"),
      replace(args(root), 11, "--stdin-file"),
      replace(args(root), 0, "--startup-scan-v3"),
    ];

    for (const candidate of invalid) {
      const stdin = countedChunks([validBody("must not read")]);
      expect(
        await runPawNextNewWorkCliV3(candidate, { stdin: stdin.values }),
        candidate.join(" "),
      ).toEqual({ exitCode: 2, stream: "stderr", text: USAGE });
      expect(stdin.reads()).toBe(0);
    }

    const missing = path.join(root, "missing-workspace");
    const stdin = countedChunks([validBody("must not read")]);
    const unavailable = await runPawNextNewWorkCliV3(args(missing), {
      stdin: stdin.values,
    });
    expect(stdin.reads()).toBe(0);
    expect(unavailable.exitCode).toBe(1);
    expect(JSON.parse(unavailable.text)).toEqual({
      ...reportIdentity(),
      outcome: "failed",
      reasonCode: "workspace_unavailable",
    });
    expect(unavailable.text).not.toContain(root);
    expect(fs.existsSync(missing)).toBeFalse();
  });

  test("rejects TTY, malformed JSON, invalid UTF-8, and non-byte chunks before catalog or write", async () => {
    const root = workspace();
    const before = fs.readdirSync(root);
    const invalidBodies: readonly AsyncIterable<Uint8Array>[] = [
      chunks([]),
      chunks([bytes("")]),
      chunks([bytes(" ")]),
      chunks([bytes("null")]),
      chunks([bytes("[]")]),
      chunks([bytes("{}")]),
      chunks([bytes('{"content":1}')]),
      chunks([bytes('{"content":""}')]),
      chunks([bytes('{"content":"   "}')]),
      chunks([bytes('{"content":"x","extra":true}')]),
      chunks([bytes('{"content":"x"} trailing')]),
      chunks([new Uint8Array([0xc3, 0x28])]),
      chunks(["not bytes" as unknown as Uint8Array]),
      chunks([
        "x".repeat(
          PAW_NEXT_NEW_WORK_STDIN_MAX_BYTES_V1 + 1,
        ) as unknown as Uint8Array,
      ]),
    ];

    for (const stdin of invalidBodies) {
      const productCalls = { value: 0 };
      const result = await runPawNextNewWorkCliV3(args(root), {
        stdin,
        invokeProduct: async () => {
          productCalls.value += 1;
          throw new Error("must not invoke product");
        },
      });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.text)).toEqual({
        ...reportIdentity(),
        outcome: "invalid_request",
        reasonCode: "stdin_request_invalid",
      });
      expect(productCalls.value).toBe(0);
      expect(fs.readdirSync(root)).toEqual(before);
    }

    const tty = countedChunks([validBody("must not read")]);
    const ttyResult = await runPawNextNewWorkCliV3(args(root), {
      stdin: tty.values,
      stdinIsTTY: true,
    });
    expect(ttyResult.exitCode).toBe(2);
    expect(tty.reads()).toBe(0);
    expect(fs.readdirSync(root)).toEqual(before);
  });

  test("enforces the raw one-MiB boundary while accepting split multibyte UTF-8", async () => {
    const root = workspace();
    const emptyBodyBytes = validBody("").byteLength;
    const exact = validBody(
      "a".repeat(PAW_NEXT_NEW_WORK_STDIN_MAX_BYTES_V1 - emptyBodyBytes),
    );
    expect(exact.byteLength).toBe(PAW_NEXT_NEW_WORK_STDIN_MAX_BYTES_V1);

    const atLimit = await runPawNextNewWorkCliV3(args(root), {
      stdin: chunks([exact.subarray(0, 17), exact.subarray(17)]),
    });
    expect(atLimit.exitCode).toBe(1);
    expect(JSON.parse(atLimit.text).reasonCode).toBe(
      "configuration_unavailable",
    );

    const overLimit = await runPawNextNewWorkCliV3(args(root), {
      stdin: chunks([exact, bytes(" ")]),
    });
    expect(overLimit.exitCode).toBe(2);
    expect(JSON.parse(overLimit.text).reasonCode).toBe("stdin_request_invalid");

    const unicode = validBody("跨分块文本");
    const splitInsideCodePoint = unicode.findIndex(
      (value, index) => index > 0 && value >= 0x80,
    );
    const split = await runPawNextNewWorkCliV3(args(root), {
      stdin: chunks([
        unicode.subarray(0, splitInsideCodePoint + 1),
        unicode.subarray(splitInsideCodePoint + 1),
      ]),
    });
    expect(split.exitCode).toBe(1);
    expect(JSON.parse(split.text).reasonCode).toBe("configuration_unavailable");
  });

  test("invokes one exact V3 product and emits only bounded operational evidence", () => {
    const completed = runMockChild("completed");
    expect(completed.catalogFactoryCalls).toBe(1);
    expect(completed.resolverCalls).toBe(1);
    expect(completed.inventoryReads).toBe(1);
    expect(completed.prefixReads).toBe(1);
    expect(completed.productCalls).toBe(1);
    expect(completed.timeoutCalls + completed.intervalCalls).toBe(0);
    expect(completed.result.exitCode).toBe(0);
    expect(JSON.parse(completed.result.text)).toEqual({
      ...reportIdentity(),
      outcome: "completed",
      inputAcceptance: "accepted",
      segmentStart: "started",
      segmentIndex: 2,
      tailSeq: 17,
      controlStatus: "completed",
    });
    assertReportRedacted(completed);

    const retry = runMockChild("retry");
    expect(retry.productCalls).toBe(1);
    expect(JSON.parse(retry.result.text)).toMatchObject({
      outcome: "completed",
      inputAcceptance: "already_accepted",
      segmentStart: "already_started",
    });
    assertReportRedacted(retry);
  });

  test("uses fixed exit-one reports for attention, missing config, and runtime errors", () => {
    const attention = runMockChild("attention");
    expect(attention.result.exitCode).toBe(1);
    expect(JSON.parse(attention.result.text)).toMatchObject({
      outcome: "attention",
      controlStatus: "await_user",
    });
    expect(attention.productCalls).toBe(1);
    assertReportRedacted(attention);

    const missing = runMockChild("config_missing");
    expect(missing.result.exitCode).toBe(1);
    expect(JSON.parse(missing.result.text)).toEqual({
      ...reportIdentity(),
      outcome: "failed",
      reasonCode: "configuration_unavailable",
    });
    expect(missing.productCalls).toBe(0);
    assertReportRedacted(missing);

    const failed = runMockChild("runtime_throw");
    expect(failed.result.exitCode).toBe(1);
    expect(JSON.parse(failed.result.text)).toEqual({
      ...reportIdentity(),
      outcome: "failed",
      reasonCode: "runtime_failed",
    });
    expect(failed.productCalls).toBe(1);
    assertReportRedacted(failed);
  });

  test("contains no scanner, timer, retry, attachment, or ambient-input seam", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../src/paw-next/new-work-cli-v3.ts"),
      "utf8",
    );
    for (const forbidden of [
      "scanAndResume",
      "setTimeout",
      "setInterval",
      "attachments",
      "process.env",
      "process.cwd",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

interface MockChildResult {
  readonly result: {
    readonly exitCode: number;
    readonly stream: string;
    readonly text: string;
  };
  readonly secret: string;
  readonly workspaceRoot: string;
  readonly catalogFactoryCalls: number;
  readonly resolverCalls: number;
  readonly inventoryReads: number;
  readonly prefixReads: number;
  readonly productCalls: number;
  readonly timeoutCalls: number;
  readonly intervalCalls: number;
}

function runMockChild(scenario: string): MockChildResult {
  const root = workspace();
  const fixture = path.join(
    import.meta.dir,
    "fixtures",
    "paw-next-new-work-cli-v3-mock-child.ts",
  );
  const result = spawnSync(process.execPath, [fixture, scenario, root], {
    cwd: path.resolve(import.meta.dir, ".."),
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `V3 new-work CLI mock child failed ${String(result.status)}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as MockChildResult;
}

function assertReportRedacted(result: MockChildResult): void {
  expect(result.result.text).not.toContain(result.secret);
  expect(result.result.text).not.toContain(result.workspaceRoot);
  expect(result.result.text).not.toContain("cli-caller");
  expect(result.result.text).not.toContain("private");
  expect(result.result.text).not.toContain("assistant");
  expect(result.result.text).not.toContain("model");
  expect(result.result.text).not.toContain("credential");
}

function args(root: string): readonly string[] {
  return [
    "--new-work-v3",
    "--root",
    root,
    "--session-id",
    "session-v3",
    "--run-id",
    "run-v3",
    "--input-id",
    "queued-input",
    "--caller-id",
    "cli-caller",
    "--stdin-json",
  ];
}

function reportIdentity() {
  return {
    schemaVersion: PAW_NEXT_NEW_WORK_CLI_REPORT_SCHEMA_V1,
    productCatalog: "v3",
    mode: "once",
    sessionId: "session-v3",
    runId: "run-v3",
    inputId: "queued-input",
  };
}

function validBody(content: string): Uint8Array {
  return bytes(JSON.stringify({ content }));
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

async function* chunks(
  values: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

function countedChunks(values: readonly Uint8Array[]) {
  let readCount = 0;
  return {
    values: (async function* () {
      for (const value of values) {
        readCount += 1;
        yield value;
      }
    })(),
    reads: () => readCount,
  };
}

function swap(
  values: readonly string[],
  left: number,
  right: number,
): readonly string[] {
  const result = [...values];
  const temporary = result[left] as string;
  result[left] = result[right] as string;
  result[right] = temporary;
  return result;
}

function replace(
  values: readonly string[],
  index: number,
  value: string,
): readonly string[] {
  const result = [...values];
  result[index] = value;
  return result;
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-new-work-cli-v3-"));
  roots.push(root);
  return root;
}
