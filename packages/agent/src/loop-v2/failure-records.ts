/**
 * Loop v2.1 §10 验证证据的失败记录分解层。
 *
 * 一次测试运行的原始输出是未分化的日志：真断言失败、基础设施导入错误、
 * 收集失败混在一起。本层把它分解为带类型的失败记录——分类是记录的
 * 属性，由一个共享投影产出，模型上下文、readiness、修复义务消费同一份
 * 结构化事实，而不是各自对原始日志做事后评语（django-15098 教训：
 * 混合输出里模型追查环境报错、修改 runtests.py，烧掉语义修复预算）。
 *
 * 本模块不依赖 agent 内任何其他模块，保持可被 task-state 与 loop-v2
 * 双向引用而无环。
 */

export type VerificationFailureKindV2 = "assertion" | "import" | "discovery";

export interface VerificationFailureRecordV2 {
  /** 测试标识（pytest node id 或 unittest 的 name (module.Class)）。 */
  readonly testId: string;
  readonly kind: VerificationFailureKindV2;
  /** 该记录 traceback 引用的文件（原始路径，按输出原样）。 */
  readonly tracebackFiles: readonly string[];
  /** traceback 是否触及当前改动面（案发地点 ∩ 改动面 ≠ ∅）。 */
  readonly touchesChangeSurface: boolean;
  /** 首条错误行（如 ModuleNotFoundError: No module named 'tests'）。 */
  readonly errorLine?: string;
}

/**
 * 环境类失败：不是当前变更引入的缺陷。断言失败永远是 owned（套件即契约，
 * 其 traceback 天然位于测试文件、不触及产品改动面，交集规则对它无意义）；
 * 交集规则只适用于结构性错误（import/discovery）——案发地点不在改动面
 * 的导入/收集失败是环境装配问题。
 */
export function isEnvironmentFailure(
  record: VerificationFailureRecordV2,
): boolean {
  return record.kind !== "assertion" && !record.touchesChangeSurface;
}

/** 当前变更必须回应的失败：断言失败，或触及改动面的导入错误。 */
export function isOwnedFailure(record: VerificationFailureRecordV2): boolean {
  return !isEnvironmentFailure(record);
}

const MAX_RECORDS = 40;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function filesOverlap(
  tracebackFiles: readonly string[],
  filesChanged: readonly string[],
): boolean {
  const changed = filesChanged.map(normalizePath);
  return tracebackFiles.some((file) => {
    const normalized = normalizePath(file);
    const basename = normalized.split("/").at(-1) ?? "";
    return changed.some(
      (c) =>
        (c && normalized.endsWith(c)) ||
        (basename && c.endsWith(`/${basename}`)) ||
        c === basename,
    );
  });
}

interface RawFailureBlock {
  readonly testId: string;
  readonly kind: VerificationFailureKindV2;
  readonly headerIndex: number;
  readonly bodyEnd: number;
}

/**
 * 解析 pytest 与 unittest/django runtests 两种输出格式的失败块：
 * - pytest: `FAILED path::test - Error...` / `ERROR path::test - ...`（摘要行）
 * - unittest: `FAIL: name (module.Class)` / `ERROR: name (module.Class)`（块头）
 */
function parseFailureBlocks(output: string): readonly RawFailureBlock[] {
  const lines = output.split(/\r?\n/);
  const blocks: RawFailureBlock[] = [];
  for (let i = 0; i < lines.length && blocks.length < MAX_RECORDS; i += 1) {
    const line = lines[i] ?? "";
    // unittest/django 块头：单独一行，其后跟 traceback 分隔线与正文
    const unit = /^(FAIL|ERROR): ([^\s(]+(?: \([^)]+\))?)/.exec(line);
    if (unit?.[1] && unit[2]) {
      blocks.push({
        testId: unit[2].trim(),
        kind: unit[1] === "ERROR" ? "import" : "assertion",
        headerIndex: i,
        bodyEnd: findBlockEnd(lines, i),
      });
      continue;
    }
    // pytest 摘要行
    const pytest = /^(FAILED|ERROR) ([^\s]+::[^\s]+)(?:\s*-\s*(.*))?$/.exec(
      line,
    );
    if (pytest?.[1] && pytest[2]) {
      const detail = pytest[3] ?? "";
      blocks.push({
        testId: pytest[2],
        kind:
          pytest[1] === "ERROR" &&
          /(?:ModuleNotFound|ImportError)/i.test(detail)
            ? "import"
            : pytest[1] === "ERROR"
              ? "discovery"
              : "assertion",
        headerIndex: i,
        bodyEnd: i,
      });
    }
  }
  return blocks;
}

function findBlockEnd(lines: readonly string[], headerIndex: number): number {
  for (let j = headerIndex + 1; j < lines.length; j += 1) {
    if (/^(?:FAIL|ERROR): /.test(lines[j] ?? "")) return j;
    if (/^-{20,}|={20,}/.test(lines[j] ?? "")) return j;
  }
  return lines.length;
}

/** 分解一次验证运行的失败输出为带类型的失败记录。 */
export function decomposeVerificationFailuresV2(input: {
  readonly output: string;
  readonly filesChanged: readonly string[];
}): readonly VerificationFailureRecordV2[] {
  const blocks = parseFailureBlocks(input.output);
  const lines = input.output.split(/\r?\n/);
  const records: VerificationFailureRecordV2[] = [];
  for (const block of blocks) {
    if (records.length >= MAX_RECORDS) break;
    const tracebackFiles: string[] = [];
    let errorLine: string | undefined;
    for (
      let j = block.headerIndex;
      j <= block.bodyEnd && j < lines.length;
      j += 1
    ) {
      const line = lines[j] ?? "";
      const fileMatch = /^\s*File ["']([^"']+)["']/.exec(line);
      if (fileMatch?.[1]) tracebackFiles.push(fileMatch[1]);
      if (!errorLine && /^\s*(?:\w[\w.]*Error|Exception)\s*:/.test(line)) {
        errorLine = line.trim();
      }
    }
    records.push({
      testId: block.testId,
      kind: block.kind,
      tracebackFiles,
      touchesChangeSurface: filesOverlap(tracebackFiles, input.filesChanged),
      ...(errorLine ? { errorLine: errorLine.slice(0, 240) } : {}),
    });
  }
  return records;
}

/** 判定整次运行是否存在必须回应的失败（供 outcome 分类复用）。 */
export function verificationRunHasOwnedFailures(
  records: readonly VerificationFailureRecordV2[],
): boolean {
  return records.some(isOwnedFailure);
}

/**
 * 结构化渲染（事实陈述，无行为命令）：进入模型可见的验证结果分区，
 * 与 readiness 修复反馈共用。owned/environment 的划分本身就是事实。
 */
export function renderVerificationFailureRecordsV2(
  records: readonly VerificationFailureRecordV2[],
): string | undefined {
  if (records.length === 0) return undefined;
  const owned = records.filter(isOwnedFailure).map((r) => r.testId);
  const environment = records
    .filter(isEnvironmentFailure)
    .map(
      (r) =>
        `${r.testId} (${r.kind}; traceback does not overlap the change surface)`,
    );
  const parts: string[] = [];
  if (owned.length > 0) {
    parts.push(`failures of the current change: ${owned.join(", ")}`);
  }
  if (environment.length > 0) {
    parts.push(
      `environment failures (not introduced by the current change): ${environment.join("; ")}`,
    );
  }
  if (parts.length === 0) return undefined;
  return `[VerificationFailureRecords] ${parts.join(" | ")}`;
}
