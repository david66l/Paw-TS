import { createHash } from "node:crypto";
import path from "node:path";
import { resolveShellSandboxConfig } from "@paw/agent";
import type { PawNextProductProfileV3 } from "@paw/paw-next";
import { loadSkillsFromDirectory } from "@paw/core";
import { resolveScope } from "@paw/memory";
import { type LanguageModel, resolveModelOutputLimit } from "@paw/models";
import {
  CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
} from "@paw/runtime";
import type { PawSettingsLocal } from "@paw/settings";
import { PAW_AGENT_SYSTEM_PROMPT, PAW_CODING_EXECUTION_GUIDANCE } from "./agent-system-prompt.js";
import { desktopProjectContext } from "./project-context.js";

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function desktopProfile(
  workspaceRoot: string,
  model: LanguageModel,
  settings: PawSettingsLocal,
  maxSteps = 80,
  memoryEnabled = true,
): PawNextProductProfileV3 {
  const runtime = model.runtimeProfile;
  if (!runtime)
    throw new Error(
      "请先在设置中配置可用的模型；Paw Next 不使用占位模型执行任务。",
    );
  const protocol = runtime.protocol;
  const scope = resolveScope({ workspaceRoot });
  const writable = settings.paid_memory_extraction !== false;
  const contextWindow = model.capabilities?.contextWindow ?? 128_000;
  const outputLimit = resolveModelOutputLimit(
    model.capabilities?.maxOutputTokens,
  );
  const sandbox = resolveShellSandboxConfig(workspaceRoot);
  const skills = loadSkillsFromDirectory(
    path.join(workspaceRoot, ".paw", "skills"),
  );
  const skillCatalog = skills.length
    ? `\nWorkspace skills (read their files before applying):\n${JSON.stringify(skills.map((skill) => ({ id: skill.id, description: skill.description, directory: skill.skillDir ?? path.join(workspaceRoot, ".paw", "skills") })))}`
    : "";
  return {
    profileId: "paw-desktop",
    environmentAudit: true,
    revision: 1,
    configHash: "0".repeat(64),
    model: {
      protocol,
      transport: model.completeStream ? "stream" : "complete",
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      capabilities: {
        ...(model.capabilities?.imageInput
          ? { imageInput: true as const }
          : {}),
        contextWindow,
        maxOutputTokens: outputLimit,
      },
      thinkingEnabled: runtime.thinkingEnabled ?? null,
      reasoningEffort: runtime.reasoningEffort ?? null,
      credentialSlot: "desktop-settings",
    },
    control: {
      liveSteering: true,
      settleFinalToolBatch: true,
      mode: "interactive",
      maxModelTurns: maxSteps,
      naturalStop: "complete",
      maxSegments: 64,
      maxTotalModelTurns: maxSteps * 64,
    },
    systemPrompt: `${PAW_AGENT_SYSTEM_PROMPT}\n\n${PAW_CODING_EXECUTION_GUIDANCE}${desktopProjectContext(workspaceRoot, sandbox)}${skillCatalog}`,
    budget: {
      contextWindowTokens: contextWindow,
      reservedOutputTokens: outputLimit,
      estimationMarginTokens: 256,
      estimator: { id: `core:${model.label}`, version: "v1" },
    },
    permission: {
      policyVersion: "paw.desktop-permission.v1",
      defaultAction: "ask",
      rules: [
        { id: "read", layer: "default", category: "read", action: "allow" },
      ],
    },
    approval: "available",
    heartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: 90_000,
      intervalMs: 30_000,
    },
    shellSandbox:
      sandbox.mode === "off"
        ? null
        : {
            ...sandbox,
            runtime: sandbox.runtime ?? "docker",
            memoryMb: sandbox.memoryMb ?? 2048,
            cpus: sandbox.cpus ?? 2,
            containerWorkspaceRoot:
              sandbox.containerWorkspaceRoot ?? "/workspace",
            commandShell: sandbox.commandShell ?? "sh",
            pullPolicy: sandbox.pullPolicy ?? "missing",
            workspaceReadOnly: sandbox.workspaceReadOnly ?? false,
          },
    workSegmentPolicyVersion: "paw.work-segment.v1",
    payloadRuntime: {
      codec: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
      storePolicy: {
        policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
        maxArtifactBytes: 16 * 1024 * 1024,
      },
      readBudget: {
        policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
        maxTotalBytes: 32 * 1024 * 1024,
      },
      locationBindingVersion: CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
      locationAwareSessionVersion: LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
      materializerVersion: LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
    },
    ...(memoryEnabled
      ? {
          memory: {
            policyVersion: "paw.next-memory-plugin.v1",
            mode: writable ? "read_write" : "read_only",
            providerVersion: "paw.memory-v2-readonly-provider.rrf.v1",
            scope: {
              tenantId: scope.tenantId,
              userId: scope.userId,
              workspaceId: scope.workspaceId,
              repositoryId: scope.repositoryId,
            },
            maxCards: 8,
            maxInjectedTokens: 4096,
            ...(writable
              ? {
                  writer: {
                    policyVersion: "paw.memory-writer.v1",
                    extractorVersion: "paw.memory-atom-extractor.json.v1",
                    maxAtoms: 8,
                    maxSourceChars: 24_000,
                    topicOrganizer: {
                      policyVersion: "paw.memory-topic-organization.v1",
                      extractorVersion: "paw.memory-topic-extractor.json.v1",
                      maxTopics: 8,
                    },
                    personaProjector: {
                      policyVersion: "paw.memory-persona-evidence-projector.v1",
                      maxClaims: 8,
                      maxChars: 2048,
                      minimumConfidence: 0.7,
                    },
                    rawEvidenceResolver: {
                      policyVersion: "paw.memory-raw-evidence-resolver.v1",
                      maxSpans: 6,
                      maxChars: 6000,
                    },
                    coveragePlanner: {
                      policyVersion: "paw.memory-evidence-coverage-planner.v1",
                      extractorVersion:
                        "paw.memory-evidence-requirement-planner.json.v1",
                      maxRequirements: 4,
                      maxExpansionTopics: 3,
                      maxSupplementalStates: 8,
                      maxSupplementalChars: 4096,
                    },
                    evidencePlanner: {
                      policyVersion: "paw.memory-topic-evidence-planner.v1",
                      maxIndexTopics: 96,
                      maxSelectedTopics: 3,
                      maxStates: 16,
                      maxEvidenceChars: 8000,
                    },
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
