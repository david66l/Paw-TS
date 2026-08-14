import {
  type ShellCommandSegment,
  parseCommandChain,
} from "./shell-command.js";

export type VerificationCommandFamily =
  | "pytest"
  | "unittest"
  | "python-runner"
  | "django"
  | "javascript"
  | "node"
  | "go"
  | "cargo";

export interface VerificationCommandIntent {
  readonly family: VerificationCommandFamily;
  /** Whether the shell's final exit status proves this runner exited zero. */
  readonly exitStatusReliable: boolean;
}

type VerificationSegmentIntent = Pick<VerificationCommandIntent, "family">;

/** pytest modes which can exit successfully without executing assertions. */
const PYTEST_NON_EXECUTION_OPTIONS = new Set([
  "--collect-only",
  "--collectonly",
  "--co",
  "--fixtures",
  "--fixtures-per-test",
  "--funcargs",
  "--help",
  "--markers",
  "--setup-only",
  "--setup-plan",
  "--version",
  "-h",
]);

function executableName(token: string): string {
  return (token.replaceAll("\\", "/").split("/").at(-1) ?? token).toLowerCase();
}

function stripEnvironmentPrefix(tokens: readonly string[]): readonly string[] {
  let index = 0;
  if (tokens[index]?.toLowerCase() === "env") index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
  return tokens.slice(index);
}

function isPythonExecutable(token: string): boolean {
  return /^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i.test(
    executableName(token),
  );
}

function pythonModuleInvocation(
  tokens: readonly string[],
): { readonly module: string; readonly args: readonly string[] } | undefined {
  if (!tokens[0] || !isPythonExecutable(tokens[0])) return undefined;
  let index = 1;
  if (/^py(?:\.exe)?$/i.test(executableName(tokens[0]))) {
    if (/^-\d+(?:\.\d+)?$/.test(tokens[index] ?? "")) index += 1;
  }
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "-V" || token === "--version") return undefined;
    if (token === "-m") {
      const module = tokens[index + 1];
      return module
        ? { module: module.toLowerCase(), args: tokens.slice(index + 2) }
        : undefined;
    }
    if (/^-(?:b|E|I|O|OO|P|q|s|S|u|v|x)$/.test(token)) {
      index += 1;
      continue;
    }
    if (/^-(?:W|X)$/.test(token) && tokens[index + 1]) {
      index += 2;
      continue;
    }
    if (/^-(?:W|X).+/.test(token)) {
      index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function isNonExecutionPytestInvocation(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (arg === "-V" || arg === "-VV") return true;
    return PYTEST_NON_EXECUTION_OPTIONS.has(arg.toLowerCase());
  });
}

function pythonScriptFamily(
  tokens: readonly string[],
): VerificationCommandFamily | undefined {
  if (!tokens[0] || !isPythonExecutable(tokens[0])) return undefined;
  let index = 1;
  if (/^py(?:\.exe)?$/i.test(executableName(tokens[0]))) {
    if (/^-\d+(?:\.\d+)?$/.test(tokens[index] ?? "")) index += 1;
  }
  while (/^-\w+$/.test(tokens[index] ?? "")) index += 1;
  const script = tokens[index];
  if (!script) return undefined;
  const name = executableName(script);
  if (/^(?:run_tests|runtests)\.py$/i.test(name)) return "python-runner";
  if (
    /^manage\.py$/i.test(name) &&
    tokens[index + 1]?.toLowerCase() === "test"
  ) {
    return "django";
  }
  return undefined;
}

function analyzeSegment(
  rawTokens: readonly string[],
): VerificationSegmentIntent | undefined {
  const tokens = stripEnvironmentPrefix(rawTokens);
  const executable = tokens[0] ? executableName(tokens[0]) : "";
  if (!executable) return undefined;

  if (/^pytest(?:\.exe)?$/i.test(executable)) {
    return isNonExecutionPytestInvocation(tokens.slice(1))
      ? undefined
      : { family: "pytest" };
  }

  const module = pythonModuleInvocation(tokens);
  if (module?.module === "pytest") {
    return isNonExecutionPytestInvocation(module.args)
      ? undefined
      : { family: "pytest" };
  }
  if (module?.module === "unittest") return { family: "unittest" };
  if (module?.module === "django" && module.args[0]?.toLowerCase() === "test") {
    return { family: "django" };
  }

  const pythonFamily = pythonScriptFamily(tokens);
  if (pythonFamily) return { family: pythonFamily };
  if (/^(?:run_tests|runtests)\.py$/i.test(executable)) {
    return { family: "python-runner" };
  }

  if (/^(?:npm|pnpm|yarn|bun)(?:\.exe|\.cmd)?$/i.test(executable)) {
    const first = tokens[1]?.toLowerCase();
    const second = tokens[2]?.toLowerCase();
    if (first === "test") return { family: "javascript" };
    if (
      first === "run" &&
      /^(?:test|check|build|lint|typecheck|e2e|verify)(?::[\w-]+)?$/i.test(
        second ?? "",
      )
    ) {
      return { family: "javascript" };
    }
  }
  if (/^(?:vitest|jest)(?:\.exe|\.cmd)?$/i.test(executable)) {
    return { family: "javascript" };
  }
  if (
    /^npx(?:\.exe|\.cmd)?$/i.test(executable) &&
    /^(?:vitest|jest)$/i.test(tokens[1] ?? "")
  ) {
    return { family: "javascript" };
  }
  if (/^node(?:\.exe)?$/i.test(executable)) {
    const script = tokens[1] ? executableName(tokens[1]) : "";
    if (/(?:test|smoke|verify|e2e)/i.test(script)) return { family: "node" };
  }
  if (executable === "go" && tokens[1]?.toLowerCase() === "test") {
    return { family: "go" };
  }
  if (executable === "cargo" && tokens[1]?.toLowerCase() === "test") {
    return { family: "cargo" };
  }
  return undefined;
}

function exitStatusProvesVerification(
  chain: readonly ShellCommandSegment[],
  verificationIndex: number,
): boolean {
  // An earlier OR fallback may skip this verification entirely when its left
  // side succeeds. A background predecessor is similarly not an ordered proof.
  for (let index = 0; index < verificationIndex; index += 1) {
    const connector = chain[index]?.connectorAfter;
    if (connector === "||" || connector === "&") return false;
  }

  // A following `&&` can only produce overall success after this runner
  // succeeds. Pipes, fallbacks, sequential lists, and background execution can
  // all replace or detach the runner's status, so they are not pass evidence.
  for (let index = verificationIndex; index < chain.length; index += 1) {
    const connector = chain[index]?.connectorAfter;
    if (connector && connector !== "&&") return false;
  }
  return true;
}

/** Analyze whether a shell command actually intends to execute assertions. */
export function analyzeVerificationCommand(
  command: string,
): VerificationCommandIntent | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (/\b(?:pip3?|uv|npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/i.test(trimmed)) {
    return undefined;
  }
  const chain = parseCommandChain(trimmed);
  if (!chain) return undefined;
  for (let index = 0; index < chain.length; index += 1) {
    const segment = chain[index];
    if (!segment) continue;
    const intent = analyzeSegment(segment.tokens);
    if (intent) {
      return {
        ...intent,
        exitStatusReliable: exitStatusProvesVerification(chain, index),
      };
    }
  }
  return undefined;
}

export function verificationCommandFamily(
  command: string,
): VerificationCommandFamily | undefined {
  return analyzeVerificationCommand(command)?.family;
}

export function isVerificationCommand(command: string): boolean {
  return analyzeVerificationCommand(command) !== undefined;
}
