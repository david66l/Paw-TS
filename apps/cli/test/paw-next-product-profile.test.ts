import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
  readFileSessionJournalCommitIndexV1,
} from "@paw/runtime";

import { preparePawNextProductRuntimeV1 } from "../src/paw-next/composition.js";
import {
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
  type PawNextProductProfileStoreV1,
  type PawNextProductProfileV1,
  buildPawNextTaskOptionsFromProfileV1,
  createPawNextProductProfileResolverV1,
  loadPawNextProductProfileStoreV1,
} from "../src/paw-next/product-profile.js";
import {
  type PawNextStartupRunIdentityV1,
  scanAndResumePawNextRunsV1,
} from "../src/paw-next/startup-scan.js";

const roots: string[] = [];
const SECRET_ONE = "sk-profile-secret-one";
const SECRET_TWO = "sk-profile-secret-two";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next strict product profile", () => {
  test("one builder gives Fresh and startup resolver the same frozen product identity", () => {
    const root = workspace();
    const identity = bootstrapIdentity(root, "same-builder");
    const seed = profile();
    const direct = buildPawNextTaskOptionsFromProfileV1({
      identity,
      profile: seed,
      apiKey: SECRET_ONE,
    });
    const configHash = preparePawNextProductRuntimeV1(direct).configHash;
    const canonicalProfile = { ...seed, configHash };
    writeProfileStore(root, [canonicalProfile]);
    writeSettings(root, { primary: SECRET_ONE });

    const store = loadPawNextProductProfileStoreV1({ workspaceRoot: root });
    expect(Object.isFrozen(store)).toBeTrue();
    expect(Object.isFrozen(store.profiles)).toBeTrue();
    expect(Object.isFrozen(store.profiles[0]?.model.capabilities)).toBeTrue();
    const resolver = createPawNextProductProfileResolverV1({
      workspaceRoot: root,
    });
    const resumed = resolver({ ...identity, configHash });
    if (!resumed) throw new Error("strict profile unexpectedly unavailable");
    const prepared = preparePawNextProductRuntimeV1(resumed);

    expect(prepared.configHash).toBe(configHash);
    expect(prepared.manifest.profileIdentity).toEqual({
      profileId: seed.profileId,
      revision: seed.revision,
    });
    expect(prepared.manifest.credentialBindingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(prepared.manifest)).not.toContain(SECRET_ONE);
    expect(resumed).toMatchObject({
      workspaceRoot: fs.realpathSync.native(root),
      sessionId: identity.sessionId,
      runId: identity.runId,
      inputId: identity.inputId,
      goal: identity.goal,
      providerProtocol: seed.model.protocol,
      transport: seed.model.transport,
      profileIdentity: {
        profileId: seed.profileId,
        revision: seed.revision,
      },
    });
  });

  test("credential slot and secret are bound without exposing either secret", () => {
    const root = workspace();
    const identity = bootstrapIdentity(root, "credential-binding");
    const primary = profile();
    const same = preparedProfile(identity, primary, SECRET_ONE);
    const repeated = preparedProfile(identity, primary, SECRET_ONE);
    const changedSecret = preparedProfile(identity, primary, SECRET_TWO);
    const changedSlot = preparedProfile(
      identity,
      {
        ...primary,
        model: { ...primary.model, credentialSlot: "secondary" },
      },
      SECRET_ONE,
    );

    expect(repeated.configHash).toBe(same.configHash);
    expect(repeated.manifest.credentialBindingHash).toBe(
      same.manifest.credentialBindingHash,
    );
    expect(same.manifest.credentialBindingHash).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            "paw.credential-binding.v1",
            primary.model.credentialSlot,
            SECRET_ONE,
          ]),
        )
        .digest("hex"),
    );
    expect(changedSecret.configHash).not.toBe(same.configHash);
    expect(changedSlot.configHash).not.toBe(same.configHash);
    expect(changedSecret.manifest.credentialBindingHash).not.toBe(
      same.manifest.credentialBindingHash,
    );
    for (const prepared of [same, changedSecret, changedSlot]) {
      const serialized = JSON.stringify(prepared.manifest);
      expect(serialized).not.toContain(SECRET_ONE);
      expect(serialized).not.toContain(SECRET_TWO);
    }

    writeProfileStore(root, [{ ...primary, configHash: same.configHash }]);
    writeSettings(root, { primary: SECRET_TWO });
    const resolver = createPawNextProductProfileResolverV1({
      workspaceRoot: root,
    });
    let message = "";
    try {
      resolver({ ...identity, configHash: same.configHash });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("configHash mismatch");
    expect(message).not.toContain(SECRET_ONE);
    expect(message).not.toContain(SECRET_TWO);
  });

  test("configHash is selection evidence and cannot be fed back into the builder", () => {
    const root = workspace();
    const identity = bootstrapIdentity(root, "no-hash-inference");
    const firstProfile = profile();
    const secondProfile = {
      ...firstProfile,
      configHash: "f".repeat(64),
    };
    const first = buildPawNextTaskOptionsFromProfileV1({
      identity: {
        ...identity,
        configHash: "a".repeat(64),
      } as typeof identity,
      profile: firstProfile,
      apiKey: SECRET_ONE,
    });
    const second = buildPawNextTaskOptionsFromProfileV1({
      identity,
      profile: secondProfile,
      apiKey: SECRET_ONE,
    });

    expect("configHash" in first).toBeFalse();
    expect(preparePawNextProductRuntimeV1(first).configHash).toBe(
      preparePawNextProductRuntimeV1(second).configHash,
    );
    writeProfileStore(root, [
      {
        ...firstProfile,
        configHash: preparePawNextProductRuntimeV1(first).configHash,
      },
    ]);
    const resolver = createPawNextProductProfileResolverV1({
      workspaceRoot: root,
    });
    expect(
      resolver({ ...identity, configHash: "b".repeat(64) }),
    ).toBeUndefined();
  });

  test("an explicit Anthropic profile builds Anthropic without provider inference", () => {
    const root = workspace();
    const identity = bootstrapIdentity(root, "anthropic-explicit");
    const base = profile();
    const anthropic: PawNextProductProfileV1 = {
      ...base,
      profileId: "anthropic-profile",
      model: {
        ...base.model,
        protocol: "anthropic-compatible",
        model: "claude-profile-test",
        baseUrl: "https://api.anthropic.example.invalid/v1",
        thinkingEnabled: null,
      },
      budget: {
        ...base.budget,
        estimator: { id: "core:anthropic:claude-profile-test", version: "v1" },
      },
    };
    const options = buildPawNextTaskOptionsFromProfileV1({
      identity,
      profile: anthropic,
      apiKey: SECRET_ONE,
    });
    const prepared = preparePawNextProductRuntimeV1(options);

    expect(options.providerProtocol).toBe("anthropic-compatible");
    expect(options.model.label).toBe("anthropic:claude-profile-test");
    expect(options.model.runtimeProfile).toMatchObject({
      protocol: "anthropic-compatible",
      model: "claude-profile-test",
    });
    expect(prepared.manifest.providerProtocol).toBe("anthropic-compatible");
  });

  test("every explicit frozen profile dimension reaches config identity", () => {
    const root = workspace();
    const identity = bootstrapIdentity(root, "frozen-dimensions");
    const base = profile();
    const baseline = preparedProfile(identity, base, SECRET_ONE).configHash;
    const variants: readonly PawNextProductProfileV1[] = [
      { ...base, profileId: "another-profile-id" },
      { ...base, revision: 2 },
      {
        ...base,
        model: {
          ...base.model,
          model: "profile-test-model-v2",
        },
        budget: {
          ...base.budget,
          estimator: {
            id: "core:openai:profile-test-model-v2",
            version: "v1",
          },
        },
      },
      {
        ...base,
        model: {
          ...base.model,
          baseUrl: "https://second.example.invalid/v1",
        },
      },
      {
        ...base,
        model: {
          ...base.model,
          capabilities: {
            ...base.model.capabilities,
            contextWindow: 64_000,
          },
        },
      },
      {
        ...base,
        model: { ...base.model, thinkingEnabled: true },
      },
      {
        ...base,
        model: { ...base.model, transport: "stream" },
      },
      {
        ...base,
        control: { ...base.control, maxModelTurns: 9 },
      },
      { ...base, systemPrompt: "another exact system prompt" },
      {
        ...base,
        budget: { ...base.budget, reservedOutputTokens: 1_024 },
      },
      {
        ...base,
        permission: {
          ...base.permission,
          policyVersion: "profile-policy.v2",
        },
      },
      {
        ...base,
        heartbeat: { ...base.heartbeat, ttlMs: 600, intervalMs: 200 },
      },
      {
        ...base,
        shellSandbox: sandbox(),
      },
    ];

    for (const variant of variants) {
      expect(
        preparedProfile(identity, variant, SECRET_ONE).configHash,
      ).not.toBe(baseline);
    }
  });

  test("strict array schema rejects unknown, ambiguous, or implicit configuration", () => {
    const root = workspace();
    const valid = profile();
    const invalidStores: unknown[] = [
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
        profiles: {},
      },
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
        profiles: [valid],
        extra: true,
      },
      store([{ ...valid, extra: true } as never]),
      store([
        {
          ...valid,
          model: { ...valid.model, protocol: "auto" },
        } as never,
      ]),
      store([{ ...valid, approval: "available" } as never]),
      store([valid, { ...valid }]),
      store([
        valid,
        {
          ...valid,
          profileId: "other-profile",
        },
      ]),
    ];

    for (const [index, value] of invalidStores.entries()) {
      writeJson(profilePath(root), value);
      expect(
        () => loadPawNextProductProfileStoreV1({ workspaceRoot: root }),
        `invalid store ${index}`,
      ).toThrow();
    }
    expect(() =>
      buildPawNextTaskOptionsFromProfileV1({
        identity: bootstrapIdentity(root, "bad-estimator"),
        profile: {
          ...valid,
          budget: {
            ...valid.budget,
            estimator: { id: "auto", version: "v1" },
          },
        },
        apiKey: SECRET_ONE,
      }),
    ).toThrow("exact Core built-in estimator");
  });

  test("profile revisions coexist while an exact revision remains unique", () => {
    const root = workspace();
    const identity = bootstrapIdentity(root, "profile-revisions");
    const revisionOne = profile();
    const revisionTwo = { ...revisionOne, revision: 2 };
    const preparedOne = preparedProfile(identity, revisionOne, SECRET_ONE);
    const preparedTwo = preparedProfile(identity, revisionTwo, SECRET_ONE);
    writeProfileStore(root, [
      { ...revisionOne, configHash: preparedOne.configHash },
      { ...revisionTwo, configHash: preparedTwo.configHash },
    ]);
    writeSettings(root, { primary: SECRET_ONE });

    const loaded = loadPawNextProductProfileStoreV1({ workspaceRoot: root });
    expect(
      loaded.profiles.map(({ profileId, revision }) => ({
        profileId,
        revision,
      })),
    ).toEqual([
      { profileId: revisionOne.profileId, revision: 1 },
      { profileId: revisionOne.profileId, revision: 2 },
    ]);
    const resolver = createPawNextProductProfileResolverV1({
      workspaceRoot: root,
    });
    const resolvedOne = resolver({
      ...identity,
      configHash: preparedOne.configHash,
    });
    const resolvedTwo = resolver({
      ...identity,
      configHash: preparedTwo.configHash,
    });
    if (!resolvedOne || !resolvedTwo) {
      throw new Error("coexisting profile revision was unavailable");
    }
    expect(preparePawNextProductRuntimeV1(resolvedOne).configHash).toBe(
      preparedOne.configHash,
    );
    expect(preparePawNextProductRuntimeV1(resolvedTwo).configHash).toBe(
      preparedTwo.configHash,
    );
  });

  test("strict reads reject final-file and ancestor swaps between validation and open", () => {
    const root = workspace();
    const originalProfilePath = profilePath(root);
    writeProfileStore(root, [profile()]);
    const replacementPath = path.join(root, ".paw", "replacement-profile.json");
    writeJson(
      replacementPath,
      store([{ ...profile(), profileId: "replacement" }]),
    );
    const originalOpen = fs.openSync;
    let swapped = false;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((
      file,
      flags,
      mode,
    ) => {
      if (!swapped && path.resolve(String(file)) === originalProfilePath) {
        swapped = true;
        fs.renameSync(originalProfilePath, `${originalProfilePath}.saved`);
        fs.renameSync(replacementPath, originalProfilePath);
      }
      return originalOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() =>
        loadPawNextProductProfileStoreV1({ workspaceRoot: root }),
      ).toThrow("changed before it could be opened");
    } finally {
      openSpy.mockRestore();
    }

    const secondRoot = workspace();
    const pawRoot = path.join(secondRoot, ".paw");
    writeProfileStore(secondRoot, [profile()]);
    const replacementPaw = path.join(secondRoot, ".paw-replacement");
    fs.mkdirSync(replacementPaw, { recursive: true });
    writeJson(
      path.join(replacementPaw, path.basename(profilePath(secondRoot))),
      store([profile()]),
    );
    const secondOriginalOpen = fs.openSync;
    let ancestorSwapped = false;
    const ancestorSpy = spyOn(fs, "openSync").mockImplementation(((
      file,
      flags,
      mode,
    ) => {
      if (
        !ancestorSwapped &&
        path.resolve(String(file)) === profilePath(secondRoot)
      ) {
        ancestorSwapped = true;
        fs.renameSync(pawRoot, `${pawRoot}.saved`);
        fs.renameSync(replacementPaw, pawRoot);
      }
      return secondOriginalOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() =>
        loadPawNextProductProfileStoreV1({ workspaceRoot: secondRoot }),
      ).toThrow("changed before it could be opened");
    } finally {
      ancestorSpy.mockRestore();
    }

    const settingsRoot = workspace();
    const settingsIdentity = bootstrapIdentity(settingsRoot, "settings-swap");
    const settingsSeed = profile();
    const settingsConfigHash = preparedProfile(
      settingsIdentity,
      settingsSeed,
      SECRET_ONE,
    ).configHash;
    writeProfileStore(settingsRoot, [
      { ...settingsSeed, configHash: settingsConfigHash },
    ]);
    writeSettings(settingsRoot, { primary: SECRET_ONE });
    const settingsReplacement = path.join(
      settingsRoot,
      ".paw",
      "replacement-settings.json",
    );
    writeJson(settingsReplacement, {
      models: { primary: { apiKey: SECRET_TWO } },
    });
    const settingsResolver = createPawNextProductProfileResolverV1({
      workspaceRoot: settingsRoot,
    });
    const thirdOriginalOpen = fs.openSync;
    let settingsSwapped = false;
    const settingsSpy = spyOn(fs, "openSync").mockImplementation(((
      file,
      flags,
      mode,
    ) => {
      if (
        !settingsSwapped &&
        path.resolve(String(file)) === settingsPath(settingsRoot)
      ) {
        settingsSwapped = true;
        fs.renameSync(
          settingsPath(settingsRoot),
          `${settingsPath(settingsRoot)}.saved`,
        );
        fs.renameSync(settingsReplacement, settingsPath(settingsRoot));
      }
      return thirdOriginalOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(() =>
        settingsResolver({
          ...settingsIdentity,
          configHash: settingsConfigHash,
        }),
      ).toThrow("changed before it could be opened");
    } finally {
      settingsSpy.mockRestore();
    }
  });

  test("profile and credentials stay inside the canonical workspace", () => {
    const root = workspace();
    const outside = workspace();
    const emptyWorkspace = workspace();
    const credentiallessWorkspace = workspace();
    writeProfileStore(root, [profile()]);
    writeProfileStore(outside, [profile()]);
    writeSettings(root, {});
    writeSettings(outside, { primary: SECRET_ONE });
    writeProfileStore(credentiallessWorkspace, [profile()]);

    expect(() =>
      loadPawNextProductProfileStoreV1({
        workspaceRoot: emptyWorkspace,
      }),
    ).toThrow();
    expect(() =>
      loadPawNextProductProfileStoreV1({
        workspaceRoot: root,
        profilePath: profilePath(outside),
      }),
    ).toThrow("inside the workspace");
    expect(() =>
      createPawNextProductProfileResolverV1({
        workspaceRoot: root,
        settingsPath: settingsPath(outside),
      })(
        startupIdentity(
          bootstrapIdentity(root, "outside-settings"),
          profile().configHash,
        ),
      ),
    ).toThrow("inside the workspace");
    expect(() =>
      createPawNextProductProfileResolverV1({ workspaceRoot: root })(
        startupIdentity(
          bootstrapIdentity(root, "missing-slot"),
          profile().configHash,
        ),
      ),
    ).toThrow("credential slot is unavailable");
    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dir, "../src/paw-next/product-profile.ts"),
    ).href;
    const hostileIdentity = startupIdentity(
      bootstrapIdentity(credentiallessWorkspace, "no-env-fallback"),
      profile().configHash,
    );
    const hostileEnv = spawnSync(
      process.execPath,
      [
        "-e",
        `const { createPawNextProductProfileResolverV1 } = await import(${JSON.stringify(moduleUrl)}); try { createPawNextProductProfileResolverV1({ workspaceRoot: ${JSON.stringify(credentiallessWorkspace)} })(${JSON.stringify(hostileIdentity)}); process.exit(9); } catch (error) { process.stdout.write(error instanceof Error ? error.message : String(error)); }`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, OPENAI_API_KEY: SECRET_ONE },
      },
    );
    expect(hostileEnv.status, hostileEnv.stderr).toBe(0);
    expect(hostileEnv.stdout).toContain("settings.local.json");
    expect(hostileEnv.stdout).not.toContain(SECRET_ONE);

    const hardlink = path.join(root, ".paw", "profile-hardlink.json");
    fs.linkSync(profilePath(root), hardlink);
    expect(() =>
      loadPawNextProductProfileStoreV1({
        workspaceRoot: root,
        profilePath: hardlink,
      }),
    ).toThrow("single-link regular file");
  });

  test.skipIf(process.platform === "win32")(
    "a profile symlink cannot escape the workspace",
    () => {
      const root = workspace();
      const outside = workspace();
      writeProfileStore(outside, [profile()]);
      const link = path.join(root, ".paw", "linked-profile.json");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(profilePath(outside), link, "file");
      expect(() =>
        loadPawNextProductProfileStoreV1({
          workspaceRoot: root,
          profilePath: link,
        }),
      ).toThrow("cannot use links");
    },
  );

  test("startup scanner resolves only after reading canonical bootstrap identity", async () => {
    const root = workspace();
    const identity = bootstrapIdentity(root, "prefix-first");
    const configHash = preparedProfile(
      identity,
      profile(),
      SECRET_ONE,
    ).configHash;
    await appendBootstrap(identity, configHash);
    const received: PawNextStartupRunIdentityV1[] = [];

    const report = await scanAndResumePawNextRunsV1({
      workspaceRoot: root,
      resolveOptions(value) {
        received.push(value);
        return undefined;
      },
    });

    expect(received).toEqual([{ ...identity, configHash }]);
    expect(report.runs).toEqual([
      {
        sessionId: identity.sessionId,
        runId: identity.runId,
        status: "config_unavailable",
      },
    ]);
  });
});

