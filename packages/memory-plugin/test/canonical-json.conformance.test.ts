import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  canonicalJsonStringifyV1,
  hashCanonicalJsonV1,
  immutableCanonicalJsonCloneV1,
} from "@paw/core";
import {
  hashCanonicalJsonV1 as standaloneHashV1,
  canonicalJsonStringifyV1 as standaloneStringifyV1,
} from "@paw/memory-core/canonical";

/**
 * `@paw/memory-core` ships with an empty dependency list, so it carries its own
 * copy of the canonical encoder instead of importing `@paw/core`. Hashes double
 * as identities for persisted revisions, which makes silent drift between the
 * two copies a data-corruption bug rather than a cosmetic one. This suite is the
 * guard: it pins the encoding to hand-written golden strings and then proves the
 * standalone copy reproduces them byte for byte.
 */

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Values whose canonical text is short enough to state by hand. */
const GOLDEN: readonly (readonly [label: string, value: unknown, expected: string])[] = [
  ["null", null, "null"],
  ["true", true, "true"],
  ["false", false, "false"],
  ["integer", 1, "1"],
  ["negative integer", -1, "-1"],
  ["fraction", 1.5, "1.5"],
  ["negative zero normalizes to 0", -0, "0"],
  ["exponent form", 1e21, "1e+21"],
  ["small exponent form", 1e-7, "1e-7"],
  ["plain string", "a", '"a"'],
  ["empty array", [], "[]"],
  ["empty object", {}, "{}"],
  ["array of mixed scalars", [1, "a", null], '[1,"a",null]'],
  ["nested array", [[1], [2, [3]]], "[[1],[2,[3]]]"],
  ["keys sort by code unit, not locale", { b: 1, a: 2 }, '{"a":2,"b":1}'],
  [
    "uppercase sorts before lowercase",
    { a: 2, B: 1, z: 3, Z: 4, e: 5, é: 6 },
    '{"B":1,"Z":4,"a":2,"e":5,"z":3,"é":6}',
  ],
  ["digits sort as text", { 9: 1, 10: 2 }, '{"10":2,"9":1}'],
  ["empty key", { "": 1 }, '{"":1}'],
  ["nested sort is per level", { z: { b: 1, a: [] }, a: "x" }, '{"a":"x","z":{"a":[],"b":1}}'],
  ["detached JSON", { d: 1, c: 2, b: 3, a: 4 }, '{"a":4,"b":3,"c":2,"d":1}'],
  ["quote escaping", 'a"b', '"a\\"b"'],
  ["newline escaping", "a\nb", '"a\\nb"'],
  ["tab escaping", "a\tb", '"a\\tb"'],
  ["control character escaping", "\u0001", '"\\u0001"'],
  ["astral character stays literal", "😀", '"😀"'],
  ["undefined field is absent", { a: undefined, b: 1 }, '{"b":1}'],
  [
    "undefined field is absent at depth",
    { a: 1, n: { b: undefined, c: 2 } },
    '{"a":1,"n":{"c":2}}',
  ],
  ["undefined field inside an array element is absent", [{ a: undefined }], "[{}]"],
];

describe("canonical JSON golden vectors", () => {
  for (const [label, value, expected] of GOLDEN) {
    test(`${label}: core`, () => {
      expect(canonicalJsonStringifyV1(value)).toBe(expected);
      expect(hashCanonicalJsonV1(value)).toBe(sha256(expected));
    });

    test(`${label}: standalone memory-core`, () => {
      expect(standaloneStringifyV1(value)).toBe(expected);
      expect(standaloneHashV1(value)).toBe(sha256(expected));
    });
  }

  test("every core entry point agrees on the golden vectors", () => {
    for (const [, value, expected] of GOLDEN) {
      expect(canonicalJsonStringifyV1(value)).toBe(expected);
      // The hash must be taken over the same text the encoder returns.
      expect(hashCanonicalJsonV1(value)).toBe(sha256(canonicalJsonStringifyV1(value)));
    }
  });
});

