import {
  type AgentSpec,
  DEFAULT_AGENT_SEEDS,
  createInputToMarkdown,
  loadAgentRegistryReadonly,
  parseAgentMarkdown,
  validateAgentSpec,
} from "@paw/agent";
import {
  type CollaborationAgentSpecV1,
  type CollaborationCapabilityV1,
  type CollaborationRosterV1,
  DEFAULT_COLLABORATION_ROSTER_V1,
  createCollaborationRosterV1,
  isCollaborationCapabilityV1,
} from "@paw/collaboration";

/** Composition-boundary adapter. It reuses AgentSpec data, never the old loop. */
export function loadPawNextCollaborationRosterV1(
  workspaceRoot: string,
): CollaborationRosterV1 {
  const byId = new Map<string, CollaborationAgentSpecV1>(
    DEFAULT_COLLABORATION_ROSTER_V1.agents.map((agent) => [agent.id, agent]),
  );
  for (const seed of DEFAULT_AGENT_SEEDS) {
    const spec = parseAgentMarkdown(createInputToMarkdown(seed), seed.id);
    if (spec?.kind === "worker") byId.set(spec.id, adaptAgentSpec(spec));
  }
  for (const spec of loadAgentRegistryReadonly(workspaceRoot).list()) {
    if (spec.kind === "worker") byId.set(spec.id, adaptAgentSpec(spec));
  }
  return createCollaborationRosterV1([...byId.values()]);
}

function adaptAgentSpec(spec: AgentSpec): CollaborationAgentSpecV1 {
  const validation = validateAgentSpec(spec);
  if (!validation.ok) {
    throw new Error(
      `Invalid AgentSpec ${spec.id}: ${validation.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  const capabilities = inferCapabilities(spec);
  const tools = spec.tools === "inherit" ? [] : spec.tools;
  const mayMutate =
    spec.childPolicy === "read_write" &&
    (spec.tools === "inherit" ||
      tools.some((tool) =>
        [
          "workspace.write_file",
          "workspace.edit_file",
          "workspace.apply_patch",
        ].includes(tool),
      ));
  const executesTests =
    capabilities.includes("testing") &&
    (spec.tools === "inherit" || tools.includes("workspace.run_shell"));
  const effect = mayMutate
    ? ("mutate" as const)
    : executesTests
      ? ("execute" as const)
      : ("inspect" as const);
  return {
    id: spec.id,
    name: spec.name,
    role: spec.role,
    description: spec.description ?? spec.role,
    prompt: spec.prompt,
    outputFormat: spec.outputFormat,
    capabilities,
    tools: spec.tools,
    effect,
    childPolicy: effect === "mutate" ? "read_write" : "read_only",
    canSpawn: false,
    maxSteps: spec.maxSteps,
  };
}

function inferCapabilities(
  spec: AgentSpec,
): readonly CollaborationCapabilityV1[] {
  if (spec.capabilities?.length) {
    const invalid = spec.capabilities.filter(
      (capability) => !isCollaborationCapabilityV1(capability),
    );
    if (invalid.length > 0) {
      throw new Error(
        `AgentSpec ${spec.id} has unsupported capabilities: ${invalid.join(", ")}`,
      );
    }
    return spec.capabilities as readonly CollaborationCapabilityV1[];
  }
  const text =
    `${spec.id} ${spec.role} ${spec.description ?? ""}`.toLowerCase();
  const capabilities = new Set<CollaborationCapabilityV1>();
  if (/investigat|research|调研|调查|分析/.test(text)) {
    capabilities.add("investigation");
  }
  if (/implement|coding|代码实现|编码/.test(text)) {
    capabilities.add("implementation");
  }
  if (/test|qa|验收|测试/.test(text)) capabilities.add("testing");
  if (/review|审查|评审/.test(text)) capabilities.add("review");
  if (/document|docs|文档/.test(text)) capabilities.add("documentation");
  if (/integrat|release|交付|集成/.test(text)) capabilities.add("integration");

  const tools = spec.tools === "inherit" ? [] : spec.tools;
  const mayWrite =
    spec.childPolicy === "read_write" &&
    (spec.tools === "inherit" ||
      tools.some((tool) =>
        [
          "workspace.write_file",
          "workspace.edit_file",
          "workspace.apply_patch",
        ].includes(tool),
      ));
  if (mayWrite && capabilities.size === 0) {
    capabilities.add("implementation");
  }
  if (mayWrite && tools.includes("workspace.run_shell")) {
    capabilities.add("integration");
  }
  if (capabilities.size === 0) capabilities.add("investigation");
  return [...capabilities];
}
