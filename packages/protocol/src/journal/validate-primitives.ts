/** Field-level assertions used by every other validator. */
import type { DurableJsonPayloadV1 } from "./primitives.js";

export function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!hasOwn(value, key)) throw new Error(`${field}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not allowed`);
  }
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function assertExact(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new Error(`${field} must be ${expected}`);
}

export function assertId(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value)) {
    throw new Error(`${field} must be a stable non-empty id`);
  }
}

export function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export function assertSingleLineString(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${field} must be a bounded single-line string`);
  }
}

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

export function assertOptionalStringField(value: Record<string, unknown>, field: string): void {
  if (hasOwn(value, field)) assertNonEmptyString(value[field], field);
}

export function assertBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
}

export function assertPositiveInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

export function assertNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

export function assertOneOf(value: unknown, expected: readonly string[], field: string): void {
  if (typeof value !== "string" || !expected.includes(value)) {
    throw new Error(`${field} has an unsupported value`);
  }
}

/**
 * 校验 durable JSON payload 的形状（inline / artifact_ref 两支），
 * 并把收窄结果交给类型系统 —— 调用点因此不必再写
 * `fact.checkpoint as DurableJsonPayloadV1`（§R7）。
 */
export function assertDurableJsonPayload(
  value: unknown,
  field: string,
): asserts value is DurableJsonPayloadV1 {
  const payload = expectObject(value, field);
  if (payload.kind === "inline") {
    assertExactKeys(payload, ["kind", "value", "hash"], [], field);
    assertJsonValue(payload.value, `${field}.value`);
    assertSingleLineString(payload.hash, `${field}.hash`);
    return;
  }
  if (payload.kind === "artifact_ref") {
    assertExactKeys(payload, ["kind", "artifactRef", "hash"], [], field);
    assertId(payload.artifactRef, `${field}.artifactRef`);
    assertSingleLineString(payload.hash, `${field}.hash`);
    return;
  }
  throw new Error(`${field}.kind has an unsupported value`);
}

export function assertJsonValue(value: unknown, field: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be valid JSON`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${field}[${index}]`));
    return;
  }
  const record = expectObject(value, field);
  for (const [key, item] of Object.entries(record)) {
    assertJsonValue(item, `${field}.${key}`);
  }
}
