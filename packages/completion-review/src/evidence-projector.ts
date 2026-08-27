import type { JsonValue, ToolSettlementStatusV1 } from "@paw/protocol";

import type {
  CompletionReviewEvidenceOutcomeV1,
  CompletionReviewToolEvidenceV1,
  CompletionReviewVerificationKindV1,
} from "./candidate.js";

export interface CompletionReviewRawToolEvidenceV1 {
  readonly seq: number;
  readonly callId: string;
  readonly tool: string;
  readonly status: ToolSettlementStatusV1;
  readonly args: JsonValue;
  readonly summary: string;
  readonly isError?: boolean;
  readonly payload?: JsonValue;
}

export function projectCompletionReviewToolEvidenceV1(input: {
  readonly calls: readonly CompletionReviewRawToolEvidenceV1[];
  readonly latestMutationSeq: number;
}): readonly CompletionReviewToolEvidenceV1[] {
  const jobCommands = projectJobCommands(input.calls);
  return Object.freeze(
    input.calls.map((call) => {
      const command = commandFor(call, jobCommands);
      const verificationKind = classifyVerificationCommandV1(command);
      const verificationTarget = projectVerificationTargetV1(
        command,
        verificationKind,
      );
      const exitCode = projectExitCode(call);
      const timedOut = projectTimedOut(call);
      const outcome = projectOutcome(call, timedOut);
      return Object.freeze({
        callId: call.callId,
        tool: call.tool,
        executionStatus: call.status,
        outcome:
          outcome === "passed" && masksVerificationExitV1(command)
            ? "indeterminate"
            : outcome,
        verificationKind,
        ...(verificationTarget === undefined ? {} : { verificationTarget }),
        args: call.args,
        summary: call.summary,
        afterLatestMutation:
          input.latestMutationSeq === 0 || call.seq > input.latestMutationSeq,
        ...(call.isError === undefined ? {} : { isError: call.isError }),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(timedOut ? { timedOut: true } : {}),
      });
    }),
  );
}

function projectVerificationTargetV1(
  command: string | undefined,
  kind: CompletionReviewVerificationKindV1,
): string | undefined {
  if (!command?.trim() || kind === "none") return undefined;
  const invocation = verificationInvocationV1(command, kind);
  const withoutTrailingCommand = invocation.replace(/;\s*\S[\s\S]*$/u, "");
  const withoutOutputFilter = withoutTrailingCommand.replace(
    /\s+(?:\d?>&\d+\s*)?\|\s*(?:tail|head|grep|tee)\b[\s\S]*$/iu,
    "",
  );
  const normalized = withoutOutputFilter
    .replace(/\s+\d?>&\d+\s*$/u, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return normalized ? `${kind}:${normalized}` : undefined;
}

function masksVerificationExitV1(command: string | undefined): boolean {
  if (!command) return false;
  const kind = classifyVerificationCommandV1(command);
  if (kind === "none") return false;
  return /;\s*\S/u.test(verificationInvocationV1(command, kind));
}

function verificationInvocationV1(
  command: string,
  kind: Exclude<CompletionReviewVerificationKindV1, "none">,
): string {
  const marker =
    kind === "test"
      ? /(?:pytest|py\.test|jest|vitest|mocha|ava|rspec|phpunit|ctest|(?:go|cargo|dotnet|mvn|gradle|gradlew)\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|(?:python(?:\d+(?:\.\d+)*)?(?:\.exe)?|py)\s+(?:-m\s+(?:unittest|pytest)|(?:[^\s;&|]*[\\/])?(?:runtests|manage)\.py)|(?:\.\.?[\\/])?[^\s;&|]*runtests\.py|node\s+--test|make\s+(?:test|check))/iu
      : kind === "lint"
        ? /(?:eslint|stylelint|ruff|flake8|pylint|golangci-lint|clippy|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint)/iu
        : kind === "typecheck"
          ? /(?:tsc|mypy|pyright|typecheck|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check-types))/iu
          : /(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|cargo\s+build|go\s+build|dotnet\s+build|mvn\s+package|gradle(?:w)?\s+build)/iu;
  const index = command.search(marker);
  return index < 0 ? command : command.slice(index);
}

