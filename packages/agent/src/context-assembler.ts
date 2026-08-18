import type { ChatMessage } from "@paw/core";

/** Durable transcript is the only portion allowed to survive save/resume. */
export interface DurableContextV1 {
  readonly messages: readonly ChatMessage[];
}

/**
 * Typed host facts rendered in a canonical order for one request.
 *
 * A fixed shape prevents duplicate fact kinds and unstable prompt ordering.
 * The original user request is deliberately absent: it belongs only to the
 * durable transcript. `currentObjective` is therefore a current next step,
 * never a copy of the original goal.
 */
export interface HostStateV1 {
  readonly taskBrief?: {
    readonly currentObjective?: string;
    readonly stage?: string;
    readonly openItems?: readonly string[];
  };
  readonly constraints?: readonly string[];
  readonly taskProgress?: string;
  readonly planSnapshot?: {
    readonly json: string;
    readonly parallelismAvailable?: true;
  };
  readonly relevantMemory?: string;
  readonly relevantCode?: readonly {
    readonly path: string;
    readonly reason: string;
    readonly symbols?: readonly string[];
  }[];
  readonly status?: string;
}

/** At most one host control projection is admitted to a model request. */
export type CompletionGateKindV1 =
  | "managed_jobs"
  | "pending_work"
  | "verification"
  | "repair_obligation"
  | "semantic_review"
  | "verification_probe"
  | "candidate_review"
  | "acceptance";

export type EphemeralControlV1 =
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "progress"; readonly text: string }
  | { readonly kind: "test_warden"; readonly text: string }
  | {
      readonly kind: "completion_gate";
      readonly gate: CompletionGateKindV1;
      readonly text: string;
    }
  | { readonly kind: "readiness"; readonly text: string }
  | { readonly kind: "protocol_recovery"; readonly text: string };

const CONTROL_PRIORITY_V1: Readonly<
  Record<EphemeralControlV1["kind"], number>
> = {
  status: 0,
  progress: 1,
  test_warden: 2,
  completion_gate: 3,
  readiness: 4,
  protocol_recovery: 5,
};

/** Deterministically admit at most one control projection for a request. */
export function selectEphemeralControlV1(
  candidates: readonly (EphemeralControlV1 | undefined)[],
): EphemeralControlV1 | undefined {
  let selected: EphemeralControlV1 | undefined;
  for (const candidate of candidates) {
    if (!candidate?.text.trim()) continue;
    if (
      !selected ||
      CONTROL_PRIORITY_V1[candidate.kind] > CONTROL_PRIORITY_V1[selected.kind]
    ) {
      selected = candidate;
    }
  }
  return selected;
}

export interface AssembleModelContextInputV1 {
  readonly durable: DurableContextV1;
  readonly hostState?: HostStateV1;
  readonly control?: EphemeralControlV1;
}

const LEGACY_HOST_PROJECTION_PREFIXES = [
  "[Context Package]",
  "[Status Snapshot v1]",
] as const;
const LEGACY_FORMAT_RECOVERY_PATTERN =
  /^\[Your last output could not be parsed as a tool call and was NOT executed\.\]\nReason: [^\r\n]+\.\nCorrect format is a single JSON object, no surrounding text or code fences:\n\{"tool":"workspace\.read_file","args":\{"path":"<file>"\}\}\nFix the format and retry the call, or if you are done reply with:\n\{"action":"final_answer","summary":"<your complete findings>"\}$/;
const LEGACY_NO_ACTION_FIRST_PATTERN =
  /^\[You stopped without a final_answer action\. If you have completed the task, output: \{"action":"final_answer","summary":"<your complete findings here>"\}\. If not done, continue — call the next tool or take the next action\.\]$/;
const LEGACY_NO_ACTION_SECOND_PATTERN =
  /^\[Your previous response again contained no executable action\. Continue by emitting exactly one valid tool call, or emit \{"action":"final_answer","summary":"<complete result>"\} only if the task is actually done\.\]$/;
const LEGACY_NO_ACTION_LATER_PATTERN =
  /^\[Protocol recovery attempt ((?:[3-9]|[1-9]\d+)): do not narrate the action you intend to take\. Emit the valid tool-call JSON now\. If and only if the task is complete, emit \{"action":"final_answer","summary":"<complete result>"\}\.\]$/;