function profile(): PawNextProductProfileV1 {
  return {
    profileId: "strict-workspace-profile",
    revision: 1,
    configHash: "0".repeat(64),
    model: {
      protocol: "openai-compatible",
      transport: "complete",
      model: "profile-test-model",
      baseUrl: "https://example.invalid/v1",
      capabilities: { contextWindow: 32_000, maxOutputTokens: 2_048 },
      thinkingEnabled: null,
      reasoningEffort: null,
      credentialSlot: "primary",
    },
    control: {
      mode: "interactive",
      maxModelTurns: 8,
      naturalStop: "complete",
    },
    systemPrompt: "exact profile system prompt",
    budget: {
      contextWindowTokens: 32_000,
      reservedOutputTokens: 2_048,
      estimationMarginTokens: 512,
      estimator: { id: "core:openai:profile-test-model", version: "v1" },
    },
    permission: {
      policyVersion: "profile-policy.v1",
      defaultAction: "deny",
      rules: [],
    },
    approval: "unavailable",
    heartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: 300,
      intervalMs: 100,
    },
    shellSandbox: null,
  };
}

function sandbox() {
  return {
    mode: "strict" as const,
    network: "deny" as const,
    image: "example.invalid/paw-sandbox:v1",
    runtime: "docker" as const,
    memoryMb: 1_024,
    cpus: 1,
    containerWorkspaceRoot: "/workspace",
    commandShell: "sh" as const,
    pullPolicy: "never" as const,
    workspaceReadOnly: false,
  };
}

