import { describe, expect, test } from "bun:test";

import { hashCanonicalJsonV1 as coreHashCanonicalJsonV1 } from "@paw/core";

import {
  PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1,
  createPawNextProductManifestV1,
  hashCanonicalJsonV1,
  toFrozenJsonValueV1,
} from "../src/product-manifest.js";

/**
 * `packages/paw-next` 是桌面端唯一的组装入口，此前**一个测试都没有**（§C7 / 批次 D
 * #34）。这个文件先把最容易出错、且不依赖运行时的一层钉住：这个模块自己的
 * canonical JSON 与冻结克隆。
 *
 * 它同时是批次 B #6 那次收敛的回归网：`paw-next` 原本是**第四种** canonical JSON
 * 实现（也是唯一一个会对 `undefined` / 非有限数直接抛错的），收敛后它改为委托给
 * `@paw/core`。下面第一条用例就是那句话的可执行版本。
 */
describe("paw-next canonical hashing", () => {
  const VALUES: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["number", 1.5],
    ["string", "a"],
    ["empty object", {}],
    ["unordered keys", { b: 1, a: 2, C: 3 }],
    ["nested", { z: { y: [1, { x: null }] }, a: "x" }],
    ["undefined field", { a: undefined, b: 1 }],
    ["array with scalars", [1, "a", null]],
  ];

  for (const [label, value] of VALUES) {
    test(`agrees with @paw/core for ${label}`, () => {
      expect(hashCanonicalJsonV1(value)).toBe(coreHashCanonicalJsonV1(value));
    });
  }

  test("key order cannot change the digest", () => {
    const digests = new Set(
      [
        { a: 1, b: 2, c: 3 },
        { c: 3, a: 1, b: 2 },
        { b: 2, c: 3, a: 1 },
      ].map((v) => hashCanonicalJsonV1(v)),
    );
    expect(digests.size).toBe(1);
  });

  test("rejects values JSON cannot represent", () => {
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => 1,
      [1, undefined],
    ]) {
      expect(() => hashCanonicalJsonV1(value)).toThrow();
    }
  });

  test("toFrozenJsonValueV1 returns a key-sorted, deeply frozen, detached copy", () => {
    const source = { z: { y: [{ x: 1 }] }, a: null };
    const frozen = toFrozenJsonValueV1(source);

    expect(frozen).toEqual({ a: null, z: { y: [{ x: 1 }] } });
    expect(frozen).not.toBe(source);
    const isFrozenDeep = (v: unknown): boolean =>
      v === null || typeof v !== "object"
        ? true
        : Object.isFrozen(v) && Object.values(v).every(isFrozenDeep);
    expect(isFrozenDeep(frozen)).toBe(true);
    // 归一化后的副本再编码是固定点
    expect(hashCanonicalJsonV1(frozen)).toBe(hashCanonicalJsonV1(source));
  });

  test("a created manifest carries the schema version and is frozen", () => {
    const manifest = createPawNextProductManifestV1({
      profileIdentity: { profileId: "p", revision: 1 },
      credentialBindingHash: "a".repeat(64),
      runConfig: { model: "m" },
      model: "m",
      providerProtocol: "openai-compatible",
      transport: "http",
      registryHash: "b".repeat(64),
    } as Parameters<typeof createPawNextProductManifestV1>[0]);

    expect(manifest.schemaVersion).toBe(PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1);
    expect(Object.isFrozen(manifest)).toBe(true);
    // 同一输入必须给出同一摘要（清单身份的基础）
    const again = createPawNextProductManifestV1({
      profileIdentity: { profileId: "p", revision: 1 },
      credentialBindingHash: "a".repeat(64),
      runConfig: { model: "m" },
      model: "m",
      providerProtocol: "openai-compatible",
      transport: "http",
      registryHash: "b".repeat(64),
    } as Parameters<typeof createPawNextProductManifestV1>[0]);
    expect(hashCanonicalJsonV1(again)).toBe(hashCanonicalJsonV1(manifest));
  });
});
