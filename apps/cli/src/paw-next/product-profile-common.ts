import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ShellSandboxConfig } from "@paw/harness";
import { AnthropicCompatibleModel, OpenAICompatibleModel } from "@paw/models";
import {
  type FrozenPermissionConfigV1,
  FrozenPermissionEngineV1,
  type PermissionRuleV1,
  type SessionLeaseHeartbeatPolicyV1,
  freezeSessionLeaseHeartbeatPolicyV1,
} from "@paw/runtime";

import type { RunExistingPawNextTaskOptionsV1 } from "./composition.js";
import type { PawNextProductProfileIdentityV1 } from "./product-manifest.js";
import type {
  BuildPawNextTaskOptionsFromProfileInputV1,
  PawNextProductModelProfileV1,
  PawNextProductProfileV1,
} from "./product-profile.js";

export function canonicalPawNextWorkspaceInternal(input: string): string {
  const workspaceRoot = fs.realpathSync.native(path.resolve(input));
  const stat = fs.lstatSync(workspaceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Paw Next workspace must be a real directory");
  }
  return workspaceRoot;
}

export function readStrictPawNextWorkspaceJsonInternal(
  workspaceRoot: string,
  input: string,
  label: string,
): unknown {
  const before = inspectSafeWorkspaceFile(workspaceRoot, input, label);
  let fd: number | undefined;
  try {
    fd = fs.openSync(before.path, fs.constants.O_RDONLY);
    const openedBefore = fs.fstatSync(fd, { bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      openedBefore.dev !== before.dev ||
      openedBefore.ino !== before.ino
    ) {
      throw new Error(`${label} changed before it could be opened`);
    }
    const raw = fs.readFileSync(fd, "utf8");
    const openedAfter = fs.fstatSync(fd, { bigint: true });
    const after = inspectSafeWorkspaceFile(workspaceRoot, input, label);
    if (
      openedAfter.dev !== openedBefore.dev ||
      openedAfter.ino !== openedBefore.ino ||
      openedAfter.nlink !== 1n ||
      openedAfter.size !== openedBefore.size ||
      openedAfter.mtimeNs !== openedBefore.mtimeNs ||
      openedAfter.ctimeNs !== openedBefore.ctimeNs ||
      after.dev !== openedBefore.dev ||
      after.ino !== openedBefore.ino
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Cannot parse ${label} JSON`, { cause: error });
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function parsePawNextProductProfileInternal(
  value: unknown,
  label: string,
): PawNextProductProfileV1 {
  const record = exactRecordInternal(value, label, [
    "profileId",
    "revision",
    "configHash",
    "model",
    "control",
    "systemPrompt",
    "budget",
    "permission",
    "approval",
    "heartbeat",
    "shellSandbox",
  ]);
  const profileId = stableId(record.profileId, `${label}.profileId`);
  const revision = positiveInteger(record.revision, `${label}.revision`);
  const configHash = sha256(record.configHash, `${label}.configHash`);
  const model = parseModel(record.model, `${label}.model`);
  const control = exactRecordInternal(record.control, `${label}.control`, [
    "mode",
    "maxModelTurns",
    "naturalStop",
  ]);
  if (control.mode !== "interactive") {
    throw new Error(`${label}.control.mode must be interactive`);
  }
  const budget = exactRecordInternal(record.budget, `${label}.budget`, [
    "contextWindowTokens",
    "reservedOutputTokens",
    "estimationMarginTokens",
    "estimator",
  ]);
  const estimator = exactRecordInternal(
    budget.estimator,
    `${label}.budget.estimator`,
    ["id", "version"],
  );
  const permission = parsePermission(record.permission, `${label}.permission`);
  new FrozenPermissionEngineV1(permission);
  if (record.approval !== "unavailable") {
    throw new Error(`${label}.approval must be unavailable`);
  }
  return Object.freeze({
    profileId,
    revision,
    configHash,
    model,
    control: Object.freeze({
      mode: "interactive",
      maxModelTurns: positiveInteger(
        control.maxModelTurns,
        `${label}.control.maxModelTurns`,
      ),
      naturalStop: oneOf(
        control.naturalStop,
        ["complete", "await_user"] as const,
        `${label}.control.naturalStop`,
      ),
    }),
    systemPrompt: nonEmptyString(record.systemPrompt, `${label}.systemPrompt`),
    budget: Object.freeze({
      contextWindowTokens: positiveInteger(
        budget.contextWindowTokens,
        `${label}.budget.contextWindowTokens`,
      ),
      reservedOutputTokens: positiveInteger(
        budget.reservedOutputTokens,
        `${label}.budget.reservedOutputTokens`,
      ),
      estimationMarginTokens: nonNegativeInteger(
        budget.estimationMarginTokens,
        `${label}.budget.estimationMarginTokens`,
      ),
      estimator: Object.freeze({
        id: nonEmptyString(estimator.id, `${label}.budget.estimator.id`),
        version: nonEmptyString(
          estimator.version,
          `${label}.budget.estimator.version`,
        ),
      }),
    }),
    permission,
    approval: "unavailable",
    heartbeat: parseHeartbeat(record.heartbeat, `${label}.heartbeat`),
    shellSandbox:
      record.shellSandbox === null
        ? null
        : parseShellSandbox(record.shellSandbox, `${label}.shellSandbox`),
  });
}

export function buildPawNextTaskOptionsFromProfileInternal(
  input: BuildPawNextTaskOptionsFromProfileInputV1,
): RunExistingPawNextTaskOptionsV1 {
  const profile = parsePawNextProductProfileInternal(input.profile, "profile");
  const workspaceRoot = canonicalPawNextWorkspaceInternal(
    input.identity.workspaceRoot,
  );
  assertIdentity(input.identity);
  if (typeof input.apiKey !== "string" || !input.apiKey.trim()) {
    throw new Error("Named Paw Next credential is empty");
  }
  const common = {
    apiKey: input.apiKey,
    baseUrl: profile.model.baseUrl,
    model: profile.model.model,
    capabilities: profile.model.capabilities,
    ...(profile.model.reasoningEffort === null
      ? {}
      : { reasoningEffort: profile.model.reasoningEffort }),
  };
  const model =
    profile.model.protocol === "openai-compatible"
      ? new OpenAICompatibleModel({
          ...common,
          ...(profile.model.thinkingEnabled === null
            ? {}
            : { thinkingEnabled: profile.model.thinkingEnabled }),
        })
      : new AnthropicCompatibleModel(common);
  if (
    profile.budget.estimator.id !== `core:${model.label}` ||
    profile.budget.estimator.version !== "v1"
  ) {
    throw new Error(
      "Paw Next profile must name the exact Core built-in estimator",
    );
  }
  const profileIdentity: PawNextProductProfileIdentityV1 = Object.freeze({
    profileId: profile.profileId,
    revision: profile.revision,
  });
  return Object.freeze({
    workspaceRoot,
    sessionId: input.identity.sessionId,
    runId: input.identity.runId,
    inputId: input.identity.inputId,
    goal: input.identity.goal,
    model,
    profileIdentity,
    credentialBindingHash: hashCredentialBinding(
      profile.model.credentialSlot,
      input.apiKey,
    ),
    providerProtocol: profile.model.protocol,
    transport: profile.model.transport,
    permissionConfig: profile.permission,
    systemPrompt: profile.systemPrompt,
    maxModelTurns: profile.control.maxModelTurns,
    naturalStop: profile.control.naturalStop,
    contextWindowTokens: profile.budget.contextWindowTokens,
    reservedOutputTokens: profile.budget.reservedOutputTokens,
    estimationMarginTokens: profile.budget.estimationMarginTokens,
    estimatorId: profile.budget.estimator.id,
    estimatorVersion: profile.budget.estimator.version,
    heartbeatPolicy: profile.heartbeat,
    ...(profile.shellSandbox === null
      ? {}
      : { shellSandbox: profile.shellSandbox }),
  });
}

export function exactRecordInternal(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
  for (const key of keys) {
    if (!(key in record)) throw new Error(`${label}.${key} is required`);
  }
  return record;
}

function parseModel(
  value: unknown,
  label: string,
): PawNextProductModelProfileV1 {
  const record = exactRecordInternal(value, label, [
    "protocol",
    "transport",
    "model",
    "baseUrl",
    "capabilities",
    "thinkingEnabled",
    "reasoningEffort",
    "credentialSlot",
  ]);
  const protocol = oneOf(
    record.protocol,
    ["openai-compatible", "anthropic-compatible"] as const,
    `${label}.protocol`,
  );
  const capabilities = exactRecordInternal(
    record.capabilities,
    `${label}.capabilities`,
    ["contextWindow", "maxOutputTokens"],
  );
  const thinkingEnabled = nullableBoolean(
    record.thinkingEnabled,
    `${label}.thinkingEnabled`,
  );
  const reasoningEffort = nullableOneOf(
    record.reasoningEffort,
    ["high", "max"] as const,
    `${label}.reasoningEffort`,
  );
  if (protocol === "anthropic-compatible" && thinkingEnabled !== null) {
    throw new Error(`${label}.thinkingEnabled must be null for Anthropic`);
  }
  if (thinkingEnabled === false && reasoningEffort !== null) {
    throw new Error(`${label} cannot combine disabled thinking and effort`);
  }
  return Object.freeze({
    protocol,
    transport: oneOf(
      record.transport,
      ["complete", "stream"] as const,
      `${label}.transport`,
    ),
    model: nonEmptyString(record.model, `${label}.model`),
    baseUrl: absoluteHttpUrl(record.baseUrl, `${label}.baseUrl`),
    capabilities: Object.freeze({
      contextWindow: positiveInteger(
        capabilities.contextWindow,
        `${label}.capabilities.contextWindow`,
      ),
      maxOutputTokens: positiveInteger(
        capabilities.maxOutputTokens,
        `${label}.capabilities.maxOutputTokens`,
      ),
    }),
    thinkingEnabled,
    reasoningEffort,
    credentialSlot: stableId(record.credentialSlot, `${label}.credentialSlot`),
  });
}

function parsePermission(
  value: unknown,
  label: string,
): FrozenPermissionConfigV1 {
  const record = exactRecordInternal(value, label, [
    "policyVersion",
    "defaultAction",
    "rules",
  ]);
  if (!Array.isArray(record.rules)) {
    throw new Error(`${label}.rules must be an array`);
  }
  const rules: PermissionRuleV1[] = record.rules.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}.rules[${index}] must be an object`);
    }
    const rule = item as Record<string, unknown>;
    const allowed = new Set(["id", "layer", "tool", "category", "action"]);
    for (const key of Object.keys(rule)) {
      if (!allowed.has(key)) {
        throw new Error(`${label}.rules[${index}].${key} is not supported`);
      }
    }
    for (const key of ["id", "layer", "action"] as const) {
      if (!(key in rule)) {
        throw new Error(`${label}.rules[${index}].${key} missing`);
      }
    }
    return Object.freeze({
      id: nonEmptyString(rule.id, `${label}.rules[${index}].id`),
      layer: oneOf(
        rule.layer,
        ["hard", "admin", "user", "default"] as const,
        `${label}.rules[${index}].layer`,
      ),
      action: oneOf(
        rule.action,
        ["allow", "ask", "deny"] as const,
        `${label}.rules[${index}].action`,
      ),
      ...(rule.tool === undefined
        ? {}
        : { tool: nonEmptyString(rule.tool, `${label}.rules[${index}].tool`) }),
      ...(rule.category === undefined
        ? {}
        : {
            category: oneOf(
              rule.category,
              ["read", "write", "shell"] as const,
              `${label}.rules[${index}].category`,
            ),
          }),
    });
  });
  return Object.freeze({
    policyVersion: nonEmptyString(
      record.policyVersion,
      `${label}.policyVersion`,
    ),
    defaultAction: oneOf(
      record.defaultAction,
      ["ask", "deny"] as const,
      `${label}.defaultAction`,
    ),
    rules: Object.freeze(rules),
  });
}