const LEGACY_PLAN_PARALLEL_NOTE =
  "Pending items that do not depend on each other can be investigated in parallel via workspace.run_agent (read-only sub-agents return one-page summaries).";
const LEGACY_VERIFICATION_GATE_PATTERNS = [
  /^\[VerificationGate\] This task requires file changes \(\[require_mutation\]\) but none were recorded\. Use an available workspace mutation tool, then continue — do not final_answer yet\.$/,
  /^\[VerificationGate\] The current edit introduced \d+ syntax diagnostic error\(s\)(?: \([\s\S]{1,2000}\))?\. Fix the syntax error before final_answer\. This immediate diagnostic is not a substitute for the required test verification\.$/,
  /^\[VerificationGate\] The last passing verification predates the latest file change \(verified revision \d+, current revision \d+\)\. Re-run the relevant verification after the final edit before final_answer\.$/,
  /^\[VerificationGate\] Files were changed but the latest code verification failed \([\s\S]{1,4000}\)\. Fix the implementation failure and re-run verification before final_answer\.$/,
  /^\[VerificationGate\] The shell command contained a verification runner, but downstream control flow owns the final exit status, so it is not pass evidence\. Run one materially simpler direct command from the same test-runner family before final_answer; remove display-only pipes, fallbacks, or trailing commands\.$/,
  /^\[VerificationGate\] The local verification failed for a recoverable command-invocation reason\. Run one materially simpler direct command from the same test-runner family before final_answer; remove display-only pipes, redirections, wrappers, or invalid options\.$/,
  /^\[VerificationGate\] Local verification did not produce trustworthy pass evidence because shell control flow masked the runner status, and this task has a trusted external verifier\. Inspect the final diff for the current revision before final_answer; do not claim that local tests passed\.$/,
  /^\[VerificationGate\] Local verification could not execute and this task has a trusted external verifier\. Inspect the final diff for the current revision before final_answer; do not claim that local tests passed\.$/,
  /^\[VerificationGate\] Files were changed but the latest shell command's final exit status does not prove its verification runner passed \([\s\S]{1,4000}\)\. Run the verification directly or preserve its exit status explicitly before final_answer\.$/,
  /^\[VerificationGate\] Files were changed but the latest verification did not execute because its harness\/environment failed \([\s\S]{1,4000}\)\. Repair or replace the verification command and obtain real test evidence before final_answer\.$/,
  /^\[VerificationGate\] Files were changed \([\s\S]{1,4000}\) but no passing test evidence was recorded\. Run the relevant tests \(e\.g\. pytest \/ npm test\), then final_answer\. A \[skip_verify: <reason>\] claim is accepted only when the trusted task input includes \[allow_skip_verify\]\.$/,
] as const;
const LEGACY_COMPLETION_GATE_PATTERNS: readonly {
  readonly gate: CompletionGateKindV1;
  readonly pattern: RegExp;
}[] = [
  {
    gate: "managed_jobs",
    pattern:
      /^\[Managed jobs are unfinished: \d+ running, \d+ stopping, \d+ awaiting commit\. Wait for the host to settle and commit every terminal result before outputting final_answer\.\]$/,
  },
  {
    gate: "pending_work",
    pattern:
      /^\[You have pending work: (?:(?:\d+ plan item\(s\))(?:, \d+ todo\(s\))?|\d+ todo\(s\))\. Continue from where you left off — do not summarize or apologize, just take the next action\.\]$/,
  },
  ...LEGACY_VERIFICATION_GATE_PATTERNS.map((pattern) => ({
    gate: "verification" as const,
    pattern,
  })),
  {
    gate: "repair_obligation",
    pattern:
      /^\[LoopControl:repair_required id=repair-[a-f0-9]{16}\] (?:Run a direct [\s\S]+ verification for revision \d+, covering [\s\S]+|Commit a material source change after revision \d+[\s\S]*)\. Prose, repeated reads, unrelated tools, or another final_answer do not satisfy this durable obligation\.$/,
  },
  {
    gate: "semantic_review",
    pattern:
      /^\[LoopV2SemanticReview:fail key=[a-f0-9]{64}\]\nIndependent semantic review returned fail for the persisted candidate\.(?:\n[1-8]\. (?:blocking|warning) (?:criterion=[^\s]+|invariant=[^\s]+|unbound-warning)(?: file=[^\r\n]{1,1000})?: [^\r\n]{1,500} Risk: [^\r\n]{1,500}(?: Minimal alternative: [^\r\n]{1,500})?){1,8}\nFix the bound issue, produce a real source mutation, re-run relevant verification, and then submit a new candidate\. Resubmitting identical code is pointless: this review is bound to the exact candidate, and an identical resubmission replays the same verdict\. Only a real code change produces a new candidate and a fresh review\.$/,
  },
  {
    gate: "semantic_review",
    pattern:
      /^\[LoopV2SemanticReview:partial key=[a-f0-9]{64}\]\nIndependent semantic review returned partial for the persisted candidate\.(?:\n[1-8]\. (?:blocking|warning) (?:criterion=[^\s]+|invariant=[^\s]+|unbound-warning)(?: file=[^\r\n]{1,1000})?: [^\r\n]{1,500} Risk: [^\r\n]{1,500}(?: Minimal alternative: [^\r\n]{1,500})?){1,8}\nSemantic review did not produce a certifying verdict\. Do not resubmit the unchanged candidate; make a fact-changing correction or report an honest blocker\.$/,
  },
  {
    gate: "verification_probe",
    pattern:
      /^\[LoopV2Probe:fail key=probe:[a-f0-9]{64}\]\nAn adversarial verification probe executed against the current candidate diff and FAILED\. The candidate is not certified\.\nFailed probe\(s\):\n(?:[1-9]\d*\. command: [^\r\n]{1,4000}\n {3}output: [\s\S]{1,700}\n?)+Fix the code so the failing behavior is corrected, then propose a new final answer\. Resubmitting the same code is pointless: the failed probe is bound to this exact candidate, so an identical resubmission will replay the same failure\. Only a real code change produces a new candidate and a fresh probe\.$/,
  },
  {
    gate: "candidate_review",
    pattern:
      /^\[IndependentReview:(?:REPORT_GROUNDING_(?:UNKNOWN|FAIL)|FAIL|PARTIAL) r\d+\] [\s\S]+\n(?:Revise only the proposed final summary so every verification, baseline, and pass\/fail claim matches the host-recorded evidence\. Do not mutate source merely to satisfy this reporting gate\. A materially revised summary will be reviewed again on the same source revision\.|Fix the concrete issue, re-run relevant verification, inspect the new diff, and then try final_answer again\. The semantic reviewer will run again only after a real source mutation\.|Address any actionable semantic finding\. If this is only an unavoidable environment limitation, try final_answer again and report the limitation honestly\.)$/,
  },
  {
    gate: "acceptance",
    pattern:
      /^\[AcceptanceGate\] Before final_answer, resolve [\s\S]+\. Verify each observable condition against the current code revision, then use acceptance_update with concrete evidence\. Do not mark an item satisfied from memory or intention\.$/,
  },
];
const LEGACY_CONTROL_PROJECTION_PATTERNS = [
  /^\[ProgressAdvice:(?:inspect_gap|hypothesis_stale|safety_line)\] /,
  /^\[TestWarden\] (?:No Python test files detected;|Attempted:|Pre-flight:|No existing tests are linked to the changed files;|\d+ impacted test file\(s\) all passed\.|\d+\/\d+ impacted test file\(s\) FAILED:)/,
  /^\[LoopV2Readiness:(?:needs_work|blocked) key=[a-f0-9]{64}\]\n/,
  /^\[ProviderProtocol:empty_response\] The provider returned no visible text or executable action\. Retry once with complete tool calls, an explicit control action, or a visible candidate response\.$/,
  /^\[ProviderProtocol:truncated_response\] The previous response was discarded before any tool execution because it was truncated\. Retry the complete tool call or candidate response once; do not continue partial JSON\.$/,
  /^\[ProviderProtocol:missing_tool_calls\] The provider declared tool calls but supplied none\. Emit the complete structured calls once, or return a visible candidate response\.$/,
  /^\[LoopControl:turn_boundary\] Your previous natural-language response ended the provider turn but did not submit a completion candidate\. Continue with the next required tool\/action\. If the task is actually ready, submit the structured final_answer action explicitly\.$/,
  /^\[LoopControl:repair_required id=repair-[a-f0-9]{16}\] The durable (?:direct_verification|material_change) obligation remains open\. Execute the matching tool action now\. Prose, repeated reads, unrelated successful tools, and another final_answer do not satisfy it\.$/,
  LEGACY_FORMAT_RECOVERY_PATTERN,
  LEGACY_NO_ACTION_FIRST_PATTERN,
  LEGACY_NO_ACTION_SECOND_PATTERN,
  LEGACY_NO_ACTION_LATER_PATTERN,
  ...LEGACY_COMPLETION_GATE_PATTERNS.map((entry) => entry.pattern),
] as const;

