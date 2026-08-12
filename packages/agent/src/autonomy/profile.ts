/**
 * AutonomyProfile — unified approval / ask_user / shell-policy wiring.
 *
 * Interactive, supervised, and headless share the same tool-approval bus;
 * only the default resolvers and shell policy differ.
 */

import {
  applyAutonomyShellPolicy,
  type AutonomyShellLevel,
} from "@paw/harness";
import type { AskUserResolveInput, ToolApprovalInput } from "../orchestrator.js";

export type AutonomyLevel = AutonomyShellLevel;

export interface AutonomyProfileOptions {
  readonly level: AutonomyLevel;
  /** Override tool approval (interactive UI). Headless ignores and auto-allows. */
  readonly resolveToolApproval?: (
    input: ToolApprovalInput,
  ) => Promise<boolean>;
  /** Override ask_user. Headless returns a non-interactive continue message. */
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  /**
   * Optional static policy overlay: true = always ask, false = never ask.
   * Undefined falls through to toolRequiresApproval defaults.
   */
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
}

export interface AutonomyProfile {
  readonly level: AutonomyLevel;
  readonly resolveToolApproval?: (
    input: ToolApprovalInput,
  ) => Promise<boolean>;
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  /** Apply shell policy for this profile (call once when creating the run). */
  readonly apply: () => void;
}

const HEADLESS_ASK_USER =
  "Continue with the best judgment; no interactive user is available.";

/**
 * Resolve a concrete AutonomyProfile for factory / CLI / eval.
 * Default for long-running coding agents: headless.
 */
export function createAutonomyProfile(
  opts: AutonomyProfileOptions | AutonomyLevel = "headless",
): AutonomyProfile {
  const options: AutonomyProfileOptions =
    typeof opts === "string" ? { level: opts } : opts;
  const { level } = options;

  if (level === "headless") {
    return {
      level,
      resolveToolApproval: async () => true,
      resolveAskUser: async () => HEADLESS_ASK_USER,
      approvalPolicy: options.approvalPolicy,
      apply: () => applyAutonomyShellPolicy("headless"),
    };
  }

  if (level === "supervised") {
    // Auto-allow reads; mutating tools still go through resolver when provided.
    const approvalPolicy =
      options.approvalPolicy ??
      ((tool: string): boolean | undefined => {
        if (
          tool.includes("read") ||
          tool.includes("list") ||
          tool.includes("search") ||
          tool.includes("grep") ||
          tool.includes("glob")
        ) {
          return false;
        }
        return undefined;
      });
    return {
      level,
      resolveToolApproval: options.resolveToolApproval ?? (async () => true),
      resolveAskUser:
        options.resolveAskUser ?? (async () => HEADLESS_ASK_USER),
      approvalPolicy,
      apply: () => applyAutonomyShellPolicy("supervised"),
    };
  }

  // interactive
  return {
    level,
    resolveToolApproval: options.resolveToolApproval,
    resolveAskUser: options.resolveAskUser,
    approvalPolicy: options.approvalPolicy,
    apply: () => applyAutonomyShellPolicy("interactive"),
  };
}
