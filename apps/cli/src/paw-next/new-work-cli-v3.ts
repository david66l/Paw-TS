import fs from "node:fs";
import path from "node:path";

import {
  readCommittedFileRunPrefixV1,
  readFileSessionAuthorityInventoryV1,
} from "@paw/runtime";

import {
  type PawNextWorkSegmentResultV3,
  type RunExistingPawNextWorkSegmentInputV3,
  runExistingPawNextWorkSegmentV3,
} from "./composition.js";
import { readPawNextExistingBootstrapIdentityV1 } from "./existing-run-preflight.js";
import { createPawNextProductProfileCatalogV3 } from "./product-profile-catalog-v3.js";

export const PAW_NEXT_NEW_WORK_STDIN_MAX_BYTES_V1 = 1024 * 1024;
export const PAW_NEXT_NEW_WORK_CLI_REPORT_SCHEMA_V1 =
  "paw.next-new-work-cli-report.v1" as const;

export type PawNextNewWorkCliExitCodeV1 = 0 | 1 | 2;

export interface PawNextNewWorkCliResultV1 {
  readonly exitCode: PawNextNewWorkCliExitCodeV1;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface RunPawNextNewWorkCliOptionsV3 {
  readonly stdin: AsyncIterable<Uint8Array>;
  readonly stdinIsTTY?: boolean;
  /** @internal Deterministic product-invocation seam; main never overrides it. */
  readonly invokeProduct?: (
    input: RunExistingPawNextWorkSegmentInputV3,
  ) => Promise<PawNextWorkSegmentResultV3>;
}

type ParsedArgsV3 = Readonly<{
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  inputId: string;
  callerId: string;
}>;

type FailureReasonV1 =
  | "stdin_request_invalid"
  | "workspace_unavailable"
  | "configuration_unavailable"
  | "known_run_unavailable"
  | "runtime_failed";

type PawNextNewWorkCliReportV1 = Readonly<{
  schemaVersion: typeof PAW_NEXT_NEW_WORK_CLI_REPORT_SCHEMA_V1;
  productCatalog: "v3";
  mode: "once";
  sessionId: string;
  runId: string;
  inputId: string;
  outcome: "completed" | "attention" | "failed" | "invalid_request";
  reasonCode?: FailureReasonV1;
  inputAcceptance?: "accepted" | "already_accepted";
  segmentStart?: "started" | "already_started";
  segmentIndex?: number;
  tailSeq?: number;
  controlStatus?: PawNextWorkSegmentResultV3["state"]["decision"]["kind"];
}>;

/** Explicit one-shot V3 known-run new-work command. */
export async function runPawNextNewWorkCliV3(
  args: readonly string[],
  options: RunPawNextNewWorkCliOptionsV3,
): Promise<PawNextNewWorkCliResultV1> {
  const parsed = parseArgs(args);
  if (!parsed) return result(2, "stderr", usage());

  let workspaceRoot: string;
  try {
    workspaceRoot = canonicalWorkspace(parsed.workspaceRoot);
  } catch {
    return reportFailure(parsed, 1, "workspace_unavailable");
  }

  let request: Readonly<{ content: string }>;
  let captured: ReturnType<typeof captureOptions>;
  try {
    captured = captureOptions(options);
    if (captured.stdinIsTTY) {
      throw new Error("stdin must be a bounded non-interactive stream");
    }
    request = await readBoundedRequest(captured.stdin);
  } catch {
    return reportFailure(parsed, 2, "stdin_request_invalid");
  }

  let catalog: ReturnType<typeof createPawNextProductProfileCatalogV3>;
  try {
    catalog = createPawNextProductProfileCatalogV3({
      workspaceRoot,
      v3: {},
    });
  } catch {
    return reportFailure(parsed, 1, "configuration_unavailable");
  }

  let bootstrap: ReturnType<typeof readPawNextExistingBootstrapIdentityV1>;
  try {
    const inventory = readFileSessionAuthorityInventoryV1({
      workspaceRoot,
      sessionId: parsed.sessionId,
    });
    const run = inventory.runs.find((item) => item.runId === parsed.runId);
    if (!run) throw new Error("known run is absent");
    const prefix = readCommittedFileRunPrefixV1({
      workspaceRoot,
      sessionId: parsed.sessionId,
      runId: parsed.runId,
      expectedHead: run.head,
    });
    bootstrap = readPawNextExistingBootstrapIdentityV1(prefix);
  } catch {
    return reportFailure(parsed, 1, "known_run_unavailable");
  }

  let resolution: RunExistingPawNextWorkSegmentInputV3["resolution"];
  try {
    const candidate = catalog({
      workspaceRoot,
      sessionId: parsed.sessionId,
      runId: parsed.runId,
      inputId: bootstrap.inputId,
      goal: bootstrap.goal,
      configHash: bootstrap.configHash,
    });
    if (!candidate || candidate.productVersion !== "v3") {
      throw new Error("known run V3 configuration is unavailable");
    }
    resolution = candidate;
  } catch {
    return reportFailure(parsed, 1, "configuration_unavailable");
  }

  let invokeProduct: typeof runExistingPawNextWorkSegmentV3;
  try {
    invokeProduct = captured.invokeProduct ?? runExistingPawNextWorkSegmentV3;
    if (typeof invokeProduct !== "function") {
      throw new Error("product invocation is invalid");
    }
  } catch {
    return reportFailure(parsed, 1, "runtime_failed");
  }

  try {
    const productResult = await invokeProduct({
      resolution,
      work: Object.freeze({
        inputId: parsed.inputId,
        callerId: parsed.callerId,
        content: request.content,
      }),
    });
    assertProductResult(productResult, parsed.inputId);
    const controlStatus = productResult.state.decision.kind;
    const report: PawNextNewWorkCliReportV1 = Object.freeze({
      ...reportIdentity(parsed),
      outcome: controlStatus === "completed" ? "completed" : "attention",
      inputAcceptance: productResult.inputAcceptance.status,
      segmentStart: productResult.segmentStart.status,
      segmentIndex: productResult.segmentStart.segmentIndex,
      tailSeq: productResult.tailSeq,
      controlStatus,
    });
    return result(
      controlStatus === "completed" ? 0 : 1,
      "stdout",
      stableJson(report),
    );
  } catch {
    return reportFailure(parsed, 1, "runtime_failed");
  }
}

function assertProductResult(
  value: PawNextWorkSegmentResultV3,
  expectedInputId: string,
): void {
  const controlStatus = value?.state?.decision?.kind;
  if (
    controlStatus !== "continue" &&
    controlStatus !== "await_user" &&
    controlStatus !== "await_external" &&
    controlStatus !== "completed" &&
    controlStatus !== "incomplete" &&
    controlStatus !== "failed" &&
    controlStatus !== "aborted"
  ) {
    throw new Error("new-work product control status is invalid");
  }
  if (
    (value.inputAcceptance.status !== "accepted" &&
      value.inputAcceptance.status !== "already_accepted") ||
    value.inputAcceptance.inputId !== expectedInputId ||
    (value.segmentStart.status !== "started" &&
      value.segmentStart.status !== "already_started") ||
    value.segmentStart.inputId !== expectedInputId ||
    !Number.isSafeInteger(value.segmentStart.segmentIndex) ||
    value.segmentStart.segmentIndex < 1 ||
    !Number.isSafeInteger(value.tailSeq) ||
    value.tailSeq < 1
  ) {
    throw new Error("new-work product result is invalid");
  }
}

function parseArgs(args: readonly string[]): ParsedArgsV3 | undefined {
  if (
    args.length !== 12 ||
    args[0] !== "--new-work-v3" ||
    args[1] !== "--root" ||
    args[3] !== "--session-id" ||
    args[5] !== "--run-id" ||
    args[7] !== "--input-id" ||
    args[9] !== "--caller-id" ||
    args[11] !== "--stdin-json"
  ) {
    return undefined;
  }
  const workspaceRoot = args[2];
  const sessionId = args[4];
  const runId = args[6];
  const inputId = args[8];
  const callerId = args[10];
  if (
    !workspaceRoot ||
    !path.isAbsolute(workspaceRoot) ||
    !stableId(sessionId) ||
    !stableId(runId) ||
    !stableId(inputId) ||
    !stableId(callerId)
  ) {
    return undefined;
  }
  return Object.freeze({ workspaceRoot, sessionId, runId, inputId, callerId });
}

function canonicalWorkspace(requested: string): string {
  const canonical = fs.realpathSync.native(path.normalize(requested));
  const stat = fs.lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("workspace must be a real directory");
  }
  return canonical;
}

