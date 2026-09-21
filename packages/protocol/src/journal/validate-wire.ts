/** Validators for wire values that are not facts. */
import {
  assertBoolean,
  assertDurableJsonPayload,
  assertExact,
  assertExactKeys,
  assertId,
  assertJsonValue,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertOptionalStringField,
  assertPositiveInteger,
  expectObject,
  hasOwn,
} from "./validate-primitives.js";
import {
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
} from "./versions.js";
import type { TaskCheckpointItemV1, TaskCheckpointV1 } from "./wire-task-checkpoint.js";

export function assertUniqueBoundedIds(
  value: unknown,
  maximumLength: number,
  field: string,
  requireNonEmpty: boolean,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumLength ||
    (requireNonEmpty && value.length === 0)
  ) {
    throw new Error(`${field} must be a bounded array`);
  }
  const ids = new Set<string>();
  for (const id of value) {
    assertId(id, field);
    if (ids.has(id as string)) {
      throw new Error(`${field} must not contain duplicate ids`);
    }
    ids.add(id as string);
  }
}

export function assertUnitInterval(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
}

/**
 * 校验 task checkpoint 的形状，并把结论交给类型系统。
 *
 * 原先返回 `void`：运行时逐项校验了 exact keys、schemaVersion 与每个 item，
 * 却没告诉编译器，于是调用点必须自己补断言（`parse.ts:61` 的
 * `value as TaskCheckpointV1`、`validate-input-fact.ts:965` 的
 * `payload.value as unknown as TaskCheckpointV1`）。改成 `asserts` 谓词后
 * 那些断言消失（docs/CODE-REVIEW.md §R7）。
 *
 * 注意运行时比类型**更严**（至少一个 sourced item），这对 `asserts` 是安全的：
 * 断言一个比已验证条件更弱的类型永远成立。
 */
export function assertTaskCheckpoint(
  value: unknown,
  field: string,
): asserts value is TaskCheckpointV1 {
  const checkpoint = expectObject(value, field);
  assertExactKeys(
    checkpoint,
    [
      "schemaVersion",
      "confirmedFacts",
      "currentHypotheses",
      "ruledOut",
      "changedFiles",
      "verification",
      "unresolved",
    ],
    ["goal", "nextAction"],
    field,
  );
  assertExact(
    checkpoint.schemaVersion,
    TASK_CHECKPOINT_SCHEMA_VERSION_V1,
    `${field}.schemaVersion`,
  );
  if (hasOwn(checkpoint, "goal")) {
    assertTaskCheckpointItem(checkpoint.goal, `${field}.goal`);
  }
  if (hasOwn(checkpoint, "nextAction")) {
    assertTaskCheckpointItem(checkpoint.nextAction, `${field}.nextAction`);
  }
  const listFields = [
    "confirmedFacts",
    "currentHypotheses",
    "ruledOut",
    "changedFiles",
    "verification",
    "unresolved",
  ] as const;
  let itemCount = hasOwn(checkpoint, "goal") || hasOwn(checkpoint, "nextAction") ? 1 : 0;
  for (const listField of listFields) {
    const items = checkpoint[listField];
    if (!Array.isArray(items)) {
      throw new Error(`${field}.${listField} must be an array`);
    }
    items.forEach((item, index) =>
      assertTaskCheckpointItem(item, `${field}.${listField}[${index}]`),
    );
    itemCount += items.length;
  }
  if (itemCount === 0) {
    throw new Error(`${field} must contain at least one sourced item`);
  }
}

export function assertTaskCheckpointItem(
  value: unknown,
  field: string,
): asserts value is TaskCheckpointItemV1 {
  const item = expectObject(value, field);
  assertExactKeys(item, ["statement", "sourceSeqs"], [], field);
  assertNonEmptyString(item.statement, `${field}.statement`);
  if (!Array.isArray(item.sourceSeqs) || item.sourceSeqs.length === 0) {
    throw new Error(`${field}.sourceSeqs must be a non-empty array`);
  }
  let previous = 0;
  for (const seq of item.sourceSeqs) {
    assertPositiveInteger(seq, `${field}.sourceSeqs`);
    if ((seq as number) <= previous) {
      throw new Error(`${field}.sourceSeqs must be strictly increasing`);
    }
    previous = seq as number;
  }
}