const LEGACY_IMPLEMENTATION_GUIDANCE =
  "[Implementation checkpoint] Half of the available model turns have been used without a recorded source change. Consolidate the evidence into the smallest plausible implementation soon. If one specific unseen source span or materially different diagnostic is still required to edit safely, gather it now; avoid exact repeats and broad browsing. Then edit the product source and run the narrowest existing test.";
const LEGACY_MAX_STEPS_WARNING = `CRITICAL - APPROACHING MAXIMUM STEPS

You are approaching the maximum number of steps for this task. Stop exploring and complete the task now.

STRICT REQUIREMENTS:
1. Do NOT start any new explorations or read additional files unless absolutely critical
2. Complete the task with the information you already have
3. Call final_answer with a summary of what was accomplished and any remaining work
4. If you cannot complete the task with available information, state what was done and what remains`;
const LEGACY_CONVERGENCE_NEXT_STEPS = new Set([
  "Run the narrowest high-signal acceptance or regression test against the current source revision. Prefer an existing repository test or a direct command; do not build and debug a separate helper harness. Do not rely on a test that predates the latest edit.",
  "The shell command's final status does not prove the verification runner passed. Run one materially simpler direct command from the same test-runner family now; remove display-only pipes, fallbacks, or trailing commands.",
  "The verification command failed for a recoverable invocation reason. Run one materially simpler direct command from the same test-runner family now; remove display-only pipes, redirections, wrappers, or invalid options.",
  "Local verification did not produce trustworthy pass evidence, and a trusted external verifier is configured. Deliver final_answer now with an honest evidence caveat; do not claim tests passed.",
  "Local verification could not execute, and a trusted external verifier is configured. Deliver final_answer now with an honest local-verification caveat; do not claim tests passed.",
  "Local shell control flow did not preserve the verification status, and a trusted external verifier is configured. Stop building replacement harnesses and inspect the final product diff now.",
  "Local verification could not execute, and a trusted external verifier is configured. Stop building replacement harnesses and inspect the final product diff now.",
  "The last shell command did not preserve the verification runner's exit status. Run the test directly or explicitly preserve its status; do not treat the downstream command's exit zero as a test pass.",
  "The last verification did not execute because the harness or environment failed. Repair the invocation with a bounded diagnostic, then rerun it; do not treat infrastructure failure as a code assertion failure.",
  "Use the exact current test failure to revise the implementation, then rerun that test. Avoid reopening broad repository exploration.",
  "Inspect the final diff for the current revision. Check scope, accidental files, and whether the implementation actually covers the requested edge cases.",
  "The current revision has passing verification and an inspected diff. Run at most one materially different adversarial check if a concrete risk remains; otherwise deliver final_answer now.",
]);

