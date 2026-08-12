/**
 * Session goals for long-run harness (initializer + coding).
 */

import type { FeatureItem } from "./artifacts.js";

export function buildInitializerGoal(opts: {
  readonly appSpecRelative?: string;
  readonly workspaceRoot?: string;
}): string {
  const spec = opts.appSpecRelative ?? "app_spec.txt";
  const ws = opts.workspaceRoot
    ? `\nWORKSPACE ROOT (absolute): ${opts.workspaceRoot}\nAll edits/commits MUST stay inside this directory. Do not touch sibling folders.\n`
    : "";
  return [
    "You are the INITIALIZER agent for a multi-session long-running build.",
    "This is session 1 of many. Set up durable handoff artifacts for future sessions.",
    ws,
    "Read app_spec.txt first (project specification).",
    "",
    "REQUIRED deliverables (create/update on disk):",
    "1) Read feature_list.json but DO NOT edit it; it is owned by the outer verifier.",
    "2) Create init.mjs — Node script that prints how to install deps and start the web UI (port 5173 preferred).",
    "3) Create README.md with how to run the app and how to run tests.",
    "4) Scaffold the minimal web app structure from the spec (Vite+React or equivalent SPA).",
    "5) git init if needed; commit init.mjs, README, and the runnable scaffold. Never add feature_list.json to Git.",
    "6) Update paw-progress.md with what you did and what the next session should implement first.",
    "",
    "Constraints:",
    "- Do NOT edit feature_list.json or mark any feature passing.",
    "- Prefer a runnable empty UI shell over incomplete features.",
    "- Use workspace.edit_file / write_file / apply_patch; run shell for npm/bun install as needed.",
    "- Do NOT leave `npm run dev` / vite running in the foreground (hangs the session).",
    "- End with final_answer summarizing files created and the first feature to implement next.",
    "",
    `Spec file: ${spec}`,
  ].join("\n");
}

export function buildCodingGoal(opts: {
  readonly feature: FeatureItem;
  readonly remaining: number;
  readonly total: number;
  readonly workspaceRoot?: string;
  readonly priorFailure?: string;
}): string {
  const f = opts.feature;
  const ws = opts.workspaceRoot
    ? `\nWORKSPACE ROOT (absolute): ${opts.workspaceRoot}\nStay inside this directory only.\n`
    : "";
  return [
    "You are the CODING agent in a multi-session long-running build.",
    "Fresh context: recover state from disk, then make incremental progress.",
    ws,
    "STARTUP (do in order):",
    "1) Read paw-progress.md",
    "2) Read feature_list.json as a read-only acceptance contract",
    "3) git log --oneline -15",
    "4) Start/check the app per README / init.mjs if useful",
    "",
    `THIS SESSION: implement EXACTLY ONE feature — id=${f.id}`,
    `description: ${f.description}`,
    `Human steps: ${f.steps.join(" | ")}`,
    f.e2e
      ? `E2E contract (harness will re-check with Playwright): ${JSON.stringify(f.e2e.actions)}`
      : "No machine e2e block — still verify in the running UI yourself.",
    opts.priorFailure
      ? `PRIOR HARNESS FAILURE (fix this exact evidence; do not repeat the same approach):\n${opts.priorFailure}`
      : "No prior harness failure for this feature.",
    "",
    "RULES:",
    "- Only work on this one feature; do not start a second feature.",
    "- Edit existing project source; do not leave unrun helper scripts.",
    "- Do NOT start long-lived servers (vite/npm run dev) in the foreground — they hang the session.",
    "  The outer harness starts the UI and runs Playwright E2E after you finish.",
    "  You may use short one-shot checks (npm run build, curl with timeout) only.",
    "- Do NOT edit feature_list.json, including passes. The outer Playwright verifier exclusively owns that ledger.",
    "- git commit with a clear message naming the feature id.",
    "- Append a short note to paw-progress.md for the next session.",
    "",
    `Progress: ${opts.total - opts.remaining}/${opts.total} already passing; ${opts.remaining} remaining including this one.`,
    "",
    "End with final_answer: what changed and how you verified it. The outer verifier records pass/fail.",
  ].join("\n");
}
