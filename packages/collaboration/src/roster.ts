import { createHash } from "node:crypto";

export const COLLABORATION_ROSTER_VERSION_V1 =
  "paw.collaboration-roster.v4:effect-profiles" as const;

export const COLLABORATION_CAPABILITIES_V1 = [
  "investigation",
  "implementation",
  "testing",
  "review",
  "documentation",
  "integration",
] as const;

export type CollaborationCapabilityV1 =
  (typeof COLLABORATION_CAPABILITIES_V1)[number];

export const COLLABORATION_ROLES_V1 = [
  "investigator",
  "reviewer",
  "verifier",
] as const;

export type CollaborationRoleV1 = (typeof COLLABORATION_ROLES_V1)[number];
export type CollaborationChildPolicyV1 = "read_only" | "read_write";

export const COLLABORATION_EFFECT_PROFILES_V1 = [
  "inspect",
  "execute",
  "mutate",
] as const;

export type CollaborationEffectProfileV1 =
  (typeof COLLABORATION_EFFECT_PROFILES_V1)[number];

export interface CollaborationAgentSpecV1 {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly prompt: string;
  readonly outputFormat: string;
  readonly capabilities: readonly CollaborationCapabilityV1[];
  readonly tools: "inherit" | readonly string[];
  /** Canonical authority used by the collaboration runtime. */
  readonly effect: CollaborationEffectProfileV1;
  /** Legacy compatibility projection. New code must use `effect`. */
  readonly childPolicy: CollaborationChildPolicyV1;
  readonly canSpawn: boolean;
  readonly maxSteps: number;
}

export type CollaborationAgentSpecInputV1 = Omit<
  CollaborationAgentSpecV1,
  "effect" | "childPolicy"
> &
  Readonly<{
    readonly effect?: CollaborationEffectProfileV1;
    readonly childPolicy?: CollaborationChildPolicyV1;
  }>;

export interface CollaborationRosterV1 {
  readonly schemaVersion: typeof COLLABORATION_ROSTER_VERSION_V1;
  readonly rosterHash: string;
  readonly agents: readonly CollaborationAgentSpecV1[];
}

export const DEFAULT_COLLABORATION_ROLE_V1: CollaborationRoleV1 =
  "investigator";

const ROLE_PROMPTS_V1: Readonly<Record<CollaborationRoleV1, string>> =
  Object.freeze({
    investigator:
      "Trace the relevant implementation and return concrete code evidence, likely causes, and unresolved questions.",
    reviewer:
      "Challenge the proposed approach for correctness, regressions, hidden assumptions, and missing tests. Lead with actionable findings.",
    verifier:
      "Inspect verification code and available results. Separate what the evidence proves, disproves, and leaves inconclusive.",
  });

const READ_TOOLS = Object.freeze([
  "workspace.read_file",
  "workspace.list_dir",
  "workspace.search",
  "workspace.glob",
  "workspace.grep",
  "workspace.git_status",
  "workspace.git_log",
  "workspace.git_diff",
  "workspace.symbol_search",
  "workspace.lsp",
  "workspace.web_fetch",
  "workspace.web_search",
]);

const EXECUTION_TOOLS = Object.freeze([
  ...READ_TOOLS,
  "workspace.run_shell",
  "workspace.job_start",
  "workspace.job_list",
  "workspace.job_read",
  "workspace.job_wait",
  "workspace.job_kill",
]);

export const DEFAULT_COLLABORATION_ROSTER_V1 = createCollaborationRosterV1(
  COLLABORATION_ROLES_V1.map((role) => ({
    id: role,
    name: role,
    role,
    description: ROLE_PROMPTS_V1[role],
    prompt: ROLE_PROMPTS_V1[role],
    outputFormat:
      role === "verifier"
        ? "Report each verification command, exit code, timeout state, and end with VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL."
        : "Return a concise evidence-based summary.",
    capabilities:
      role === "investigator"
        ? ["investigation"]
        : role === "reviewer"
          ? ["review"]
          : ["testing"],
    tools: role === "verifier" ? EXECUTION_TOOLS : READ_TOOLS,
    effect: role === "verifier" ? "execute" : "inspect",
    canSpawn: false,
    maxSteps: role === "verifier" ? 72 : 56,
  })),
);

