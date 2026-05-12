/**
 * Lightweight shell command gate (subset of Python paw.harness.shell_guard).
 * Blocks obvious destructive patterns and subshell injection before exec.
 */

const DANGEROUS_LITERAL = [
  "rm -rf /",
  "rm -rf /*",
  "> /dev/sda",
  "mkfs.",
  "dd if=",
  ":(){ :|:& };:",
];

const INJECTION_MARKERS = ["$(", "`", "<<<"];

const DANGEROUS_MULTIWORD = [
  "git push --force",
  "git reset --hard",
  "git clean -f",
  "pip uninstall",
  "npm uninstall",
  "cargo uninstall",
  "docker rm",
  "docker rmi",
  "kubectl delete",
];

const DANGEROUS_FIRST_TOKEN = new Set([
  "rm",
  "dd",
  "mkfs",
  "shred",
  "chmod",
  "chown",
  "sudo",
  "su",
]);

function normalizeForScan(command: string): string {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function firstToken(segment: string): string {
  const s = segment.trim();
  if (!s) {
    return "";
  }
  const m = /^([^\s|&;<>]+)/.exec(s);
  return (m?.[1] ?? s.split(/\s+/)[0] ?? "").toLowerCase();
}

export interface ShellGuardResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Returns whether the command may be executed under the harness shell tool. */
export function validateShellCommand(command: string): ShellGuardResult {
  const raw = command.trim();
  if (!raw) {
    return { allowed: false, reason: "empty command" };
  }
  for (const m of INJECTION_MARKERS) {
    if (raw.includes(m)) {
      return {
        allowed: false,
        reason: `disallowed pattern (injection/obfuscation): ${m}`,
      };
    }
  }
  const low = raw.toLowerCase();
  for (const p of DANGEROUS_LITERAL) {
    if (low.includes(p)) {
      return { allowed: false, reason: `blocked pattern: ${p}` };
    }
  }
  const norm = normalizeForScan(raw);
  for (const p of DANGEROUS_MULTIWORD) {
    if (norm.includes(p)) {
      return { allowed: false, reason: `blocked pattern: ${p}` };
    }
  }
  const segments = raw.split("|");
  for (const seg of segments) {
    const tok = firstToken(seg);
    if (tok && DANGEROUS_FIRST_TOKEN.has(tok)) {
      return {
        allowed: false,
        reason: `disallowed command: ${tok}`,
      };
    }
  }
  return { allowed: true };
}
