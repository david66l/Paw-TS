import type {
  InputFactV1,
  JsonValue,
  TaskCheckpointItemV1,
  TaskCheckpointV1,
} from "@paw/protocol";
import { parseModelResponseV1, parseTaskCheckpointV1 } from "@paw/protocol";

export const CHECKPOINT_EVIDENCE_POLICY_VERSION_V1 =
  "paw.checkpoint-evidence.v1:t12000:p256" as const;

const MAX_EVIDENCE_TEXT_CHARS_V1 = 12_000;
const MAX_EVIDENCE_PATHS_V1 = 256;
const MUTATION_TOOLS = new Set([
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.apply_patch",
  "workspace.undo_last_edit",
  "workspace.notebook_edit",
]);
const EXECUTION_TOOLS = new Set([
  "workspace.run_shell",
  "workspace.job_start",
  "workspace.job_wait",
]);
const VERIFICATION_COMMAND =
  /(?:^|\s)(?:test|pytest|vitest|jest|tsc|lint|check|build)(?:\s|$)/i;
const PATH_PATTERN =
  /[A-Za-z0-9_@./\\:-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|json|ya?ml|toml|md|css|scss|html|sh|sql|ipynb)\b/g;

export interface CheckpointEvidenceItemV1 {
  readonly seq: number;
  readonly factType: InputFactV1["type"];
  readonly text: string;
  readonly paths: readonly string[];
  readonly callId?: string;
  readonly tool?: string;
  readonly command?: string;
  readonly status?: string;
}

export interface CheckpointEvidenceBundleV1 {
  readonly policyVersion: typeof CHECKPOINT_EVIDENCE_POLICY_VERSION_V1;
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
  readonly items: readonly CheckpointEvidenceItemV1[];
}

export interface CheckpointResolvedPayloadV1 {
  readonly carrierSeq: number;
  readonly value: JsonValue;
}

export type CheckpointEvidenceIssueCodeV1 =
  | "invalid_checkpoint"
  | "unknown_source_seq"
  | "duplicate_statement"
  | "goal_requires_user_input"
  | "confirmed_fact_requires_objective_evidence"
  | "changed_file_requires_successful_mutation"
  | "changed_file_path_mismatch"
  | "verification_requires_successful_execution"
  | "verification_command_mismatch"
  | "mutation_evidence_omitted"
  | "verification_evidence_omitted";

export interface CheckpointEvidenceIssueV1 {
  readonly code: CheckpointEvidenceIssueCodeV1;
  readonly field: string;
  readonly message: string;
}

export type CheckpointEvidenceVerificationV1 =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      issues: readonly CheckpointEvidenceIssueV1[];
    }>;

export function projectCheckpointEvidenceV1(
  sourceEntries: readonly {
    readonly seq: number;
    readonly fact: InputFactV1;
  }[],
  resolvedPayloads: readonly CheckpointResolvedPayloadV1[] = [],
): CheckpointEvidenceBundleV1 {
  if (sourceEntries.length === 0) {
    throw new Error("Checkpoint evidence source is empty");
  }
  let previousSeq = 0;
  const payloadBySeq = new Map(
    resolvedPayloads.map((payload) => [payload.carrierSeq, payload.value]),
  );
  if (payloadBySeq.size !== resolvedPayloads.length) {
    throw new Error("Checkpoint resolved payload carrier is duplicated");
  }
  const sourceSeqs = new Set(sourceEntries.map((entry) => entry.seq));
  if ([...payloadBySeq.keys()].some((seq) => !sourceSeqs.has(seq))) {
    throw new Error("Checkpoint resolved payload is outside the source range");
  }
  const items = sourceEntries.map((entry) => {
    if (!Number.isSafeInteger(entry.seq) || entry.seq <= previousSeq) {
      throw new Error("Checkpoint evidence source order is invalid");
    }
    previousSeq = entry.seq;
    return projectEvidenceItem(
      entry.seq,
      entry.fact,
      payloadBySeq.get(entry.seq),
    );
  });
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) throw new Error("Checkpoint evidence projection failed");
  return Object.freeze({
    policyVersion: CHECKPOINT_EVIDENCE_POLICY_VERSION_V1,
    sourceFromSeq: first.seq,
    sourceThroughSeq: last.seq,
    items: Object.freeze(items),
  });
}

