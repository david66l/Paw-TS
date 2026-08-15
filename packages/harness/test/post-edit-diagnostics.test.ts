import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { diagnoseEditedFilesV1, executeTool } from "../src/index.js";

describe("post-edit diagnostics", () => {
  test("reports clean and broken TypeScript/JSON syntax with bounded authority", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-diagnostics-"));
    writeFileSync(
      path.join(workspaceRoot, "clean.ts"),
      "export const n = 1;\n",
    );
    writeFileSync(path.join(workspaceRoot, "broken.ts"), "export const = ;\n");
    writeFileSync(path.join(workspaceRoot, "broken.json"), '{"value": }\n');

    const result = diagnoseEditedFilesV1(workspaceRoot, [
      "clean.ts",
      "broken.ts",
      "broken.json",
    ]);
    expect(result.authority).toBe("syntax_only_not_verification");
    expect(result.status).toBe("issues");
    expect(result.issueCount).toBe(2);
    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      ["clean.ts", "clean"],
      ["broken.ts", "issues"],
      ["broken.json", "issues"],
    ]);
  });

  test("attaches syntax errors to a successful edit tool result", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-edit-diagnostics-"),
    );
    writeFileSync(
      path.join(workspaceRoot, "source.ts"),
      "export const n = 1;\n",
    );

    const result = await executeTool({ workspaceRoot }, "workspace.edit_file", {
      path: "source.ts",
      old_string: "export const n = 1;",
      new_string: "export const = ;",
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("syntax diagnostics: 1 error(s)");
    expect(result.payload).toMatchObject({
      diagnostics: {
        schemaVersion: "paw.post-edit-diagnostics.v1",
        authority: "syntax_only_not_verification",
        status: "issues",
        issueCount: 1,
      },
    });
  });

  test("unsupported files are explicit unavailable, never fake-clean", () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-diagnostics-skip-"),
    );
    writeFileSync(path.join(workspaceRoot, "README.md"), "# hello\n");
    const result = diagnoseEditedFilesV1(workspaceRoot, ["README.md"]);
    expect(result.status).toBe("unavailable");
    expect(result.files[0]).toMatchObject({
      engine: "none",
      status: "skipped",
    });
  });
});
