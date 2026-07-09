/**
 * Tool Result Processor (8.14)
 *
 * 解析、标准化、压缩、安全过滤工具输出。
 * MVP: 正则脱敏 + 截断超长输出 + 提取错误信息。不调模型。
 */

export interface RawToolResult {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: "SUCCESS" | "FAILURE" | "TIMEOUT" | "PARTIAL";
  rawOutput: string;
  errorOutput?: string;
  exitCode?: number;
  durationMs: number;
}

export interface ProcessedToolResult {
  toolCallId: string;
  toolName: string;
  resultType: string;
  status: string;
  summary: string;
  importantFacts: string[];
  warnings: string[];
  errors: { errorType?: string; message: string; location?: string }[];
  securityStatus: "clean" | "redacted" | "blocked";
  truncated: boolean;
  originalSize: number;
  processedSize: number;
  sourceReference: string; // toolCallId
}

// ── 敏感信息检测规则 ──

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[a-zA-Z0-9]{32,}/g, "OPENAI_API_KEY"],
  [/AKIA[0-9A-Z]{16}/g, "AWS_ACCESS_KEY"],
  [/ghp_[a-zA-Z0-9]{36}/g, "GITHUB_TOKEN"],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, "PRIVATE_KEY"],
  [/(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi, "PASSWORD"],
  [/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, "JWT_TOKEN"],
  [/(?:mongodb|postgresql|mysql|redis):\/\/[^@\s]+@/gi, "DB_CREDENTIAL"],
];

const REDACT_REPLACEMENT = "***REDACTED***";

// ── 错误提取 ──

const ERROR_PATTERNS: [RegExp, string][] = [
  [/Error:\s*(.+)$/gm, "Error"],
  [/TypeError:\s*(.+)$/gm, "TypeError"],
  [/SyntaxError:\s*(.+)$/gm, "SyntaxError"],
  [/(?:FAIL|FAILED|FAILURE)\s*(?::|in)\s*(.+)$/gm, "Failure"],
  [/command not found:\s*(.+)$/gm, "CommandNotFound"],
  [/Module not found:\s*(.+)$/gm, "ModuleNotFound"],
];

export class ToolResultProcessor {
  private readonly maxOutputSize: number;
  private readonly maxFactCount: number;

  constructor(opts?: { maxOutputSize?: number; maxFactCount?: number }) {
    this.maxOutputSize = opts?.maxOutputSize ?? 8000;
    this.maxFactCount = opts?.maxFactCount ?? 10;
  }

  process(raw: RawToolResult): ProcessedToolResult {
    const originalSize = raw.rawOutput.length;
    let output = raw.rawOutput;
    let securityStatus: ProcessedToolResult["securityStatus"] = "clean";

    // 1. 脱敏
    const redacted = this.redact(output);
    if (redacted !== output) {
      output = redacted;
      securityStatus = "redacted";
    }

    // 2. 截断
    let truncated = false;
    if (output.length > this.maxOutputSize) {
      output = output.slice(0, this.maxOutputSize) + "\n... [TRUNCATED]";
      truncated = true;
    }

    // 3. 提取错误
    const errors = this.extractErrors(raw);

    // 4. 生成摘要
    const summary = this.buildSummary(raw, errors, truncated);

    // 5. 提取事实
    const importantFacts = this.extractFacts(raw).slice(0, this.maxFactCount);

    // 6. 提取警告
    const warnings = this.extractWarnings(raw);

    return {
      toolCallId: raw.toolCallId,
      toolName: raw.toolName,
      resultType: this.classifyResultType(raw.toolType, raw.status),
      status: raw.status,
      summary,
      importantFacts,
      warnings,
      errors,
      securityStatus,
      truncated,
      originalSize,
      processedSize: output.length,
      sourceReference: raw.toolCallId,
    };
  }

  /** 脱敏：正则匹配 + 替换 */
  redact(text: string): string {
    let result = text;
    for (const [pattern] of SECRET_PATTERNS) {
      result = result.replace(pattern, REDACT_REPLACEMENT);
    }
    return result;
  }

  /** 提取错误信息 */
  private extractErrors(raw: RawToolResult): ProcessedToolResult["errors"] {
    const errors: ProcessedToolResult["errors"] = [];
    const text = raw.errorOutput ?? raw.rawOutput;

    for (const [pattern, errorType] of ERROR_PATTERNS) {
      const matches = text.matchAll(pattern);
      for (const m of matches) {
        errors.push({ errorType, message: m[1]?.trim() ?? m[0].trim() });
      }
    }

    // exit code 非零也视为错误
    if (raw.exitCode && raw.exitCode !== 0 && errors.length === 0) {
      errors.push({ errorType: "NonZeroExit", message: `Exit code: ${raw.exitCode}` });
    }

    return errors.slice(0, 5); // 最多 5 个错误
  }

  /** 生成摘要 */
  private buildSummary(
    raw: RawToolResult,
    errors: ProcessedToolResult["errors"],
    truncated: boolean,
  ): string {
    const parts: string[] = [];
    parts.push(`[${raw.status}] ${raw.toolName}`);

    if (errors.length > 0) {
      parts.push(`- ${errors.length} error(s): ${errors.map((e) => e.message).join("; ")}`);
    }

    if (raw.exitCode !== undefined) {
      parts.push(`- Exit: ${raw.exitCode}`);
    }

    parts.push(`- Duration: ${raw.durationMs}ms`);

    if (truncated) {
      parts.push("- Output truncated");
    }

    return parts.join("\n");
  }

  /** 提取关键事实（文件路径、版本号、状态等） */
  private extractFacts(raw: RawToolResult): string[] {
    const facts: string[] = [];
    const text = raw.rawOutput;

    // 文件路径
    const fileMatches = text.matchAll(/(?:\/[\w.-]+)+\.(?:ts|js|json|yaml|yml|sql|md|txt)\b/g);
    for (const m of fileMatches) {
      if (facts.length < this.maxFactCount) facts.push(m[0]);
    }

    // 版本号
    const verMatches = text.matchAll(/(?:version|v)\s*[:=]?\s*(\d+\.\d+\.\d+)/gi);
    for (const m of verMatches) {
      if (m[1] && facts.length < this.maxFactCount) facts.push(`version: ${m[1]}`);
    }

    return [...new Set(facts)];
  }

  /** 提取警告 */
  private extractWarnings(raw: RawToolResult): string[] {
    const warnings: string[] = [];
    const text = raw.rawOutput;
    const warnMatches = text.matchAll(/(?:WARN(?:ING)?|DEPRECATED|deprecated|NOTE):?\s*(.+)$/gim);
    for (const m of warnMatches) {
      if (m[1]) warnings.push(m[1].trim());
    }
    return warnings.slice(0, 5);
  }

  /** 工具结果分类 */
  private classifyResultType(toolType: string, status: string): string {
    switch (toolType.toUpperCase()) {
      case "TEST": return "TEST_RESULT";
      case "BUILD": return "BUILD_RESULT";
      case "COMMAND": return status === "FAILURE" ? "ERROR_RESULT" : "COMMAND_OUTPUT";
      case "SEARCH": return "CODE_SEARCH_RESULT";
      case "FILE_OPERATION": return "FILE_OPERATION_RESULT";
      default: return "COMMAND_OUTPUT";
    }
  }
}
