import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { checkWorkspacePath } from "@paw/workspace";

export const POST_EDIT_DIAGNOSTICS_SCHEMA_V1 =
  "paw.post-edit-diagnostics.v1" as const;

export interface PostEditDiagnosticIssueV1 {
  readonly severity: "error";
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface PostEditFileDiagnosticV1 {
  readonly path: string;
  readonly engine: "bun_syntax" | "json_parse" | "python_ast" | "none";
  readonly status: "clean" | "issues" | "unavailable" | "skipped";
  readonly issues: readonly PostEditDiagnosticIssueV1[];
  readonly reason?: string;
}

export interface PostEditDiagnosticsV1 {
  readonly schemaVersion: typeof POST_EDIT_DIAGNOSTICS_SCHEMA_V1;
  readonly authority: "syntax_only_not_verification";
  readonly status: "clean" | "issues" | "unavailable";
  readonly issueCount: number;
  readonly files: readonly PostEditFileDiagnosticV1[];
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_ISSUES = 20;
let cachedPythonCommand:
  | { readonly command: string; readonly prefix: readonly string[] }
  | null
  | undefined;

function issue(message: string): PostEditDiagnosticIssueV1 {
  return Object.freeze({
    severity: "error" as const,
    message: message.replace(/\s+/g, " ").trim().slice(0, 500),
  });
}

function diagnoseJson(
  relativePath: string,
  content: string,
): PostEditFileDiagnosticV1 {
  try {
    JSON.parse(content);
    return Object.freeze({
      path: relativePath,
      engine: "json_parse" as const,
      status: "clean" as const,
      issues: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({
      path: relativePath,
      engine: "json_parse" as const,
      status: "issues" as const,
      issues: Object.freeze([
        issue(error instanceof Error ? error.message : String(error)),
      ]),
    });
  }
}

function bunLoader(extension: string): "js" | "jsx" | "ts" | "tsx" | undefined {
  switch (extension) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    default:
      return undefined;
  }
}

function diagnoseJavaScript(
  relativePath: string,
  content: string,
  loader: "js" | "jsx" | "ts" | "tsx",
): PostEditFileDiagnosticV1 {
  if (typeof Bun === "undefined" || typeof Bun.Transpiler !== "function") {
    return Object.freeze({
      path: relativePath,
      engine: "bun_syntax" as const,
      status: "unavailable" as const,
      issues: Object.freeze([]),
      reason: "Bun.Transpiler unavailable",
    });
  }
  try {
    new Bun.Transpiler({ loader }).transformSync(content);
    return Object.freeze({
      path: relativePath,
      engine: "bun_syntax" as const,
      status: "clean" as const,
      issues: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({
      path: relativePath,
      engine: "bun_syntax" as const,
      status: "issues" as const,
      issues: Object.freeze([
        issue(error instanceof Error ? error.message : String(error)),
      ]),
    });
  }
}

const PYTHON_AST_SCRIPT = [
  "import ast,json,pathlib,sys",
  "p=sys.argv[1]",
  "try:",
  " ast.parse(pathlib.Path(p).read_text(encoding='utf-8'), filename=p)",
  "except SyntaxError as e:",
  " print(json.dumps({'message':e.msg,'line':e.lineno,'column':e.offset}))",
  " sys.exit(1)",
].join("\n");

function diagnosePython(
  relativePath: string,
  absolutePath: string,
): PostEditFileDiagnosticV1 {
  const candidates =
    cachedPythonCommand === null
      ? []
      : cachedPythonCommand
        ? [cachedPythonCommand]
        : process.platform === "win32"
          ? [
              { command: "python", prefix: [] },
              { command: "py", prefix: ["-3"] },
            ]
          : [
              { command: "python3", prefix: [] },
              { command: "python", prefix: [] },
            ];
  for (const candidate of candidates) {
    const args = [...candidate.prefix, "-c", PYTHON_AST_SCRIPT, absolutePath];
    const result = spawnSync(candidate.command, args, {
      encoding: "utf8",
      timeout: 1_500,
      windowsHide: true,
      maxBuffer: 16 * 1024,
    });
    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      continue;
    }
    cachedPythonCommand = candidate;
    if (result.status === 0) {
      return Object.freeze({
        path: relativePath,
        engine: "python_ast" as const,
        status: "clean" as const,
        issues: Object.freeze([]),
      });
    }
    const output = `${result.stdout ?? ""}`.trim();
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      const message =
        typeof parsed.message === "string" ? parsed.message : output;
      return Object.freeze({
        path: relativePath,
        engine: "python_ast" as const,
        status: "issues" as const,
        issues: Object.freeze([
          Object.freeze({
            ...issue(message || "Python syntax error"),
            ...(typeof parsed.line === "number" ? { line: parsed.line } : {}),
            ...(typeof parsed.column === "number"
              ? { column: parsed.column }
              : {}),
          }),
        ]),
      });
    } catch {
      return Object.freeze({
        path: relativePath,
        engine: "python_ast" as const,
        status: "unavailable" as const,
        issues: Object.freeze([]),
        reason:
          `python AST probe failed: ${output || result.stderr || "unknown"}`
            .replace(/\s+/g, " ")
            .slice(0, 300),
      });
    }
  }
  cachedPythonCommand = null;
  return Object.freeze({
    path: relativePath,
    engine: "python_ast" as const,
    status: "unavailable" as const,
    issues: Object.freeze([]),
    reason: "Python executable unavailable",
  });
}

function diagnoseFile(
  workspaceRoot: string,
  relativePath: string,
): PostEditFileDiagnosticV1 {
  const checked = checkWorkspacePath(workspaceRoot, relativePath);
  if (!checked.allowed) {
    return Object.freeze({
      path: relativePath,
      engine: "none" as const,
      status: "unavailable" as const,
      issues: Object.freeze([]),
      reason: checked.reason ?? "path rejected",
    });
  }
  if (!existsSync(checked.resolvedPath)) {
    return Object.freeze({
      path: relativePath,
      engine: "none" as const,
      status: "skipped" as const,
      issues: Object.freeze([]),
      reason: "file deleted",
    });
  }
  let content: string;
  try {
    content = readFileSync(checked.resolvedPath, "utf8");
  } catch (error) {
    return Object.freeze({
      path: relativePath,
      engine: "none" as const,
      status: "unavailable" as const,
      issues: Object.freeze([]),
      reason:
        `diagnostic read failed: ${error instanceof Error ? error.message : String(error)}`
          .replace(/\s+/g, " ")
          .slice(0, 300),
    });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    return Object.freeze({
      path: relativePath,
      engine: "none" as const,
      status: "skipped" as const,
      issues: Object.freeze([]),
      reason: `file exceeds ${MAX_FILE_BYTES} byte diagnostic limit`,
    });
  }
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".json") return diagnoseJson(relativePath, content);
  const loader = bunLoader(extension);
  if (loader) return diagnoseJavaScript(relativePath, content, loader);
  if (extension === ".py") {
    return diagnosePython(relativePath, checked.resolvedPath);
  }
  return Object.freeze({
    path: relativePath,
    engine: "none" as const,
    status: "skipped" as const,
    issues: Object.freeze([]),
    reason: `no cheap syntax diagnostic for ${extension || "extensionless file"}`,
  });
}

export function diagnoseEditedFilesV1(
  workspaceRoot: string,
  relativePaths: readonly string[],
): PostEditDiagnosticsV1 {
  const unique = [...new Set(relativePaths.map((item) => item.trim()))].filter(
    Boolean,
  );
  const files = unique.map((file) => diagnoseFile(workspaceRoot, file));
  const issues = files.flatMap((file) => file.issues).slice(0, MAX_ISSUES);
  const supported = files.filter(
    (file) => file.status === "clean" || file.status === "issues",
  );
  return Object.freeze({
    schemaVersion: POST_EDIT_DIAGNOSTICS_SCHEMA_V1,
    authority: "syntax_only_not_verification" as const,
    status:
      issues.length > 0
        ? ("issues" as const)
        : supported.length > 0
          ? ("clean" as const)
          : ("unavailable" as const),
    issueCount: issues.length,
    files: Object.freeze(files),
  });
}
