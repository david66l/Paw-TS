/**
 * Memory Distiller（spec v2 §5.4 / §5.7）
 *
 * 异步 LLM 蒸馏：任务目标 + 关键轨迹段 + outcome → JSON 候选条目。
 * LLM 通过 DistillerLlm 接口注入（测试 mock）。
 *
 * 蒸馏契约五条硬纪律（validateCandidate 强制执行，违反即 schema 校验失败）：
 * 1. 去具体化：禁止具体函数名/变量名/文件路径/字符串字面量
 * 2. when_to_use 必填："当…时"/"When …" 开头的条件句
 * 3. 失败-修正绑定：轨迹含失败→成功转折时必须产出 failureFixPair；孤立失败禁止入库
 * 4. 证据指针：每条候选 ≥1 个 evidence
 * 5. 体量：perspective ≤2 句；modification ≤3 条；单条目 ≤300 tokens
 *
 * 弱模型降级（§5.7）：校验失败重试 1 次，再失败 → 调用方走降级 append-only。
 * 手写校验（不引入 zod 依赖）。
 */

export interface DistillerLlm {
  complete(prompt: string): Promise<string>;
}

export interface DistillInput {
  runId: string;
  /** 任务目标 */
  goal: string;
  /** 关键轨迹段（调用方已截断） */
  trajectory: string;
  outcome: "success" | "failed" | "unknown";
}

export interface DistillCandidate {
  kind: "semantic" | "episodic";
  /** semantic：单句事实（英文） */
  fact?: string;
  keywords?: string[];
  /** episodic：检索键条件句 */
  whenToUse?: string;
  perspective?: string;
  modification?: string[];
  failureFixPair?: { failed: string; feedback: string; fixed: string };
  issueType?: string;
  /** ≥1 个证据指针："runs/<runId>/trajectory#step-N" */
  evidence: string[];
  /** 可选：事实生效时间（迟到的旧事实）；缺省 = 写入时间。供时序倒挂判定（§7.4） */
  tValid?: string;
}

export type DistillResult =
  | { status: "ok"; candidates: DistillCandidate[] }
  | { status: "degraded"; summary: string; errors: string[] };

// ── prompt ──

export function buildDistillPrompt(input: DistillInput): string {
  const failureFixRequired =
    input.outcome === "success" && /(?:error|failed|failure|报错|失败)/i.test(input.trajectory);
  return `你是记忆蒸馏器。从任务轨迹中提炼可复用的长期记忆候选，输出 JSON。

硬性纪律（违反将被 schema 校验拒绝）：
1. 去具体化：禁止出现具体函数名/变量名/文件路径/字符串字面量；允许保留错误类型名、工具名、通用技术名词。
2.  episodic 候选的 whenToUse 必填：以 "When …" 开头的条件句，描述适用场景而非任务本身。
3. 失败-修正绑定：轨迹含失败→成功转折时必须产出 failureFixPair（failed/feedback/fixed）；孤立失败描述禁止入库。${failureFixRequired ? "（本轨迹检测到失败→成功转折，failureFixPair 必填）" : ""}
4. 每条候选附 ≥1 个 evidence 指针（如 "runs/${input.runId}/trajectory#step-3"）。
5. 体量：perspective ≤2 句；modification ≤3 条；单条目 ≤300 tokens。
6. 技术内容用英文蒸馏；用户偏好保留用户原语言。

输出 JSON（不要输出任何其它内容）：
{ "candidates": [
  { "kind": "semantic", "fact": "…", "keywords": ["…"], "evidence": ["…"] },
  { "kind": "episodic", "whenToUse": "When …", "perspective": "…", "modification": ["…"],
    "failureFixPair": { "failed": "…", "feedback": "…", "fixed": "…" }, "issueType": "…", "evidence": ["…"] }
] }
没有值得固化的内容时输出 { "candidates": [] }。

任务目标：
${input.goal}

任务 outcome：${input.outcome}

关键轨迹段：
${input.trajectory}`;
}

// ── 校验（手写，契约纪律的可执行形式）──

const FILE_PATH_RE = /(?:[\w.-]+\/[\w./-]+)|(?:\w+\.(?:ts|tsx|js|jsx|py|java|go|rs|sql|json|ya?ml|toml|vue|svelte)\b)/;
const CODE_IDENTIFIER_RE = /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/; // camelCase 标识符
const WHEN_TO_USE_RE = /^(?:当|When[\s,])/;

function countSentences(s: string): number {
  return s.split(/[.!?。！？]+/).filter((x) => x.trim().length > 0).length;
}

/** 单条目体量上限 300 tokens ≈ 1200 字符（粗估 chars/4） */
const MAX_FIELD_CHARS = 1200;

