import path from "node:path";

import type { ToolDefinition } from "@paw/core";
import { RUN_AGENT, type ToolRunResult } from "@paw/harness";
import {
  type RuntimeToolPluginEntryV1,
  type RuntimeToolPluginV1,
  canonicalRuntimeResourcePathV1,
} from "@paw/runtime";

import {
  collaborationDelegationRequiresWriteV1,
  normalizeCollaborationDelegationV1,
  parseCollaborationDelegationPlanV1,
} from "./delegation.js";
import {
  COLLABORATION_POLICY_VERSION_V1,
  type CollaborationPolicyV1,
  DEFAULT_COLLABORATION_POLICY_V1,
  freezeCollaborationPolicyV1,
} from "./policy.js";
import {
  COLLABORATION_CAPABILITIES_V1,
  type CollaborationAgentSpecV1,
  type CollaborationRosterV1,
  DEFAULT_COLLABORATION_ROSTER_V1,
} from "./roster.js";

export const COLLABORATION_TOOL_PLUGIN_ID_V1 = "paw.collaboration" as const;
export const COLLABORATION_PROVIDER_TOOL_NAME_V1 =
  "workspace_delegate" as const;

export function createCollaborationToolPluginV1(input?: {
  readonly policy?: CollaborationPolicyV1;
  readonly roster?: CollaborationRosterV1;
}): RuntimeToolPluginV1 {
  const policy = freezeCollaborationPolicyV1(
    input?.policy ?? DEFAULT_COLLABORATION_POLICY_V1,
  );
  const roster = input?.roster ?? DEFAULT_COLLABORATION_ROSTER_V1;
  const taskProperties = {
    id: {
      type: "string",
      maxLength: 80,
      description: "Stable short task id used by dependencies",
    },
    goal: {
      type: "string",
      maxLength: policy.maxGoalChars,
      description: "One bounded deliverable",
    },
    kind: {
      type: "string",
      enum: [...COLLABORATION_CAPABILITIES_V1],
      description: "Required specialist capability",
    },
    scope: {
      type: "array",
      maxItems: 12,
      items: { type: "string", maxLength: 300 },
      description:
        "Semantic focus for the task. This does not grant filesystem authority; runtime boundaries are derived from the selected AgentSpec.",
    },
    acceptance: {
      type: "array",
      maxItems: 12,
      items: { type: "string", maxLength: 500 },
      description: "Concrete evidence expected from this task",
    },
    depends_on: {
      type: "array",
      maxItems: policy.maxMissionTasks,
      items: { type: "string", maxLength: 80 },
      description: "Task ids that must complete first",
    },
    max_steps: {
      type: "integer",
      minimum: 1,
      maximum: policy.maxChildSteps,
      description:
        "Optional hard turn cap. When omitted, the child starts with the policy soft window and renews on progress up to its AgentSpec hard cap.",
    },
    agent_id: {
      type: "string",
      maxLength: 100,
      description:
        "Required explicit team member id from the Current Team Brief",
    },
  } as const;
  const definition: ToolDefinition = {
    type: "function",
    function: {
      name: COLLABORATION_PROVIDER_TOOL_NAME_V1,
      description: collaborationToolDescriptionV1(roster),
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          goal: {
            type: "string",
            maxLength: policy.maxGoalChars,
            description: "Single-task goal or overall mission goal",
          },
          kind: {
            type: "string",
            enum: [...COLLABORATION_CAPABILITIES_V1],
            description: "Capability for a single task or overall mission",
          },
          scope: taskProperties.scope,
          acceptance: taskProperties.acceptance,
          max_steps: taskProperties.max_steps,
          agent_id: taskProperties.agent_id,
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: policy.maxMissionTasks,
            description:
              "Optional task graph. Prefer no tasks for a single specialist.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: taskProperties,
              required: ["id", "goal", "kind", "agent_id"],
            },
          },
        },
        required: ["goal", "kind"],
        anyOf: [{ required: ["agent_id"] }, { required: ["tasks"] }],
      },
    },
  };
  const entry: RuntimeToolPluginEntryV1 = {
    internalName: RUN_AGENT,
    providerName: COLLABORATION_PROVIDER_TOOL_NAME_V1,
    definition,
    deferred: false,
    resultPolicy: "bounded_json",
    executionKind: "harness",
    validate(args) {
      try {
        const plan = normalizeCollaborationDelegationV1({
          args,
          policy,
          roster,
        });
        const single = plan.mode === "single" ? plan.tasks[0] : undefined;
        return {
          ok: true as const,
          args: Object.freeze({
            goal: plan.goal,
            kind: single?.capability ?? (args as Record<string, unknown>).kind,
            max_steps: single?.maxSteps ?? policy.defaultMaxSteps,
            ...(single ? { initial_steps: single.initialSteps } : {}),
            ...(single ? { agent_id: single.agentId } : {}),
            delegation_plan: plan,
          }),
        };
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
    },
    classify(args, workspaceRoot) {
      const root = canonicalRuntimeResourcePathV1(workspaceRoot);
      const collaborationDomain = path.join(root, ".paw", "collaboration");
      const plan = parseCollaborationDelegationPlanV1(args.delegation_plan);
      const requiresWrite = collaborationDelegationRequiresWriteV1(
        plan,
        roster,
      );
      return {
        lockDomain: collaborationDomain,
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
        resources: [
          {
            // Readers and writers must address the same resource key so the
            // runtime's read/write lock excludes a mutating child across its
            // complete delegated lifecycle.
            key: path.join(collaborationDomain, "workspace"),
            access: requiresWrite ? "write" : "read",
          },
        ],
      };
    },
  };
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: COLLABORATION_TOOL_PLUGIN_ID_V1,
    pluginVersion: COLLABORATION_POLICY_VERSION_V1,
    entries: Object.freeze([Object.freeze(entry)]),
  });
}