export function classifyVerificationCommandV1(
  command: string | undefined,
): CompletionReviewVerificationKindV1 {
  if (!command?.trim()) return "none";
  const value = ` ${command.toLowerCase().replaceAll(/\s+/gu, " ")} `;
  if (
    /(?:^|[\s;&|])(pytest|py\.test|jest|vitest|mocha|ava|rspec|phpunit|ctest)(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(go|cargo|dotnet|mvn|gradle|gradlew)(?:\.\w+)?\s+test(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w.-]+)?(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(?:python(?:\d+(?:\.\d+)*)?(?:\.exe)?|py)\s+-m\s+(?:unittest|pytest)(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(?:python(?:\d+(?:\.\d+)*)?(?:\.exe)?|py)\s+(?:[^\s;&|]*[\\/])?runtests\.py(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(?:python(?:\d+(?:\.\d+)*)?(?:\.exe)?|py)\s+(?:[^\s;&|]*[\\/])?manage\.py\s+test(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(?:\.\.?[\\/])?[^\s;&|]*runtests\.py(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])node\s+--test(?:[\s;&|]|$)/u.test(value) ||
    /(?:^|[\s;&|])make\s+(?:test|check)(?:[\s;&|]|$)/u.test(value)
  ) {
    return "test";
  }
  if (
    /(?:^|[\s;&|])(eslint|stylelint|ruff|flake8|pylint|golangci-lint|clippy)(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?:[\s;&|]|$)/u.test(
      value,
    )
  ) {
    return "lint";
  }
  if (
    /(?:^|[\s;&|])(tsc|mypy|pyright|typecheck)(?:[\s;&|]|$)/u.test(value) ||
    /(?:^|[\s;&|])(npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check-types)(?:[\s;&|]|$)/u.test(
      value,
    )
  ) {
    return "typecheck";
  }
  if (
    /(?:^|[\s;&|])(npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:[\s;&|]|$)/u.test(
      value,
    ) ||
    /(?:^|[\s;&|])(cargo\s+build|go\s+build|dotnet\s+build|mvn\s+package|gradle(?:w)?\s+build)(?:[\s;&|]|$)/u.test(
      value,
    )
  ) {
    return "build";
  }
  return "none";
}

function projectJobCommands(
  calls: readonly CompletionReviewRawToolEvidenceV1[],
): ReadonlyMap<string, string> {
  const commands = new Map<string, string>();
  for (const call of calls) {
    if (!isTool(call.tool, "job_start")) continue;
    const jobId = stringField(call.payload, "jobId");
    const command = stringField(call.args, "command");
    if (jobId && command) commands.set(jobId, command);
  }
  return commands;
}

function commandFor(
  call: CompletionReviewRawToolEvidenceV1,
  jobCommands: ReadonlyMap<string, string>,
): string | undefined {
  if (isTool(call.tool, "run_shell")) {
    return stringField(call.args, "command");
  }
  if (isTool(call.tool, "job_wait")) {
    const id = stringField(call.args, "id");
    return id ? jobCommands.get(id) : undefined;
  }
  return undefined;
}

function projectOutcome(
  call: CompletionReviewRawToolEvidenceV1,
  timedOut: boolean,
): CompletionReviewEvidenceOutcomeV1 {
  if (call.status !== "completed" || timedOut) return "indeterminate";
  if (isTool(call.tool, "job_wait")) {
    const status = nestedStringField(call.payload, "snapshot", "status");
    if (status === "completed") return "passed";
    if (status === "failed" || status === "killed") return "failed";
    return "indeterminate";
  }
  return call.isError === false
    ? "passed"
    : call.isError === true
      ? "failed"
      : "indeterminate";
}

function projectExitCode(
  call: CompletionReviewRawToolEvidenceV1,
): number | undefined {
  const direct = numberField(call.payload, "exit_code");
  if (direct !== undefined) return direct;
  if (!isTool(call.tool, "job_wait")) return undefined;
  const detail = nestedStringField(call.payload, "snapshot", "detail");
  const match = detail?.match(/^exit code:\s*(\d+)$/iu);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function projectTimedOut(call: CompletionReviewRawToolEvidenceV1): boolean {
  if (booleanField(call.payload, "timed_out") === true) return true;
  if (booleanField(call.payload, "timedOut") === true) return true;
  return stringField(call.payload, "error_code") === "E_RETRY";
}

function isTool(tool: string, suffix: string): boolean {
  return tool === `workspace_${suffix}` || tool === `workspace.${suffix}`;
}

function record(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function stringField(
  value: JsonValue | undefined,
  field: string,
): string | undefined {
  const item = record(value)?.[field];
  return typeof item === "string" ? item : undefined;
}

function numberField(
  value: JsonValue | undefined,
  field: string,
): number | undefined {
  const item = record(value)?.[field];
  return typeof item === "number" && Number.isSafeInteger(item) && item >= 0
    ? item
    : undefined;
}

function booleanField(
  value: JsonValue | undefined,
  field: string,
): boolean | undefined {
  const item = record(value)?.[field];
  return typeof item === "boolean" ? item : undefined;
}

function nestedStringField(
  value: JsonValue | undefined,
  parent: string,
  field: string,
): string | undefined {
  return stringField(record(value)?.[parent], field);
}
