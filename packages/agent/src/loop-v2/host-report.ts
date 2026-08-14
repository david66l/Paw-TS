import type {
  CandidateInputV2,
  SemanticReviewV2,
} from "./candidate-certification.js";
import { sha256Canonical } from "./canonical.js";
import type { RunOutcomeV2 } from "./run-outcome.js";

export interface CandidateVerificationClaimV2 {
  readonly verificationId: string;
  readonly outcome: "passed" | "code_failed" | "harness_failed";
  readonly statement: string;
}

export interface CandidateDeliveryNoteV2 {
  /** Explanatory prose only; rendered with an explicit unverified label. */
  readonly overview?: string;
  readonly remainingRisks?: readonly string[];
  readonly verificationClaims?: readonly CandidateVerificationClaimV2[];
}

export interface HostReportInputV2 {
  readonly candidate: CandidateInputV2;
  readonly outcome: RunOutcomeV2;
  readonly review?: SemanticReviewV2;
  readonly candidateNote?: CandidateDeliveryNoteV2;
}

export interface OmittedCandidateClaimV2 {
  readonly verificationId: string;
  readonly reason: "unknown_verification" | "outcome_mismatch";
  readonly statement: string;
}

export interface HostReportV2 {
  readonly markdown: string;
  readonly omittedClaims: readonly OmittedCandidateClaimV2[];
  readonly reportHash: string;
}

/**
 * Renders exactly once from host ledgers. Candidate prose cannot add changed
 * files, commands, pass/fail facts, artifact state, or external resolution.
 */
export function renderHostReportV2(input: HostReportInputV2): HostReportV2 {
  const verificationById = new Map(
    input.candidate.currentVerification.map((verification) => [
      verification.id,
      verification,
    ]),
  );
  const omittedClaims: OmittedCandidateClaimV2[] = [];
  const corroboratedClaims: CandidateVerificationClaimV2[] = [];
  for (const claim of input.candidateNote?.verificationClaims ?? []) {
    const verification = verificationById.get(claim.verificationId);
    if (!verification) {
      omittedClaims.push({
        verificationId: claim.verificationId,
        reason: "unknown_verification",
        statement: claim.statement,
      });
    } else if (verification.outcome !== claim.outcome) {
      omittedClaims.push({
        verificationId: claim.verificationId,
        reason: "outcome_mismatch",
        statement: claim.statement,
      });
    } else {
      corroboratedClaims.push(claim);
    }
  }

  const changedPaths = sortedUnique(
    input.candidate.mutationJournal.flatMap((mutation) => mutation.paths),
  );
  const changedSymbols = sortedUnique(
    input.candidate.changedPublicSurface.flatMap((surface) =>
      surface.symbol ? [`${surface.path}#${surface.symbol}`] : [],
    ),
  );
  const lines = [
    "# Paw Run Report",
    "",
    "## Outcome",
    "",
    `- Execution: ${input.outcome.executionStatus}`,
    `- Candidate: ${input.outcome.candidateStatus}`,
    `- Local verification: ${input.outcome.localVerification}`,
    `- External verification: ${input.outcome.externalVerification}`,
    `- Artifact: ${input.outcome.artifactStatus}`,
    `- Reason: ${input.outcome.reasonCode}`,
    "",
    "## Changed files",
    "",
    ...(changedPaths.length > 0
      ? changedPaths.map((path) => `- ${escapeMarkdown(path)}`)
      : ["- None recorded"]),
  ];

  if (changedSymbols.length > 0) {
    lines.push(
      "",
      "## Changed public or unknown symbols",
      "",
      ...changedSymbols.map((symbol) => `- ${escapeMarkdown(symbol)}`),
    );
  }

  lines.push("", "## Verification ledger", "");
  if (input.candidate.currentVerification.length === 0) {
    lines.push("- No current-revision verification recorded");
  } else {
    for (const verification of input.candidate.currentVerification) {
      lines.push(
        `- ${escapeMarkdown(verification.id)}: ${verification.outcome}; \`${escapeInlineCode(verification.argv.join(" "))}\`; authority=${verification.authoritative ? "authoritative" : "diagnostic"}`,
      );
    }
  }

  lines.push("", "## Semantic review", "");
  if (!input.review) {
    lines.push("- Not run");
  } else {
    lines.push(`- Verdict: ${input.review.verdict}`);
    for (const finding of input.review.findings) {
      const binding =
        finding.criterionId ?? finding.invariantId ?? "unbound-warning";
      lines.push(
        `- ${finding.severity} (${escapeMarkdown(binding)}): ${escapeMarkdown(finding.risk)}`,
      );
    }
  }

  const openRisks = input.candidate.unresolvedRisks;
  lines.push("", "## Host-recorded open risks", "");
  if (openRisks.length === 0) {
    lines.push("- None recorded");
  } else {
    lines.push(
      ...openRisks.map(
        (risk) =>
          `- ${risk.severity} ${escapeMarkdown(risk.id)}: ${escapeMarkdown(risk.statement)}`,
      ),
    );
  }

  const overview = input.candidateNote?.overview?.trim();
  const remainingRisks = (input.candidateNote?.remainingRisks ?? [])
    .map((risk) => risk.trim())
    .filter(Boolean);
  if (overview || remainingRisks.length > 0 || corroboratedClaims.length > 0) {
    lines.push("", "## Candidate note (unverified explanation)", "");
    if (overview) lines.push(escapeMarkdown(overview));
    for (const risk of remainingRisks) {
      lines.push(`- Remaining risk: ${escapeMarkdown(risk)}`);
    }
    for (const claim of corroboratedClaims) {
      lines.push(
        `- Corroborated by ${escapeMarkdown(claim.verificationId)}: ${escapeMarkdown(claim.statement)}`,
      );
    }
  }

  if (omittedClaims.length > 0) {
    lines.push(
      "",
      `> ${omittedClaims.length} unsupported candidate verification claim(s) omitted; host ledger remains authoritative.`,
    );
  }

  const markdown = `${lines.join("\n")}\n`;
  return {
    markdown,
    omittedClaims,
    reportHash: sha256Canonical({
      candidateInputHash: sha256Canonical(input.candidate),
      outcome: input.outcome,
      review: input.review,
      markdown,
      omittedClaims,
    }),
  };
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`|]/g, "\\$&").replace(/\r?\n/g, " ");
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "'").replace(/\r?\n/g, " ");
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
