/**
 * Embedding Service
 *
 * 文本 → 向量的生成接口。默认使用字符 n-gram 哈希（零依赖），
 * 可注入外部模型（OpenAI / Ollama）升级精度。
 */

import { getSql } from "../../connection.js";

export interface EmbeddingService {
  /** 生成文本的 embedding 向量 */
  embed(text: string): Promise<number[]>;
  /** 向量维度 */
  readonly dimensions: number;
}

/**
 * 默认实现：字符 n-gram 统计 → 稀疏哈希向量。
 * 不需要任何外部依赖或 API key，适合 MVP 快速验证。
 * 精度远低于模型 embedding，但能区分明显不同的文本。
 */
export class NGramEmbeddingService implements EmbeddingService {
  readonly dimensions: number;
  private readonly n: number;

  constructor(dimensions = 256, n = 3) {
    this.dimensions = dimensions;
    this.n = n;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    const normalized = text.toLowerCase().replace(/[^a-z0-9一-鿿]/g, " ");

    for (let i = 0; i <= normalized.length - this.n; i++) {
      const gram = normalized.slice(i, i + this.n);
      const idx = this.hashToIndex(gram);
      vec[idx] = (vec[idx] ?? 0) + 1;
    }

    return this.normalize(vec);
  }

  private hashToIndex(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % this.dimensions;
  }

  private normalize(vec: number[]): number[] {
    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    const norm = Math.sqrt(sumSq) || 1;
    return vec.map((v) => v / norm);
  }
}

/**
 * 将 embedding 向量存入 memory_embeddings 表。
 * 幂等：同 memory_id 存在则更新。
 */
export async function storeEmbedding(
  memoryId: string, memoryVersionId: string, vector: number[],
  model = "ngram-256", modelVersion = "1.0",
): Promise<void> {
  const sql = getSql();
  const id = `emb_${memoryId}`;
  const formatted = `[${vector.join(",")}]`;
  await sql`
    INSERT INTO memory_embeddings (id, memory_id, memory_version_id, embedding, embedding_model, embedding_version, index_revision, created_at)
    VALUES (${id}, ${memoryId}, ${memoryVersionId}, ${formatted}::vector, ${model}, ${modelVersion}, 1, now())
    ON CONFLICT (memory_id) DO UPDATE SET
      memory_version_id = ${memoryVersionId},
      embedding = ${formatted}::vector,
      embedding_model = ${model},
      embedding_version = ${modelVersion},
      index_revision = memory_embeddings.index_revision + 1
  `;
}

/** 计算两个向量的余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
