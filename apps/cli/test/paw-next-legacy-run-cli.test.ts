import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

import {
  PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
  PAW_NEXT_LEGACY_EXPORT_USAGE_V1,
  runPawNextLegacyExportCliV1,
} from "../src/paw-next/legacy-run-cli.js";
import {
  LEGACY_RUN_SOURCE_KIND_V1,
  discoverLegacyPawRunsV1,
} from "../src/paw-next/legacy-run-offline.js";

const roots: string[] = [];
const mainTs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main.ts",
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("explicit legacy evidence export CLI", () => {
  test("rejects every non-exact argv shape before invoking any port", async () => {
    const root = temporaryDirectory("paw-legacy-cli-invalid-");
    const output = path.join(
      temporaryDirectory("paw-legacy-cli-out-"),
      "x.json",
    );
    let calls = 0;
    const ports = {
      discover: (...args: Parameters<typeof discoverLegacyPawRunsV1>) => {
        calls += 1;
        return discoverLegacyPawRunsV1(...args);
      },
    };
    const invalid: readonly (readonly string[])[] = [
      [],
      ["--legacy-export-v1"],
      [
        "--legacy-export-v1",
        "--root",
        ".",
        "--source-kind",
        LEGACY_RUN_SOURCE_KIND_V1,
        "--run-id",
        "r1",
        "--output",
        output,
      ],
      [
        "--legacy-export-v1",
        "--root",
        root,
        "--source-kind",
        "paw-core-v1",
        "--run-id",
        "r1",
        "--output",
        output,
      ],
      [
        "--legacy-export-v1",
        "--root",
        root,
        "--source-kind",
        LEGACY_RUN_SOURCE_KIND_V1,
        "--run-id",
        "r1",
        "--output",
        "-",
      ],
      [
        "--legacy-export-v1",
        "--root",
        root,
        "--source-kind",
        LEGACY_RUN_SOURCE_KIND_V1,
        "--run-id",
        "r1",
        "--output",
        output,
        "--extra",
      ],
    ];

    for (const argv of invalid) {
      expect(await runPawNextLegacyExportCliV1(argv, ports)).toEqual({
        exitCode: 2,
        stream: "stderr",
        text: PAW_NEXT_LEGACY_EXPORT_USAGE_V1,
      });
    }
    expect(calls).toBe(0);
    expect(fs.existsSync(output)).toBe(false);
  });

  test("calls discover, inspect, and export once and emits only fixed safe metadata", async () => {
    const root = temporaryDirectory("paw-legacy-cli-success-");
    const output = path.join(
      temporaryDirectory("paw-legacy-cli-output-"),
      "evidence.json",
    );
    writePair(root, "cli-run", "API_KEY=super-secret legacy body");
    const calls = { discover: 0, inspect: 0, export: 0 };
    const offline = await import("../src/paw-next/legacy-run-offline.js");

    const result = await runPawNextLegacyExportCliV1(
      validArgs(root, "cli-run", output),
      {
        discover: (input) => {
          calls.discover += 1;
          return offline.discoverLegacyPawRunsV1(input);
        },
        inspect: (input) => {
          calls.inspect += 1;
          return offline.inspectLegacyPawRunV1(input);
        },
        exportEvidence: (input) => {
          calls.export += 1;
          return offline.exportLegacyPawRunEvidenceV1(input);
        },
      },
    );

    expect(calls).toEqual({ discover: 1, inspect: 1, export: 1 });
    expect(result.exitCode).toBe(0);
    expect(result.stream).toBe("stdout");
    expect(JSON.parse(result.text)).toEqual({
      schemaVersion: PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
      mode: "offline_evidence_export",
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: "cli-run",
      status: "exported",
      continuable: false,
      sourceStatus: "paired_unbound",
      bundleHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      byteLength: expect.any(Number),
    });
    expect(result.text).not.toContain(root);
    expect(result.text).not.toContain(output);
    expect(result.text).not.toContain("super-secret");
    expect(result.text).not.toContain("legacy body");
    expect(result.text).not.toContain("bytesBase64");
    expect(fs.readFileSync(output, "utf8")).toContain("bytesBase64");
  });

  test("sanitizes hostile errors and never retries or serializes injected objects", async () => {
    const root = temporaryDirectory("paw-legacy-cli-hostile-");
    const output = path.join(
      temporaryDirectory("paw-legacy-cli-hostile-out-"),
      "x.json",
    );
    const secret = `secret-${root}-raw-error`;
    let discoverCalls = 0;
    const discoverFailure = await runPawNextLegacyExportCliV1(
      validArgs(root, "hostile", output),
      {
        discover: () => {
          discoverCalls += 1;
          throw new Error(secret);
        },
      },
    );
    expect(discoverCalls).toBe(1);
    expect(discoverFailure).toEqual({
      exitCode: 1,
      stream: "stderr",
      text: JSON.stringify({
        schemaVersion: PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
        mode: "offline_evidence_export",
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "hostile",
        status: "failed",
        continuable: false,
        reasonCode: "source_unavailable",
      }),
    });
    expect(discoverFailure.text).not.toContain(secret);
    expect(discoverFailure.text).not.toContain(root);

    writePair(root, "hostile", secret);
    const realInventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    let exportCalls = 0;
    const exportFailure = await runPawNextLegacyExportCliV1(
      validArgs(root, "hostile", output),
      {
        discover: () => realInventory,
        inspect: () =>
          ({
            schemaVersion: "paw.legacy-run-inspection.v1",
            ...realInventory.entries.find((item) => item.runId === "hostile"),
            inventoryHash: realInventory.inventoryHash,
            // Hostile runtime fields must never be reflected by the report.
            toJSON: () => ({ secret, workspaceRoot: root }),
          }) as never,
        exportEvidence: () => {
          exportCalls += 1;
          throw new Error(secret);
        },
      },
    );
    expect(exportCalls).toBe(1);
    expect(exportFailure.exitCode).toBe(1);
    expect(JSON.parse(exportFailure.text)).toMatchObject({
      status: "failed",
      continuable: false,
      reasonCode: "export_failed",
    });
    expect(exportFailure.text).not.toContain(secret);
    expect(exportFailure.text).not.toContain(root);
    expect(fs.existsSync(output)).toBe(false);

    let serialized = 0;
    const hostileResult = await runPawNextLegacyExportCliV1(
      validArgs(root, "hostile", output),
      {
        discover: () => realInventory,
        inspect: () =>
          ({
            schemaVersion: "paw.legacy-run-inspection.v1",
            ...realInventory.entries.find((item) => item.runId === "hostile"),
            inventoryHash: realInventory.inventoryHash,
          }) as never,
        exportEvidence: () =>
          ({
            status: `exported-${secret}`,
            sourceStatus: `paired-${secret}`,
            continuable: false,
            bundleHash: secret,
            byteLength: 1,
            toJSON: () => {
              serialized += 1;
              return { secret, root };
            },
          }) as never,
      },
    );
    expect(hostileResult.exitCode).toBe(1);
    expect(JSON.parse(hostileResult.text)).toMatchObject({
      status: "failed",
      reasonCode: "export_failed",
    });
    expect(serialized).toBe(0);
    expect(hostileResult.text).not.toContain(secret);
    expect(hostileResult.text).not.toContain(root);
  });

  test("maps target_exists to a stable failure without exposing the target path", async () => {
    const root = temporaryDirectory("paw-legacy-cli-exists-");
    const output = path.join(
      temporaryDirectory("paw-legacy-cli-exists-out-"),
      "evidence.json",
    );
    writePair(root, "existing", "hidden-body");
    fs.writeFileSync(output, "existing-target");

    const result = await runPawNextLegacyExportCliV1(
      validArgs(root, "existing", output),
    );

    expect(result).toEqual({
      exitCode: 1,
      stream: "stderr",
      text: JSON.stringify({
        schemaVersion: PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
        mode: "offline_evidence_export",
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "existing",
        status: "target_exists",
        continuable: false,
        sourceStatus: "paired_unbound",
        reasonCode: "target_exists",
      }),
    });
    expect(result.text).not.toContain(output);
    expect(result.text).not.toContain(root);
    expect(result.text).not.toContain("hidden-body");
    expect(fs.readFileSync(output, "utf8")).toBe("existing-target");
  });

  test("main exposes only the exact lazy branch and keeps evidence bytes out of stdout", () => {
    const root = temporaryDirectory("paw-legacy-main-");
    const output = path.join(
      temporaryDirectory("paw-legacy-main-out-"),
      "evidence.json",
    );
    writePair(root, "main-run", "stdout-secret-body");

    const child = spawnSync(
      process.execPath,
      [mainTs, "paw-next", ...validArgs(root, "main-run", output)],
      { encoding: "utf8", env: process.env },
    );

    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toMatchObject({
      schemaVersion: PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
      mode: "offline_evidence_export",
      status: "exported",
      continuable: false,
    });
    expect(child.stdout).not.toContain(root);
    expect(child.stdout).not.toContain(output);
    expect(child.stdout).not.toContain("stdout-secret-body");
    expect(child.stdout).not.toContain("bytesBase64");
    expect(fs.readFileSync(output, "utf8")).toContain("bytesBase64");

    const nonExact = spawnSync(
      process.execPath,
      [mainTs, "paw-next", "--legacy-export-v1=false"],
      { encoding: "utf8", env: process.env },
    );
    expect(nonExact.status).toBe(2);
    expect(nonExact.stdout).toBe("");
    expect(nonExact.stderr).toContain("paw-ts — Paw TypeScript CLI");

    const source = fs.readFileSync(
      path.resolve(path.dirname(mainTs), "paw-next", "legacy-run-cli.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });
});

function validArgs(
  root: string,
  runId: string,
  output: string,
): readonly string[] {
  return [
    "--legacy-export-v1",
    "--root",
    root,
    "--source-kind",
    LEGACY_RUN_SOURCE_KIND_V1,
    "--run-id",
    runId,
    "--output",
    output,
  ];
}

function temporaryDirectory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePair(root: string, runId: string, body: string): void {
  const sessions = path.join(root, ".paw", "sessions");
  const states = path.join(root, ".paw", "states");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(states, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, `${runId}.jsonl`),
    `${JSON.stringify({
      runId,
      seq: 1,
      ts: 1,
      event: { type: "run.started", goal: body },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(states, `${runId}.json`),
    JSON.stringify({
      runId,
      goal: body,
      workspaceRoot: root,
      turn: 0,
      maxSteps: 1,
      messages: [{ role: "user", content: body }],
      savedAt: 1,
    }),
  );
}