export interface LegacyProtocolRecoveryProjectionV1 {
  readonly pendingControl: Extract<
    EphemeralControlV1,
    { readonly kind: "protocol_recovery" }
  >;
  readonly formatErrorNudges?: number;
  readonly noActionNudges?: number;
  readonly hasEverUsedTools?: true;
}

/** Migrate only an unconsumed legacy recovery marker at the durable tail. */
export function parseLegacyProtocolRecoveryProjectionV1(
  messages: readonly ChatMessage[],
): LegacyProtocolRecoveryProjectionV1 | undefined {
  const tail = messages.at(-1);
  if (!tail || tail.role !== "user") return undefined;
  const text = tail.content;
  if (LEGACY_FORMAT_RECOVERY_PATTERN.test(text)) {
    const count = messages.filter(
      (message) =>
        message.role === "user" &&
        LEGACY_FORMAT_RECOVERY_PATTERN.test(message.content),
    ).length;
    return {
      pendingControl: { kind: "protocol_recovery", text },
      formatErrorNudges: Math.min(Math.max(count, 1), 2),
    };
  }
  const laterAttempt = LEGACY_NO_ACTION_LATER_PATTERN.exec(text);
  const attempt = LEGACY_NO_ACTION_FIRST_PATTERN.test(text)
    ? 1
    : LEGACY_NO_ACTION_SECOND_PATTERN.test(text)
      ? 2
      : laterAttempt
        ? Number.parseInt(laterAttempt[1] ?? "", 10)
        : undefined;
  if (!attempt || !Number.isSafeInteger(attempt) || attempt > 10_000) {
    return undefined;
  }
  return {
    pendingControl: { kind: "protocol_recovery", text },
    noActionNudges: attempt,
    hasEverUsedTools: true,
  };
}

