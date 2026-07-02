/**
 * 轻量级语义嵌入缓存 —— 用于记忆检索的向量化支持。
 *
 * 【模块职责】
 * 为 AutoMemory（自动记忆）系统提供文本向量化（embedding）能力，支持语义相似度检索。
 * 当用户查询与历史记忆进行匹配时，不是简单的关键词搜索，而是将两者转为向量后计算
 * 余弦相似度，从而找到语义相关（而非字面匹配）的记忆条目。
 *
 * 【两级策略（Two-tier strategy）】
 *   Tier 1: Ollama `/api/embeddings`（本地、离线）—— 真正的语义向量，高质量
 *   Tier 2: 纯 TypeScript bigram + word Jaccard 回退 —— 零依赖，始终可用
 *
 * 当 Ollama 不可用时（未安装、网络问题、超时等），自动降级到 Tier 2 的统计文本相似度，
 * 确保语义检索功能不会完全失效，只是精度略降。
 *
 * 【为什么存在】
 * - 记忆检索是长期运行 AI 助手的关键能力。没有向量相似度，就只能靠关键词匹配，
 *   无法找到"修复构建脚本"和"构建流程报错"这样的语义相关记忆。
 * - Ollama 本地嵌入模型（如 nomic-embed-text）无需网络、无需 API key，
 *   适合离线开发场景。
 * - 嵌入向量以 base64 编码存储在 AutoMemory 的 YAML frontmatter 中，
 *   随 markdown 文件一起保存和迁移，不依赖外部向量数据库。
 *
 * 【关键设计决策】
 * - **查询缓存（LRU，50条目上限）**：相似查询在同一会话内不应重复请求 Ollama。
 *   仅缓存短查询（前 500 字符做 key），不缓存完整记忆内容。
 * - **CJK 大字符检测**：`textSimilarity` 专门处理中日韩文本——
 *   对 CJK 文本提取字符级 bigram 作为伪词元，使得"修复"、"构建"等中文词
 *   能被正确匹配。
 * - **Jaccard 相似度混合权重**：wordSim（0.55）+ bigramSim（0.45）。
 *   word 级别的匹配比纯字符级别更有意义，权重略高。
 * - **静态编码/解码方法**：`encodeEmbedding` / `decodeEmbedding` 不依赖实例状态，
 *   方便在序列化/反序列化场景中直接使用。
 * - `computeEmbedding` 返回 `null` 而非抛出异常，调用方可以优雅降级到 textSimilarity。
 */

/** 嵌入模型配置 */
export interface EmbeddingConfig {
  /** 嵌入模型名称（默认："nomic-embed-text"） */
  readonly model?: string;
  /** Ollama 服务的基础 URL（默认："http://localhost:11434"） */
  readonly baseUrl?: string;
  /** 请求超时毫秒数（默认：10_000） */
  readonly timeoutMs?: number;
}

/** 记忆条目的数据结构 —— 用于生成嵌入向量的输入 */
export interface EmbeddingCacheEntry {
  /** 记忆标题 */
  readonly title: string;
  /** 记忆摘要 */
  readonly summary: string;
  /** 记忆完整内容 */
  readonly content: string;
}

/** 默认嵌入模型 */
const DEFAULT_EMBEDDING_MODEL = "jina/jina-embeddings-v2-base-code";
/** 默认 Ollama 服务地址 */
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
/** 默认请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 查询缓存最大条目数（LRU 驱逐） */
const QUERY_CACHE_MAX_SIZE = 50;

/**
 * 无状态嵌入辅助类。
 *
 * 每次运行实例化一次，配置好模型名和 Ollama 地址，
 * 然后调用 {@link computeEmbedding} 为查询文本生成向量，
 * 调用 {@link computeMemoryEmbedding} 为记忆条目生成向量。
 *
 * 查询向量的结果会在内存中 LRU 缓存（最多 50 条），
 * 避免同一会话中的相似查询重复请求 Ollama。
 */
export class EmbeddingCache {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** 查询向量缓存（LRU，最多 50 条） */
  private readonly queryCache: Map<string, number[]> = new Map();
  /** 查询缓存键值的有序列表（用于 LRU 驱逐：头部 = 最旧，尾部 = 最新） */
  private readonly queryCacheKeys: string[] = [];

