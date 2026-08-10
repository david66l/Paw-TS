/**
 * memory export（spec v2 §4.1 / §5.5 / §9.2，M9）
 *
 * 导出条目到 `.paw/shared-memory/`（显式共享目录，gitignore 已放行）：
 * - `memory-export.jsonl`：一行一条完整条目（JSON）
 * - `README.md`：人读摘要（规模/kind 分布/密钥扫描报告）
 *
 * 导出前全量过密钥扫描（§5.5 双保险的 export 道）：
 * - 命中已知模式 → 该条跳过并列入报告
 * - 仅高熵命中 → 打码 [REDACTED] 后照常导出
 * （对序列化后的 JSON 行扫描：[REDACTED] 不含引号，替换后 JSON 仍合法）
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryStoreEngine } from "./store/engine.js";
import { PostgresMemoryStoreEngine } from "./store/postgres-engine.js";
import { scanForSecrets } from "./write/secrets.js";

export interface ExportOptions {
  engine?: MemoryStoreEngine;
  /** 导出目录，默认 <cwd>/.paw/shared-memory */
  dir?: string;
  repo?: string;
  /** true = 含已软失效条目（条目中带 tInvalid 标注）；默认只导出活跃条目 */
  includeInvalidated?: boolean;
  now?: () => Date;
}

export interface ExportReport {
  dir: string;
  /** 参与扫描的条目总数 */
  total: number;
  exported: number;
  /** 命中已知密钥模式被跳过的条目 */
  skippedSecret: { id: string; pattern: string }[];
  /** 高熵打码后导出的条目数 */
  redacted: number;
  files: string[];
}

export async function exportMemories(opts: ExportOptions = {}): Promise<ExportReport> {
  const engine = opts.engine ?? new PostgresMemoryStoreEngine();
  const dir = opts.dir ?? join(process.cwd(), ".paw", "shared-memory");
  const now = (opts.now ?? (() => new Date()))();

  const entries = await engine.query({
    repo: opts.repo,
    includeInvalidated: opts.includeInvalidated ?? false,
    limit: 10000,
  });

  const lines: string[] = [];
  const skipped: { id: string; pattern: string }[] = [];
  let redacted = 0;
  const kindCounts: Record<string, number> = {};

  for (const entry of entries) {
    const line = JSON.stringify(entry);
    const scan = scanForSecrets(line);
    if (scan.action === "reject") {
      skipped.push({ id: entry.id, pattern: scan.pattern });
      continue;
    }
    if (scan.action === "redact") {
      redacted += 1;
      lines.push(scan.text);
    } else {
      lines.push(line);
    }
    kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;
  }

  await mkdir(dir, { recursive: true });
  const jsonlPath = join(dir, "memory-export.jsonl");
  const readmePath = join(dir, "README.md");
  await writeFile(jsonlPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf-8");
  await writeFile(readmePath, renderReadme(entries.length, lines.length, skipped, redacted, kindCounts, now), "utf-8");

  return {
    dir,
    total: entries.length,
    exported: lines.length,
    skippedSecret: skipped,
    redacted,
    files: [jsonlPath, readmePath],
  };
}

function renderReadme(
  total: number,
  exported: number,
  skipped: { id: string; pattern: string }[],
  redacted: number,
  kindCounts: Record<string, number>,
  now: Date,
): string {
  const kinds = Object.entries(kindCounts).map(([k, n]) => `- ${k}: ${n} 条`).join("\n") || "- （空）";
  const skipLines = skipped.map((s) => `- ${s.id}（命中 ${s.pattern}）`).join("\n") || "- （无）";
  return `# 共享记忆导出

> 由 \`paw-ts memory export\` 生成，可提交 git（导出时已全量过密钥扫描）。
> 重新导入/消费方式见 文档/记忆机制spec-v2 04 §4.1。

- 生成时间: ${now.toISOString()}
- 扫描条目: ${total}    导出: ${exported}    打码: ${redacted}    跳过（疑似密钥）: ${skipped.length}

## 条目分布

${kinds}

## 密钥扫描跳过清单

${skipLines}

## 文件

- \`memory-export.jsonl\`：一行一条记忆条目（MemoryEntry JSON，含双时戳与效用账本）
`;
}