export interface LegacyCompletionGateProjectionV1 {
  readonly pendingControl: Extract<
    EphemeralControlV1,
    { readonly kind: "completion_gate" }
  >;
  readonly autoContinueNudges?: number;
  readonly verifyNudges?: number;
  readonly acceptanceNudges?: number;
  readonly candidateReviewNudges?: number;
  readonly candidateReviewRevision?: number;
  readonly candidateReviewSummaryFingerprint?: string;
}

export interface LegacyCandidateReviewIdentityV1 {
  readonly mutationRevision: number;
  readonly summaryFingerprint?: string;
}

/** Migrate only a not-yet-consumed completion gate at the durable tail. */
export function parseLegacyCompletionGateProjectionV1(
  messages: readonly ChatMessage[],
  candidateReview?: LegacyCandidateReviewIdentityV1,
): LegacyCompletionGateProjectionV1 | undefined {
  const tail = messages.at(-1);
  if (!tail || tail.role !== "user") return undefined;
  const matched = LEGACY_COMPLETION_GATE_PATTERNS.find((entry) =>
    entry.pattern.test(tail.content),
  );
  if (!matched) return undefined;
  const candidateRevisionMatch =
    matched.gate === "candidate_review"
      ? /^\[IndependentReview:[^\]]+ r(\d+)\]/.exec(tail.content)
      : undefined;
  const candidateRevision = candidateRevisionMatch
    ? Number.parseInt(candidateRevisionMatch[1] ?? "", 10)
    : undefined;
  const isReportGroundingGate =
    /^\[IndependentReview:REPORT_GROUNDING_(?:UNKNOWN|FAIL) r\d+\]/.test(
      tail.content,
    );
  const candidateIdentityMatches =
    candidateRevision !== undefined &&
    candidateReview?.mutationRevision === candidateRevision;
  return {
    pendingControl: {
      kind: "completion_gate",
      gate: matched.gate,
      text: tail.content,
    },
    ...(matched.gate === "pending_work" ? { autoContinueNudges: 1 } : {}),
    ...(matched.gate === "verification" ? { verifyNudges: 1 } : {}),
    ...(matched.gate === "acceptance" ? { acceptanceNudges: 1 } : {}),
    ...(matched.gate === "candidate_review" &&
    candidateRevision !== undefined &&
    Number.isSafeInteger(candidateRevision)
      ? {
          candidateReviewNudges: 1,
          candidateReviewRevision: candidateRevision,
          ...(isReportGroundingGate &&
          candidateIdentityMatches &&
          candidateReview?.summaryFingerprint
            ? {
                candidateReviewSummaryFingerprint:
                  candidateReview.summaryFingerprint,
              }
            : {}),
        }
      : {}),
  };
}

/** Remove only host/control formats Paw itself durably injected before P0.3. */
export function stripLegacyContextProjectionsV1(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  return messages.filter((message) => !isLegacyContextProjection(message));
}

/**
 * The sole primary agent-turn request assembly boundary.
 *
 * Host state and control are projections: they are rendered into the returned
 * request only and never written back to ContextManager/AppState. Callers must
 * build once and reuse the same array for eval capture and model invocation.
 */
