import { createHash } from "node:crypto";

import type { JsonValue } from "@paw/protocol";

/** Stable JSON text used at every Runtime Context hash/render boundary. */
export function canonicalJsonStringifyV1(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringifyV1).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonStringifyV1(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

/** Detached, key-normalized and immutable JSON for untrusted codec/hash ports. */
export function immutableCanonicalJsonCloneV1(value: JsonValue): JsonValue {
  return deepFreezeJson(
    JSON.parse(canonicalJsonStringifyV1(value)) as JsonValue,
  );
}

/** Lowercase sha256 of the shared canonical JSON encoding. */
export function hashCanonicalJsonV1(value: JsonValue): string {
  return createHash("sha256")
    .update(canonicalJsonStringifyV1(value))
    .digest("hex");
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreezeJson(item);
    Object.freeze(value);
  }
  return value;
}
