import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ChatMessage,
  CostTracker,
  ModelTokenUsage,
  RunEventEnvelope,
} from "@paw/core";
import type { SubAgentLauncher } from "@paw/harness";
import type { LanguageModel } from "@paw/models";
import { gitDiff } from "@paw/workspace";
import {
  type AcceptanceCriterion,
  type TaskState,
  type TestResultSummary,
  verificationOutcome,
} from "./task-state.js";

export type CandidateReviewVerdict = "pass" | "fail" | "partial";
export type ReportGroundingVerdict = "pass" | "fail" | "unknown";

export interface CandidateReviewResult {
  readonly verdict: CandidateReviewVerdict;
  /** Whether the proposed user-facing verification claims match host evidence. */
  readonly reportGrounding: ReportGroundingVerdict;
  readonly summary: string;
  readonly raw?: string;
  readonly modelCalls?: number;
  readonly usage?: ModelTokenUsage;
}

export interface CandidateVerificationEvidence {
  readonly command: string;
  readonly family?: TestResultSummary["family"];
  readonly mutationRevision: number;
  readonly outcome: "passed" | "code_failed" | "harness_failed";
  readonly failureKind?: TestResultSummary["failureKind"];
  readonly retryability?: TestResultSummary["retryability"];
  readonly summary: string;
  readonly evidence?: string;
}

export interface CandidateReviewInput {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly proposedSummary: string;
  readonly mutationRevision: number;
  readonly filesChanged: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  /** Host-recorded executable verification facts, never reconstructed from prose. */
  readonly verificationEvidence: readonly CandidateVerificationEvidence[];
  /** Durable host fact from a successful diff-inspection tool, independent of reviewer capture. */
  readonly diffInspectedRevision?: number;
  /** Bounded, untrusted excerpts of the implementer's own deliberation. */
  readonly deliberation: readonly string[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
}

/** Independent, read-only semantic review. It does not replace executable verification. */
export interface CandidateReviewer {
  review(input: CandidateReviewInput): Promise<CandidateReviewResult>;
}

export interface SubAgentCandidateReviewerOptions {
  readonly launcher: SubAgentLauncher;
  readonly maxSteps?: number;
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
}

export interface ModelCandidateReviewerOptions {
  readonly model: LanguageModel;
  readonly costTracker?: CostTracker;
}

/** A bounded, fresh-context semantic critic; executable checks remain a separate gate. */
export class ModelCandidateReviewer implements CandidateReviewer {
  private readonly model: LanguageModel;
  private readonly costTracker?: CostTracker;

  constructor(options: ModelCandidateReviewerOptions) {
    this.model = options.model;
    this.costTracker = options.costTracker;
  }

  async review(input: CandidateReviewInput): Promise<CandidateReviewResult> {
    const evidence = captureCandidateEvidence(input);
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a fresh-context semantic critic. Review only the supplied task, decisions, and diff. No tools exist in this call. Do not emit tool calls or assume unseen evidence.",
      },
      {
        role: "user",
        content: buildCandidateReviewGoal(input, evidence.text, "plain_text"),
      },
    ];
    const first = await this.complete(messages, input.signal);
    const parsed = enforceEvidenceDiscipline(
      parseCandidateReview(first.text),
      evidence.conclusive,
    );
    if (hasExplicitReviewProtocol(first.text)) {
      const usage = first.usage ? sumUsage([first.usage]) : undefined;
      return {
        ...parsed,
        modelCalls: 1,
        ...(usage ? { usage } : {}),
      };
    }
    const second = await this.complete(
      [
        ...messages,
        { role: "assistant", content: first.text },
        {
          role: "user",
          content:
            "Protocol recovery: tools are unavailable and the complete candidate diff and host verification ledger are already above. Do not request files or commands. Judge implementation semantics separately from report grounding. End with exactly REPORT_GROUNDING: PASS or REPORT_GROUNDING: FAIL, then VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.",
        },
      ],
      input.signal,
    );
    const usage = sumUsage([first.usage, second.usage].filter(isUsage));
    return {
      ...enforceEvidenceDiscipline(
        parseCandidateReview(second.text),
        evidence.conclusive,
      ),
      modelCalls: 2,
      ...(usage ? { usage } : {}),
    };
  }

  private async complete(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<{ readonly text: string; readonly usage?: ModelTokenUsage }> {
    const result = await this.model.complete(
      messages,
      signal ? { signal } : undefined,
    );
    if (result.usage) this.costTracker?.record(this.model.label, result.usage);
    return { text: result.text, usage: result.usage };
  }
}