export function verifyTaskCheckpointEvidenceV1(
  value: unknown,
  evidence: CheckpointEvidenceBundleV1,
): CheckpointEvidenceVerificationV1 {
  let checkpoint: TaskCheckpointV1;
  try {
    checkpoint = parseTaskCheckpointV1(value);
  } catch (error) {
    return rejected([
      issue(
        "invalid_checkpoint",
        "checkpoint",
        error instanceof Error ? error.message : String(error),
      ),
    ]);
  }
  const bySeq = new Map(evidence.items.map((item) => [item.seq, item]));
  const issues: CheckpointEvidenceIssueV1[] = [];
  const seenStatements = new Set<string>();
  for (const [field, item] of checkpointItems(checkpoint)) {
    const normalizedStatement = normalize(item.statement);
    if (seenStatements.has(normalizedStatement)) {
      issues.push(
        issue(
          "duplicate_statement",
          field,
          "checkpoint repeats one statement across semantic fields",
        ),
      );
    }
    seenStatements.add(normalizedStatement);
    const cited = item.sourceSeqs.flatMap((seq) => {
      const source = bySeq.get(seq);
      if (!source) {
        issues.push(
          issue(
            "unknown_source_seq",
            field,
            `checkpoint cites unavailable source seq ${seq}`,
          ),
        );
        return [];
      }
      return [source];
    });
    if (field === "goal" && !cited.some(isUserInputEvidence)) {
      issues.push(
        issue(
          "goal_requires_user_input",
          field,
          "goal must cite a promoted user input",
        ),
      );
    }
    if (
      field.startsWith("confirmedFacts[") &&
      !cited.some(isObjectiveEvidence)
    ) {
      issues.push(
        issue(
          "confirmed_fact_requires_objective_evidence",
          field,
          "confirmed fact cites no objective Journal settlement or user input",
        ),
      );
    }
    if (field.startsWith("changedFiles[")) {
      verifyChangedFile(field, item, cited, evidence.items, issues);
    }
    if (field.startsWith("verification[")) {
      verifyVerification(field, item, cited, evidence.items, issues);
    }
  }
  verifyEvidenceCoverage(checkpoint, evidence.items, issues);
  return issues.length === 0 ? Object.freeze({ ok: true }) : rejected(issues);
}

function projectEvidenceItem(
  seq: number,
  fact: InputFactV1,
  resolvedPayload: JsonValue | undefined,
): CheckpointEvidenceItemV1 {
  const detail = evidenceDetail(fact, resolvedPayload);
  const text = truncate(detail.text, MAX_EVIDENCE_TEXT_CHARS_V1);
  return Object.freeze({
    seq,
    factType: fact.type,
    text,
    paths: Object.freeze(extractPaths(text).slice(0, MAX_EVIDENCE_PATHS_V1)),
    ...(detail.callId === undefined ? {} : { callId: detail.callId }),
    ...(detail.tool === undefined ? {} : { tool: detail.tool }),
    ...(detail.command === undefined ? {} : { command: detail.command }),
    ...(detail.status === undefined ? {} : { status: detail.status }),
  });
}

