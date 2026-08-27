import type {
  ManagedJobSnapshotV1,
  TaskProgressActivityV1,
  TaskProgressItemV1,
  TaskProgressServiceV1,
  TaskProgressSnapshotV1,
} from "@paw/harness";
import type {
  JsonValue,
  RunJournalEnvelopeV1,
  ToolSettledFactV1,
} from "@paw/protocol";
import {
  type VerifiedCanonicalPayloadEvidenceV1,
  projectCanonicalSessionInputSnapshotV1,
} from "@paw/runtime";

import {
  DEFAULT_TASK_PROGRESS_POLICY_V1,
  type TaskProgressPolicyV1,
  freezeTaskProgressPolicyV1,
  normalizeTaskProgressItemsV1,
} from "./policy.js";

export const TASK_PROGRESS_SCHEMA_V1 = "paw.task-progress.v1" as const;
export const TASK_PROGRESS_PROVIDER_TOOL_V1 = "workspace_todo_write" as const;

export interface CreateTaskProgressServiceOptionsV1 {
  readonly readCanonicalPrefix: () =>
    | readonly RunJournalEnvelopeV1[]
    | Promise<readonly RunJournalEnvelopeV1[]>;
  readonly loadPayloadEvidence: (
    prefix: readonly RunJournalEnvelopeV1[],
    signal?: AbortSignal,
  ) =>
    | VerifiedCanonicalPayloadEvidenceV1
    | Promise<VerifiedCanonicalPayloadEvidenceV1>;
  readonly listActivities?: () => readonly ManagedJobSnapshotV1[];
  readonly clock?: () => number;
  readonly policy?: TaskProgressPolicyV1;
}

interface LocatedProgressPayloadV1 {
  readonly callId: string;
  readonly carrierSeq: number;
  readonly payload: NonNullable<
    NonNullable<ToolSettledFactV1["observation"]>["payload"]
  >;
}