/**
 * Runs a fresh-context reviewer through Paw's existing child-agent boundary.
 * The child is explicitly read-only and receives the candidate diff when Git
 * can provide it. If diff capture fails, it can still inspect the named files.
 */
export class SubAgentCandidateReviewer implements CandidateReviewer {
  private readonly launcher: SubAgentLauncher;
  private readonly maxSteps: number;
  private readonly onEvent?: (envelope: RunEventEnvelope) => void;

  constructor(options: SubAgentCandidateReviewerOptions) {
    this.launcher = options.launcher;
    this.maxSteps = options.maxSteps ?? 10;
    this.onEvent = options.onEvent;
  }

  async review(input: CandidateReviewInput): Promise<CandidateReviewResult> {
    const evidence = captureCandidateEvidence(input);
    const result = await this.launcher.launch(
      buildCandidateReviewGoal(input, evidence.text, "final_answer"),
      this.maxSteps,
      {
        parentRunId: input.runId,
        agentId: `${input.runId}-candidate-review-r${input.mutationRevision}`,
        signal: input.signal,
        onEvent: input.onEvent ?? this.onEvent,
        args: { child_policy: "read_only" },
        sharedContext: {
          role: "independent candidate solution reviewer",
          task: "Adversarially compare the current implementation with the original request.",
          facts: [`Candidate mutation revision: ${input.mutationRevision}`],
          constraints: [
            "Do not modify project files.",
            "A passing test is not proof that every requested semantic detail is implemented.",
          ],
          artifacts: [],
          state: { completed: [], pending: ["issue an independent verdict"] },
          childPolicy: "read_only",
        },
      },
    );
    const parsed = parseCandidateReview(result.summary);
    const modelEvents =
      result.trace?.events.filter(
        (event) => event.event.type === "model.done",
      ) ?? [];
    const usage = sumUsage(
      modelEvents.flatMap((event) =>
        event.event.type === "model.done" && event.event.usage
          ? [event.event.usage]
          : [],
      ),
    );
    return {
      ...parsed,
      modelCalls: modelEvents.length,
      ...(usage ? { usage } : {}),
    };
  }
}

export function candidateReviewInput(
  runId: string,
  workspaceRoot: string,
  proposedSummary: string,
  state: TaskState,
  signal?: AbortSignal,
  onEvent?: (envelope: RunEventEnvelope) => void,
  messages?: readonly ChatMessage[],
): CandidateReviewInput {
  return {
    runId,
    workspaceRoot,
    goal: state.goal,
    proposedSummary,
    mutationRevision: state.mutationRevision ?? 0,
    filesChanged: state.filesChanged,
    acceptanceCriteria: state.acceptanceCriteria ?? [],
    verificationEvidence: state.testResults.map((result) => ({
      command: result.command,
      ...(result.family ? { family: result.family } : {}),
      mutationRevision: result.mutationRevision ?? 0,
      outcome: verificationOutcome(result),
      ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      ...(result.retryability ? { retryability: result.retryability } : {}),
      summary: result.summary,
      ...(result.evidence ? { evidence: result.evidence } : {}),
    })),
    ...(state.diffInspectedRevision !== undefined
      ? { diffInspectedRevision: state.diffInspectedRevision }
      : {}),
    deliberation: extractCandidateDeliberation(messages ?? []),
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
  };
}

export function candidateSummaryFingerprint(summary: string): string {
  return createHash("sha256")
    .update(summary.trim().replace(/\s+/g, " "), "utf8")
    .digest("hex");
}