export function createCollaborationRosterV1(
  input: readonly CollaborationAgentSpecInputV1[],
): CollaborationRosterV1 {
  const agents = input.map(freezeAgentSpec);
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) {
      throw new Error(`Duplicate collaboration agent id: ${agent.id}`);
    }
    ids.add(agent.id);
  }
  agents.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    schemaVersion: COLLABORATION_ROSTER_VERSION_V1,
    rosterHash: hash(JSON.stringify(agents)),
    agents: Object.freeze(agents),
  });
}

export function resolveCollaborationAgentV1(
  roster: CollaborationRosterV1,
  id: string,
): CollaborationAgentSpecV1 | undefined {
  return roster.agents.find((agent) => agent.id === id);
}

export function selectCollaborationAgentV1(
  roster: CollaborationRosterV1,
  input: Readonly<{ agentId?: unknown; role?: unknown }>,
): CollaborationAgentSpecV1 {
  const requestedId =
    typeof input.agentId === "string" && input.agentId.trim()
      ? input.agentId.trim()
      : isCollaborationRoleV1(input.role)
        ? collaborationAgentIdV1(input.role)
        : collaborationAgentIdV1(DEFAULT_COLLABORATION_ROLE_V1);
  const agent = resolveCollaborationAgentV1(roster, requestedId);
  if (!agent) throw new Error(`Unknown collaboration agent: ${requestedId}`);
  return agent;
}

export function resolveCollaborationAgentForCapabilityV1(
  roster: CollaborationRosterV1,
  capability: CollaborationCapabilityV1,
  agentId: unknown,
): CollaborationAgentSpecV1 {
  if (typeof agentId !== "string" || !agentId.trim()) {
    throw new Error(
      "Collaboration agent id is required; agent selection belongs to the main Agent",
    );
  }
  const selected = resolveCollaborationAgentV1(roster, agentId.trim());
  if (!selected) {
    throw new Error(`Unknown collaboration agent: ${agentId.trim()}`);
  }
  if (!selected.capabilities.includes(capability)) {
    throw new Error(
      `Collaboration agent ${selected.id} does not provide ${capability}`,
    );
  }
  return selected;
}

export function collaborationAgentSpecHashV1(
  agent: CollaborationAgentSpecV1,
): string {
  return hash(JSON.stringify(freezeAgentSpec(agent)));
}

export function collaborationAgentEffectV1(
  agent: Pick<CollaborationAgentSpecV1, "effect">,
): CollaborationEffectProfileV1 {
  return agent.effect;
}

export function parseCollaborationAgentSpecV1(
  input: unknown,
): CollaborationAgentSpecV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Collaboration AgentSpec is missing");
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort().join("\0");
  const legacyKeys =
    "canSpawn\0capabilities\0childPolicy\0description\0id\0maxSteps\0name\0outputFormat\0prompt\0role\0tools";
  const currentKeys =
    "canSpawn\0capabilities\0childPolicy\0description\0effect\0id\0maxSteps\0name\0outputFormat\0prompt\0role\0tools";
  if (keys !== legacyKeys && keys !== currentKeys) {
    throw new Error("Collaboration AgentSpec fields are invalid");
  }
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.role !== "string" ||
    typeof record.description !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.outputFormat !== "string" ||
    !Array.isArray(record.capabilities) ||
    record.capabilities.length === 0 ||
    !record.capabilities.every(isCollaborationCapabilityV1) ||
    (record.tools !== "inherit" &&
      (!Array.isArray(record.tools) ||
        !record.tools.every((tool) => typeof tool === "string"))) ||
    (record.childPolicy !== "read_only" &&
      record.childPolicy !== "read_write") ||
    (record.effect !== undefined &&
      !isCollaborationEffectProfileV1(record.effect)) ||
    typeof record.canSpawn !== "boolean" ||
    typeof record.maxSteps !== "number"
  ) {
    throw new Error("Collaboration AgentSpec fields are invalid");
  }
  return freezeAgentSpec({
    id: record.id,
    name: record.name,
    role: record.role,
    description: record.description,
    prompt: record.prompt,
    outputFormat: record.outputFormat,
    capabilities: record.capabilities as readonly CollaborationCapabilityV1[],
    tools: record.tools as "inherit" | readonly string[],
    ...(record.effect === undefined
      ? {}
      : { effect: record.effect as CollaborationEffectProfileV1 }),
    childPolicy: record.childPolicy,
    canSpawn: record.canSpawn,
    maxSteps: record.maxSteps,
  });
}