function preparedProfile(
  identity: ReturnType<typeof bootstrapIdentity>,
  value: PawNextProductProfileV1,
  apiKey: string,
) {
  return preparePawNextProductRuntimeV1(
    buildPawNextTaskOptionsFromProfileV1({
      identity,
      profile: value,
      apiKey,
    }),
  );
}

function bootstrapIdentity(root: string, suffix: string) {
  return {
    workspaceRoot: root,
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    inputId: `input-${suffix}`,
    goal: `goal-${suffix}`,
  };
}

function startupIdentity(
  identity: ReturnType<typeof bootstrapIdentity>,
  configHash: string,
): PawNextStartupRunIdentityV1 {
  return { ...identity, configHash };
}

function store(
  profiles: readonly PawNextProductProfileV1[],
): PawNextProductProfileStoreV1 {
  return {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
    profiles,
  };
}

function writeProfileStore(
  root: string,
  profiles: readonly PawNextProductProfileV1[],
): void {
  writeJson(profilePath(root), store(profiles));
}

function writeSettings(
  root: string,
  credentials: Record<string, string>,
): void {
  writeJson(settingsPath(root), {
    models: Object.fromEntries(
      Object.entries(credentials).map(([slot, apiKey]) => [slot, { apiKey }]),
    ),
  });
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function profilePath(root: string): string {
  return path.join(root, ".paw", "paw-next-product-profiles.v1.json");
}

function settingsPath(root: string): string {
  return path.join(root, ".paw", "settings.local.json");
}

async function appendBootstrap(
  identity: ReturnType<typeof bootstrapIdentity>,
  configHash: string,
): Promise<void> {
  const index = readFileSessionJournalCommitIndexV1(identity);
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: identity.workspaceRoot,
    sessionId: identity.sessionId,
    runId: identity.runId,
    ttlMs: 60_000,
    baseTailSeq: index.head.tailSeq,
    basePrefixHash: index.head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`test lease unavailable: ${acquired.status}`);
  }
  const session = new FileRunSessionV1({
    workspaceRoot: identity.workspaceRoot,
    sessionId: identity.sessionId,
    runId: identity.runId,
    executionLease: acquired.lease,
  });
  try {
    await session.appendInputFacts([
      {
        type: "attempt.started",
        goalHash: hash(identity.goal),
        configHash,
      },
      {
        type: "input.promoted",
        inputId: identity.inputId,
        delivery: "initial",
        content: identity.goal,
        contentHash: hash(identity.goal),
      },
    ]);
  } finally {
    session.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-next-profile-"));
  roots.push(root);
  return root;
}