export function extractCandidateDeliberation(
  messages: readonly ChatMessage[],
): string[] {
  const candidates: Array<{ index: number; score: number; text: string }> = [];
  const signal =
    /(?:safer|risk|strict|exact|assert|expect|edge|preserv|retain|include|omit|drop|loss|position|index|exception|error detail|message|alternative|trade.?off|hypothesis|uncertain|可能|风险|严格|保留|丢失|位置|异常|消息|方案)/gi;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    // Historical final reports are candidate outputs, not implementation
    // deliberation. Feeding them back here makes a later review judge stale
    // verification claims even when the current proposedSummary removed them.
    const content = /["'](?:action|tool)["']\s*:\s*["']final_answer["']/i.test(
      message.content,
    )
      ? undefined
      : message.content;
    const source = [message.thinking, content]
      .filter((value): value is string => !!value?.trim())
      .join("\n")
      .trim();
    if (!source) continue;
    const matches = source.match(signal)?.length ?? 0;
    const score = matches + (message.thinking ? 2 : 0);
    if (score > 0)
      candidates.push({ index, score, text: source.slice(-6_000) });
  }
  candidates.sort(
    (left, right) => right.score - left.score || left.index - right.index,
  );
  const selected = candidates
    .slice(0, 6)
    .sort((left, right) => left.index - right.index);
  const excerpts: string[] = [];
  let chars = 0;
  for (const candidate of selected) {
    const excerpt = candidate.text;
    if (chars + excerpt.length > 24_000) break;
    excerpts.push(excerpt);
    chars += excerpt.length;
  }
  return excerpts;
}

export function parseCandidateReview(raw: string): CandidateReviewResult {
  const matches = [
    ...raw.matchAll(/(?:^|\n)\s*VERDICT:\s*(PASS|FAIL|PARTIAL)\s*(?=\n|$)/gi),
  ];
  const verdictText = matches.at(-1)?.[1]?.toLowerCase();
  const verdict: CandidateReviewVerdict =
    verdictText === "pass" || verdictText === "fail" ? verdictText : "partial";
  const withoutVerdict = raw
    .replace(/(?:^|\n)\s*VERDICT:\s*(?:PASS|FAIL|PARTIAL)\s*(?=\n|$)/gi, "")
    .replace(/(?:^|\n)\s*REPORT_GROUNDING:\s*(?:PASS|FAIL)\s*(?=\n|$)/gi, "")
    .trim();
  const groundingMatches = [
    ...raw.matchAll(/(?:^|\n)\s*REPORT_GROUNDING:\s*(PASS|FAIL)\s*(?=\n|$)/gi),
  ];
  const groundingText = groundingMatches.at(-1)?.[1]?.toLowerCase();
  return {
    verdict,
    reportGrounding:
      groundingText === "pass" || groundingText === "fail"
        ? groundingText
        : "unknown",
    summary: compactReviewSummary(
      withoutVerdict ||
        (matches.length > 0
          ? `Independent reviewer returned ${verdict}.`
          : "Independent reviewer returned no parseable verdict."),
    ),
    raw,
  };
}

function hasExplicitReviewProtocol(raw: string): boolean {
  return (
    /(?:^|\n)\s*VERDICT:\s*(?:PASS|FAIL|PARTIAL)\s*(?=\n|$)/i.test(raw) &&
    /(?:^|\n)\s*REPORT_GROUNDING:\s*(?:PASS|FAIL)\s*(?=\n|$)/i.test(raw)
  );
}

function isUsage(value: ModelTokenUsage | undefined): value is ModelTokenUsage {
  return value !== undefined;
}

