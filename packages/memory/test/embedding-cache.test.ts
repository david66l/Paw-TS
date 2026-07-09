import { describe, expect, test } from "bun:test";

import { EmbeddingCache, resolveEmbeddingConfig } from "../src/shared/embedding-cache.js";

describe("EmbeddingCache — static methods (no Ollama dependency)", () => {
  describe("cosineSimilarity", () => {
    test("identical vectors return 1", () => {
      const v = [1, 2, 3, 4, 5];
      expect(EmbeddingCache.cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    });

    test("orthogonal vectors return 0", () => {
      expect(EmbeddingCache.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    test("opposite vectors return -1", () => {
      expect(EmbeddingCache.cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(
        -1,
        5,
      );
    });

    test("handles unequal-length vectors", () => {
      const a = [1, 2, 3];
      const b = [1, 2];
      const sim = EmbeddingCache.cosineSimilarity(a, b);
      expect(sim).toBeGreaterThan(0.5);
      expect(sim).toBeLessThan(1);
    });

    test("zero-length vectors return 0", () => {
      expect(EmbeddingCache.cosineSimilarity([], [1, 2])).toBe(0);
      expect(EmbeddingCache.cosineSimilarity([1, 2], [])).toBe(0);
    });

    test("distinct vectors have low similarity", () => {
      const a = [1, 0, 0, 0, 0];
      const b = [0, 0, 0, 0, 1];
      expect(EmbeddingCache.cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });
  });

  describe("encodeEmbedding / decodeEmbedding round-trip", () => {
    test("encodes and decodes without loss", () => {
      const original = [0.1, 0.2, -0.3, 0.5, 0.8];
      const encoded = EmbeddingCache.encodeEmbedding(original);
      expect(typeof encoded).toBe("string");
      expect(encoded.length).toBeGreaterThan(0);

      const decoded = EmbeddingCache.decodeEmbedding(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(decoded![i]!).toBeCloseTo(original[i]!, 4);
      }
    });

    test("large embedding round-trip", () => {
      const original = Array.from({ length: 384 }, () => Math.random() - 0.5);
      const encoded = EmbeddingCache.encodeEmbedding(original);
      const decoded = EmbeddingCache.decodeEmbedding(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.length).toBe(384);
      for (let i = 0; i < 384; i++) {
        expect(decoded![i]!).toBeCloseTo(original[i]!, 4);
      }
    });

    test("empty string returns null", () => {
      expect(EmbeddingCache.decodeEmbedding("")).toBeNull();
    });

    test("invalid base64 returns null", () => {
      expect(EmbeddingCache.decodeEmbedding("!!!not-valid!!!")).toBeNull();
    });

    test("byte length not divisible by 4 returns null", () => {
      // "abc" in base64 = 2 bytes (not divisible by 4)
      expect(EmbeddingCache.decodeEmbedding("abc")).toBeNull();
    });
  });

  describe("textSimilarity (pure-TS fallback)", () => {
    test("identical texts return near 1", () => {
      const sim = EmbeddingCache.textSimilarity(
        "fix the build script",
        "fix the build script",
      );
      expect(sim).toBeCloseTo(1, 1);
    });

    test("semantically similar texts score higher than unrelated", () => {
      const related = EmbeddingCache.textSimilarity(
        "fix build script",
        "repair the compile pipeline",
      );
      const unrelated = EmbeddingCache.textSimilarity(
        "fix build script",
        "add user authentication",
      );
      expect(related).toBeGreaterThan(unrelated);
    });

    test("Chinese + English mixed", () => {
      const high = EmbeddingCache.textSimilarity(
        "修复build脚本",
        "fix the build script",
      );
      // Should have some overlap via character bigrams
      expect(high).toBeGreaterThan(0);
    });

    test("Chinese paraphrases match better than unrelated", () => {
      const related = EmbeddingCache.textSimilarity(
        "打包构建流程出错了",
        "编译部署失败",
      );
      const unrelated = EmbeddingCache.textSimilarity(
        "打包构建流程出错了",
        "添加用户登录功能",
      );
      // Chinese bigrams should capture more overlap for related terms
      expect(related).toBeGreaterThanOrEqual(unrelated);
    });

    test("empty strings return 0", () => {
      expect(EmbeddingCache.textSimilarity("", "anything")).toBe(0);
      expect(EmbeddingCache.textSimilarity("anything", "")).toBe(0);
    });
  });
});

describe("EmbeddingCache — constructor", () => {
  test("defaults when no config provided", () => {
    const cache = new EmbeddingCache();
    expect(cache.embeddingModel).toBe("jina/jina-embeddings-v2-base-code");
    expect(cache.embeddingBaseUrl).toBe("http://localhost:11434");
  });

  test("respects custom config", () => {
    const cache = new EmbeddingCache({
      model: "bge-m3",
      baseUrl: "http://127.0.0.1:12345",
    });
    expect(cache.embeddingModel).toBe("bge-m3");
    expect(cache.embeddingBaseUrl).toBe("http://127.0.0.1:12345");
  });

  test("strips trailing slash from baseUrl", () => {
    const cache = new EmbeddingCache({
      baseUrl: "http://localhost:11434/",
    });
    expect(cache.embeddingBaseUrl).toBe("http://localhost:11434");
  });
});

describe("resolveEmbeddingConfig", () => {
  test("returns null when no model configured", () => {
    expect(resolveEmbeddingConfig({})).toBeNull();
  });

  test("returns config with model", () => {
    const cfg = resolveEmbeddingConfig({
      memory_embedding_model: "jina/jina-embeddings-v2-base-code",
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("jina/jina-embeddings-v2-base-code");
    expect(cfg!.baseUrl).toBe("http://localhost:11434");
  });

  test("uses custom ollama_host", () => {
    const cfg = resolveEmbeddingConfig({
      memory_embedding_model: "bge-m3",
      ollama_host: "http://gpu-server:11434",
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.model).toBe("bge-m3");
    expect(cfg!.baseUrl).toBe("http://gpu-server:11434");
  });
});