function parseHeartbeat(
  value: unknown,
  label: string,
): SessionLeaseHeartbeatPolicyV1 {
  const record = exactRecordInternal(value, label, [
    "policyVersion",
    "ttlMs",
    "intervalMs",
  ]);
  if (record.policyVersion !== "paw.session-lease-heartbeat.v1") {
    throw new Error(`${label}.policyVersion is unsupported`);
  }
  return freezeSessionLeaseHeartbeatPolicyV1({
    policyVersion: record.policyVersion,
    ttlMs: positiveInteger(record.ttlMs, `${label}.ttlMs`),
    intervalMs: positiveInteger(record.intervalMs, `${label}.intervalMs`),
  });
}

function parseShellSandbox(value: unknown, label: string): ShellSandboxConfig {
  const record = exactRecordInternal(value, label, [
    "mode",
    "network",
    "image",
    "runtime",
    "memoryMb",
    "cpus",
    "containerWorkspaceRoot",
    "commandShell",
    "pullPolicy",
    "workspaceReadOnly",
  ]);
  const workspaceRoot = nonEmptyString(
    record.containerWorkspaceRoot,
    `${label}.containerWorkspaceRoot`,
  );
  if (!path.posix.isAbsolute(workspaceRoot)) {
    throw new Error(`${label}.containerWorkspaceRoot must be absolute POSIX`);
  }
  return Object.freeze({
    mode: oneOf(
      record.mode,
      ["off", "workspace", "strict"] as const,
      `${label}.mode`,
    ),
    network: oneOf(
      record.network,
      ["deny", "full"] as const,
      `${label}.network`,
    ),
    image: nonEmptyString(record.image, `${label}.image`),
    runtime: oneOf(
      record.runtime,
      ["docker", "podman"] as const,
      `${label}.runtime`,
    ),
    memoryMb: positiveInteger(record.memoryMb, `${label}.memoryMb`),
    cpus: positiveNumber(record.cpus, `${label}.cpus`),
    containerWorkspaceRoot: workspaceRoot,
    commandShell: oneOf(
      record.commandShell,
      ["sh", "bash"] as const,
      `${label}.commandShell`,
    ),
    pullPolicy: oneOf(
      record.pullPolicy,
      ["missing", "never"] as const,
      `${label}.pullPolicy`,
    ),
    workspaceReadOnly: booleanValue(
      record.workspaceReadOnly,
      `${label}.workspaceReadOnly`,
    ),
  });
}