function evidenceDetail(
  fact: InputFactV1,
  resolvedPayload: JsonValue | undefined,
): {
  readonly text: string;
  readonly callId?: string;
  readonly tool?: string;
  readonly command?: string;
  readonly status?: string;
} {
  switch (fact.type) {
    case "input.promoted":
      return { text: fact.content };
    case "input.accepted":
      return {
        text: `accepted input ${fact.inputId} for ${fact.delivery}`,
      };
    case "model.settled":
      return {
        text: canonicalStringify({
          status: fact.status,
          hasToolCalls: fact.hasToolCalls,
          hasVisibleOutput: fact.hasVisibleOutput,
          ...(fact.errorCode ? { errorCode: fact.errorCode } : {}),
          ...(resolvedPayload === undefined
            ? fact.response
              ? { response: fact.response }
              : {}
            : {
                assistantContent:
                  parseModelResponseV1(resolvedPayload).assistantContent,
              }),
        }),
        status: fact.status,
      };
    case "tool.call_observed": {
      const tool = normalizeToolName(fact.tool);
      const command = objectString(fact.args, "command");
      return {
        text: `${tool} ${canonicalStringify(fact.args)}`,
        callId: fact.callId,
        tool,
        ...(command === undefined ? {} : { command }),
      };
    }
    case "tool.settled":
      return {
        text: canonicalStringify({
          status: fact.status,
          ...(fact.errorCode ? { errorCode: fact.errorCode } : {}),
          ...(fact.result === undefined ? {} : { result: fact.result }),
          ...(fact.observation === undefined
            ? {}
            : { observation: fact.observation }),
          ...(resolvedPayload === undefined
            ? {}
            : { observationPayload: resolvedPayload }),
        } as unknown as JsonValue),
        callId: fact.callId,
        status: fact.status,
      };
    case "runtime.activity_started":
      return {
        text: `${fact.activityKind} ${fact.label} started`,
        callId: fact.activityId,
        status: "running",
      };
    case "runtime.activity_settled":
      return {
        text: fact.summary,
        callId: fact.activityId,
        status: fact.status,
      };
    case "runtime.failed":
      return {
        text: `${fact.area} ${fact.errorCode}: ${fact.message}`,
        status: "failed",
      };
    case "abort.requested":
      return {
        text: `abort requested by ${fact.source}: ${fact.reason ?? "unspecified"}`,
        status: "cancelled",
      };
    case "context.checkpoint_recorded":
      return {
        text: canonicalStringify({
          checkpointId: fact.checkpointId,
          sourceFromSeq: fact.sourceFromSeq,
          sourceThroughSeq: fact.sourceThroughSeq,
          checkpoint: resolvedPayload ?? fact.checkpoint,
        }),
        status: "completed",
      };
    default:
      return { text: canonicalStringify(fact as unknown as JsonValue) };
  }
}

function verifyChangedFile(
  field: string,
  item: TaskCheckpointItemV1,
  cited: readonly CheckpointEvidenceItemV1[],
  all: readonly CheckpointEvidenceItemV1[],
  issues: CheckpointEvidenceIssueV1[],
): void {
  const proof = successfulToolProof(cited, all, MUTATION_TOOLS);
  if (!proof) {
    issues.push(
      issue(
        "changed_file_requires_successful_mutation",
        field,
        "changed file must cite a matching mutation call and completed settlement",
      ),
    );
    return;
  }
  const paths = new Set([...proof.call.paths, ...proof.settlement.paths]);
  if (
    paths.size === 0 ||
    ![...paths].some((path) => includesPath(item.statement, path))
  ) {
    issues.push(
      issue(
        "changed_file_path_mismatch",
        field,
        "changed file statement does not preserve a path from mutation evidence",
      ),
    );
  }
}

function verifyVerification(
  field: string,
  item: TaskCheckpointItemV1,
  cited: readonly CheckpointEvidenceItemV1[],
  all: readonly CheckpointEvidenceItemV1[],
  issues: CheckpointEvidenceIssueV1[],
): void {
  const proof = successfulToolProof(cited, all, EXECUTION_TOOLS);
  const activity = cited.find(
    (source) =>
      source.factType === "runtime.activity_settled" &&
      source.status === "completed",
  );
  if (!proof && !activity) {
    issues.push(
      issue(
        "verification_requires_successful_execution",
        field,
        "verification must cite a completed execution or runtime activity",
      ),
    );
    return;
  }
  if (
    proof?.call.command &&
    !normalize(item.statement).includes(normalize(proof.call.command))
  ) {
    issues.push(
      issue(
        "verification_command_mismatch",
        field,
        "verification statement must preserve the executed command",
      ),
    );
  }
}