export function assertCheckpointSourcesInRange(
  checkpoint: TaskCheckpointV1,
  fromSeq: number,
  throughSeq: number,
): void {
  for (const item of taskCheckpointItems(checkpoint)) {
    if (item.sourceSeqs.some((seq) => seq < fromSeq || seq > throughSeq)) {
      throw new Error("task checkpoint source seq is outside its covered range");
    }
  }
}

export function taskCheckpointItems(checkpoint: TaskCheckpointV1): readonly TaskCheckpointItemV1[] {
  return [
    ...(checkpoint.goal ? [checkpoint.goal] : []),
    ...checkpoint.confirmedFacts,
    ...checkpoint.currentHypotheses,
    ...checkpoint.ruledOut,
    ...checkpoint.changedFiles,
    ...checkpoint.verification,
    ...checkpoint.unresolved,
    ...(checkpoint.nextAction ? [checkpoint.nextAction] : []),
  ];
}

export function assertDerivedDecision(value: unknown): void {
  const decision = expectObject(value, "derived decision");
  assertExactKeys(
    decision,
    ["type", "reducerVersion", "inputThroughSeq", "stateHash", "action"],
    [],
    "derived decision",
  );
  assertExact(decision.type, "control.decided", "decision type");
  assertNonEmptyString(decision.reducerVersion, "reducerVersion");
  assertPositiveInteger(decision.inputThroughSeq, "inputThroughSeq");
  assertNonEmptyString(decision.stateHash, "stateHash");
  assertControlDecisionAction(decision.action, "decision action");
}

export function assertControlDecisionAction(value: unknown, field: string): void {
  const action = expectObject(value, field);
  if (action.kind === "wait") {
    assertExactKeys(action, ["kind", "waitFor", "reasonCode"], [], field);
    assertOneOf(action.waitFor, ["user", "external"], "waitFor");
  } else {
    assertExactKeys(action, ["kind", "reasonCode"], [], field);
    assertOneOf(
      action.kind,
      ["continue", "complete", "incomplete", "failed", "abort"],
      "decision action kind",
    );
  }
  assertId(action.reasonCode, "reasonCode");
}

export function assertModelResponse(value: unknown): void {
  const response = expectObject(value, "model response");
  assertExactKeys(
    response,
    ["schemaVersion", "providerProtocol", "assistantContent", "toolCalls"],
    ["auditThinking", "reasoningPassback", "finishReason", "usage"],
    "model response",
  );
  assertExact(
    response.schemaVersion,
    MODEL_RESPONSE_SCHEMA_VERSION_V1,
    "model response.schemaVersion",
  );
  assertOneOf(
    response.providerProtocol,
    ["openai-compatible", "anthropic-compatible"],
    "model response.providerProtocol",
  );
  if (typeof response.assistantContent !== "string") {
    throw new Error("model response.assistantContent must be a string");
  }
  assertOptionalStringField(response, "auditThinking");
  assertOptionalStringField(response, "reasoningPassback");
  if (
    response.providerProtocol === "anthropic-compatible" &&
    hasOwn(response, "reasoningPassback")
  ) {
    throw new Error("anthropic-compatible model response cannot use string reasoningPassback");
  }
  assertOptionalStringField(response, "finishReason");
  if (hasOwn(response, "usage")) assertModelResponseUsage(response.usage);
  if (!Array.isArray(response.toolCalls)) {
    throw new Error("model response.toolCalls must be an array");
  }
  const ids = new Set<string>();
  response.toolCalls.forEach((call, sourceIndex) => {
    assertModelResponseToolCall(call, sourceIndex);
    const callId = (call as Record<string, unknown>).callId as string;
    if (ids.has(callId)) {
      throw new Error(`model response has duplicate callId: ${callId}`);
    }
    ids.add(callId);
  });
}

