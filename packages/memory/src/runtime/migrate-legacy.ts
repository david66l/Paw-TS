/**
 * 旧 file 记忆 → 新 Postgres MemoryStore 迁移（L1）。
 *
 * 规则（cutover plan §8）：
 * - 每条 AutoMemory MD → 1 candidate → Governance →（低风险）active item
 * - subjectKey = legacy:file:{name}（幂等，重跑不翻倍）
 * - 不删除源 MD（只读迁移）
 *
 * CLI:
 *   bun run packages/memory/src/runtime/migrate-legacy.ts --root <workspace>
 *   bun run memory:migrate-legacy -- --root .
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { AutoMemoryStore, type AutoMemoryEntry } from "../compat/auto-memory.js";
import { closeSql, ping as dbPing } from "../db/connection.js";
import { governanceDecisionDao } from "../db/dao/governanceDecision.js";
import { memoryCandidateDao } from "../db/dao/memoryCandidate.js";
import { memoryItemDao } from "../db/dao/memoryItem.js";
import { generateId } from "../db/modules/platform/idGen.js";
import {
  GovernanceExecutor,
  MemoryGovernance,
} from "../db/modules/index.js";
import type { MemoryCandidate, MemoryType } from "../db/types.js";
import { kindFromLegacyType, type MemoryKind } from "../shared/memory-types.js";
import { resolveScope } from "./scope.js";

export interface MigrateLegacyOptions {
  readonly workspaceRoot: string;
  readonly userId?: string;
  readonly repositoryId?: string;
  readonly dryRun?: boolean;
  /** 跳过 governance 执行（只生成候选统计）— 仅 dry 用途 */
  readonly promote?: boolean;
}

export interface MigrateLegacyResult {
  readonly memoryDir: string;
  readonly scanned: number;
  readonly skippedExisting: number;
  readonly candidatesCreated: number;
  readonly written: number;
  readonly rejected: number;
  readonly pendingReview: number;
  readonly errors: readonly string[];
  readonly writtenIds: readonly string[];
}

function mapType(entry: AutoMemoryEntry): MemoryType {
  const kind: MemoryKind | undefined =
    entry.kind ?? kindFromLegacyType(entry.type);
  switch (kind) {
    case "user_preference":
      return "user_preference";
    case "project_rule":
      return "rule";
    case "failure_pattern":
      return "failure";
    case "task_episode":
      return "task_summary";
    case "procedure":
      return "skill";
    case "module_summary":
    case "reference":
      return "project_knowledge";
    default:
      break;
  }
  switch (entry.type) {
    case "user":
    case "feedback":
      return "user_preference";
    case "project":
    case "reference":
      return "project_knowledge";
    default:
      return "project_knowledge";
  }
}

function confidenceOf(entry: AutoMemoryEntry): number {
  if (typeof entry.confidence === "number" && entry.confidence >= 0) {
    return Math.min(1, entry.confidence);
  }
  if (entry.priority === "high") return 0.85;
  if (entry.priority === "low") return 0.55;
  return 0.75;
}

function riskOf(entry: AutoMemoryEntry): MemoryCandidate["riskLevel"] {
  if (mapType(entry) === "failure") return "medium";
  return "low";
}

/**
 * 将工作区旧 AutoMemory 目录导入 Postgres。
 * 幂等：已存在 subjectKey `legacy:file:{name}` 的 active 记忆会跳过。
 */
