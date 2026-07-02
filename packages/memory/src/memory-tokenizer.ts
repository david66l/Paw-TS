/**
 * 记忆检索的分词器、路径规范化和路径匹配评分工具
 * Tokenization, path normalization, and path matching helpers for memory
 * retrieval.
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块是记忆检索系统的"文本预处理层"，提供三个核心能力：
 *
 *   1. **分词 (tokenize)**：将文本拆分为可搜索的词元（token）。对于英文单词，
 *      过滤掉过短的词（<=2 字符）；对于中文（CJK 统一汉字区间 U+4E00–U+9FFF），
 *      同时保留原词和二元组（bigram），以支持部分匹配。
 *
 *   2. **路径规范化**：将 Windows 反斜杠统一为 Unix 正斜杠；将路径字符串中
 *      的文件路径替换为其"词干"，使路径能参与关键词匹配（例如
 *      `src/utils/foo-bar.ts` → `foo bar`）。
 *
 *   3. **路径匹配评分 (pathMatchScore)**：计算当前文件与候选记忆文件之间的
 *      路径相似度分数。精确匹配得分最高（40），同名文件次之（20），同目录
 *      再次之（30），共享祖先目录可得 15 分。
 *
 * 架构定位：位于"查询理解层 (memory-query)" 和 "检索评分层 (memory-retriever)"
 * 之间，提供通用的文本处理原语。
 * ============================================================================
 */

/**
 * 将文本分词为可搜索的词元（word/CJK-bigram）集合。
 *
 * 分词策略：
 * - 英文字母数字序列：长度 > 2 的才保留，过滤掉无意义的短词
 * - CJK 字符序列（一-鿿）：保留原词（>=2 字），同时生成二元组
 *   （如 "重构架构" → "重构架", "构架构"），支持子串匹配
 * - 标点符号和特殊字符被替换为空格，不参与分词
 *
 * Tokenize text into searchable word/CJK-bigram tokens.
 */
export function tokenize(text: string): string[] {
  // 预处理：转小写，将非单词非 CJK 字符替换为空格
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s一-鿿]/g, " ")
    .trim();
  if (!normalized) return [];

  const tokens = new Set<string>();
  for (const chunk of normalized.split(/\s+/)) {
    if (!chunk) continue;
    // 纯 CJK 字符块：保留原词（长度 >= 2）和所有二元组
    if (/^[一-鿿]+$/.test(chunk)) {
      if (chunk.length >= 2) tokens.add(chunk);
      for (let i = 0; i < chunk.length - 1; i++) {
        tokens.add(chunk.slice(i, i + 2));
      }
      continue;
    }
    // 英文/数字块：过滤掉长度 <= 2 的短词
    if (chunk.length > 2) tokens.add(chunk);
  }
  return [...tokens];
}

/**
 * 将 Windows 反斜杠路径分隔符规范化为 Unix 正斜杠。
 * Normalize Windows path separators to `/`.
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * 将路径形式的字符串替换为其词干单词，使其能参与关键词匹配。
 *
 * 例如：`src/utils/foo-bar.ts` 被替换为 `foo bar`，
 * 这样分词后可以与查询中的 "foo" 或 "bar" 匹配上。
 *
 * 处理逻辑：
 * 1. 匹配路径形式的字符串（至少一个目录层级）
 * 2. 提取文件基本名（basename）
 * 3. 去掉扩展名，将分隔符（`-`、`_`、`.`）替换为空格
 *
 * Replace path-like strings with their stem words so they participate in keyword matching.
 */
export function stripPathLikeText(text: string): string {
  return text.replace(
    /(?:^|\s)(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+(?:\.[A-Za-z0-9]+)?(?=\s|$|[),.;:])/g,
    (match) => {
      const trimmed = match.trim();
      // 提取文件名（最后一个 / 之后的部分）
      const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1);
      // 去掉扩展名
      const stem = basename.replace(/\.[A-Za-z0-9]+$/, "");
      // 将分隔符替换为空格，返回为独立词
      return ` ${stem.replace(/[-_.]+/g, " ")} `;
    },
  );
}

/**
 * 计算当前路径与候选记忆路径之间的相关性评分。
 *
 * 评分阶梯（从高到低）：
 * - 40 分：完全匹配（路径完全相同）
 * - 30 分：同目录（allowBroadPathMatch 开启时，两个文件的父目录完全相同）
 * - 20 分：同名文件（不同目录下文件名相同）
 * - 15 分：共享至少 2 级祖先目录
 * - 0 分：无关联
 *
 * @param current - 当前正在处理的文件路径
 * @param related - 记忆中关联的文件路径
 * @param allowBroadPathMatch - 是否允许宽松的目录级匹配
 *
 * Score how strongly `current` path matches `related` path.
 */
export function pathMatchScore(
  current: string,
  related: string,
  allowBroadPathMatch: boolean,
): number {
  // 统一路径分隔符
  const cur = normalizePathSeparators(current);
  const rel = normalizePathSeparators(related);

  // 精确路径匹配：得分 40
  if (cur === rel) return 40;

  // 同名文件匹配：得分 20
  const curFile = cur.slice(cur.lastIndexOf("/") + 1);
  const relFile = rel.slice(rel.lastIndexOf("/") + 1);
  if (curFile === relFile) return 20;

  // 如果不允许宽松匹配，到此为止
  if (!allowBroadPathMatch) return 0;

  // 同目录匹配：得分 30
  const curDir = cur.slice(0, cur.lastIndexOf("/"));
  const relDir = rel.slice(0, rel.lastIndexOf("/"));
  if (curDir && curDir === relDir) return 30;

  // 共享祖先目录：计算公共深度，>=2 级得分 15
  const curParts = cur.split("/");
  const relParts = rel.split("/");
  let commonDepth = 0;
  for (let i = 0; i < Math.min(curParts.length, relParts.length); i++) {
    if (curParts[i] === relParts[i]) commonDepth++;
    else break;
  }
  if (commonDepth >= 2) return 15;

  return 0;
}