export function assertModelResponseUsage(value: unknown): void {
  const usage = expectObject(value, "model response.usage");
  assertExactKeys(
    usage,
    [],
    [
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "cachedPromptTokens",
      "cacheMissPromptTokens",
    ],
    "model response.usage",
  );
  if (Object.keys(usage).length === 0) {
    throw new Error("model response.usage must contain at least one counter");
  }
  for (const field of [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cachedPromptTokens",
    "cacheMissPromptTokens",
  ]) {
    if (hasOwn(usage, field)) {
      assertNonNegativeInteger(usage[field], `model response.usage.${field}`);
    }
  }
}

export function assertModelResponseToolCall(value: unknown, expectedSourceIndex: number): void {
  const call = expectObject(value, `model response.toolCalls[${expectedSourceIndex}]`);
  const field = `model response.toolCalls[${expectedSourceIndex}]`;
  assertExactKeys(
    call,
    ["callId", "name", "rawArguments", "args", "sourceIndex", "argumentsValid"],
    [],
    field,
  );
  assertId(call.callId, `${field}.callId`);
  assertNonEmptyString(call.name, `${field}.name`);
  if (typeof call.rawArguments !== "string") {
    throw new Error(`${field}.rawArguments must be a string`);
  }
  const args = expectObject(call.args, `${field}.args`);
  assertJsonValue(args, `${field}.args`);
  assertNonNegativeInteger(call.sourceIndex, `${field}.sourceIndex`);
  if (call.sourceIndex !== expectedSourceIndex) {
    throw new Error("model response tool sourceIndex must be contiguous");
  }
  assertBoolean(call.argumentsValid, `${field}.argumentsValid`);

  let parsed: unknown;
  let parsedObject: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(call.rawArguments as string) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (Object.getPrototypeOf(parsed) === Object.prototype || Object.getPrototypeOf(parsed) === null)
    ) {
      parsedObject = parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid raw JSON is valid evidence only when argumentsValid is false.
  }
  if (call.argumentsValid) {
    if (!parsedObject || !jsonValuesEqual(parsedObject, args)) {
      throw new Error(`${field} valid rawArguments must exactly match normalized args`);
    }
  } else if (parsedObject || Object.keys(args).length !== 0) {
    throw new Error(`${field} invalid arguments must preserve non-object raw input and empty args`);
  }
}

export function assertInputAttachments(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("attachments must be a non-empty array");
  }
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const attachment = expectObject(item, `attachments[${index}]`);
    assertExactKeys(
      attachment,
      ["attachmentId", "type", "name", "content"],
      ["mimeType"],
      `attachments[${index}]`,
    );
    assertId(attachment.attachmentId, `attachments[${index}].attachmentId`);
    if (ids.has(attachment.attachmentId as string)) {
      throw new Error("attachments contain a duplicate attachmentId");
    }
    ids.add(attachment.attachmentId as string);
    assertOneOf(attachment.type, ["image", "file"], "attachment type");
    assertNonEmptyString(attachment.name, `attachments[${index}].name`);
    assertOptionalStringField(attachment, "mimeType");
    assertDurableJsonPayload(attachment.content, `attachments[${index}].content`);
    const content = attachment.content;
    if (content.kind === "inline" && typeof content.value !== "string") {
      throw new Error("inline attachment content must be a string");
    }
  });
}

export function assertToolObservation(value: unknown, field: string): void {
  const observation = expectObject(value, field);
  assertExactKeys(observation, ["schemaVersion", "summary", "isError"], ["payload"], field);
  assertExact(
    observation.schemaVersion,
    TOOL_OBSERVATION_SCHEMA_VERSION_V1,
    `${field}.schemaVersion`,
  );
  assertNonEmptyString(observation.summary, `${field}.summary`);
  assertBoolean(observation.isError, `${field}.isError`);
  if (hasOwn(observation, "payload")) {
    assertDurableJsonPayload(observation.payload, `${field}.payload`);
  }
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonValuesEqual(item, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