async function readBoundedRequest(
  stdin: AsyncIterable<Uint8Array>,
): Promise<Readonly<{ content: string }>> {
  if (!stdin || typeof stdin[Symbol.asyncIterator] !== "function") {
    throw new Error("stdin is not async iterable");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of stdin) {
    if (!(chunk instanceof Uint8Array)) throw new Error("stdin chunk invalid");
    totalBytes += chunk.byteLength;
    if (totalBytes > PAW_NEXT_NEW_WORK_STDIN_MAX_BYTES_V1) {
      throw new Error("stdin request exceeds byte limit");
    }
    chunks.push(chunk.slice());
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
  const parsed = JSON.parse(text) as unknown;
  if (!isPlainRecord(parsed)) throw new Error("stdin body must be an object");
  const keys = Object.keys(parsed);
  if (
    keys.length !== 1 ||
    keys[0] !== "content" ||
    typeof parsed.content !== "string" ||
    !parsed.content.trim()
  ) {
    throw new Error("stdin body is invalid");
  }
  return Object.freeze({ content: parsed.content });
}

function captureOptions(value: RunPawNextNewWorkCliOptionsV3): Readonly<{
  stdin: AsyncIterable<Uint8Array>;
  stdinIsTTY: boolean;
  invokeProduct?: RunPawNextNewWorkCliOptionsV3["invokeProduct"];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("new-work CLI options are invalid");
  }
  for (const key of Object.keys(value)) {
    if (key !== "stdin" && key !== "stdinIsTTY" && key !== "invokeProduct") {
      throw new Error("new-work CLI options are invalid");
    }
  }
  const stdinIsTTY = value.stdinIsTTY;
  if (stdinIsTTY !== undefined && typeof stdinIsTTY !== "boolean") {
    throw new Error("new-work CLI stdinIsTTY is invalid");
  }
  const source = value.stdin;
  if (!source) {
    throw new Error("new-work CLI stdin is invalid");
  }
  const iteratorFactory = source[Symbol.asyncIterator];
  if (typeof iteratorFactory !== "function") {
    throw new Error("new-work CLI stdin is invalid");
  }
  const iterator = iteratorFactory.call(source);
  if (!iterator || typeof iterator.next !== "function") {
    throw new Error("new-work CLI stdin iterator is invalid");
  }
  const next = iterator.next.bind(iterator);
  const close =
    typeof iterator.return === "function"
      ? iterator.return.bind(iterator)
      : undefined;
  const capturedStdin = Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return Object.freeze({
        next,
        ...(close === undefined ? {} : { return: close }),
      });
    },
  });
  const invokeProduct = value.invokeProduct;
  if (invokeProduct !== undefined && typeof invokeProduct !== "function") {
    throw new Error("new-work CLI product invocation is invalid");
  }
  return Object.freeze({
    stdin: capturedStdin,
    stdinIsTTY: stdinIsTTY === true,
    ...(invokeProduct === undefined ? {} : { invokeProduct }),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
  );
}

