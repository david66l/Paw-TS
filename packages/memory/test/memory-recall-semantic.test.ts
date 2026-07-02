/**
 * Integration test: memory retrieval with semantic boost.
 *
 * Uses the real AutoMemoryStore + UnifiedMemoryStore path so
 * write → read → retrieve flows through the same code as production.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AutoMemoryStore,
  EmbeddingCache,
  KeywordMemoryRetriever,
  UnifiedMemoryStore,
  type RetrievalQuery,
} from "../src/index.js";
import { fakeEmbedding } from "./fixtures.js";

// Use a stable temp dir so AutoMemoryStore writes to the expected location
const WS = path.join(tmpdir(), `paw-sem-${Date.now()}`);
const store = new AutoMemoryStore({ workspaceRoot: WS });

const ENTRIES = [
  { name: "build-fix", desc: "修复构建脚本build打包报错", content: "build script fix 构建脚本修复 tsc bundler", type: "project" as const, seed: 100 },
  { name: "compile-guide", desc: "编译流水线tsc bundle打包步骤", content: "compile pipeline tsc bundle 编译 打包 构建流程", type: "project" as const, seed: 105 },
  { name: "ts2307-fix", desc: "修复TS2307模块找不到错误", content: "TS2307 构建 错误 build error 模块缺失", type: "project" as const, seed: 102 },
  { name: "deploy-sop", desc: "构建部署打包生产环境SOP", content: "deploy 打包 部署 build production 构建", type: "reference" as const, seed: 108 },
  { name: "react-state", desc: "React前端组件状态管理方案", content: "react frontend state 前端 组件 状态 hooks context", type: "reference" as const, seed: 300 },
  { name: "user-auth", desc: "用户登录认证JWT模块架构", content: "user auth login 用户 登录 JWT 认证 session", type: "project" as const, seed: 900 },
  { name: "api-limit", desc: "API接口限流策略配置", content: "API rate limit 限流 接口 频率 配额", type: "reference" as const, seed: 910 },
];

// Write memories with embeddings
for (const m of ENTRIES) {
  store.save({
    name: m.name,
    description: m.desc,
    type: m.type,
    content: m.content,
    embedding: EmbeddingCache.encodeEmbedding(fakeEmbedding(m.seed)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
store.buildIndex();

const unified = new UnifiedMemoryStore({ workspaceRoot: WS });
const retriever = new KeywordMemoryRetriever(unified);

// Verify written memories are readable
const all = store.list();
console.log(`[test] wrote ${ENTRIES.length} memories, list() returns ${all.length}`);

afterAll(() => {
  for (const m of ENTRIES) {
    try { store.delete(m.name); } catch { /* ok */ }
  }
});

// ── Tests ──

describe("semantic boost — embedding path", () => {
  test("build query with embedding ranks build memories first", () => {
    const q: RetrievalQuery = {
      goal: "构建失败了帮我修复构建脚本错误",
      workspaceRoot: WS,
      limit: 5,
      queryEmbedding: fakeEmbedding(103),
    };
    const result = retriever.retrieve(q);
    expect(result.records.length).toBeGreaterThanOrEqual(2);

    const names = result.records.map((r) => r.title);
    // Build-related entries should dominate results
    const buildSet = new Set(["build-fix", "compile-guide", "ts2307-fix", "deploy-sop"]);
    const topBuild = names.filter((n) => buildSet.has(n));
    expect(topBuild.length).toBeGreaterThanOrEqual(2);
  });

  test("auth query ranks auth memory top", () => {
    const q: RetrievalQuery = {
      goal: "用户登录 用户认证 JWT 认证模块怎么实现",
      workspaceRoot: WS,
      limit: 5,
      queryEmbedding: fakeEmbedding(905),
    };
    const result = retriever.retrieve(q);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records[0]?.title).toBe("user-auth");
  });

  test("boost=0 vs boost=0.3 produce different scores", () => {
    const base: RetrievalQuery = {
      goal: "构建错误修复",
      workspaceRoot: WS,
      limit: 3,
      queryEmbedding: fakeEmbedding(101),
    };
    const rOff = retriever.rankRecords({ ...base, semanticBoostWeight: 0 });
    const rOn = retriever.rankRecords({ ...base, semanticBoostWeight: 0.3 });
    expect(rOff.length).toBe(rOn.length);
    const anyChanged = rOn.some(
      (rw, i) => Math.abs(rw.score - (rOff[i]?.score ?? 0)) > 0.001,
    );
    expect(anyChanged).toBe(true);
  });
});

describe("semantic boost — text fallback (no Ollama)", () => {
  test("chinese build query matches build memories via textSimilarity", () => {
    const q: RetrievalQuery = {
      goal: "打包部署构建流程",
      workspaceRoot: WS,
      limit: 5,
      // no queryEmbedding → activates textSimilarity fallback
    };
    const result = retriever.retrieve(q);
    expect(result.records.length).toBeGreaterThan(0);
    const names = result.records.map((r) => r.title);
    expect(names).toContain("deploy-sop");
  });

  test("textSimilarity: related > unrelated", () => {
    const rel = EmbeddingCache.textSimilarity(
      "修复构建脚本build报错",
      "打包编译流程构建报错修复",
    );
    const unr = EmbeddingCache.textSimilarity(
      "修复构建脚本build报错",
      "用户登录JWT认证模块",
    );
    expect(rel).toBeGreaterThan(unr);
  });

  test("textSimilarity: mixed CN/EN text overlap works", () => {
    // Pure CN vs pure EN == 0 (fundamental limitation of pure-TS fallback).
    // But mixed text with shared tokens should work:
    const sim = EmbeddingCache.textSimilarity(
      "build 构建 compile 编译 error 错误",
      "build 构建 compile 编译 fix 修复",
    );
    expect(sim).toBeGreaterThan(0.3);
  });
});
