/**
 * SWE-Exp checkpoint / resume：按臂落盘，中断后跳过已完成臂
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  SweExpArmCheckpoint,
  SweExpRunManifest,
} from "./agent-types.js";

export function runDir(baseDir: string, suiteRunId: string): string {
  return path.join(baseDir, "runs", suiteRunId);
}

export function pairDir(
  baseDir: string,
  suiteRunId: string,
  pairId: string,
): string {
  return path.join(runDir(baseDir, suiteRunId), "pairs", pairId);
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

/** Crash-safe JSON checkpoint: same-directory fsync + atomic rename. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx");
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.from(body, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, filePath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function writeManifest(
  baseDir: string,
  manifest: SweExpRunManifest,
): void {
  const dir = runDir(baseDir, manifest.runId);
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, "manifest.json"), manifest);
}

export function readManifest(
  baseDir: string,
  suiteRunId: string,
): SweExpRunManifest | null {
  const p = path.join(runDir(baseDir, suiteRunId), "manifest.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SweExpRunManifest;
}

export function armCheckpointPath(
  baseDir: string,
  suiteRunId: string,
  pairId: string,
  arm: "off" | "on",
): string {
  return path.join(pairDir(baseDir, suiteRunId, pairId), `${arm}.json`);
}

export function loadArmCheckpoint(
  baseDir: string,
  suiteRunId: string,
  pairId: string,
  arm: "off" | "on",
): SweExpArmCheckpoint | null {
  const p = armCheckpointPath(baseDir, suiteRunId, pairId, arm);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SweExpArmCheckpoint;
}

export function saveArmCheckpoint(
  baseDir: string,
  suiteRunId: string,
  cp: SweExpArmCheckpoint,
): void {
  const outDir = pairDir(baseDir, suiteRunId, cp.pairId);
  ensureDir(outDir);
  writeJsonAtomic(path.join(outDir, `${cp.arm}.json`), cp);
}

export function isArmCompleted(
  baseDir: string,
  suiteRunId: string,
  pairId: string,
  arm: "off" | "on",
): boolean {
  const cp = loadArmCheckpoint(baseDir, suiteRunId, pairId, arm);
  return cp?.status === "completed";
}
