/**
 * M9 测试：.gitignore 默认项 + export 密钥扫描 + readonly 模式（spec §4.1/§5.5/§6.7/§9.2）
 *
 * gitignore 用 git check-ignore 实测；config/export 用临时目录；
 * db 部分 ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/export-readonly.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { TriggeredRetriever } from "../src/longterm/retrieval/triggered.js";
import { MemoryWritePipeline } from "../src/longterm/write/pipeline.js";
import { exportMemories } from "../src/longterm/export.js";
import { loadMemoryConfig, saveMemoryConfig, DEFAULT_MEMORY_CONFIG } from "../src/longterm/config.js";
import type { SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)); // paw-ts 根

// ═══════════════════════════════════════════════════════════════
// .gitignore（git check-ignore 实测，不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe(".gitignore 默认项（§4.1）", () => {
  function checkIgnore(path: string): { ignored: boolean; rule: string } {
    const r = Bun.spawnSync(["git", "check-ignore", "-v", path], { cwd: REPO_ROOT });
    const out = r.stdout.toString().trim();
    return { ignored: r.exitCode === 0, rule: out.split(/\s+/)[1] ?? "" };
  }

  test(".paw/memory/ 被忽略", () => {
    const r = checkIgnore(".paw/memory/facts.jsonl");
    expect(r.ignored).toBe(true);
  });

  test(".paw/shared-memory/ 可提交（例外放行）", () => {
    const r = checkIgnore(".paw/shared-memory/memory-export.jsonl");
    expect(r.ignored).toBe(false);
  });

  test(".paw/ 其它内容仍被忽略（settings 等不回归）", () => {
    expect(checkIgnore(".paw/settings.local.json").ignored).toBe(true);
    expect(checkIgnore(".paw/sessions/run-1.jsonl").ignored).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 配置文件（临时目录，不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("memory-config.json", () => {
  test("缺文件 → 默认配置；写入 → 读回", async () => {
    const root = await mkdtemp(join(tmpdir(), "m9-cfg-"));
    try {
      expect(await loadMemoryConfig(root)).toEqual(DEFAULT_MEMORY_CONFIG);
      await saveMemoryConfig({ readonly: true }, root);
      expect(await loadMemoryConfig(root)).toEqual({ readonly: true, shadow: false });
      await saveMemoryConfig({ shadow: true }, root);
      const cfg = await loadMemoryConfig(root);
      expect(cfg).toEqual({ readonly: true, shadow: true });
      // 文件在 .paw/ 下（gitignore 覆盖，不进 git）
      const raw = await readFile(join(root, ".paw", "memory-config.json"), "utf-8");
      expect(JSON.parse(raw).readonly).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("损坏文件 → 默认配置（不阻塞）", async () => {
    const root = await mkdtemp(join(tmpdir(), "m9-cfg-bad-"));
    try {
      await saveMemoryConfig({}, root);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, ".paw", "memory-config.json"), "{corrupted", "utf-8");
      expect(await loadMemoryConfig(root)).toEqual(DEFAULT_MEMORY_CONFIG);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成：export + readonly
// ═══════════════════════════════════════════════════════════════

const RUN = `run_m9_${Date.now().toString(36)}`;
const REPO = `m9-export-${Date.now().toString(36)}`;
const createdIds: string[] = [];

function makeSemantic(fact: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "", kind: "semantic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
    fact, keywords: [], embeddingKey: fact,
    ...overrides,
  };
}

describe("export + readonly db 集成", () => {
  const engine = new PostgresMemoryStoreEngine();

  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM outbox_events WHERE aggregate_type = 'memory_write' AND payload->>'runId' LIKE ${RUN + "%"}`;
    }
    await closeSql();
  });

  it("export：密钥条目跳过、高熵打码、报告正确", async () => {
    const normal = makeSemantic("The export pipeline writes JSONL plus a README summary");
    const withSecret = makeSemantic("call the service with sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4 when needed");
    const withEntropy = makeSemantic("migration marker x9Qv2mZ8kLp4Wn7Bz3Ya6TqR appears in legacy rows");
    for (const e of [normal, withSecret, withEntropy]) {
      await engine.put(e);
      createdIds.push(deriveEntryId(e));
    }

    const dir = await mkdtemp(join(tmpdir(), "m9-export-"));
    try {
      const report = await exportMemories({ engine, dir, repo: REPO });
      expect(report.total).toBe(3);
      expect(report.exported).toBe(2);
      expect(report.redacted).toBe(1);
      expect(report.skippedSecret).toHaveLength(1);
      expect(report.skippedSecret[0]!.id).toBe(deriveEntryId(withSecret));
      expect(report.skippedSecret[0]!.pattern).toContain("sk");

      const jsonl = await readFile(join(dir, "memory-export.jsonl"), "utf-8");
      expect(jsonl).toContain("The export pipeline writes JSONL");
      expect(jsonl).not.toContain("sk-a1b2c3d4");           // 密钥条目整条不进导出
      expect(jsonl).not.toContain("x9Qv2mZ8kLp4Wn7Bz3Ya6TqR"); // 高熵 token 被打码
      expect(jsonl).toContain("[REDACTED]");
      // 每行仍是合法 JSON
      for (const line of jsonl.trim().split("\n")) JSON.parse(line);

      const readme = await readFile(join(dir, "README.md"), "utf-8");
      expect(readme).toContain("跳过（疑似密钥）: 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("export --all 含已失效条目（带 tInvalid 标注）", async () => {
    const dead = makeSemantic("Fluorite fact later invalidated but exported with annotation");
    await engine.put(dead);
    const id = deriveEntryId(dead);
    createdIds.push(id);
    const tInvalid = new Date().toISOString();
    await engine.invalidate(id, tInvalid);

    const dirActive = await mkdtemp(join(tmpdir(), "m9-exp-a-"));
    const dirAll = await mkdtemp(join(tmpdir(), "m9-exp-b-"));
    try {
      await exportMemories({ engine, dir: dirActive, repo: REPO });
      const activeJsonl = await readFile(join(dirActive, "memory-export.jsonl"), "utf-8");
      expect(activeJsonl).not.toContain(id); // 默认不含已失效

      await exportMemories({ engine, dir: dirAll, repo: REPO, includeInvalidated: true });
      const jsonl = await readFile(join(dirAll, "memory-export.jsonl"), "utf-8");
      const row = JSON.parse(jsonl.trim().split("\n").find((l) => l.includes(id))!) as { id: string; tInvalid: string };
      expect(row.id).toBe(id);
      expect(row.tInvalid).toBe(tInvalid); // 失效标注保留
    } finally {
      await rm(dirActive, { recursive: true, force: true });
      await rm(dirAll, { recursive: true, force: true });
    }
  });

  it("readonly：enqueue 丢弃 + op-log 记录，检索正常", async () => {
    const entry = makeSemantic("Gypsum readonly probe stays retrievable while writes drop");
    await engine.put(entry);
    const id = deriveEntryId(entry);
    createdIds.push(id);

    const runId = `${RUN}_ro`;
    const sql = getSql();
    const [before] = await sql`
      SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_type = 'memory_write'
    `;

    const pipeline = new MemoryWritePipeline({ readonly: true });
    await pipeline.enqueue({
      type: "user_correction", text: "记住：readonly 时这条不该入库", messageRef: "m-ro", runId, repo: REPO,
    });

    const [after] = await sql`
      SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_type = 'memory_write'
    `;
    expect((after as { n: number }).n).toBe((before as { n: number }).n); // 未落队列

    const drops = await queryOpLog({ runId, op: "write.dropped" });
    expect(drops).toHaveLength(1);
    expect(drops[0]!.detail.reason).toBe("readonly");

    // 检索只读正常
    const pkg = await new TriggeredRetriever({ engine, countTokens: (t) => Math.ceil(t.length / 4) }).retrieve({
      type: "explicit_query", question: "gypsum readonly probe", repo: REPO, runId: `${RUN}_ro_q`,
    });
    expect(pkg.items.map((i) => i.id)).toContain(id);
  });

  it("readonly 动态函数求值（on→off 切换生效）", async () => {
    let flag = true;
    const pipeline = new MemoryWritePipeline({ readonly: () => flag });
    const runId = `${RUN}_dyn`;
    await pipeline.enqueue({ type: "user_correction", text: "记住：动态开关探针", messageRef: "m1", runId, repo: REPO });
    flag = false;
    await pipeline.enqueue({ type: "user_correction", text: "记住：动态开关探针", messageRef: "m2", runId, repo: REPO });

    const drops = await queryOpLog({ runId, op: "write.dropped" });
    expect(drops).toHaveLength(1); // 第一次被丢，第二次入队
    const enqueued = await queryOpLog({ runId, op: "write.enqueued" });
    expect(enqueued).toHaveLength(1);
  });

  it("CLI：readonly on/off 切换与状态查询（临时 cwd）", async () => {
    // runMemoryCommand 的 readonly 走 process.cwd()/.paw —— 子进程切换 cwd 验证；
    // 脚本写临时文件执行（Windows 多行 -e 参数会被拆分），用绝对路径 import
    const root = await mkdtemp(join(tmpdir(), "m9-cli-"));
    try {
      const longtermIndex = fileURLToPath(new URL("../src/longterm/index.ts", import.meta.url));
      const scriptPath = join(root, "probe.ts");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(scriptPath, [
        `import { runMemoryCommand } from ${JSON.stringify(longtermIndex)};`,
        `const r1 = await runMemoryCommand(["readonly", "on"]);`,
        `console.log("ON:", r1.ok, r1.text.includes("已开启"));`,
        `const r2 = await runMemoryCommand(["readonly"]);`,
        `console.log("STATUS:", r2.text);`,
        `const r3 = await runMemoryCommand(["readonly", "off"]);`,
        `console.log("OFF:", r3.ok, r3.text.includes("已关闭"));`,
      ].join("\n"), "utf-8");
      const proc = Bun.spawnSync(["bun", scriptPath], { cwd: root, env: process.env });
      const out = proc.stdout.toString() + proc.stderr.toString();
      expect(out).toContain("ON: true true");
      expect(out).toContain("readonly: on");
      expect(out).toContain("OFF: true true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
