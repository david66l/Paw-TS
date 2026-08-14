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
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of command) {
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
    if (
      character === ";" ||
      character === "&" ||
      character === "|" ||
      character === "\n"
    ) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
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
  const tokenized: string[][] = [];
  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenizeCommandSegment(segment);
    if (!tokens) return null;
    if (tokens.length > 0) tokenized.push(tokens);
  }
  return tokenized;
}
