import type { TaskProgressItemV1 } from "@paw/harness";

export interface TaskProgressPolicyV1 {
  readonly maxItems: number;
  readonly maxItemIdChars: number;
  readonly maxItemContentChars: number;
}

export const DEFAULT_TASK_PROGRESS_POLICY_V1: TaskProgressPolicyV1 =
  Object.freeze({
    maxItems: 100,
    maxItemIdChars: 100,
    maxItemContentChars: 500,
  });

export function freezeTaskProgressPolicyV1(
  input: TaskProgressPolicyV1,
): TaskProgressPolicyV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !==
      "maxItemContentChars\0maxItemIdChars\0maxItems" ||
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > 1_000 ||
    !Number.isSafeInteger(input.maxItemIdChars) ||
    input.maxItemIdChars < 1 ||
    input.maxItemIdChars > 1_000 ||
    !Number.isSafeInteger(input.maxItemContentChars) ||
    input.maxItemContentChars < 1 ||
    input.maxItemContentChars > 10_000
  ) {
    throw new Error("Task progress policy is invalid");
  }
  return Object.freeze({ ...input });
}

export function normalizeTaskProgressItemsV1(
  input: unknown,
  policy: TaskProgressPolicyV1,
): readonly TaskProgressItemV1[] {
  if (!Array.isArray(input) || input.length > policy.maxItems) {
    throw new Error(`todos must contain at most ${policy.maxItems} items`);
  }
  const ids = new Set<string>();
  let active = 0;
  const items = input.map((value, index): TaskProgressItemV1 => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`todos[${index}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join("\0");
    if (
      keys !== "content\0id\0status" &&
      keys !== "content\0id\0priority\0status"
    ) {
      throw new Error(`todos[${index}] has unsupported fields`);
    }
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const content =
      typeof record.content === "string" ? record.content.trim() : "";
    if (!id || id.length > policy.maxItemIdChars) {
      throw new Error(`todos[${index}].id is invalid`);
    }
    if (!content || content.length > policy.maxItemContentChars) {
      throw new Error(`todos[${index}].content is invalid`);
    }
    if (ids.has(id)) throw new Error(`duplicate todo id: ${id}`);
    ids.add(id);
    const status = record.status;
    if (status !== "pending" && status !== "in_progress" && status !== "done") {
      throw new Error(`todos[${index}].status is invalid`);
    }
    if (status === "in_progress") active += 1;
    const priority = record.priority;
    if (
      priority !== undefined &&
      priority !== "low" &&
      priority !== "medium" &&
      priority !== "high"
    ) {
      throw new Error(`todos[${index}].priority is invalid`);
    }
    return Object.freeze({
      id,
      content,
      status,
      ...(priority === undefined ? {} : { priority }),
    });
  });
  if (active > 1) throw new Error("only one todo may be in_progress");
  return Object.freeze(items);
}

export function taskProgressPolicyIdentityV1(
  policy: TaskProgressPolicyV1,
): string {
  return `paw.task-progress.v1:i${policy.maxItems}:d${policy.maxItemIdChars}:c${policy.maxItemContentChars}`;
}