function reportFailure(
  parsed: ParsedArgsV3,
  exitCode: 1 | 2,
  reasonCode: FailureReasonV1,
): PawNextNewWorkCliResultV1 {
  const report: PawNextNewWorkCliReportV1 = Object.freeze({
    ...reportIdentity(parsed),
    outcome:
      reasonCode === "stdin_request_invalid" ? "invalid_request" : "failed",
    reasonCode,
  });
  return result(exitCode, "stdout", stableJson(report));
}

function reportIdentity(parsed: ParsedArgsV3) {
  return Object.freeze({
    schemaVersion: PAW_NEXT_NEW_WORK_CLI_REPORT_SCHEMA_V1,
    productCatalog: "v3" as const,
    mode: "once" as const,
    sessionId: parsed.sessionId,
    runId: parsed.runId,
    inputId: parsed.inputId,
  });
}

function stableJson(value: PawNextNewWorkCliReportV1): string {
  return JSON.stringify(value, null, 2);
}

function result(
  exitCode: PawNextNewWorkCliExitCodeV1,
  stream: PawNextNewWorkCliResultV1["stream"],
  text: string,
): PawNextNewWorkCliResultV1 {
  return Object.freeze({ exitCode, stream, text });
}

function usage(): string {
  return "Usage: paw-ts paw-next --new-work-v3 --root <absolute-workspace> --session-id <id> --run-id <id> --input-id <id> --caller-id <id> --stdin-json";
}
