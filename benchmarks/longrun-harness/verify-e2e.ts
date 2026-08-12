/**
 * Desktop E2E verifier — real Chromium/Edge UI via Playwright (Node subprocess).
 * Bun+Playwright often hangs on Windows CDP; we shell out to node.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FeatureItem } from "./artifacts.js";

export interface E2eFeatureResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface E2eReport {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly results: readonly E2eFeatureResult[];
}

function detectDevServer(workspaceRoot: string): {
  cmd: string;
  args: string[];
  url: string;
} | null {
  const pkgPath = path.join(workspaceRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = `${pkg.scripts?.dev ?? ""} ${pkg.scripts?.start ?? ""}`;
  // Plain static HTML reference apps: node e2e serves files itself.
  if (!/vite|next|react-scripts|webpack/i.test(script)) return null;
  const port = 5173;
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return {
    cmd: npmCmd,
    args: [
      "run",
      pkg.scripts?.dev ? "dev" : "start",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    url: `http://127.0.0.1:${port}`,
  };
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

function runNodeE2e(opts: {
  readonly workspaceRoot: string;
  readonly onlyIds?: readonly string[];
  readonly headed?: boolean;
  readonly baseUrl?: string;
}): E2eReport {
  const script = path.join(import.meta.dir, "run-e2e-node.mjs");
  const args = [script, opts.workspaceRoot];
  if (opts.headed) args.push("--headed");
  if (opts.onlyIds?.length) args.push(`--only=${opts.onlyIds.join(",")}`);
  if (opts.baseUrl) args.push(`--base-url=${opts.baseUrl}`);
  const reportPath = path.join(opts.workspaceRoot, ".paw-e2e-last.json");
  const r = spawnSync("node", args, {
    encoding: "utf8",
    cwd: path.resolve(import.meta.dir, "../.."),
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) {
    throw new Error(`node e2e failed to start: ${r.error.message}`);
  }
  if (existsSync(reportPath)) {
    try {
      return JSON.parse(readFileSync(reportPath, "utf8")) as E2eReport;
    } catch (e) {
      throw new Error(
        `node e2e wrote unreadable report: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const out = (r.stdout ?? "").trim();
  const firstBrace = out.indexOf("{");
  const jsonText = firstBrace >= 0 ? out.slice(firstBrace) : out;
  try {
    return JSON.parse(jsonText) as E2eReport;
  } catch {
    throw new Error(
      `node e2e bad output (exit ${r.status}): ${(r.stderr || out).slice(0, 1500)}`,
    );
  }
}

export async function verifyFeaturesE2e(opts: {
  readonly workspaceRoot: string;
  readonly features: readonly FeatureItem[];
  readonly onlyIds?: readonly string[];
  readonly headed?: boolean;
}): Promise<E2eReport> {
  const targets = opts.features.filter((f) => {
    if (!f.e2e?.actions?.length) return false;
    if (opts.onlyIds?.length) return opts.onlyIds.includes(f.id);
    return true;
  });
  if (targets.length === 0) {
    return { ok: true, baseUrl: "", results: [] };
  }

  const dev = detectDevServer(opts.workspaceRoot);
  let proc: ChildProcess | undefined;
  let baseUrl: string | undefined;
  if (dev) {
    proc = spawn(dev.cmd, dev.args, {
      cwd: opts.workspaceRoot,
      shell: true,
      stdio: "pipe",
      env: { ...process.env, BROWSER: "none" },
    });
    const ok = await waitForUrl(dev.url, 90_000);
    if (!ok) {
      killTree(proc);
      throw new Error(`Dev server not ready at ${dev.url}`);
    }
    baseUrl = dev.url;
  }

  try {
    return runNodeE2e({
      workspaceRoot: opts.workspaceRoot,
      onlyIds: opts.onlyIds,
      headed: opts.headed,
      baseUrl,
    });
  } finally {
    if (proc) killTree(proc);
  }
}

/** After coding claims passes, re-check those ids and force-fail list on mismatch. */
export function reconcilePassesWithE2e(
  features: FeatureItem[],
  e2e: E2eReport,
): {
  features: FeatureItem[];
  flippedToFail: string[];
  verifiedToPass: string[];
} {
  const byId = new Map(e2e.results.map((r) => [r.id, r]));
  const flippedToFail: string[] = [];
  const verifiedToPass: string[] = [];
  const next = features.map((f) => {
    const r = byId.get(f.id);
    if (!r) return f;
    if (f.passes && !r.ok) {
      flippedToFail.push(f.id);
      return { ...f, passes: false };
    }
    if (!f.passes && r.ok) {
      verifiedToPass.push(f.id);
      return { ...f, passes: true };
    }
    return f;
  });
  return { features: next, flippedToFail, verifiedToPass };
}
