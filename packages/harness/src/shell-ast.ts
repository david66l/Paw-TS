/**
 * Shell command AST — powered by `unbash` (zero-dependency bash parser).
 *
 * We use `unbash` for parsing and then normalise its AST into a smaller,
 * opinionated set of nodes that the policy engine understands.
 *
 * `unbash` supports the full POSIX / bash grammar; we intentionally only
 * surface the subset that matters for a coding-agent harness:
 *   • command sequences (; && ||)
 *   • pipelines (|)
 *   • redirects (> >> < 2> 2>&1 etc.)
 *   • quoted strings ("..." '...')
 *   • command substitution ($(...) `...`)
 *   • variables ($VAR  ${VAR})
 *   • env-var prefixes (FOO=bar cmd)
 *
 * Other constructs (if/for/while/functions) are treated opaquely — the
 * policy engine sees them as a single command with an unknown name, which
 * conservatively triggers the "ask" default action.
 */

import { parse as unbashParse, type Node, type Word, type Redirect } from "unbash";

// ---------------------------------------------------------------------------
// Our normalised AST nodes (kept stable for the policy engine)
// ---------------------------------------------------------------------------

export interface EnvVar {
  readonly name: string;
  readonly value: string;
}

export interface RedirectNode {
  readonly op: string;
  readonly target: string;
  readonly targetHasSubstitution: boolean;
}

export interface Arg {
  readonly value: string;
  readonly raw: string;
  readonly hasSubstitution: boolean;
}

export interface Command {
  readonly type: "command";
  readonly name: string;
  readonly args: Arg[];
  readonly redirects: RedirectNode[];
  readonly envVars: EnvVar[];
}

export interface Pipeline {
  readonly type: "pipeline";
  readonly commands: Command[];
}

export interface CommandGroup {
  readonly type: "group";
  readonly operator: ";" | "&&" | "||";
  readonly left: ASTNode;
  readonly right: ASTNode;
}

export type ASTNode = Command | Pipeline | CommandGroup;

// ---------------------------------------------------------------------------
// Word analysis helpers
// ---------------------------------------------------------------------------

function wordHasSubstitution(word: Word): boolean {
  if (!word.parts) return false;
  return word.parts.some(
    (p) =>
      p.type === "CommandExpansion" ||
      p.type === "ProcessSubstitution" ||
      p.type === "ArithmeticExpansion",
  );
}

function wordValue(word: Word): string {
  return word.value;
}

function wordRaw(word: Word): string {
  return word.text;
}

// ---------------------------------------------------------------------------
// Normalisation: unbash AST → our AST
// ---------------------------------------------------------------------------

function normaliseRedirect(r: Redirect): RedirectNode | null {
  const target = r.target ? wordValue(r.target) : "";
  return {
    op: r.operator,
    target,
    targetHasSubstitution: r.target ? wordHasSubstitution(r.target) : false,
  };
}

function normaliseCommand(node: Node): Command {
  if (node.type !== "Command") {
    // Opaque construct — represent as a command with an unknown name so
    // the policy engine falls back to the conservative default.
    return {
      type: "command",
      name: "",
      args: [],
      redirects: [],
      envVars: [],
    };
  }

  const envVars: EnvVar[] = [];
  for (const p of node.prefix) {
    if (p.type === "Assignment" && p.name) {
      envVars.push({
        name: p.name,
        value: p.value ? wordValue(p.value) : "",
      });
    }
  }

  const args: Arg[] = [];
  for (const s of node.suffix) {
    args.push({
      value: wordValue(s),
      raw: wordRaw(s),
      hasSubstitution: wordHasSubstitution(s),
    });
  }

  const redirects = node.redirects
    .map(normaliseRedirect)
    .filter((r): r is RedirectNode => r !== null);

  return {
    type: "command",
    name: node.name ? wordValue(node.name).toLowerCase() : "",
    args,
    redirects,
    envVars,
  };
}

function normaliseNode(node: Node): ASTNode {
  if (node.type === "Command") {
    return normaliseCommand(node);
  }

  if (node.type === "Pipeline") {
    const commands: Command[] = [];
    for (const c of node.commands) {
      commands.push(normaliseCommand(c));
    }
    if (commands.length === 1) return commands[0]!;
    return { type: "pipeline", commands };
  }

  if (node.type === "AndOr") {
    // AndOr chains: a && b || c && d …
    // We fold them left-associatively into a binary tree.
    const cmds = node.commands.map(normaliseNode);
    const ops = node.operators;
    if (cmds.length === 0) {
      return { type: "command", name: "", args: [], redirects: [], envVars: [] };
    }
    let left = cmds[0]!;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] === "&&" ? "&&" : "||";
      const right = cmds[i + 1]!;
      left = { type: "group", operator: op, left, right };
    }
    return left;
  }

  // Opaque construct
  return { type: "command", name: "", args: [], redirects: [], envVars: [] };
}

export function parse(command: string): ASTNode {
  const script = unbashParse(command);
  if (script.commands.length === 0) {
    return { type: "command", name: "", args: [], redirects: [], envVars: [] };
  }
  if (script.commands.length === 1) {
    return normaliseNode(script.commands[0]!.command);
  }

  // Multiple top-level statements → fold with ";"
  let left = normaliseNode(script.commands[0]!.command);
  for (let i = 1; i < script.commands.length; i++) {
    const right = normaliseNode(script.commands[i]!.command);
    left = { type: "group", operator: ";", left, right };
  }
  return left;
}

// ---------------------------------------------------------------------------
// AST traversal helpers
// ---------------------------------------------------------------------------

export function* walkCommands(node: ASTNode): Generator<Command> {
  if (node.type === "command") {
    yield node;
  } else if (node.type === "pipeline") {
    for (const c of node.commands) yield c;
  } else if (node.type === "group") {
    yield* walkCommands(node.left);
    yield* walkCommands(node.right);
  }
}

export function* walkPipelines(node: ASTNode): Generator<Pipeline> {
  if (node.type === "pipeline") {
    yield node;
  } else if (node.type === "group") {
    yield* walkPipelines(node.left);
    yield* walkPipelines(node.right);
  }
}

/** Flatten a group into a list of nodes for sequential analysis. */
export function flattenGroups(node: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  function flatten(n: ASTNode) {
    if (n.type === "group") {
      flatten(n.left);
      flatten(n.right);
    } else {
      out.push(n);
    }
  }
  flatten(node);
  return out;
}