describe("canonical JSON digests", () => {
  /**
   * Hard-coded digests pin the whole pipeline — encoding, sha256 and lowercase
   * hex — so that swapping the digest algorithm cannot pass unnoticed.
   */
  test("published digests are stable", () => {
    expect(hashCanonicalJsonV1({ b: 1, a: 2 })).toBe(
      "d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772",
    );
    expect(hashCanonicalJsonV1({ a: 2, B: 1 })).toBe(
      "812e5e7fb7bb816dc477e91a136430192eadcf83ff303881298146e106ae0161",
    );
    expect(hashCanonicalJsonV1([1, "a", null])).toBe(
      "6f9c54658fdbc2f155e7105e0ad633c8c03e83b677a6b8a5dfb7541264b83622",
    );
  });

  test("key insertion order cannot change a digest", () => {
    const permutations = [
      { a: 1, b: 2, c: 3 },
      { c: 3, a: 1, b: 2 },
      { b: 2, c: 3, a: 1 },
    ];
    const digests = new Set(permutations.map((value) => hashCanonicalJsonV1(value)));
    expect(digests.size).toBe(1);
  });
});

/** Values JSON cannot represent; coercion is what makes distinct inputs collide. */
const REJECTED: readonly (readonly [label: string, make: () => unknown])[] = [
  ["undefined", () => undefined],
  ["function", () => () => 1],
  ["symbol", () => Symbol("s")],
  ["bigint", () => 1n],
  ["NaN", () => Number.NaN],
  ["Infinity", () => Number.POSITIVE_INFINITY],
  ["-Infinity", () => Number.NEGATIVE_INFINITY],
  ["undefined array element", () => [1, undefined]],
  [
    "sparse array",
    () => {
      const sparse: unknown[] = [1, 2];
      delete sparse[0];
      return sparse;
    },
  ],
  ["function field", () => ({ a: () => 1 })],
  ["nested bigint", () => ({ a: { b: 1n } })],
];

describe("canonical JSON rejects non-JSON values", () => {
  for (const [label, make] of REJECTED) {
    test(`core throws on ${label}`, () => {
      expect(() => canonicalJsonStringifyV1(make())).toThrow(TypeError);
    });

    test(`standalone memory-core throws on ${label}`, () => {
      expect(() => standaloneStringifyV1(make())).toThrow(TypeError);
    });
  }

  test("cyclic values are rejected instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJsonStringifyV1(cyclic)).toThrow(/cyclic/);
    expect(() => standaloneStringifyV1(cyclic)).toThrow(/cyclic/);
  });

  test("a value repeated across sibling fields is not mistaken for a cycle", () => {
    const shared = { a: 1 };
    expect(canonicalJsonStringifyV1([shared, shared])).toBe('[{"a":1},{"a":1}]');
    expect(standaloneStringifyV1([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
});

describe("immutableCanonicalJsonCloneV1", () => {
  test("returns a key-normalized copy that shares no reference with the input", () => {
    const source = { z: { y: [{ x: 1 }] } };
    const clone = immutableCanonicalJsonCloneV1(source);

    expect(canonicalJsonStringifyV1(clone)).toBe('{"z":{"y":[{"x":1}]}}');
    expect(clone).not.toBe(source);
    expect(clone).toEqual({ z: { y: [{ x: 1 }] } });

    const sourceNodes = collectObjects(source);
    for (const node of collectObjects(clone)) {
      expect(sourceNodes.has(node)).toBe(false);
    }
  });

  test("freezes every nested node, not just the root", () => {
    const clone = immutableCanonicalJsonCloneV1({ z: { y: [{ x: 1 }] }, a: null });
    expect(isDeeplyFrozen(clone)).toBe(true);
    expect(canonicalJsonStringifyV1(clone)).toBe('{"a":null,"z":{"y":[{"x":1}]}}');
  });

  test("mutating the source afterwards cannot change the clone", () => {
    const source = { list: [1, 2], nested: { a: "x" } };
    const clone = immutableCanonicalJsonCloneV1(source);
    source.list.push(3);
    source.nested.a = "y";
    expect(canonicalJsonStringifyV1(clone)).toBe('{"list":[1,2],"nested":{"a":"x"}}');
  });
});

/** Every object/array reachable from the value. */
function collectObjects(value: unknown, found = new Set<object>()): Set<object> {
  if (value === null || typeof value !== "object") return found;
  found.add(value);
  for (const item of Object.values(value)) collectObjects(item, found);
  return found;
}

function isDeeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeeplyFrozen);
}