export function isCollaborationRoleV1(
  value: unknown,
): value is CollaborationRoleV1 {
  return COLLABORATION_ROLES_V1.some((role) => role === value);
}

export function isCollaborationCapabilityV1(
  value: unknown,
): value is CollaborationCapabilityV1 {
  return COLLABORATION_CAPABILITIES_V1.some(
    (capability) => capability === value,
  );
}

export function isCollaborationEffectProfileV1(
  value: unknown,
): value is CollaborationEffectProfileV1 {
  return COLLABORATION_EFFECT_PROFILES_V1.some((effect) => effect === value);
}

export function collaborationRolePromptV1(role: CollaborationRoleV1): string {
  return ROLE_PROMPTS_V1[role];
}

export function collaborationAgentIdV1(role: CollaborationRoleV1): string {
  return role;
}

function freezeAgentSpec(
  input: CollaborationAgentSpecInputV1,
): CollaborationAgentSpecV1 {
  const effect = resolveEffectProfile(input);
  const childPolicy: CollaborationChildPolicyV1 =
    effect === "mutate" ? "read_write" : "read_only";
  if (
    !input ||
    typeof input !== "object" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.id) ||
    !input.name.trim() ||
    !input.role.trim() ||
    !input.description.trim() ||
    !input.prompt.trim() ||
    !input.outputFormat.trim() ||
    !Array.isArray(input.capabilities) ||
    input.capabilities.length === 0 ||
    !input.capabilities.every(isCollaborationCapabilityV1) ||
    typeof input.canSpawn !== "boolean" ||
    !Number.isSafeInteger(input.maxSteps) ||
    input.maxSteps < 1 ||
    input.maxSteps > 200
  ) {
    throw new Error("Collaboration AgentSpec is invalid");
  }
  const tools =
    input.tools === "inherit"
      ? "inherit"
      : Object.freeze(
          [...new Set(input.tools.map((tool) => tool.trim()))]
            .filter(Boolean)
            .sort(),
        );
  const capabilities = Object.freeze([...new Set(input.capabilities)].sort());
  return Object.freeze({
    id: input.id,
    name: input.name.trim(),
    role: input.role.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    outputFormat: input.outputFormat.trim(),
    capabilities,
    tools,
    effect,
    childPolicy,
    canSpawn: input.canSpawn,
    maxSteps: input.maxSteps,
  });
}

function resolveEffectProfile(
  input: CollaborationAgentSpecInputV1,
): CollaborationEffectProfileV1 {
  if (input.effect !== undefined) {
    if (!isCollaborationEffectProfileV1(input.effect)) {
      throw new Error("Collaboration AgentSpec effect is invalid");
    }
    const compatiblePolicy =
      input.effect === "mutate" ? "read_write" : "read_only";
    if (
      input.childPolicy !== undefined &&
      input.childPolicy !== compatiblePolicy
    ) {
      throw new Error(
        "Collaboration AgentSpec effect conflicts with childPolicy",
      );
    }
    return input.effect;
  }
  if (input.childPolicy === "read_write") return "mutate";
  if (input.childPolicy === "read_only") return "inspect";
  throw new Error("Collaboration AgentSpec requires effect or childPolicy");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