export function validateCandidate(raw: unknown): { ok: true; value: DistillCandidate } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["候选不是对象"] };
  const c = raw as Record<string, unknown>;

  if (c.kind !== "semantic" && c.kind !== "episodic") {
    errors.push(`kind 非法: ${String(c.kind)}`);
    return { ok: false, errors };
  }

  // 纪律 4：证据指针
  if (!Array.isArray(c.evidence) || c.evidence.length === 0 || !c.evidence.every((e) => typeof e === "string" && e.length > 0)) {
    errors.push("evidence 必须是非空字符串数组（≥1 个证据指针）");
  }

  // 参与检查的文本字段
  const textFields: string[] = [];

  if (c.kind === "semantic") {
    if (typeof c.fact !== "string" || c.fact.trim().length === 0) {
      errors.push("semantic 候选缺 fact");
    } else {
      if (c.fact.length > MAX_FIELD_CHARS) errors.push("fact 超体量上限（300 tokens）");
      textFields.push(c.fact);
    }
    if (c.keywords !== undefined && (!Array.isArray(c.keywords) || !c.keywords.every((k) => typeof k === "string"))) {
      errors.push("keywords 必须是字符串数组");
    }
  } else {
    // episodic
    if (typeof c.whenToUse !== "string" || !WHEN_TO_USE_RE.test(c.whenToUse.trim())) {
      errors.push('whenToUse 必填且须以 "当/When" 开头（纪律 2）');
    } else {
      textFields.push(c.whenToUse);
    }
    if (typeof c.perspective !== "string" || c.perspective.trim().length === 0) {
      errors.push("episodic 候选缺 perspective");
    } else {
      if (countSentences(c.perspective) > 2) errors.push("perspective 超 2 句（纪律 5）");
      textFields.push(c.perspective);
    }
    if (!Array.isArray(c.modification) || c.modification.length === 0 || c.modification.length > 3) {
      errors.push("modification 必须为 1–3 条（纪律 5）");
    } else {
      for (const m of c.modification) if (typeof m === "string") textFields.push(m);
    }
    if (c.failureFixPair !== undefined) {
      const p = c.failureFixPair as Record<string, unknown>;
      if (typeof p !== "object" || p === null
        || typeof p.failed !== "string" || typeof p.feedback !== "string" || typeof p.fixed !== "string") {
        errors.push("failureFixPair 必须含 failed/feedback/fixed 三个字符串字段（纪律 3）");
      }
    }
  }

  // 可选 tValid（时序倒挂判定用）
  if (c.tValid !== undefined && (typeof c.tValid !== "string" || Number.isNaN(Date.parse(c.tValid)))) {
    errors.push("tValid 必须是可解析的时间字符串");
  }

  // 纪律 1：去具体化
  for (const t of textFields) {
    if (FILE_PATH_RE.test(t)) errors.push(`疑似文件路径/文件名（纪律 1）: ${t.slice(0, 50)}…`);
    if (CODE_IDENTIFIER_RE.test(t)) errors.push(`疑似代码标识符（纪律 1）: ${t.slice(0, 50)}…`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: c as unknown as DistillCandidate };
}

/** 从 LLM 输出提取 JSON 对象（容忍前后废话） */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("输出中无 JSON 对象");
  return JSON.parse(text.slice(start, end + 1));
}

// ── 蒸馏器 ──

export class MemoryDistiller {
  constructor(private readonly llm: DistillerLlm) {}

  /**
   * 蒸馏轨迹为候选条目。校验失败自动重试 1 次（§5.7）；
   * 再失败返回 degraded（调用方降级 append-only）。
   */
  async distill(input: DistillInput): Promise<DistillResult> {
    const prompt = buildDistillPrompt(input);
    const allErrors: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      let parsed: unknown;
      try {
        const raw = await this.llm.complete(attempt === 0 ? prompt : `${prompt}\n\n上次输出校验失败：${allErrors.join("；")}。请修正后重新输出 JSON。`);
        parsed = extractJson(raw);
      } catch (e) {
        allErrors.push(`attempt ${attempt + 1}: 输出非 JSON（${e instanceof Error ? e.message : String(e)}）`);
        continue;
      }

      const rawCandidates = (parsed as { candidates?: unknown }).candidates;
      if (!Array.isArray(rawCandidates)) {
        allErrors.push(`attempt ${attempt + 1}: 缺 candidates 数组`);
        continue;
      }

      const candidates: DistillCandidate[] = [];
      let attemptErrors: string[] = [];
      for (const rc of rawCandidates) {
        const v = validateCandidate(rc);
        if (v.ok) candidates.push(v.value);
        else attemptErrors = attemptErrors.concat(v.errors);
      }
      // 候选为空且原始数组也为空 = 合法的"无值得固化内容"
      if (attemptErrors.length === 0) return { status: "ok", candidates };
      allErrors.push(...attemptErrors.map((e) => `attempt ${attempt + 1}: ${e}`));
    }

    return {
      status: "degraded",
      summary: input.trajectory.slice(0, 500),
      errors: allErrors,
    };
  }
}
