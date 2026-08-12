/**
 * Autonomy shell policies — first-class profiles for interactive vs headless runs.
 * Headless converts ask→allow while preserving deny rules (dangerous / sensitive).
 */

import {
  createBuiltinPolicyConfig,
  setPolicyConfig,
  type PolicyAction,
  type PolicyConfig,
  type PolicyRule,
  type ToolPolicy,
} from "./shell-policy-config.js";

export type AutonomyShellLevel = "interactive" | "supervised" | "headless";

const HEADLESS_EXTRA_ALLOW: readonly PolicyRule[] = [
  { pattern: "python*", action: "allow", reason: "headless coding runtime" },
  { pattern: "python3*", action: "allow", reason: "headless coding runtime" },
  { pattern: "pytest*", action: "allow", reason: "headless test runner" },
  { pattern: "npm*", action: "allow", reason: "headless package manager" },
  { pattern: "npx*", action: "allow", reason: "headless package manager" },
  { pattern: "bun*", action: "allow", reason: "headless package manager" },
  { pattern: "node*", action: "allow", reason: "headless coding runtime" },
  { pattern: "pnpm*", action: "allow", reason: "headless package manager" },
  { pattern: "yarn*", action: "allow", reason: "headless package manager" },
  { pattern: "git*", action: "allow", reason: "headless vcs" },
  { pattern: "cargo*", action: "allow", reason: "headless coding runtime" },
  { pattern: "go*", action: "allow", reason: "headless coding runtime" },
  { pattern: "make*", action: "allow", reason: "headless build" },
  { pattern: "cmake*", action: "allow", reason: "headless build" },
  { pattern: "pip*", action: "allow", reason: "headless package manager" },
  { pattern: "uv*", action: "allow", reason: "headless package manager" },
];

function mapAskToAllow(rules: readonly PolicyRule[]): PolicyRule[] {
  return rules.map((r) =>
    r.action === "ask"
      ? {
          ...r,
          action: "allow" as const,
          reason: r.reason ?? "headless auto-allow",
        }
      : r,
  );
}

function remapToolPolicy(tool: ToolPolicy, askToAllow: boolean): ToolPolicy {
  const defaultAction: PolicyAction =
    askToAllow && tool.defaultAction === "ask" ? "allow" : tool.defaultAction;
  return {
    defaultAction,
    rules: askToAllow ? mapAskToAllow(tool.rules) : [...tool.rules],
  };
}

/** Build a PolicyConfig for the given autonomy shell level (does not apply it). */
export function buildAutonomyShellPolicy(
  level: AutonomyShellLevel,
): PolicyConfig {
  const base = createBuiltinPolicyConfig();
  if (level === "interactive" || level === "supervised") {
    return base;
  }

  const bash = base.tools.bash;
  const bashRules = bash
    ? [...mapAskToAllow(bash.rules), ...HEADLESS_EXTRA_ALLOW]
    : [...HEADLESS_EXTRA_ALLOW];

  const tools: Record<string, ToolPolicy> = {};
  for (const [name, tool] of Object.entries(base.tools)) {
    if (name === "bash") {
      tools.bash = {
        defaultAction: "allow",
        rules: bashRules,
      };
      continue;
    }
    tools[name] = remapToolPolicy(tool, true);
  }
  if (!tools.bash) {
    tools.bash = { defaultAction: "allow", rules: [...HEADLESS_EXTRA_ALLOW] };
  }

  return {
    version: `${base.version}+headless`,
    defaultAction: "allow",
    tools,
  };
}

/** Apply shell policy for an autonomy level (process-wide singleton). */
export function applyAutonomyShellPolicy(level: AutonomyShellLevel): void {
  setPolicyConfig(buildAutonomyShellPolicy(level));
}