  constructor(config?: EmbeddingConfig) {
    this.model = config?.model ?? DEFAULT_EMBEDDING_MODEL;
    // 去除 baseUrl 尾部斜杠，防止拼接出双斜杠的 URL
    this.baseUrl =
      config?.baseUrl?.replace(/\/$/, "") ?? DEFAULT_OLLAMA_HOST;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 当前使用的嵌入模型名称 */
  get embeddingModel(): string {
    return this.model;
  }

  /** 当前 Ollama 服务地址 */
  get embeddingBaseUrl(): string {
    return this.baseUrl;
  }

  // ── 嵌入向量计算 ──────────────────────────────────────

  /**
   * 通过 Ollama API 计算文本的嵌入向量。
   *
   * @param text  要向量化的文本（查询文本或记忆内容）
   * @returns 嵌入向量（浮点数数组），失败时返回 null
   *
   * 结果会在内存中 LRU 缓存（最多 50 条目），缓存 key 取文本前 500 字符。
   * 注意：缓存仅用于短查询文本，不缓存完整记忆内容。
   */
  async computeEmbedding(text: string): Promise<number[] | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // LRU 缓存查找（仅对短查询文本缓存，不缓存完整记忆内容）
    const cacheKey = trimmed.slice(0, 500);
    const cached = this.queryCache.get(cacheKey);
    if (cached) return cached;

    try {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: trimmed }),
        // AbortSignal.timeout 是 Node 18+ 的内置超时机制
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { embedding?: number[] };
      const emb = json.embedding;
      if (Array.isArray(emb) && emb.length > 0) {
        this.setQueryCache(cacheKey, emb);
        return emb;
      }
      return null;
    } catch {
      // 任何错误（网络、超时、Ollama 不可用）都返回 null，由调用方降级到 textSimilarity
      return null;
    }
  }

  /**
   * LRU 缓存写入。
   *
   * 如果 key 已存在，将其移到最近使用位置（MRU）。
   * 如果 key 不存在且缓存已满，驱逐最旧的条目。
   */
  private setQueryCache(key: string, embedding: number[]): void {
    if (this.queryCache.has(key)) {
      // 已存在 → 移到最近使用位置
      const idx = this.queryCacheKeys.indexOf(key);
      if (idx >= 0) this.queryCacheKeys.splice(idx, 1);
    } else {
      // 缓存满时驱逐最旧条目（queryCacheKeys[0]）
      while (this.queryCacheKeys.length >= QUERY_CACHE_MAX_SIZE) {
        const old = this.queryCacheKeys.shift();
        if (old) this.queryCache.delete(old);
      }
      this.queryCache.set(key, embedding);
    }
    this.queryCacheKeys.push(key);
  }

  /** 清空查询嵌入缓存（例如在会话之间切换时调用） */
  clearQueryCache(): void {
    this.queryCache.clear();
    this.queryCacheKeys.length = 0;
  }

  /**
   * 为记忆条目计算嵌入向量。
   *
   * 将 title + summary + content 拼接为一段文本后进行向量化，
   * 使得记忆的标题和内容都对相似度计算有贡献。
   */
  async computeMemoryEmbedding(
    entry: EmbeddingCacheEntry,
  ): Promise<number[] | null> {
    const text = [entry.title, entry.summary, entry.content]
      .filter((x) => x.trim())  // 过滤空字段，避免多余换行
      .join("\n");
    return this.computeEmbedding(text);
  }

  // ── 编码辅助方法（静态方法，不依赖实例状态）───────

  /**
   * 将浮点数向量编码为 base64 字符串（用于 YAML 存储）。
   *
   * 转换流程：number[] → Float32Array → Uint8Array → base64
   * 使用 Float32Array 保证每个值占 4 字节，decode 时可以精确还原。
   */
  static encodeEmbedding(embedding: number[]): string {
    const floats = new Float32Array(embedding);
    const bytes = new Uint8Array(floats.buffer);
    return Buffer.from(bytes).toString("base64");
  }

  /**
   * 解码 base64 编码的浮点数向量。
   *
   * @param encoded  base64 字符串
   * @returns 浮点数数组，输入无效时返回 null
   *
   * 验证逻辑：字节长度必须 > 0 且能被 4 整除（Float32 = 4 字节）。
   */
  static decodeEmbedding(encoded: string): number[] | null {
    if (!encoded || encoded.trim().length === 0) return null;
    try {
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
      const floats = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.length / 4,
      );
      return Array.from(floats);
    } catch {
      return null;
    }
  }

  // ── 相似度计算 ─────────────────────────────────────────────────

  /**
   * 两个向量的余弦相似度计算。
   *
   * 公式：cos(a, b) = dot(a, b) / (||a|| × ||b||)
   *
   * 处理不等长向量：在较短向量的长度内计算点积，每个向量的剩余维度
   * 仍纳入各自范数计算。这比直接截断要更准确。
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const minLen = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    // 公共长度部分：计算点积和范数
    for (let i = 0; i < minLen; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    // 剩余维度：只纳入各自范数（不影响点积）
    for (let i = minLen; i < a.length; i++) normA += a[i]! * a[i]!;
    for (let i = minLen; i < b.length; i++) normB += b[i]! * b[i]!;

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * 纯 TypeScript 回退方案：词级 Jaccard + 字符 bigram 重叠度。
   *
   * 当 Ollama 不可用时使用此方法，为语义增强维度提供信号，
   * 而不是完全回退到纯关键词评分。
   *
   * 对于 CJK（中日韩）文本：提取字符 bigram 作为伪词元，
   * 使得"修复构建脚本"和"构建流程报错"能通过共享的 bigram
   * "修复"、"构建"、"建脚"等匹配上。
   *
   * @returns 相似度分数，范围 [0, 1]
   */
  static textSimilarity(query: string, target: string): number {
    const qNorm = query.toLowerCase().trim();
    const tNorm = target.toLowerCase().trim();
    if (!qNorm || !tNorm) return 0;

    // -- 词级 Jaccard（空格分隔词 + CJK bigram 伪词元）--
    const tokenize = (s: string): Set<string> => {
      const tokens = new Set<string>();
      // 标准空格分隔的单词
      for (const w of s.split(/\s+/)) {
        if (w.length > 1) tokens.add(w);
      }
      // CJK 字符 bigram 作为伪词元（处理中日韩文本）
      const cjk = /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/;
      if (cjk.test(s)) {
        // 提取纯 CJK 连续段，生成字符级 bigram
        const spans = s.split(/[^一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]+/);
        for (const span of spans) {
          for (let i = 0; i < span.length - 1; i++) {
            tokens.add(span.slice(i, i + 2));
          }
        }
      }
      return tokens;
    };
    const qWords = tokenize(qNorm);
    const tWords = tokenize(tNorm);
    let intersect = 0;
    for (const w of qWords) {
      if (tWords.has(w)) intersect++;
    }
    const wordUnion = new Set([...qWords, ...tWords]).size;
    // Jaccard 相似度 = |交集| / |并集|
    const wordSim = wordUnion === 0 ? 0 : intersect / wordUnion;

    // -- 字符 bigram Jaccard（所有字符，不限于 CJK）--
    const bigrams = (s: string): Set<string> => {
      const bgs = new Set<string>();
      for (let i = 0; i < s.length - 1; i++) bgs.add(s.slice(i, i + 2));
      return bgs;
    };
    const qBigrams = bigrams(qNorm);
    const tBigrams = bigrams(tNorm);
    let bgIntersect = 0;
    for (const b of qBigrams) {
      if (tBigrams.has(b)) bgIntersect++;
    }
    const bgUnion = new Set([...qBigrams, ...tBigrams]).size;
    const bgSim = bgUnion === 0 ? 0 : bgIntersect / bgUnion;

    // 词级信号比纯字符重叠更有语义意义，权重略高（0.55 vs 0.45）
    return wordSim * 0.55 + bgSim * 0.45;
  }
}

/**
 * 从设置中解析嵌入配置。
 *
 * @returns EmbeddingConfig 对象，或 null（表示语义增强功能已禁用，回退到关键词检索）
 */
export function resolveEmbeddingConfig(settings: {
  readonly memory_embedding_model?: string;
  readonly ollama_host?: string;
}): EmbeddingConfig | null {
  if (!settings.memory_embedding_model) return null;
  return {
    model: settings.memory_embedding_model,
    baseUrl: settings.ollama_host ?? DEFAULT_OLLAMA_HOST,
  };
}