function inspectSafeWorkspaceFile(
  workspaceRoot: string,
  input: string,
  label: string,
): Readonly<{ path: string; dev: bigint; ino: bigint }> {
  const target = path.resolve(workspaceRoot, input);
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} path must stay inside the workspace`);
  }
  let current = workspaceRoot;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error(`${label} path cannot use links`);
    if (index === segments.length - 1) {
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`${label} must be a single-link regular file`);
      }
    } else if (!stat.isDirectory()) {
      throw new Error(`${label} ancestor must be a directory`);
    }
  }
  const canonical = fs.realpathSync.native(target);
  if (path.relative(workspaceRoot, canonical) !== relative) {
    throw new Error(`${label} canonical path mismatch`);
  }
  const stat = fs.lstatSync(canonical, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  return Object.freeze({ path: canonical, dev: stat.dev, ino: stat.ino });
}

function assertIdentity(
  identity: BuildPawNextTaskOptionsFromProfileInputV1["identity"],
): void {
  for (const [key, value] of [
    ["sessionId", identity.sessionId],
    ["runId", identity.runId],
    ["inputId", identity.inputId],
    ["goal", identity.goal],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Paw Next profile identity ${key} must be non-empty`);
    }
  }
}

function hashCredentialBinding(slot: string, apiKey: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["paw.credential-binding.v1", slot, apiKey]))
    .digest("hex");
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function stableId(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) {
    throw new Error(`${label} is not a stable identifier`);
  }
  return result;
}
function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}
function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}
function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}
function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function nullableBoolean(value: unknown, label: string): boolean | null {
  return value === null ? null : booleanValue(value, label);
}
function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}
function nullableOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] | null {
  return value === null ? null : oneOf(value, allowed, label);
}
function absoluteHttpUrl(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTP(S) URL`);
  }
  return result;
}
