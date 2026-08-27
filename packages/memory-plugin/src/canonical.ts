import { createHash } from "node:crypto";
import type { JsonValue } from "@paw/protocol";

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

export function hashCanonicalJsonV1(value: JsonValue): string {
  return createHash("sha256")
    .update(canonicalJsonStringifyV1(value))
    .digest("hex");
}

export function hashTextV1(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