function sumUsage(
  usages: readonly ModelTokenUsage[],
): ModelTokenUsage | undefined {
  if (usages.length === 0) return undefined;
  return {
    promptTokens: usages.reduce(
      (sum, usage) => sum + (usage.promptTokens ?? 0),
      0,
    ),
    completionTokens: usages.reduce(
      (sum, usage) => sum + (usage.completionTokens ?? 0),
      0,
    ),
    totalTokens: usages.reduce(
      (sum, usage) =>
        sum +
        (usage.totalTokens ??
          (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
      0,
    ),
    cachedPromptTokens: usages.reduce(
      (sum, usage) => sum + (usage.cachedPromptTokens ?? 0),
      0,
    ),
  };
}

function buildCandidateReviewGoal(
  input: CandidateReviewInput,
  evidence: string,
  delivery: "plain_text" | "final_answer",
): string {
  const criteria = input.acceptanceCriteria
    .filter((criterion) => criterion.status !== "superseded")
    .map(
      (criterion) =>
        `- ${criterion.id}: ${criterion.text} [${criterion.status}; authority=${criterion.verificationAuthority ?? "agent"}]`,
    );
  const deliberation = input.deliberation.map(
    (excerpt, index) => `--- excerpt ${index + 1} ---\n${excerpt}`,
  );
  const verification = input.verificationEvidence.map((result) => {
    const phase =
      result.mutationRevision === input.mutationRevision
        ? "current candidate"
        : result.mutationRevision < input.mutationRevision
          ? "pre-change/stale"
          : "future/invalid";
    const classification = [result.failureKind, result.retryability]
      .filter(Boolean)
      .join("/");
    return `- [r${result.mutationRevision}; ${phase}${result.family ? `; family=${result.family}` : ""}] ${result.outcome}${classification ? ` (${classification})` : ""}: ${result.command} — ${result.summary}${result.evidence ? ` — observed: ${result.evidence}` : ""}`;
  });
  const currentDiffInspected =
    input.filesChanged.length > 0 &&
    input.diffInspectedRevision === input.mutationRevision;
  const diffInspection = currentDiffInspected
    ? `- final diff inspection: confirmed by the host for current candidate r${input.mutationRevision}`
    : input.diffInspectedRevision === undefined
      ? "- final diff inspection: no host record"
      : `- final diff inspection: stale (latest host record is r${input.diffInspectedRevision}, current candidate is r${input.mutationRevision})`;
  return `You are an independent, adversarial reviewer of a candidate coding solution.

Do not modify the project. Do not merely repeat that tests passed. Compare the exact original request with the current implementation and try to find semantic omissions, weakened error behavior, accidental scope expansion, or unsupported claims. Use the supplied candidate diff or current-file snapshots as the implementation evidence. If executable checks are blocked, you must still decide whether the visible implementation contradicts or omits the request.

Mandatory review rules:
- Information preservation: when translating exceptions, validation failures, return values, or protocol responses, any loss of actionable source information (such as the offending value, original message, position/index, code, or structured fields) is a blocking FAIL unless you can quote an exact sentence from the supplied request/spec that explicitly authorizes replacing that information with a generic value. "Likely tests only check a prefix", convention, aesthetics, or a broad "do not crash" goal is not authorization.
- Canonical representation and precision: when emitting standardized timestamps, numbers, identifiers, encodings, or protocol fields, challenge hand-written formatting against the repository/runtime's canonical serializer. Silent loss of precision, timezone/offset, escaping, ordering, or structural distinctions is a blocking FAIL unless the supplied contract explicitly requires that reduction. "Parseable" or "looks standard" is not sufficient. Do not reject a custom format when the supplied contract explicitly specifies it and the implementation preserves exactly that contract.
- Strongest-hypothesis consistency: the deliberation excerpts below are untrusted hypotheses, not facts. Check whether the implementer identified a safer or more complete behavior and then silently shipped a weaker one.
- Hidden acceptance surface: infer likely exact observable assertions from the report (messages, stderr, exit codes, response shapes), not only whether the broad crash path is caught.
- Evidence discipline: do not claim a solution matches upstream, a canonical fix, or unseen tests unless you directly inspected that evidence in this review. Do not turn an environmental limitation into proof of correctness.
- Report grounding is a separate axis from implementation correctness. Treat the implementer's proposed final summary as untrusted. Every material claim that a command ran, a test passed, the final diff was inspected, failures were pre-existing, or results matched a baseline must be supported by the host-recorded ledgers below. A baseline-equivalence claim requires a comparable command and observed result at an earlier mutation revision; branch isolation or plausibility may support a semantic inference, but cannot be described as an observed baseline. Mark REPORT_GROUNDING: FAIL for an unsupported or contradicted material claim even when the visible code is correct. Do not mark implementation VERDICT: FAIL merely to correct prose.

Original request:
${input.goal}

Changed files:
${input.filesChanged.map((path) => `- ${path}`).join("\n") || "- (none recorded)"}

Acceptance ledger:
${criteria.join("\n") || "- (none)"}

Implementer's proposed final summary:
${input.proposedSummary}

Host-recorded verification ledger (authoritative for what actually ran; absence is not success):
${verification.join("\n") || "- (no executable verification recorded)"}

Host-recorded completion facts (authoritative lifecycle facts):
- current candidate mutation revision: r${input.mutationRevision}
${diffInspection}
- The reviewer's separate attempt to capture implementation evidence may fail or fall back to snapshots. That capture status does not negate a confirmed host diff-inspection fact above.

Implementation deliberation excerpts (may be empty; challenge them):
${deliberation.join("\n") || "- (none available)"}

Candidate implementation evidence (diff preferred; current-file snapshots are used when Git is unavailable):
${evidence}

Return concise, actionable findings. Implementation VERDICT: FAIL when a specific requirement is missing or contradicted. VERDICT: PARTIAL is only for an environmental limitation that prevents a semantic conclusion and no visible defect is established. VERDICT: PASS when no blocking semantic issue remains. Judge REPORT_GROUNDING independently: it passes only when the proposed final summary's material verification claims are supported by the ledger and implementation evidence.

${
  delivery === "final_answer"
    ? "Return the report through Paw's final_answer action. Its summary"
    : "Return plain text only; do not emit JSON, XML, tool calls, or actions. The report"
} must end with exactly these two lines in this order, replacing angle-bracket choices with one literal value:
REPORT_GROUNDING: <PASS|FAIL>
VERDICT: <PASS|FAIL|PARTIAL>`;
}

function truncateDiff(diff: string): string {
  const maxChars = 80_000;
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, maxChars)}\n[diff truncated after ${maxChars} characters]`;
}

function captureCandidateEvidence(input: CandidateReviewInput): {
  readonly text: string;
  readonly conclusive: boolean;
} {
  const captured = gitDiff(input.workspaceRoot);
  if (captured.diff?.trim()) {
    return { text: truncateDiff(captured.diff), conclusive: true };
  }

  const snapshots = captureCurrentFileSnapshots(
    input.workspaceRoot,
    input.filesChanged,
  );
  const reason = captured.error ?? "Git returned an empty diff";
  if (snapshots) {
    return {
      text: `[git diff unavailable: ${reason}; reviewing current-file snapshots instead]\n${snapshots}`,
      conclusive: true,
    };
  }
  return {
    text: `[implementation evidence unavailable: ${reason}; no recorded changed file could be read]`,
    conclusive: false,
  };
}

function captureCurrentFileSnapshots(
  workspaceRoot: string,
  filesChanged: readonly string[],
): string {
  const root = path.resolve(workspaceRoot);
  const sections: string[] = [];
  let remaining = 80_000;
  for (const file of filesChanged) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    try {
      const content = readFileSync(absolute, "utf8");
      if (content.includes("\0")) continue;
      const header = `--- current file: ${relative.split(path.sep).join("/")} ---\n`;
      if (remaining <= header.length) break;
      const available = remaining - header.length;
      const body =
        content.length <= available
          ? content
          : `${content.slice(0, Math.max(0, available - 80))}\n[file snapshot truncated]`;
      const section = `${header}${body}`;
      sections.push(section);
      remaining -= section.length;
      if (remaining <= 0) break;
    } catch {
      // A deleted, binary, or concurrently moved file is not useful evidence.
    }
  }
  return sections.join("\n");
}

function enforceEvidenceDiscipline(
  result: CandidateReviewResult,
  conclusive: boolean,
): CandidateReviewResult {
  if (conclusive || result.verdict !== "pass") return result;
  return {
    ...result,
    verdict: "partial",
    summary: compactReviewSummary(
      `Implementation evidence was unavailable, so PASS is not supportable. ${result.summary}`,
    ),
  };
}

function compactReviewSummary(summary: string): string {
  const maxChars = 8_000;
  if (summary.length <= maxChars) return summary;
  const tailChars = 2_000;
  return `${summary.slice(0, maxChars - tailChars - 52)}\n[review summary truncated]\n${summary.slice(-tailChars)}`;
}
