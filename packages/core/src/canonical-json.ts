import { createHash } from "node:crypto";

import type { JsonValue } from "@paw/protocol";

export type { JsonValue };

/**
 * The single canonical JSON encoding used for every stable hash in the
 * monorepo: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, and only values that JSON itself can represent.
 *
 * Two properties are load-bearing, because hashes double as identities for
 * persisted payloads, revision certificates and run journals:
 *
 * 1. **Byte-stable across hosts.** Key order comes from code-unit comparison,
 *    never from `localeCompare`, so the same value hashes the same in every
 *    locale.
 * 2. **Injective on the values it accepts.** A value that JSON cannot encode
 *    (a non-finite number, `undefined` in a positional slot, a function, a
 *    bigint, a cycle) is rejected instead of being silently coerced. Coercion
 *    is what makes `NaN`, `Infinity` and `null` collide on one hash.
 *
 * `undefined` in a *named* field means "absent" and is omitted, matching
 * `JSON.stringify`. `@paw/memory-core` keeps a deliberately dependency-free
 * copy of this module; `canonical-json.conformance.test.ts` pins the two
 * encoders together byte for byte.
 */
export function canonicalJsonStringifyV1(value: unknown): string {
  return writeCanonicalJson(value, new Set<object>());
}

/** Lowercase sha256 of the shared canonical JSON encoding. */
export function hashCanonicalJsonV1(value: unknown): string {
  return hashTextV1(canonicalJsonStringifyV1(value));
}

/** Lowercase sha256 of raw text, for the non-JSON half of the hash family. */
export function hashTextV1(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Detached, key-normalized and deeply immutable JSON for untrusted codec/hash
 * ports. Re-encoding through the canonical form also guarantees that the
 * returned value shares no references with the input.
 */
export function immutableCanonicalJsonCloneV1(value: unknown): JsonValue {
  return deepFreezeJson(JSON.parse(canonicalJsonStringifyV1(value)) as JsonValue);
}

/** Throws unless the value can be encoded as canonical JSON. */
export function assertCanonicalJsonV1(value: unknown, label: string): void {
  try {
    canonicalJsonStringifyV1(value);
  } catch (error) {
    throw new TypeError(
      `${label} is not JSON-encodable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeCanonicalJson(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`non-finite number ${String(value)}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      // undefined, function, symbol and bigint are all outside JSON.
      throw new TypeError(`${typeof value} value`);
  }

  const container = value as object;
  if (seen.has(container)) throw new TypeError("cyclic value");
  seen.add(container);
  try {
    if (Array.isArray(container)) {
      // Indexed rather than `map`: `map` skips holes, which would join to an
      // empty slot and emit text that JSON cannot parse.
      const items: string[] = [];
      for (let index = 0; index < container.length; index += 1) {
        if (!Object.hasOwn(container, index)) {
          throw new TypeError(`sparse array hole at index ${index}`);
        }
        const item: unknown = container[index];
        if (item === undefined) {
          throw new TypeError(`undefined array element at index ${index}`);
        }
        items.push(writeCanonicalJson(item, seen));
      }
      return `[${items.join(",")}]`;
    }
    const record = container as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const item = record[key];
      if (item === undefined) continue;
      fields.push(`${JSON.stringify(key)}:${writeCanonicalJson(item, seen)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    seen.delete(container);
  }
}

/** UTF-16 code-unit order, so canonical text never depends on the host locale. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreezeJson(item);
    Object.freeze(value);
  }
  return value;
}
