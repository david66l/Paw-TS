/**
 * Code Consistency Validator (8.3)
 *
 * 对比记忆中的代码声明 vs 当前代码事实，判断一致性。
 * 依赖 CodeIndexAdapter 获取代码事实（无注入时降级返回 UNKNOWN）。
 */

import type { CodeIndexAdapter } from "./codeIndexAdapter.js";

export type ConsistencyStatus =
  | "CONSISTENT"    // 记忆与当前代码一致
  | "CHANGED"       // 代码已变化
  | "MISSING"       // 引用的实体不再存在
  | "CONFLICT"      // 明确矛盾
  | "PARTIALLY_CONSISTENT"
  | "UNKNOWN"       // 无法判断（索引不可用或不完整）
  | "IRRELEVANT";   // 记忆不涉及代码事实

export interface CodeConsistencyResult {
  memoryId: string;
  memoryType: string;
  subjectKey: string;
  status: ConsistencyStatus;
  expectedFact: string;
  observedFact: string;
  evidence: { filePath: string; detail: string }[];
  confidence: number;
  checkedAt: string;
}

export class CodeConsistencyValidator {
  private adapter: CodeIndexAdapter | null;

  /**
   * @param adapter 代码索引适配器。null 时所有验证返回 UNKNOWN。
   */
  constructor(adapter?: CodeIndexAdapter) {
    this.adapter = adapter ?? null;
  }

  /**
   * 检查一条记忆是否与当前代码事实一致。
   */
  async check(
    memoryId: string,
    memoryType: string,
    subjectKey: string,
    relatedFiles: string[],
    repositoryId: string,
    branch?: string,
  ): Promise<CodeConsistencyResult> {
    const now = new Date().toISOString();

    // 不涉及代码事实的记忆类型 → 跳过
    if (memoryType === "user_preference" || memoryType === "skill") {
      return { memoryId, memoryType, subjectKey, status: "IRRELEVANT", expectedFact: "", observedFact: "", evidence: [], confidence: 1.0, checkedAt: now };
    }

    // 无代码索引 → 无法判断
    if (!this.adapter || !this.adapter.isAvailable()) {
      return { memoryId, memoryType, subjectKey, status: "UNKNOWN", expectedFact: "N/A", observedFact: "Code index unavailable", evidence: [], confidence: 0.0, checkedAt: now };
    }

    const evidence: { filePath: string; detail: string }[] = [];

    try {
      // 检查每个关联文件是否仍然存在
      for (const filePath of relatedFiles.slice(0, 5)) {
        const results = await this.adapter.findByFile({
          repositoryId, branch, query: filePath, filePath,
        });

        if (results.length === 0) {
          evidence.push({ filePath, detail: "File not found in current index" });
        } else {
          evidence.push({ filePath, detail: `Found: ${results[0]!.data.reason}` });
        }
      }

      // 判断一致性
      const missing = evidence.filter((e) => e.detail.includes("not found"));
      const found = evidence.filter((e) => !e.detail.includes("not found"));

      if (evidence.length === 0) {
        return { memoryId, memoryType, subjectKey, status: "UNKNOWN", expectedFact: "", observedFact: "No file references to check", evidence: [], confidence: 0.0, checkedAt: now };
      }
      if (missing.length === evidence.length) {
        return { memoryId, memoryType, subjectKey, status: "MISSING", expectedFact: "All referenced files should exist", observedFact: `${missing.length} files not found`, evidence, confidence: 0.8, checkedAt: now };
      }
      if (found.length > 0 && missing.length === 0) {
        return { memoryId, memoryType, subjectKey, status: "CONSISTENT", expectedFact: "Referenced files should exist", observedFact: `All ${found.length} files found`, evidence, confidence: 0.6, checkedAt: now };
      }
      return { memoryId, memoryType, subjectKey, status: "PARTIALLY_CONSISTENT", expectedFact: "All files should exist", observedFact: `${found.length} found, ${missing.length} missing`, evidence, confidence: 0.5, checkedAt: now };
    } catch {
      return { memoryId, memoryType, subjectKey, status: "UNKNOWN", expectedFact: "", observedFact: "Check failed", evidence, confidence: 0.0, checkedAt: now };
    }
  }
}