function verifyEvidenceCoverage(
  checkpoint: TaskCheckpointV1,
  evidence: readonly CheckpointEvidenceItemV1[],
  issues: CheckpointEvidenceIssueV1[],
): void {
  const changedCitations = new Set(
    checkpoint.changedFiles.flatMap((item) => item.sourceSeqs),
  );
  const verificationCitations = new Set(
    checkpoint.verification.flatMap((item) => item.sourceSeqs),
  );
  for (const call of evidence.filter(
    (item) =>
      item.factType === "tool.call_observed" &&
      item.tool !== undefined &&
      MUTATION_TOOLS.has(item.tool),
  )) {
    const settlement = evidence.find(
      (item) =>
        item.factType === "tool.settled" &&
        item.callId === call.callId &&
        item.status === "completed",
    );
    if (
      settlement &&
      (!changedCitations.has(call.seq) || !changedCitations.has(settlement.seq))
    ) {
      issues.push(
        issue(
          "mutation_evidence_omitted",
          "changedFiles",
          `completed mutation ${call.callId} is absent from changedFiles`,
        ),
      );
    }
  }
  for (const call of evidence.filter(
    (item) =>
      item.factType === "tool.call_observed" &&
      item.tool !== undefined &&
      EXECUTION_TOOLS.has(item.tool) &&
      item.command !== undefined &&
      VERIFICATION_COMMAND.test(item.command),
  )) {
    const settlement = evidence.find(
      (item) =>
        item.factType === "tool.settled" &&
        item.callId === call.callId &&
        item.status === "completed",
    );
    if (
      settlement &&
      (!verificationCitations.has(call.seq) ||
        !verificationCitations.has(settlement.seq))
    ) {
      issues.push(
        issue(
          "verification_evidence_omitted",
          "verification",
          `completed verification command ${call.command} is absent`,
        ),
      );
    }
  }
}

function successfulToolProof(
  cited: readonly CheckpointEvidenceItemV1[],
  all: readonly CheckpointEvidenceItemV1[],
  allowedTools: ReadonlySet<string>,
):
  | Readonly<{
      call: CheckpointEvidenceItemV1;
      settlement: CheckpointEvidenceItemV1;
    }>
  | undefined {
  for (const call of cited) {
    if (
      call.factType !== "tool.call_observed" ||
      !call.callId ||
      !call.tool ||
      !allowedTools.has(call.tool)
    ) {
      continue;
    }
    const settlement = cited.find(
      (candidate) =>
        candidate.factType === "tool.settled" &&
        candidate.callId === call.callId &&
        candidate.status === "completed",
    );
    if (settlement && all.includes(settlement)) return { call, settlement };
  }
  return undefined;
}

function isUserInputEvidence(item: CheckpointEvidenceItemV1): boolean {
  return item.factType === "input.promoted";
}

function isObjectiveEvidence(item: CheckpointEvidenceItemV1): boolean {
  return (
    item.factType === "input.promoted" ||
    item.factType === "tool.settled" ||
    item.factType === "runtime.activity_settled" ||
    item.factType === "runtime.failed" ||
    (item.factType === "model.settled" && item.status !== "completed")
  );
}

function checkpointItems(
  checkpoint: TaskCheckpointV1,
): readonly (readonly [string, TaskCheckpointItemV1])[] {
  return [
    ...(checkpoint.goal ? [["goal", checkpoint.goal] as const] : []),
    ...checkpoint.confirmedFacts.map(
      (item, index) => [`confirmedFacts[${index}]`, item] as const,
    ),
    ...checkpoint.currentHypotheses.map(
      (item, index) => [`currentHypotheses[${index}]`, item] as const,
    ),
    ...checkpoint.ruledOut.map(
      (item, index) => [`ruledOut[${index}]`, item] as const,
    ),
    ...checkpoint.changedFiles.map(
      (item, index) => [`changedFiles[${index}]`, item] as const,
    ),
    ...checkpoint.verification.map(
      (item, index) => [`verification[${index}]`, item] as const,
    ),
    ...checkpoint.unresolved.map(
      (item, index) => [`unresolved[${index}]`, item] as const,
    ),
    ...(checkpoint.nextAction
      ? [["nextAction", checkpoint.nextAction] as const]
      : []),
  ];
}

function rejected(
  issues: readonly CheckpointEvidenceIssueV1[],
): CheckpointEvidenceVerificationV1 {
  return Object.freeze({ ok: false, issues: Object.freeze([...issues]) });
}

function issue(
  code: CheckpointEvidenceIssueCodeV1,
  field: string,
  message: string,
): CheckpointEvidenceIssueV1 {
  return Object.freeze({ code, field, message });
}

function extractPaths(value: string): string[] {
  return [...new Set(value.match(PATH_PATTERN) ?? [])];
}

function includesPath(statement: string, path: string): boolean {
  return normalizePath(statement).includes(normalizePath(path));
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function normalizeToolName(value: string): string {
  return value.startsWith("workspace_")
    ? `workspace.${value.slice("workspace_".length)}`
    : value;
}

function objectString(value: JsonValue, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Readonly<Record<string, JsonValue>>)[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n[truncated]`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function canonicalStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalStringify(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
