/**
 * Recognize an executed `git diff` command without pretending to understand
 * arbitrary shell syntax. This is deliberately conservative: split only
 * top-level command segments, tokenize quotes/escapes, and accept the subset
 * of Git global options that can precede a real subcommand.
 */
export function isGitDiffCommand(command: string): boolean {
  if (/[<>$`]/.test(command)) return false;
  const segments = splitCommandSegments(command);
  if (segments.length !== 1) return false;
  const tokens = tokenizeCommandSegment(segments[0] ?? "");
  return tokens ? tokensStartGitDiff(tokens) : false;
}

const GIT_GLOBAL_FLAGS = new Set([
  "--paginate",
  "--no-pager",
  "-p",
  "-P",
  "--no-replace-objects",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
]);

const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
]);

function tokensStartGitDiff(tokens: readonly string[]): boolean {
  const executable = tokens[0]?.toLocaleLowerCase();
  if (executable !== "git" && executable !== "git.exe") return false;

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) return false;
    if (!token.startsWith("-")) {
      return token.toLocaleLowerCase() === "diff";
    }
    if (GIT_GLOBAL_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(token)) {
      if (!tokens[index + 1]) return false;
      index += 2;
      continue;
    }
    if (
      (token.startsWith("-C") && token.length > 2) ||
      isAttachedLongGitOption(token)
    ) {
      index += 1;
      continue;
    }
    return false;
  }
  return false;
}

function isAttachedLongGitOption(token: string): boolean {
  const separator = token.indexOf("=");
  if (separator <= 0 || separator === token.length - 1) return false;
  return GIT_GLOBAL_VALUE_OPTIONS.has(token.slice(0, separator));
}

export function splitCommandSegments(command: string): string[] {
  return parseCommandChain(command)?.map((segment) => segment.text) ?? [];
}

export type ShellCommandConnector = "&&" | "||" | "|" | "|&" | ";" | "&" | "\n";

export interface ShellCommandSegment {
  readonly text: string;
  readonly tokens: readonly string[];
  readonly connectorBefore?: ShellCommandConnector;
  readonly connectorAfter?: ShellCommandConnector;
}

interface RawCommandSegment {
  readonly text: string;
  connectorAfter?: ShellCommandConnector;
}

/**
 * Parse the small, quote-aware command-chain subset needed by intent and
 * evidence classifiers. It deliberately preserves control operators rather
 * than pretending every segment shares the final shell exit status.
 */
export function parseCommandChain(
  command: string,
): readonly ShellCommandSegment[] | null {
  const rawSegments: RawCommandSegment[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const finishSegment = (connectorAfter?: ShellCommandConnector): boolean => {
    const text = current.trim();
    if (!text) return false;
    rawSegments.push({ text, ...(connectorAfter ? { connectorAfter } : {}) });
    current = "";
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      current += character;
      quote = character;
      continue;
    }

    // Preserve POSIX/CMD fd duplication and Bash combined redirection. These
    // ampersands are redirection syntax, not command-chain connectors.
    if (
      character === "&" &&
      (current.trimEnd().endsWith(">") || command[index + 1] === ">")
    ) {
      current += character;
      continue;
    }

    let connector: ShellCommandConnector | undefined;
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || pair === "|&") {
      connector = pair;
      index += 1;
    } else if (character === "\r" && command[index + 1] === "\n") {
      connector = "\n";
      index += 1;
    } else if (
      character === ";" ||
      character === "&" ||
      character === "|" ||
      character === "\n"
    ) {
      connector = character === "\n" ? "\n" : character;
    }

    if (connector) {
      if (!finishSegment(connector)) {
        // Blank lines are harmless separators. Other missing operands are
        // invalid or too shell-specific for this conservative classifier.
        if (connector === "\n") continue;
        return null;
      }
      continue;
    }
    current += character;
  }

  if (quote || escaped) return null;
  if (!finishSegment()) {
    const last = rawSegments.at(-1);
    if (!last) return [];
    if (last.connectorAfter === ";" || last.connectorAfter === "\n") {
      last.connectorAfter = undefined;
    } else if (last.connectorAfter !== "&") {
      return null;
    }
  }

  const parsed: ShellCommandSegment[] = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    const segment = rawSegments[index];
    if (!segment) continue;
    const tokens = tokenizeCommandSegment(segment.text);
    if (!tokens || tokens.length === 0) return null;
    parsed.push({
      text: segment.text,
      tokens,
      ...(index > 0
        ? { connectorBefore: rawSegments[index - 1]?.connectorAfter }
        : {}),
      ...(segment.connectorAfter
        ? { connectorAfter: segment.connectorAfter }
        : {}),
    });
  }
  return parsed;
}

export function tokenizeCommandSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let tokenStarted = false;

  const finishToken = () => {
    if (!tokenStarted) return;
    tokens.push(current);
    current = "";
    tokenStarted = false;
  };

  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] ?? "";
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      const next = segment[index + 1];
      const escapesNext = quote
        ? quote === '"' && (next === '"' || next === "\\")
        : next !== undefined && /\s|["'\\]/.test(next);
      if (escapesNext) {
        escaped = true;
      } else {
        // Backslash is a path separator in Windows shells. Preserve it unless
        // it is unambiguously escaping shell whitespace, a quote, or itself.
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  if (quote || escaped) return null;
  finishToken();
  return tokens;
}

/**
 * Tokenize each top-level shell segment for intent inspection. This is not a
 * shell executor or a security parser; it only gives command classifiers one
 * shared, quote-aware view of executable and argument tokens.
 */
export function tokenizeCommandSegments(command: string): string[][] | null {
  return (
    parseCommandChain(command)?.map((segment) => [...segment.tokens]) ?? null
  );
}
