import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";
import {
  ENVIRONMENT_AUDIT_POLICY_VERSION_V1,
  fingerprintAuditFile,
} from "./environment-audit.js";

export const AUDITED_MEMORY_POLICY_V1 = "paw.audited-memory.v1" as const;

/** Desktop migration carries prior chat as context in the first input. It is
 * not a new user assertion; retain only the current request for memory. */
export function memoryUserStatement(content: string): string {
  const prefix = "Previous conversation (historical data):\n";
  const boundary = "\n\nCurrent user request:\n";
  if (!content.startsWith(prefix)) return content;
  const end = content.indexOf(boundary, prefix.length);
  if (end < 0) return "";
  try {
    if (!Array.isArray(JSON.parse(content.slice(prefix.length, end))))
      return "";
    return content.slice(end + boundary.length);
  } catch {
    return "";
  }
}

/** Only user statements and host-bound audit reports can become memory sources.
 * Executor transcripts remain in the run journal, outside long-term retrieval.
 */
export function admittedMemorySourceSeqs(
  snapshot: SessionInputSnapshot<InputFactV1>,
  workspaceRoot: string,
): ReadonlySet<number> {
  const allowed = new Set<number>();
  const feedbackIds = new Set(
    snapshot.entries.flatMap(({ fact }) =>
      fact.type === "input.accepted" && fact.callerId === "completion-review"
        ? [fact.inputId]
        : [],
    ),
  );
  let segment: (typeof snapshot.entries)[number][] = [];
  const admitAudit = () => {
    const claimEntry = [...segment]
      .reverse()
      .find(({ fact }) => fact.type === "completion.review_claimed");
    const claim = claimEntry?.fact;
    if (
      claim?.type !== "completion.review_claimed" ||
      claim.reviewerId !== ENVIRONMENT_AUDIT_POLICY_VERSION_V1
    )
      return;
    const settlement = [...segment]
      .reverse()
      .find(
        ({ fact }) =>
          fact.type === "completion.review_settled" &&
          fact.reviewId === claim.reviewId,
      );
    const fact = settlement?.fact;
    if (!settlement || fact?.type !== "completion.review_settled") return;
    const audit = fact.environmentAudit;
    if (
      fact.status !== "completed" ||
      fact.verdict !== "allow" ||
      !audit ||
      audit.policyVersion !== ENVIRONMENT_AUDIT_POLICY_VERSION_V1 ||
      audit.integrity !== "clean" ||
      audit.candidateHash !== claim.candidateHash ||
      !audit.childRunId ||
      !audit.childSessionId ||
      !audit.inspected.length ||
      audit.unmetCriteria.length ||
      !claimEntry ||
      claim.sourceThroughSeq >= claimEntry.seq ||
      segment.some(
        ({ seq, fact }) =>
          seq > claim.sourceThroughSeq &&
          !fact.type.startsWith("completion.review_") &&
          !fact.type.startsWith("memory."),
      )
    )
      return;
    try {
      if (
        audit.inspected.every(
          (file) =>
            file.hash !== "missing" &&
            fingerprintAuditFile(workspaceRoot, file.path).hash === file.hash,
        )
      )
        allowed.add(settlement.seq);
    } catch {
      /* Unavailable or changed evidence cannot support a new write. */
    }
  };
  for (const entry of snapshot.entries) {
    if (entry.fact.type === "work.segment_started") {
      admitAudit();
      segment = [];
    }
    segment.push(entry);
    if (
      entry.fact.type === "input.promoted" &&
      !feedbackIds.has(entry.fact.inputId)
    ) {
      allowed.add(entry.seq);
    }
  }
  admitAudit();
  return allowed;
}