export function createTaskProgressServiceV1(
  options: CreateTaskProgressServiceOptionsV1,
): TaskProgressServiceV1 {
  if (typeof options.readCanonicalPrefix !== "function") {
    throw new Error("Task progress canonical-prefix reader is invalid");
  }
  if (typeof options.loadPayloadEvidence !== "function") {
    throw new Error("Task progress payload-evidence loader is invalid");
  }
  const policy = freezeTaskProgressPolicyV1(
    options.policy ?? DEFAULT_TASK_PROGRESS_POLICY_V1,
  );
  const clock = options.clock ?? Date.now;
  const service: TaskProgressServiceV1 = {
    async write(input, signal) {
      try {
        throwIfAborted(signal);
        const items = normalizeTaskProgressItemsV1(input, policy);
        const prefix = await options.readCanonicalPrefix();
        if (countPendingProgressWrites(prefix) > 1) {
          return failure("only one todo_write may be pending in a tool batch");
        }
        const prior = await projectTaskProgressSnapshotV1(
          prefix,
          options.loadPayloadEvidence,
          policy,
          signal,
        );
        if (prior?.revision === Number.MAX_SAFE_INTEGER) {
          return failure("task progress revision is exhausted");
        }
        return {
          ok: true,
          value: createSnapshot(items, (prior?.revision ?? 0) + 1),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return failure(describeError(error));
      }
    },
    async read(signal) {
      try {
        throwIfAborted(signal);
        const prefix = await options.readCanonicalPrefix();
        const snapshot = await projectTaskProgressSnapshotV1(
          prefix,
          options.loadPayloadEvidence,
          policy,
          signal,
        );
        const now = clock();
        const activities = Object.freeze(
          (options.listActivities?.() ?? []).map((job) =>
            projectActivity(job, now),
          ),
        );
        return {
          ok: true,
          value: Object.freeze({
            ...(snapshot === undefined ? {} : { snapshot }),
            activities,
          }),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return failure(describeError(error));
      }
    },
  };
  return Object.freeze(service);
}

function countPendingProgressWrites(
  prefix: readonly RunJournalEnvelopeV1[],
): number {
  const pending = new Set<string>();
  for (const envelope of prefix) {
    if (envelope.record.kind !== "input_fact") continue;
    const fact = envelope.record.fact;
    if (
      fact.type === "tool.call_observed" &&
      fact.tool === TASK_PROGRESS_PROVIDER_TOOL_V1
    ) {
      pending.add(fact.callId);
    } else if (fact.type === "tool.settled") {
      pending.delete(fact.callId);
    }
  }
  return pending.size;
}

export async function projectTaskProgressSnapshotV1(
  prefix: readonly RunJournalEnvelopeV1[],
  loadPayloadEvidence: CreateTaskProgressServiceOptionsV1["loadPayloadEvidence"],
  policy: TaskProgressPolicyV1 = DEFAULT_TASK_PROGRESS_POLICY_V1,
  signal?: AbortSignal,
): Promise<TaskProgressSnapshotV1 | undefined> {
  throwIfAborted(signal);
  const frozenPolicy = freezeTaskProgressPolicyV1(policy);
  const observedTools = new Map<string, string>();
  let latest: LocatedProgressPayloadV1 | undefined;
  for (const envelope of prefix) {
    if (envelope.record.kind !== "input_fact") continue;
    const fact = envelope.record.fact;
    if (fact.type === "tool.call_observed") {
      observedTools.set(fact.callId, fact.tool);
      continue;
    }
    if (
      fact.type === "tool.settled" &&
      fact.status === "completed" &&
      fact.observation?.isError === false &&
      fact.observation.payload !== undefined &&
      observedTools.get(fact.callId) === TASK_PROGRESS_PROVIDER_TOOL_V1
    ) {
      latest = {
        callId: fact.callId,
        carrierSeq: envelope.seq,
        payload: fact.observation.payload,
      };
    }
  }
  if (!latest) return undefined;
  const value =
    latest.payload.kind === "inline"
      ? latest.payload.value
      : (await loadPayloadEvidence(prefix, signal)).requirePayload({
          snapshot: projectCanonicalSessionInputSnapshotV1(prefix),
          location: {
            kind: "tool_observation",
            carrierType: "tool.settled",
            carrierSeq: latest.carrierSeq,
            callId: latest.callId,
          },
          payload: latest.payload,
        });
  return parseTaskProgressSnapshotV1(value, frozenPolicy);
}

export function parseTaskProgressSnapshotV1(
  input: JsonValue,
  policy: TaskProgressPolicyV1 = DEFAULT_TASK_PROGRESS_POLICY_V1,
): TaskProgressSnapshotV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Task progress snapshot is invalid");
  }
  const record = input as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record).sort().join("\0");
  if (
    keys !==
      "completed\0current\0items\0percent\0revision\0schemaVersion\0status\0total" &&
    keys !== "completed\0items\0percent\0revision\0schemaVersion\0status\0total"
  ) {
    throw new Error("Task progress snapshot fields are invalid");
  }
  if (
    record.schemaVersion !== TASK_PROGRESS_SCHEMA_V1 ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1
  ) {
    throw new Error("Task progress snapshot identity is invalid");
  }
  const items = normalizeTaskProgressItemsV1(record.items, policy);
  const expected = createSnapshot(items, record.revision as number);
  if (canonicalJson(expected) !== canonicalJson(record)) {
    throw new Error("Task progress snapshot derived fields are invalid");
  }
  return expected;
}

function createSnapshot(
  items: readonly TaskProgressItemV1[],
  revision: number,
): TaskProgressSnapshotV1 {
  const completed = items.filter((item) => item.status === "done").length;
  const current = items.find((item) => item.status === "in_progress")?.content;
  const total = items.length;
  const status =
    total === 0
      ? "empty"
      : completed === total
        ? "completed"
        : current
          ? "in_progress"
          : "pending";
  return Object.freeze({
    schemaVersion: TASK_PROGRESS_SCHEMA_V1,
    revision,
    items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
    total,
    completed,
    percent: total === 0 ? 0 : Math.floor((completed * 100) / total),
    status,
    ...(current === undefined ? {} : { current }),
  });
}

function projectActivity(
  job: ManagedJobSnapshotV1,
  now: number,
): TaskProgressActivityV1 {
  const end = job.finishedAt ?? now;
  return Object.freeze({
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    elapsedMs: Math.max(0, end - job.startedAt),
    ...(job.detail === undefined ? {} : { detail: job.detail }),
  });
}

function failure(reason: string): {
  readonly ok: false;
  readonly reason: string;
} {
  return { ok: false, reason };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Task progress aborted", "AbortError");
}