export async function migrateLegacyMemories(
  opts: MigrateLegacyOptions,
): Promise<MigrateLegacyResult> {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const scope = resolveScope({
    workspaceRoot,
    userId: opts.userId,
    repositoryId: opts.repositoryId,
  });
  const promote = opts.promote !== false && !opts.dryRun;

  const store = new AutoMemoryStore({ workspaceRoot });
  const memoryDir = store.memoryDir;
  const entries = existsSync(memoryDir) ? store.list() : [];

  const errors: string[] = [];
  let skippedExisting = 0;
  let candidatesCreated = 0;
  let written = 0;
  let rejected = 0;
  let pendingReview = 0;
  const writtenIds: string[] = [];

  if (!(await dbPing())) {
    return {
      memoryDir,
      scanned: entries.length,
      skippedExisting: 0,
      candidatesCreated: 0,
      written: 0,
      rejected: 0,
      pendingReview: 0,
      errors: [
        "Postgres ping failed. Set DATABASE_URL and run bun run memory:migrate first.",
      ],
      writtenIds: [],
    };
  }

  const governance = new MemoryGovernance();
  const executor = new GovernanceExecutor();

  for (const entry of entries) {
    const subjectKey = `legacy:file:${entry.name}`;
    try {
      const existing = await memoryItemDao.findBySubjectKey(
        subjectKey,
        "active",
      );
      if (existing.length > 0) {
        skippedExisting++;
        continue;
      }

      if (opts.dryRun) {
        candidatesCreated++;
        continue;
      }

      const now = new Date().toISOString();
      const candidate: MemoryCandidate = {
        id: generateId("cand"),
        schemaVersion: 1,
        status: "draft",
        proposedType: mapType(entry),
        proposedSubjectKey: subjectKey,
        subjectKeyVersion: 1,
        proposedTitle: entry.name.slice(0, 200),
        proposedSummary: (entry.description || entry.name).slice(0, 4000),
        proposedPayload: {
          content: entry.content,
          legacyType: entry.type,
          legacyKind: entry.kind,
          tags: entry.tags ?? [],
          relatedFiles: entry.relatedFiles ?? [],
          evidence: entry.evidence ?? [],
          migratedFrom: "auto-memory-md",
        },
        proposedScope: {
          repositoryId: scope.repositoryId,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
        },
        proposedConfidence: confidenceOf(entry),
        sourceTaskIds: [],
        sourceRefs: [
          {
            sourceType: "legacy_file_migration",
            uri: `file://${path.join(memoryDir, `${entry.name}.md`)}`,
            capturedAt: now,
          },
        ],
        evidenceRefs: [],
        possibleDuplicateIds: [],
        possibleConflictIds: [],
        riskLevel: riskOf(entry),
        reviewRequired: riskOf(entry) !== "low",
        generatedBy: { actorType: "importer", actorId: "migrate-legacy" },
        generationReason: "legacy_md_import",
        sensitivity: "internal",
        createdAt: now,
        updatedAt: now,
      };

      const created = await memoryCandidateDao.create(candidate);
      candidatesCreated++;

      if (!promote) continue;

      const { decision, duplicateOf } = await governance.evaluate({
        candidateId: created.id,
      });
      let dec = decision;
      if (
        dec.decision === "APPROVE_MERGE" &&
        !dec.targetMemoryId &&
        duplicateOf
      ) {
        dec = { ...dec, targetMemoryId: duplicateOf };
      }
      await governanceDecisionDao.create(dec);

      if (dec.status === "APPROVED") {
        const exec = await executor.execute(dec);
        if (exec.success && exec.memoryId) {
          written++;
          writtenIds.push(exec.memoryId);
        } else {
          rejected++;
          if (exec.reason) errors.push(`${entry.name}: ${exec.reason}`);
        }
      } else if (dec.status === "PENDING_REVIEW") {
        pendingReview++;
      } else {
        rejected++;
      }
    } catch (e) {
      errors.push(
        `${entry.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    memoryDir,
    scanned: entries.length,
    skippedExisting,
    candidatesCreated,
    written,
    rejected,
    pendingReview,
    errors,
    writtenIds,
  };
}

// ── CLI entry ──

function parseArgs(argv: string[]): {
  root: string;
  dryRun: boolean;
  help: boolean;
} {
  let root = process.cwd();
  let dryRun = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1]) {
      root = path.resolve(argv[++i]!);
    } else if (a === "--dry" || a === "--dry-run") {
      dryRun = true;
    } else if (a === "-h" || a === "--help") {
      help = true;
    }
  }
  return { root, dryRun, help };
}

async function main(): Promise<void> {
  const { root, dryRun, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(`Usage: migrate-legacy.ts --root <workspace> [--dry]

Import AutoMemory MD files into Postgres MemoryStore (idempotent).

Requires DATABASE_URL and applied migrations (bun run memory:migrate).
`);
    process.exit(0);
  }

  console.log(`Migrating legacy memory from workspace: ${root}`);
  if (dryRun) console.log("(dry run — no writes)");

  const result = await migrateLegacyMemories({
    workspaceRoot: root,
    dryRun,
  });

  console.log(`memory dir: ${result.memoryDir}`);
  console.log(`scanned: ${result.scanned}`);
  console.log(`skipped (already migrated): ${result.skippedExisting}`);
  console.log(`candidates: ${result.candidatesCreated}`);
  console.log(`written active: ${result.written}`);
  console.log(`pending review: ${result.pendingReview}`);
  console.log(`rejected: ${result.rejected}`);
  if (result.errors.length) {
    console.log("errors:");
    for (const e of result.errors.slice(0, 20)) console.log(`  - ${e}`);
  }

  await closeSql();
  process.exit(result.errors.length && result.written === 0 ? 1 : 0);
}

const isMain =
  typeof Bun !== "undefined" &&
  Bun.main &&
  import.meta.path === Bun.main;

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
