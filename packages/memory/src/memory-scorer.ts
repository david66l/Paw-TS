/**
 * 记忆相关性评分模块。
 *
 * ## 模块定位
 *
 * 当用户发起查询或 AI 需要检索相关记忆时，本模块负责对每条候选记忆进行多维度打分，
 * 输出一个综合相关性分数。评分结果直接影响记忆的选择和注入（由 memory-selector 完成）。
 *
 * ## 架构设计
 *
 * 评分采用纯规则（rule-based）多维度加权模型，不依赖外部 LLM 调用：
 *
 * ### 评分维度（共 15 个维度，按执行顺序）
 *
 * 1.  **关键词匹配（Keyword Match）**: 标题/摘要权重 15，正文权重 5，
 *     至少需要 2 个匹配词才视为有文本信号
 * 2.  **路径匹配（Path Match）**: 查询涉及的文件 vs 记忆关联的文件，
 *     通过 `pathMatchScore` 计算路径相似度
 * 3.  **错误签名匹配（Error Signature）**: 权重 40，错误码/异常名匹配
 * 4.  **工具名匹配（Tool Name）**: 标签匹配 +5，正文匹配 +8
 * 5.  **路径不匹配惩罚（Path Mismatch Penalty）**: 关键词匹配但路径前缀无共同点（<2 层）时 -6
 * 6.  **时效性衰减（Recency Decay）**: 会话记忆半衰期 7 天，非会话记忆半衰期 30 天
 * 7.  **来源加权（Source Weight）**: 会话记忆 ×1.2 提升
 * 8.  **会话任务关键词加成（Session Task Match）**: ≥2 个词匹配时 +25
 * 8.5.**跨会话信号加成（Cross-Session Boost）**: 文件重叠 +0.1、错误重叠 +0.15、工具重叠 +0.05，上限 +0.2
 * 9.  **参考资料加成（Reference Multiplier）**: 标记为 reference 的记忆 ×1.2
 * 10. **架构查询加成（Architecture Reference Bonus）**: 架构查询 + 参考资料 → +30
 * 11. **语义相似度加成（Semantic Boost）**: 有嵌入向量时用余弦相似度，否则用文本 Jaccard fallback ×0.75
 * 12. **优先级系数（Priority Coefficient）**: high×1.3, mid×1.0, low×0.7
 * 13. **任务画像标签加成（Profile Tag Boost）**: 按任务类型（bug-fix/code-review 等）对特定标签加权
 * 14. **过期记忆惩罚（Expired Penalty）**: valid_until 已过的记忆 ×0.1
 * 15. **双向链接加成（Linked Memory Boost）**: 有关联记忆的条目 ×1.05
 *
 * ## 关键设计决策
 *
 * 1. **纯规则评分而非 LLM 评分**: 规则评分确定性高、速度快、成本为零，
 *    适合对数百条记忆做初步筛选；语义相似度作为可选加成而非主维度
 * 2. **多维度而非单维度**: 单一维度（如纯关键词匹配）容易漏掉上下文相关但用词不同的记忆
 * 3. **惩罚机制与加成机制并存**: 既要提升相关记忆（加成），也要压制表面匹配但实际无关的记忆（惩罚）
 * 4. **会话记忆优先**: 近期会话记忆中包含的上下文往往比长期记忆更相关，因此有更高的基础权重和时效性加成
 */

import { EmbeddingCache } from "./embedding-cache.js";
import {
  isArchitectureQuery,
  isReferenceMemory,
  PRIORITY_COEFFICIENTS,
  type MemoryRecord,
} from "./memory-record.js";
import { TASK_PROFILE_BUDGETS } from "./memory-profiles.js";
import type { RetrievalQuery } from "./memory-retriever.js";
import {
  normalizePathSeparators,
  pathMatchScore,
  stripPathLikeText,
  tokenize,
} from "./memory-tokenizer.js";