export function assembleModelContextV1(
  input: AssembleModelContextInputV1,
): readonly ChatMessage[] {
  const messages = stripLegacyContextProjectionsV1(input.durable.messages).map(
    (message) => ({ ...message }),
  );
  if (input.hostState && hasHostStateV1(input.hostState)) {
    const hostMessage: ChatMessage = {
      role: "user",
      content: renderHostStateV1(input.hostState),
    };
    // Keep the latest real input/observation as the attention tail. This also
    // preserves an atomic native tool-turn envelope because insertion happens
    // between messages, never inside one. Explicit control is appended below.
    let leadingSystemMessages = 0;
    while (messages[leadingSystemMessages]?.role === "system") {
      leadingSystemMessages += 1;
    }
    const insertionIndex = Math.max(leadingSystemMessages, messages.length - 1);
    messages.splice(insertionIndex, 0, hostMessage);
  }
  if (input.control) {
    const controlHeader =
      input.control.kind === "completion_gate"
        ? `kind: completion_gate\ngate: ${input.control.gate}`
        : `kind: ${input.control.kind}`;
    messages.push({
      role: "user",
      content: `[Ephemeral Control v1]\n${controlHeader}\n${input.control.text}`,
    });
  }
  return messages;
}

function isLegacyContextProjection(message: ChatMessage): boolean {
  if (message.role !== "user") return false;
  return (
    LEGACY_HOST_PROJECTION_PREFIXES.some(
      (prefix) =>
        message.content === prefix || message.content.startsWith(`${prefix}\n`),
    ) ||
    LEGACY_CONTROL_PROJECTION_PATTERNS.some((pattern) =>
      pattern.test(message.content),
    ) ||
    isLegacyLoopGuidanceProjection(message.content) ||
    isLegacyAcceptanceSuccessEcho(message.content) ||
    isLegacyPlanUpdateEcho(message.content)
  );
}

function isLegacyLoopGuidanceProjection(content: string): boolean {
  if (
    content === LEGACY_IMPLEMENTATION_GUIDANCE ||
    content === LEGACY_MAX_STEPS_WARNING
  ) {
    return true;
  }
  const contextGuard =
    /^\[Context guard\] History budget exhausted \(((?:0|[1-9]\d{0,9})) \/ ((?:0|[1-9]\d{0,9})) tokens\)\. New tool outputs will be truncated and archived as \[archived id=N\] references — use context\.recall to restore the full text when needed\. Prefer short commands and targeted reads\.$/.exec(
      content,
    );
  if (contextGuard) {
    const used = Number.parseInt(contextGuard[1] ?? "", 10);
    const budget = Number.parseInt(contextGuard[2] ?? "", 10);
    return (
      Number.isSafeInteger(used) &&
      Number.isSafeInteger(budget) &&
      used > budget
    );
  }
  const convergence =
    /^\[Convergence checkpoint\] ((?:[1-9]|1[0-2])) model turns remain\. Preserve the existing solution state and close the loop\. ([\s\S]+)$/.exec(
      content,
    );
  return (
    !!convergence && LEGACY_CONVERGENCE_NEXT_STEPS.has(convergence[2] ?? "")
  );
}

function isLegacyAcceptanceSuccessEcho(content: string): boolean {
  if (
    !content.startsWith("Acceptance ledger updated:") ||
    content.length > 50_000
  ) {
    return false;
  }
  const graphMarker = "\n[Task Graph v1]\n";
  const graphIndex = content.lastIndexOf(graphMarker);
  if (graphIndex < 0) return false;
  const prefix = content.slice(0, graphIndex);
  const stateDelimiter = ".\n\n[Current State]";
  const stateIndex = prefix.lastIndexOf(stateDelimiter);
  const reason = prefix.slice("Acceptance ledger updated: ".length, stateIndex);
  if (
    stateIndex < "Acceptance ledger updated: ".length ||
    !reason.trim() ||
    !prefix.slice(stateIndex).startsWith(stateDelimiter)
  ) {
    return false;
  }
  const graphLines = content.slice(graphIndex + graphMarker.length).split("\n");
  if (
    !/^schema=paw\.task-graph\.v1 authority=advisory_projection completion_authority=CompletionPolicy source_seq=\d+$/.test(
      graphLines[0] ?? "",
    )
  ) {
    return false;
  }
  const currentLine = graphLines[1] ?? "";
  if (!currentLine.startsWith("current=")) return false;
  const current = currentLine.slice("current=".length);
  const nodeLines = graphLines.slice(2);
  const truncationLine = nodeLines.at(-1);
  const hasTruncatedNodes = /^- \.\.\. [1-9]\d* more nodes$/.test(
    truncationLine ?? "",
  );
  const visibleNodeLines = hasTruncatedNodes
    ? nodeLines.slice(0, -1)
    : nodeLines;
  if (
    visibleNodeLines.some(
      (line) =>
        !/^- [^\r\n]{1,500} \[[^\]/\r\n]+\/[^\]/\r\n]+\/[^\]\r\n]+\] deps=[^\r\n]{1,2000}: [^\r\n]{1,4000}$/.test(
          line,
        ),
    )
  ) {
    return false;
  }
  return (
    current === "none" ||
    (hasTruncatedNodes && current.trim().length > 0) ||
    (current.length > 0 &&
      visibleNodeLines.some((line) => line.startsWith(`- ${current} [`)))
  );
}

