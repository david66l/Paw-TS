import { canonicalJsonStringifyV1, hashCanonicalJsonV1 } from "@paw/core";

/**
 * Loop v2 canonical encoding.
 *
 * Kept as a named alias because loop v2's artifacts and resume claims hash
 * through these two names; the implementation is `@paw/core`'s, so a loop v2
 * hash and a runtime hash of the same value are the same string.
 */
export function canonicalJson(value: unknown): string {
  return canonicalJsonStringifyV1(value);
}

export function sha256Canonical(value: unknown): string {
  return hashCanonicalJsonV1(value);
}