// ── 评分权重常量 ───────────────────────────────────────────────
// 这些权重值经过调优，平衡了各维度的贡献比例。
// 修改时需注意：权重过高会淹没其他维度的信号，过低则失去区分度。

/** 标题/摘要中关键词匹配的权重（比正文匹配权重高，因为标题更能代表内容主题） */
const KEYWORD_HEAD_WEIGHT = 15;
/** 正文中关键词匹配的权重 */
const KEYWORD_BODY_WEIGHT = 5;
/** 最少需要多少个关键词匹配才能认为有"文本信号"（用于触发后续条件判断） */
const MIN_TEXT_SIGNAL_MATCHES = 2;

/** 错误签名匹配的权重（较高，因为错误关联是非常强的相关性信号） */
const ERROR_SIGNATURE_WEIGHT = 40;

/** 工具名在标签中匹配的权重 */
const TOOL_NAME_TAG_WEIGHT = 5;
/** 工具名在正文/标题中匹配的权重（比标签匹配略高，因为出现在正文中说明工具的使用上下文更相关） */
const TOOL_NAME_TEXT_WEIGHT = 8;

/** 路径不匹配的扣分值（关键词匹配但路径无共同点时触发） */
const PATH_MISMATCH_PENALTY = 6;
/** 路径匹配的最低公共深度阈值（<2 层视为无实质重叠） */
const MIN_PATH_COMMON_DEPTH = 2;

/** 会话任务关键词匹配的加成（≥2 个词匹配时触发） */
const SESSION_TASK_MATCH_BONUS = 25;
/** 触发会话任务加成所需的最小匹配词数 */
const SESSION_TASK_MATCH_MIN_WORDS = 2;
/** 会话来源的基础权重乘数（1.2 = 比非会话记忆高 20%） */
const SESSION_SOURCE_MULTIPLIER = 1.2;

// 跨会话信号加成系数（A.2.2 节定义）
/** 文件路径重叠的加成比例 */
const CROSS_SESSION_FILE_BOOST = 0.1;
/** 错误签名重叠的加成比例 */
const CROSS_SESSION_ERROR_BOOST = 0.15;
/** 工具名重叠的加成比例 */
const CROSS_SESSION_TOOL_BOOST = 0.05;
/** 跨会话加成的总上限（防止过度放大跨会话信号） */
const CROSS_SESSION_BOOST_CAP = 0.2;

/** 参考资料（reference）类型记忆的权重乘数 */
const REFERENCE_MULTIPLIER = 1.2;
/** 架构查询 + 参考资料 → 额外加成分数 */
const ARCHITECTURE_REFERENCE_BONUS = 30;

/** 语义相似度 fallback（文本 Jaccard）的折扣系数：文本相似度不如嵌入向量可靠，打 75 折 */
const SEMANTIC_FALLBACK_MULTIPLIER = 0.75;

/** 过期记忆的权重乘数（极大降低，几乎不会出现在结果中但仍可被检索） */
const EXPIRED_MEMORY_MULTIPLIER = 0.1;
/** 双向链接记忆的权重乘数（微幅提升，表示知识图谱中的节点更有价值） */
const LINKED_MEMORY_MULTIPLIER = 1.05;

/** 会话记忆的默认半衰期（天）：7 天后权重衰减一半 */
const DEFAULT_SESSION_HALF_LIFE_DAYS = 7;
/** 非会话记忆的默认半衰期（天）：30 天后权重衰减一半 */
const DEFAULT_NON_SESSION_HALF_LIFE_DAYS = 30;

// ── 公开评分函数 ─────────────────────────────────────────────────

/**
 * 对单条记忆记录进行多维度相关性评分。
 *
 * ## 输入
 *
 * 查询已经被预处理（分词、文件路径提取等），通过参数分别传入，
 * 避免在评分函数内部重复计算。
 *
 * @param m - 候选记忆记录
 * @param query - 检索查询（包含 goal、recentFiles、recentToolNames 等上下文）
 * @param queryWords - 查询目标文本的分词结果（已小写化）
 * @param queryFiles - 查询涉及的文件路径列表（已归一化）
 * @param errWords - 错误关键词列表（从查询中提取的错误码/异常名），可选
 * @returns 综合相关性分数（非归一化，分数越高越相关）
 */