function isLegacyPlanUpdateEcho(content: string): boolean {
  if (!content.startsWith("Plan updated:") || content.length > 50_000) {
    return false;
  }
  const marker = "Current plan (JSON):\n";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) return false;
  const prefix = content.slice(0, markerIndex);
  const plainSuffix = ".\n\n";
  const parallelSuffix = `.\n\n\n${LEGACY_PLAN_PARALLEL_NOTE}\n`;
  const mentionsParallelNote = prefix.includes(LEGACY_PLAN_PARALLEL_NOTE);
  const matchedSuffix = mentionsParallelNote
    ? prefix.endsWith(parallelSuffix)
      ? parallelSuffix
      : undefined
    : prefix.endsWith(plainSuffix)
      ? plainSuffix
      : undefined;
  if (!matchedSuffix) {
    return false;
  }
  const reason = prefix.slice("Plan updated: ".length, -matchedSuffix.length);
  if (reason.includes("\u0000")) return false;
  const raw = content.slice(markerIndex + marker.length);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const value = parsed as Record<string, unknown>;
    return (
      typeof value.workflow_id === "string" &&
      Number.isSafeInteger(value.revision) &&
      Array.isArray(value.items) &&
      Number.isSafeInteger(value.items_total) &&
      typeof value.truncated === "boolean" &&
      "next_pending" in value &&
      typeof value.all_complete === "boolean"
    );
  } catch {
    return false;
  }
}

function hasHostStateV1(state: HostStateV1): boolean {
  return Boolean(
    state.taskBrief ||
      state.constraints?.length ||
      state.taskProgress?.trim() ||
      state.planSnapshot?.json.trim() ||
      state.relevantMemory?.trim() ||
      state.relevantCode?.length ||
      state.status?.trim(),
  );
}

function renderHostStateV1(state: HostStateV1): string {
  const lines = ["[Host State v1]"];
  const brief = state.taskBrief;
  if (brief) {
    lines.push("[Task Brief]");
    if (brief.currentObjective?.trim()) {
      lines.push(`current_objective: ${brief.currentObjective.trim()}`);
    }
    if (brief.stage?.trim()) lines.push(`stage: ${brief.stage.trim()}`);
    if (brief.openItems && brief.openItems.length > 0) {
      lines.push("open_items:");
      lines.push(...brief.openItems.map((item) => `- ${item}`));
    }
  }
  if (state.constraints && state.constraints.length > 0) {
    lines.push("[Constraints]");
    lines.push(...state.constraints.map((item) => `- ${item}`));
  }
  if (state.taskProgress?.trim()) {
    lines.push(state.taskProgress.trim());
  }
  if (state.planSnapshot?.json.trim()) {
    lines.push("[Plan Snapshot]");
    if (state.planSnapshot.parallelismAvailable) {
      lines.push(
        "Pending items that do not depend on each other can be investigated in parallel via workspace.run_agent (read-only sub-agents return one-page summaries).",
      );
    }
    lines.push("Current plan (JSON):");
    lines.push(state.planSnapshot.json.trim());
  }
  if (state.relevantMemory?.trim()) {
    lines.push("[Relevant Memory]");
    lines.push(state.relevantMemory.trim());
  }
  if (state.relevantCode && state.relevantCode.length > 0) {
    lines.push("[Relevant Code]");
    for (const block of state.relevantCode) {
      lines.push(`- ${block.path}: ${block.reason}`);
      if (block.symbols?.length) {
        lines.push(`  symbols=${block.symbols.slice(0, 8).join(", ")}`);
      }
    }
  }
  if (state.status?.trim()) {
    lines.push(state.status.trim());
  }
  return lines.join("\n");
}
