import { describe, expect, test } from "bun:test";

import { canonicalJsonStringifyV1, hashCanonicalJsonV1 } from "@paw/core";
import { canonicalJson, sha256Canonical } from "../src/loop-v2/canonical.js";

/**
 * Loop v2 hashes artifacts, resume claims and shadows through local names.
 * Those names must resolve to the one shared encoder, otherwise a loop v2 hash
 * and a runtime hash of the same value disagree — the split-brain this suite
 * exists to prevent.
 */
describe("loop v2 canonical aliases", () => {
  const vectors: readonly (readonly [label: string, value: unknown])[] = [
    ["null", null],
    ["scalar", 1],
    ["string", "a"],
    ["empty object", {}],
    ["nested object", { z: 1, a: { d: [1, 2], c: null } }],
    ["undefined field", { a: undefined, b: 1 }],
    ["unordered keys", { b: 1, a: 2, C: 3 }],
  ];

  for (const [label, value] of vectors) {
    test(`encodes ${label} exactly as core does`, () => {
      expect(canonicalJson(value)).toBe(canonicalJsonStringifyV1(value));
      expect(sha256Canonical(value)).toBe(hashCanonicalJsonV1(value));
    });
  }

  test("key order cannot change a loop v2 digest", () => {
    expect(sha256Canonical({ b: 1, a: 2 })).toBe(sha256Canonical({ a: 2, b: 1 }));
  });

  test("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError);
  });
});