export function scoreMemoryRecord(
  m: MemoryRecord,
  query: RetrievalQuery,
  queryWords: string[],
  queryFiles: string[],
  errWords: string[] | undefined,
): number {
  let score = 0;

  // ═══════════════════════════════════════════════════════════════
  // 维度 1: 关键词匹配 — 标题/摘要 权重 > 正文 权重
  // ═══════════════════════════════════════════════════════════════
  // 先从标题+摘要+标签中去除路径类文本，避免路径片段干扰关键词匹配
  const headText = stripPathLikeText(
    [m.title, m.summary, ...m.tags].join(" "),
  );
  const headWords = tokenize(headText);
  const headMatches = queryWords.filter((w) => headWords.includes(w)).length;

  // 正文也做同样的路径剥离处理
  const bodyText = stripPathLikeText(m.content);
  const bodyWords = tokenize(bodyText);
  const bodyMatches = queryWords.filter((w) => bodyWords.includes(w)).length;

  score += headMatches * KEYWORD_HEAD_WEIGHT + bodyMatches * KEYWORD_BODY_WEIGHT;
  const keywordMatches = headMatches + bodyMatches;
  // hasTextSignal：是否有足够的关键词匹配，作为后续条件判断的依据
  const hasTextSignal = keywordMatches >= MIN_TEXT_SIGNAL_MATCHES;

  // ═══════════════════════════════════════════════════════════════
  // 维度 2: 路径匹配 — 查询文件 vs 记忆关联文件
  // ═══════════════════════════════════════════════════════════════
  for (const qf of queryFiles) {
    for (const relFile of m.relatedFiles) {
      score += pathMatchScore(qf, relFile, hasTextSignal);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 3: 错误签名匹配 — 高权重，因为错误关联是非常强的相关信号
  // ═══════════════════════════════════════════════════════════════
  if (errWords && m.relatedErrors.length > 0) {
    for (const sig of m.relatedErrors) {
      if (errWords.some((w) => sig.toLowerCase().includes(w))) {
        score += ERROR_SIGNATURE_WEIGHT;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 4: 工具名匹配 — 最近使用的工具与记忆中的工具交集
  // ═══════════════════════════════════════════════════════════════
  if (query.recentToolNames && query.recentToolNames.length > 0) {
    // 构建搜索 haystack：标题 + 摘要 + 正文 + 标签
    const haystack = [m.title, m.summary, m.content, ...m.tags]
      .join(" ")
      .toLowerCase();
    for (const toolName of query.recentToolNames) {
      // 标签匹配
      if (m.tags.includes(toolName)) score += TOOL_NAME_TAG_WEIGHT;
      // 正文/标题匹配（也尝试短名称，如 MCP 工具去掉命名空间前缀）
      const short = toolName.split(".").pop() ?? toolName;
      if (haystack.includes(toolName) || haystack.includes(short)) {
        score += TOOL_NAME_TEXT_WEIGHT;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 5: 路径不匹配惩罚 — 关键词匹配但路径完全无关时扣分
  // ═══════════════════════════════════════════════════════════════
  // 场景：用户搜索 "config" 且当前在 packages/core，某条记忆也有 "config"
  // 但其关联文件在 packages/workspace，两者路径前缀完全无重叠
  if (
    keywordMatches > 0 &&
    queryFiles.length > 0 &&
    m.relatedFiles.length > 0
  ) {
    let maxCommonDepth = 0;
    // 遍历所有查询文件和记忆关联文件的路径组合，找出最大公共深度
    for (const qf of queryFiles) {
      for (const relFile of m.relatedFiles) {
        const curParts = normalizePathSeparators(qf).split("/");
        const relParts = normalizePathSeparators(relFile).split("/");
        let commonDepth = 0;
        for (let i = 0; i < Math.min(curParts.length, relParts.length); i++) {
          if (curParts[i] === relParts[i]) commonDepth++;
          else break;
        }
        if (commonDepth > maxCommonDepth) maxCommonDepth = commonDepth;
      }
    }
    // 最大公共深度不足阈值 → 触发惩罚
    if (maxCommonDepth < MIN_PATH_COMMON_DEPTH) {
      score -= PATH_MISMATCH_PENALTY;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 6: 时效性衰减 — 越久远的记忆权重越低
  // ═══════════════════════════════════════════════════════════════
  // 会话记忆的半衰期更短（7天），因为会话上下文变化快
  // 非会话记忆（auto/user/reference）的半衰期更长（30天）
  const ageDays = (Date.now() - m.updatedAt) / (1000 * 60 * 60 * 24);
  const halfLife =
    m.source === "session"
      ? (query.config?.sessionRecencyHalfLifeDays ?? DEFAULT_SESSION_HALF_LIFE_DAYS)
      : DEFAULT_NON_SESSION_HALF_LIFE_DAYS;
  // recencyBoost: 0天=1.0（满加成），半衰期天数=0.0（无加成），超过半衰期为负值但截断为0
  const recencyBoost = Math.max(0, 1 - ageDays / halfLife);
  score *= 1 + recencyBoost;

  // ═══════════════════════════════════════════════════════════════
  // 维度 7: 来源加权 — 会话记忆基础权重 ×1.2
  // ═══════════════════════════════════════════════════════════════
  if (m.source === "session") score *= SESSION_SOURCE_MULTIPLIER;

  // ═══════════════════════════════════════════════════════════════
  // 维度 8: 会话任务关键词加成 — 会话标题与查询目标高度重合时加分
  // ═══════════════════════════════════════════════════════════════
  if (m.source === "session" && m.title.trim()) {
    const taskWords = tokenize(m.title);
    const taskMatches = queryWords.filter((w) => taskWords.includes(w)).length;
    if (taskMatches >= SESSION_TASK_MATCH_MIN_WORDS) {
      score += SESSION_TASK_MATCH_BONUS;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 8.5: 跨会话信号加成（A.2.2 节定义）
  // ═══════════════════════════════════════════════════════════════
  // 跨会话意味着不同会话中出现了相同的文件/错误/工具模式，
  // 这些记忆更可能包含通用性的解决方案或约定
  if (m.source === "session") {
    let crossBoost = 0;
    // 文件重叠：会话记忆的关联文件与当前查询的最近文件有交集
    if (
      query.recentFiles &&
      query.recentFiles.length > 0 &&
      m.relatedFiles.length > 0
    ) {
      const overlap = m.relatedFiles.some((f) =>
        query.recentFiles!.some((qf) => {
          const qNorm = normalizePathSeparators(qf);
          const mNorm = normalizePathSeparators(f);
          // 精确匹配 或 文件名匹配（路径末尾相同）
          return (
            qNorm === mNorm ||
            qNorm.endsWith("/" + mNorm.split("/").pop()!)
          );
        }),
      );
      if (overlap) crossBoost += CROSS_SESSION_FILE_BOOST;
    }
    // 错误重叠：记忆的错误签名与当前查询的错误词匹配
    if (errWords && m.relatedErrors.length > 0) {
      const hit = m.relatedErrors.some((sig) =>
        errWords.some((w) => sig.toLowerCase().includes(w)),
      );
      if (hit) crossBoost += CROSS_SESSION_ERROR_BOOST;
    }
    // 工具重叠：记忆的标签与当前查询的最近工具名匹配
    if (
      query.recentToolNames &&
      query.recentToolNames.length > 0 &&
      m.tags.length > 0
    ) {
      const overlap = m.tags.some((t) =>
        query.recentToolNames!.some((tn) => {
          const short = tn.split(".").pop() ?? tn;
          return t === tn || t === short;
        }),
      );
      if (overlap) crossBoost += CROSS_SESSION_TOOL_BOOST;
    }
    // 跨会话加成有上限，防止过度放大
    if (crossBoost > 0) {
      score *= 1 + Math.min(crossBoost, CROSS_SESSION_BOOST_CAP);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 9: 参考资料记忆加成
  // ═══════════════════════════════════════════════════════════════
  if (isReferenceMemory(m)) score *= REFERENCE_MULTIPLIER;

  // ═══════════════════════════════════════════════════════════════
  // 维度 10: 架构查询 + 参考资料 → 大幅加成
  // ═══════════════════════════════════════════════════════════════
  // 当用户询问架构问题时，参考资料（如设计文档、架构决策记录）极其重要
  if (isArchitectureQuery(query.goal) && isReferenceMemory(m)) {
    score += ARCHITECTURE_REFERENCE_BONUS;
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 11: 语义相似度加成
  // ═══════════════════════════════════════════════════════════════
  // 优先使用嵌入向量的余弦相似度；若嵌入向量不可用，fallback 到文本 Jaccard 相似度
  const boostWeight = query.semanticBoostWeight ?? 0.2;
  if (boostWeight > 0) {
    if (query.queryEmbedding && m.embedding && m.embedding.length > 0) {
      // 有嵌入向量：使用余弦相似度
      const cosineSim = EmbeddingCache.cosineSimilarity(
        query.queryEmbedding,
        m.embedding,
      );
      score *= 1 + cosineSim * boostWeight;
    } else if (!query.queryEmbedding) {
      // 无嵌入向量：fallback 到文本相似度（Jaccard），打 75 折
      const textSim = EmbeddingCache.textSimilarity(
        query.goal,
        [m.title, m.summary, m.content].join(" "),
      );
      score *= 1 + textSim * boostWeight * SEMANTIC_FALLBACK_MULTIPLIER;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 12: 优先级系数
  // ═══════════════════════════════════════════════════════════════
  // high×1.3（核心记忆更突出）、mid×1.0（默认不变）、low×0.7（临时记忆降权）
  score *= PRIORITY_COEFFICIENTS[m.priority] ?? 1.0;

  // ═══════════════════════════════════════════════════════════════
  // 维度 13: 任务画像标签加成（B.4 节定义）
  // ═══════════════════════════════════════════════════════════════
  // 根据当前任务类型（bug-fix、code-review、feature-dev 等），
  // 对记忆的标签进行偏好加权。例如 bug-fix 任务会提升带 "error" 标签的记忆权重
  if (query.taskProfile) {
    const profileBudget = TASK_PROFILE_BUDGETS[query.taskProfile];
    const hasPreferredTag = profileBudget.preferredTags.some((t) =>
      m.tags.includes(t),
    );
    if (hasPreferredTag && profileBudget.tagBoost !== 1.0) {
      score *= profileBudget.tagBoost;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 14: 过期记忆惩罚（B.1.valid_until）
  // ═══════════════════════════════════════════════════════════════
  // valid_until > 0 且当前时间已超过该时间戳 → 记忆视为过期，大幅降权
  if (m.validUntil > 0 && Date.now() > m.validUntil) {
    score *= EXPIRED_MEMORY_MULTIPLIER;
  }

  // ═══════════════════════════════════════════════════════════════
  // 维度 15: 双向链接记忆加成（B.1.linked_memories）
  // ═══════════════════════════════════════════════════════════════
  // 存在 linked_memories 说明该记忆是知识图谱中的一个节点，
  // 与之关联的记忆可能也包含有用信息，因此微幅提升其权重
  if (m.linkedMemories && m.linkedMemories.length > 0) {
    score *= LINKED_MEMORY_MULTIPLIER;
  }

  return score;
}
