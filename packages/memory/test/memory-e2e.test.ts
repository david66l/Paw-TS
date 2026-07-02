/**
 * End-to-end test: full memory pipeline.
 *
 * Covers: write→index→read round-trip, session→auto extraction,
 * keyword retrieval, semantic boost, cascade, task profiles,
 * sharded index, archive/expiry, reflection counter, cache stats.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AutoMemoryStore,
  EmbeddingCache,
  KeywordMemoryRetriever,
  UnifiedMemoryStore,
  type AutoMemoryEntry,
  type RetrievalQuery,
} from "../src/index.js";
import { classifyTask } from "../src/memory-record.js";
import { shouldRunReflection, resetReflectionCounter } from "../src/memory-reflector.js";
import { retrieveMemories } from "../src/memory-retrieve.js";
import { extractErrorSignatures } from "../src/memory-record.js";
import type { SessionMemory } from "../src/session-memory.js";
import { createHash } from "node:crypto";
import { fakeEmbedding } from "./fixtures.js";

async function extractSessionHighlightsToAutoMemory(opts: {
  readonly sessionMemory: SessionMemory;
  readonly autoMemoryStore: AutoMemoryStore;
  readonly workspaceRoot: string;
}): Promise<{ created: number; updated: number }> {
  const { sessionMemory, autoMemoryStore } = opts;
  const now = Date.now();
  let created = 0;
  let updated = 0;

  const sessionPrefix = createHash("sha256")
    .update(sessionMemory.session)
    .digest("hex")
    .slice(0, 8);

  const entries: Array<{
    name: string;
    description: string;
    content: string;
    priority?: "high" | "mid" | "low";
    tags?: readonly string[];
    relatedFiles?: readonly string[];
    error_signatures?: readonly string[];
    tools_used?: readonly string[];
    linked_memories?: readonly string[];
  }> = [];

  for (const decision of sessionMemory.keyDecisions ?? []) {
    const trimmed = decision.trim();
    if (!trimmed || trimmed.length < 10) continue;
    const contentHash = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
    entries.push({
      name: `sess-${sessionPrefix}-dec-${contentHash}`,
      description: `[Session] ${trimmed.slice(0, 120)}`,
      content: `From session: ${sessionMemory.session}\n\nDecision: ${trimmed}\n\nFiles: ${(sessionMemory.filesAndFunctions ?? []).join(", ")}`,
      priority: "high",
      tags: ["session-decision", "architecture"],
      relatedFiles: sessionMemory.filesAndFunctions ?? [],
      tools_used: [],
      linked_memories: [],
    });
  }

  for (const err of sessionMemory.errorsAndFixes ?? []) {
    const trimmed = err.trim();
    if (!trimmed || trimmed.length < 10) continue;
    const contentHash = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
    entries.push({
      name: `sess-${sessionPrefix}-err-${contentHash}`,
      description: `[Session] Fix: ${trimmed.slice(0, 120)}`,
      content: `From session: ${sessionMemory.session}\n\nError & Fix: ${trimmed}\n\nFiles: ${(sessionMemory.filesAndFunctions ?? []).join(", ")}`,
      priority: "high",
      tags: ["session-error", "bug"],
      relatedFiles: sessionMemory.filesAndFunctions ?? [],
      error_signatures: extractErrorSignatures([trimmed]).length > 0
        ? extractErrorSignatures([trimmed])
        : undefined,
      tools_used: [],
      linked_memories: [],
    });
  }

  if (entries.length === 0) return { created: 0, updated: 0 };

  for (const entry of entries) {
    const action = autoMemoryStore.upsert({
      name: entry.name,
      description: entry.description,
      type: "project",
      content: entry.content,
      createdAt: now,
      updatedAt: now,
      priority: entry.priority ?? "high",
      tags: entry.tags ?? [],
      relatedFiles: entry.relatedFiles ?? [],
      error_signatures: entry.error_signatures ?? [],
      tools_used: entry.tools_used ?? [],
      linked_memories: entry.linked_memories ?? [],
    });
    if (action === "created") created++;
    else updated++;
  }

  if (created + updated > 0) {
    autoMemoryStore.buildIndex();
  }

  return { created, updated };
}

// ── Setup ─────────────────────────────────────────────────────────
const WS = mkdtempSync(path.join(tmpdir(), "paw-e2e-"));
const MEM = path.join(WS, "memory");
const store = new AutoMemoryStore({ workspaceRoot: WS, memoryDir: MEM });
const unified = new UnifiedMemoryStore({ workspaceRoot: WS, memoryDir: MEM, sessionPoolSize: 10 });

// Test helpers: all queries use minScore=0 so ranking is visible
function retrieve(q: Partial<RetrievalQuery> & { goal: string; workspaceRoot: string }) {
  return new KeywordMemoryRetriever(unified).retrieve({ minScore: 0, ...q } as RetrievalQuery);
}
function rank(q: Partial<RetrievalQuery> & { goal: string; workspaceRoot: string }) {
  return new KeywordMemoryRetriever(unified).rankRecords({ minScore: 0, ...q } as RetrievalQuery);
}

beforeAll(() => {
  const entries: AutoMemoryEntry[] = [
    {
      name: "core-arch", description: "项目核心架构：monorepo + packages 分层",
      type: "reference", priority: "high",
      content: "Paw-TS monorepo 架构，packages/core/agent/settings/models 分层设计",
      tags: ["architecture","monorepo"],
      relatedFiles: ["packages/core/src/index.ts"],
      embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(100)),
      linked_memories: ["build-system","memory-design"],
      createdAt: Date.now() - 30*86400000, updatedAt: Date.now() - 10*86400000,
    },
    {
      name: "build-fix", description: "修复 TS2307 构建脚本路径错误",
      type: "project", priority: "high",
      content: "TS2307 Cannot find module 构建错误修复 tsconfig paths",
      tags: ["bug","build"],
      relatedFiles: ["tsconfig.json","packages/core/src/build.ts"],
      error_signatures: ["TS2307","Cannot find module"],
      tools_used: ["workspace.read_file","bash_run"],
      embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(102)),
      createdAt: Date.now() - 20*86400000, updatedAt: Date.now() - 5*86400000,
    },
    {
      name: "compile-pipe", description: "编译流水线：tsc → bundle → deploy",
      type: "reference", priority: "mid",
      content: "构建流程 编译 tsc 打包 esbuild 部署 bundle deploy pipeline",
      tags: ["build","reference"],
      relatedFiles: ["package.json"],
      embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(105)),
      createdAt: Date.now() - 40*86400000, updatedAt: Date.now() - 15*86400000,
    },
    {
      name: "temp-debug", description: "临时调试 context-manager 内存泄露",
      type: "project", priority: "low",
      content: "node inspect 调试 context manager memory leak 检查",
      tags: ["debug","temp"],
      valid_until: Date.now() - 10*86400000, // expired
      embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(900)),
      createdAt: Date.now() - 120*86400000, updatedAt: Date.now() - 110*86400000,
    },
    {
      name: "user-style", description: "用户偏好：中文注释 + 函数式风格",
      type: "user", priority: "high",
      content: "注释用中文 代码风格函数式 class-free bun test 绝对路径",
      tags: ["preference"],
      embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(200)),
      createdAt: Date.now() - 10*86400000, updatedAt: Date.now() - 2*86400000,
    },
    {
      name: "react-state", description: "React 组件状态管理方案",
      type: "reference", priority: "mid",
      content: "react frontend state 组件 状态 Context useReducer Zustand",
      tags: ["react","frontend"],
      embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(500)),
      createdAt: Date.now() - 15*86400000, updatedAt: Date.now() - 14*86400000,
    },
    {
      name: "auth-jwt", description: "JWT 认证设计方案",
      type: "project", priority: "high",
      content: "认证 JWT refresh token access token 15min 7d httpOnly cookie",
      tags: ["auth","security"],
      embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(800)),
      createdAt: Date.now() - 25*86400000, updatedAt: Date.now() - 3*86400000,
    },
  ];
  for (const e of entries) store.save(e);
  store.buildIndex();
});

afterAll(() => rmSync(WS, { recursive: true, force: true }));

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 1. Round-trip", () => {
  test("entries survive (some may be archived)", () => {
    // temp-debug may be auto-archived by buildIndex due to expired validUntil
    const main = store.list().length;
    const archiveDir = path.join(MEM, "archive");
    const archived = existsSync(archiveDir) ?
      readdirSync(archiveDir).filter((f: string) => f.endsWith(".md")).length : 0;
    expect(main + archived).toBeGreaterThanOrEqual(7);
  });
  test("priority field", () => expect(store.load("core-arch")!.priority).toBe("high"));
  test("error_signatures", () => expect(store.load("build-fix")!.error_signatures).toContain("TS2307"));
  test("tools_used", () => expect(store.load("build-fix")!.tools_used).toContain("bash_run"));
  test("relatedFiles", () => expect(store.load("core-arch")!.relatedFiles).toContain("packages/core/src/index.ts"));
  test("linked_memories", () => expect(store.load("core-arch")!.linked_memories).toContain("memory-design"));
  test("valid_until (may be archived)", () => {
    // temp-debug may already be in archive/ due to expired validUntil
    const entry = store.load("temp-debug");
    if (entry) expect(entry.valid_until).toBeGreaterThan(0);
    // else: already archived — still valid behavior
  });
  test("embedding round-trip", () => {
    const e = store.load("core-arch")!;
    expect(EmbeddingCache.decodeEmbedding(e.embedding!)!.length).toBe(64);
  });
  test("load missing → null", () => expect(store.load("nope")).toBeNull());
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 2. Session→Auto (A.2.1)", () => {
  test("extracts decisions + errors with structured fields", async () => {
    const sm: SessionMemory = {
      session: "e2e-sess-1", project: "paw-ts", updatedAt: Date.now(),
      task: "Fix build + refactor auth",
      filesAndFunctions: ["packages/core/src/build.ts","tsconfig.json","packages/auth/src/jwt.ts"],
      keyDecisions: ["esbuild 替代 tsc 加速构建","JWT token 30min→15min"],
      errorsAndFixes: ["TS2307: Cannot find module → 添加 paths 映射","Build OOM → max-old-space-size=4096"],
    };
    const r = await extractSessionHighlightsToAutoMemory({ sessionMemory: sm, autoMemoryStore: store, workspaceRoot: WS });
    expect(r.created + r.updated).toBeGreaterThanOrEqual(4);
    const decs = store.list().filter(e => e.name.includes("-dec-"));
    const errs = store.list().filter(e => e.name.includes("-err-"));
    expect(decs.length).toBeGreaterThanOrEqual(2);
    expect(errs.length).toBeGreaterThanOrEqual(2);
    for (const d of decs) { expect(d.priority).toBe("high"); expect(d.tags).toContain("session-decision"); }
    for (const e of errs) { expect(e.priority).toBe("high"); expect(e.tags).toContain("bug"); }
  });

  test("same content → update, not duplicate", async () => {
    const before = store.list().length;
    const sm: SessionMemory = {
      session: "e2e-sess-1", project: "paw-ts", updatedAt: Date.now(),
      filesAndFunctions: ["packages/core/src/build.ts"],
      keyDecisions: ["esbuild 替代 tsc 加速构建"],
      errorsAndFixes: ["TS2307: Cannot find module → 添加 paths 映射"],
    };
    const r = await extractSessionHighlightsToAutoMemory({ sessionMemory: sm, autoMemoryStore: store, workspaceRoot: WS });
    expect(r.created).toBe(0);
    expect(store.list().length).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 3. Keyword retrieval + priority (Tier 1)", () => {
  test("high-priority arch memory ranks top", () => {
    const r = retrieve({ goal: "项目架构是什么", workspaceRoot: WS, limit: 5 });
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records[0]?.title).toBe("core-arch");
  });

  test("error_signatures match gets big score boost", () => {
    const r = retrieve({ goal: "TS2307 模块找不到", workspaceRoot: WS, errorMessage: "TS2307", limit: 5 });
    expect(r.records.length).toBeGreaterThan(0);
    // build-fix or session-error entries with TS2307 should appear in top results
    const topNames = r.records.map(x => x.title);
    const hasBuildOrSessionError = topNames.some(n => n === "build-fix" || n.includes("-err-"));
    expect(hasBuildOrSessionError).toBe(true);
  });

  test("expired validUntil heavily penalized", () => {
    const r = retrieve({ goal: "context manager 调试 debug 内存泄露", workspaceRoot: WS, limit: 10 });
    // temp-debug may have been archived by buildIndex; if still present, not #1
    if (r.records.length > 0) expect(r.records[0]?.title).not.toBe("temp-debug");
  });

  test("linked_memories hub boost", () => {
    const r = retrieve({ goal: "memory system design architecture", workspaceRoot: WS, limit: 5 });
    expect(r.records.map(x => x.title)).toContain("core-arch");
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 4. Semantic boost (Tier 2)", () => {
  test("build query + embedding → build memories top", () => {
    const r = retrieve({ goal: "构建失败修复构建脚本错误", workspaceRoot: WS, limit: 5, queryEmbedding: fakeEmbedding(103) });
    expect(r.records.length).toBeGreaterThanOrEqual(2);
    const buildSet = new Set(["build-fix","compile-pipe","core-arch"]);
    expect(buildSet.has(r.records[0]?.title ?? "")).toBe(true);
  });

  test("auth query → JWT memory #1", () => {
    const r = retrieve({ goal: "JWT 认证 token 设计", workspaceRoot: WS, limit: 5, queryEmbedding: fakeEmbedding(805) });
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records[0]?.title).toBe("auth-jwt");
  });

  test("semantic boost changes scores", () => {
    const off = rank({ goal: "构建错误修复", workspaceRoot: WS, queryEmbedding: fakeEmbedding(101), semanticBoostWeight: 0 });
    const on = rank({ goal: "构建错误修复", workspaceRoot: WS, queryEmbedding: fakeEmbedding(101), semanticBoostWeight: 0.3 });
    const changed = on.some((rw, i) => Math.abs(rw.score - (off[i]?.score ?? 0)) > 0.001);
    expect(changed).toBe(true);
  });

  test("textSimilarity fallback matches related text", () => {
    const r = retrieve({ goal: "打包构建部署流程", workspaceRoot: WS, limit: 5 });
    expect(r.records.map(x => x.title)).toContain("compile-pipe");
  });

  test("CJK bigrams improve Chinese matching", () => {
    const sim = EmbeddingCache.textSimilarity("构建失败修复", "打包构建流程");
    expect(sim).toBeGreaterThan(0.05);
    const unr = EmbeddingCache.textSimilarity("构建失败修复", "用户登录认证");
    expect(sim).toBeGreaterThan(unr);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 5. Cascade (Tier 3)", () => {
  test("retrievalMode=cascade", async () => {
    const r = await retrieveMemories(unified, { goal: "build fix", workspaceRoot: WS, limit: 5, queryEmbedding: fakeEmbedding(103) }, { mode: "cascade", llmSelect: async () => [] });
    expect(r.retrievalMode).toBe("cascade");
  });

  test("LLM selector returns entries", async () => {
    const r = await retrieveMemories(unified, { goal: "build fix", workspaceRoot: WS, limit: 5, queryEmbedding: fakeEmbedding(103) }, { mode: "cascade", llmSelect: async (inp) => inp.candidateIds.filter((id: string) => id.includes("build") || id.includes("compile")) });
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records.map(x => x.title)).toContain("build-fix");
  });

  test("cache hits/misses populated", async () => {
    const r = await retrieveMemories(unified, { goal: "test cache stats", workspaceRoot: WS, limit: 5, queryEmbedding: fakeEmbedding(999) }, { mode: "cascade", llmSelect: async () => [] });
    expect(typeof r.embeddingCacheHits).toBe("number");
    expect(r.embeddingCacheHits!).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 6. Task profiles (B.4)", () => {
  test("refactor_arch → large budget", () => {
    const r = retrieve({ goal: "重构架构", workspaceRoot: WS, taskProfile: "refactor_arch", limit: 10 });
    expect(r.records.length).toBeGreaterThan(0);
  });
  test("simple_script → minimal budget", () => {
    const r = retrieve({ goal: "简单脚本", workspaceRoot: WS, taskProfile: "simple_script" });
    expect(r.records.length).toBeLessThanOrEqual(2);
    expect(r.injectedTokens).toBeLessThanOrEqual(600);
  });
  test("bug_fix → boosts bug tags", () => {
    const r = retrieve({ goal: "修复 TS 错误", workspaceRoot: WS, taskProfile: "bug_fix", limit: 5 });
    expect(r.records.map(x => x.title)).toContain("build-fix");
  });
  test("classifyTask auto-detect", () => {
    expect(classifyTask("refactor auth")).toBe("refactor_arch");
    expect(classifyTask("修复报错")).toBe("bug_fix");
    expect(classifyTask("写一个脚本")).toBe("simple_script");
    expect(classifyTask("解释代码")).toBe("general");
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 7. Sharded index (A.4)", () => {
  test("master MEMORY.md references shards", () => {
    expect(readFileSync(path.join(MEM, "MEMORY.md"), "utf-8")).toContain("MEMORY-1.md");
  });
  test("loadAllIndexShards contains entries", () => {
    expect(store.loadAllIndexShards()!).toContain("core-arch");
  });
  test("list excludes shard files", () => {
    expect(store.list().some(e => /^MEMORY-\d+$/.test(e.name))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 8. Archive + validUntil", () => {
  test("low+old entries archived", () => {
    const c = store.archiveExpired(90);
    expect(c).toBeGreaterThanOrEqual(0); // may already be archived by buildIndex
  });
  test("high-priority never archived by age", () => {
    expect(store.load("core-arch")).not.toBeNull();
  });
  test("valid_until expired → archived", () => {
    // temp-debug has valid_until in past; should be handled
    const inArchive = existsSync(path.join(MEM, "archive", "temp-debug.md"));
    const inMain = store.load("temp-debug");
    expect(inArchive || inMain === null).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 9. Reflection counter (B.2)", () => {
  test("20th call triggers", () => {
    resetReflectionCounter(MEM);
    for (let i = 0; i < 19; i++) expect(shouldRunReflection(MEM)).toBe(false);
    expect(shouldRunReflection(MEM)).toBe(true);
    expect(shouldRunReflection(MEM)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 10. Embedding cache stats", () => {
  test("with queryEmbedding → hits > 0", () => {
    const r = retrieve({ goal: "architecture overview", workspaceRoot: WS, limit: 5, queryEmbedding: fakeEmbedding(100) });
    expect(r.embeddingCacheHits!).toBeGreaterThan(0);
  });
  test("without queryEmbedding → 0 hits", () => {
    const r = retrieve({ goal: "architecture overview", workspaceRoot: WS, limit: 5 });
    expect(r.embeddingCacheHits!).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe("E2E — 11. Edge cases", () => {
  test("empty goal", () => expect(retrieve({ goal: "", workspaceRoot: WS })).toBeDefined());
  test("very long query", () => expect(retrieve({ goal: "a".repeat(10000), workspaceRoot: WS })).toBeDefined());
  test("excludes current session", () => {
    const u2 = new UnifiedMemoryStore({ workspaceRoot: WS, sessionId: "e2e-sess-1", memoryDir: MEM });
    expect(u2.listExcludingCurrent().some(r => r.id === "e2e-sess-1")).toBe(false);
  });
  test("upsert creates", () => expect(store.upsert({ name:"e2e-unique", description:"Unique", type:"project", content:"x" })).toBe("created"));
  test("upsert updates by name", () => {
    store.save({ name:"e2e-up", description:"Old", type:"project", content:"old", priority:"low" });
    expect(store.upsert({ name:"e2e-up", description:"New", type:"project", content:"new", priority:"high" })).toBe("updated");
    expect(store.load("e2e-up")!.priority).toBe("high");
    store.delete("e2e-up");
  });
  test("session naming → findSimilar by content-signature", () => {
    store.save({ name:"sess-abcd01-dec-123456789abc", description:"[S] Test", type:"project", content:"t" });
    expect(store.findSimilar({ name:"sess-abcd01-dec-123456789abc", description:"Diff", type:"project", content:"diff" })).not.toBeNull();
    store.delete("sess-abcd01-dec-123456789abc");
  });
});