function collaborationToolDescriptionV1(roster: CollaborationRosterV1): string {
  const team = roster.agents.map(renderTeamMemberV1).join("\n");
  return [
    "Delegate only when specialist isolation helps; handle small work directly with normal tools.",
    "The main Agent owns task splitting and agent selection. Inspect the Current Team Brief and explicitly provide agent_id for every delegated task. The program only validates capability and permissions; it never chooses an agent from task wording.",
    "Omit tasks for one bounded specialist. Use tasks only for 2+ dependent or independent jobs; one item automatically stays a single delegation. Scheduling, durability, result collection, and mutation serialization are program-controlled.",
    "Current Team Brief:",
    team,
  ].join("\n");
}

function renderTeamMemberV1(agent: CollaborationAgentSpecV1): string {
  const abilities = agentAbilitiesV1(agent);
  const workspaceImpact =
    agent.effect === "mutate"
      ? "canonical workspace mutation allowed"
      : agent.effect === "execute"
        ? "shell/job execution allowed; canonical edit tools unavailable"
        : "canonical workspace read-only; shell and edit tools unavailable";
  return `- agent_id=${agent.id}; specialties=${agent.capabilities.join(",")}; effect=${agent.effect}; abilities=${abilities.join(",") || "none"}; spawn=${agent.canSpawn ? "allowed" : "forbidden"}; workspace=${workspaceImpact}`;
}

function agentAbilitiesV1(agent: CollaborationAgentSpecV1): readonly string[] {
  const inherits = agent.tools === "inherit";
  const tools = inherits ? [] : agent.tools;
  const has = (suffix: string): boolean =>
    inherits ||
    tools.some(
      (tool) =>
        tool === suffix ||
        tool.endsWith(`.${suffix}`) ||
        tool.endsWith(`_${suffix}`),
    );
  const hasPrefix = (prefix: string): boolean =>
    inherits ||
    tools.some((tool) => {
      const leaf = tool.split(/[._]/).slice(1).join("_");
      return leaf.startsWith(prefix);
    });
  const abilities = [
    has("read_file") || has("list_dir") ? "read" : undefined,
    has("search") || has("glob") || has("grep") ? "search" : undefined,
    hasPrefix("git_") ? "git" : undefined,
    hasPrefix("web_") ? "web" : undefined,
    agent.effect !== "inspect" && has("run_shell") ? "shell" : undefined,
    agent.effect !== "inspect" && hasPrefix("job_") ? "job" : undefined,
    agent.effect === "mutate" &&
    (has("write_file") ||
      has("edit_file") ||
      has("apply_patch") ||
      has("notebook_edit"))
      ? "edit"
      : undefined,
  ].filter((ability): ability is string => ability !== undefined);
  return Object.freeze(abilities);
}

function invalid(message: string): {
  readonly ok: false;
  readonly result: ToolRunResult;
} {
  return {
    ok: false,
    result: {
      ok: false,
      summary: `${RUN_AGENT}: ${message}`,
      payload: { code: "E_SCHEMA_INVALID", message, executed: false },
    },
  };
}
