import {
  type CollaborationAgentSpecV1,
  type CollaborationRoleV1,
  DEFAULT_COLLABORATION_ROLE_V1,
  DEFAULT_COLLABORATION_ROSTER_V1,
  collaborationRolePromptV1,
  resolveCollaborationAgentV1,
} from "./roster.js";

export const AGENT_SPEC_CHILD_RUNTIME_POLICY_VERSION_V1 =
  "paw.collaboration-child-runtime.v3:effect-profile-tools" as const;

export const READ_ONLY_CHILD_RUNTIME_POLICY_VERSION_V1 =
  AGENT_SPEC_CHILD_RUNTIME_POLICY_VERSION_V1;

export const AGENT_SPEC_CHILD_PERMISSION_POLICY_VERSION_V1 =
  "paw.collaboration-child-permissions.v3:effect-profile" as const;

export const READ_ONLY_CHILD_PERMISSION_POLICY_VERSION_V1 =
  AGENT_SPEC_CHILD_PERMISSION_POLICY_VERSION_V1;

export function readOnlyChildSystemPromptV1(role: CollaborationRoleV1): string {
  return `You are an independent read-only ${role} running in an isolated Paw Next V3 session.
${collaborationRolePromptV1(role)}
Answer only the assigned question. Inspect the smallest useful set of files, distinguish confirmed facts from hypotheses, and cite concrete paths or symbols in the final summary. You cannot edit files, run shell commands, dispatch another agent, or claim tests passed without visible verification evidence.`;
}

export function agentSpecChildSystemPromptV1(
  agent: CollaborationAgentSpecV1,
): string {
  const capability =
    agent.effect === "mutate"
      ? "You may modify workspace files and run approved shell tools exposed by your AgentSpec. Keep changes inside the assigned task and report every changed file and verification result."
      : agent.effect === "execute"
        ? "You may run approved shell and job tools to obtain direct verification evidence, but you cannot use file editing or patch tools. Report every command, exit code, timeout, and failure exactly."
        : "You cannot edit files or run shell commands.";
  return `You are ${agent.name}, an independent ${agent.role} Agent running in an isolated Paw Next V3 session.
${agent.prompt}
Answer only the assigned task. ${capability} You cannot dispatch another agent. Distinguish confirmed facts from hypotheses and never claim tests passed without visible verification evidence. A command starting successfully is not proof that it passed; use its exit code and timeout state.
Required output: ${agent.outputFormat}`;
}

export const READ_ONLY_CHILD_SYSTEM_PROMPT_V1 = readOnlyChildSystemPromptV1(
  DEFAULT_COLLABORATION_ROLE_V1,
);

export const DEFAULT_AGENT_SPEC_CHILD_SYSTEM_PROMPT_V1 =
  agentSpecChildSystemPromptV1(defaultAgentSpec());

function defaultAgentSpec(): CollaborationAgentSpecV1 {
  const agent = resolveCollaborationAgentV1(
    DEFAULT_COLLABORATION_ROSTER_V1,
    DEFAULT_COLLABORATION_ROLE_V1,
  );
  if (!agent) throw new Error("Default collaboration AgentSpec is missing");
  return agent;
}
