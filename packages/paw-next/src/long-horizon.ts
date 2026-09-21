import {
  type CollaborationRosterV1,
  createCollaborationToolPluginV1,
  parseCollaborationDelegationPlanV1,
} from "@paw/collaboration";
import type { SubAgentLauncher, SubAgentResult } from "@paw/harness";
import type { InputFactV1 } from "@paw/protocol";
import type { RuntimeToolPluginV1 } from "@paw/runtime";
import { fingerprintAuditFile } from "./environment-audit.js";
import { STAGE_GRAPH_POLICY_V1, STAGE_GRAPH_PROMPT, parseStageLinks } from "./stage-graph.js";

export const LONG_HORIZON_POLICY_V1 = "paw.long-horizon.v1" as const;
export const LONG_HORIZON_MAX_STAGES = 12;
export const LONG_HORIZON_MANAGER_PROMPT = `You are the Paw long-task Manager. Plan, delegate, inspect independent acceptance results, then decide the next stage. You cannot modify files or run commands yourself.
Use workspace_delegate for bounded stages with explicit scope and nonempty, concrete acceptance criteria. Select an agent from the tool's team brief. Every delegation starts a separate executor context; provide only the current contract and relevant verified evidence, not the whole conversation or raw execution trace. Scope describes focus, not additional filesystem permission.
Dependencies may advance only after independently verified results. Failed or unverified stages need a new repair delegation with its own call identity, or a clear blocked report. Do not call an executor's success statement verified. Ask the user when a requirement is missing. A changed user requirement overrides old plans and must be reflected in subsequent contracts.
At most ${LONG_HORIZON_MAX_STAGES} executor stages may start for one user task, including repairs. Plan within this budget; stop with remaining work when exhausted. Final completion is independently audited against the user's full task, not only your chosen stage criteria.`;

/** Same durable delegation transport, with a separate frozen manager tool identity. */
export function createLongHorizonCollaborationPlugin(
  roster: CollaborationRosterV1,
  stageGraph = false,
): RuntimeToolPluginV1 {
  const base = createCollaborationToolPluginV1({ roster });
  return {
    ...base,
    pluginVersion: stageGraph ? STAGE_GRAPH_POLICY_V1 : LONG_HORIZON_POLICY_V1,
    entries: base.entries.map((entry) => ({
      ...entry,
      definition: {
        ...entry.definition,
        function: {
          ...entry.definition.function,
          description: `${LONG_HORIZON_MANAGER_PROMPT}${stageGraph ? `\n${STAGE_GRAPH_PROMPT}` : ""}\n${entry.definition.function.description.slice(entry.definition.function.description.indexOf("Current Team Brief:"))}`,
          ...(stageGraph
            ? {
                parameters: {
                  ...entry.definition.function.parameters,
                  properties: {
                    ...(entry.definition.function.parameters.properties as Record<string, unknown>),
                    stage_links: {
                      type: "array",
                      maxItems: 12,
                      description:
                        "Dependencies and replacements referencing previous stage ledger refs.",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["task_id", "requires"],
                        properties: {
                          task_id: { type: "string", maxLength: 80 },
                          requires: {
                            type: "array",
                            maxItems: 12,
                            items: {
                              type: "string",
                              pattern: "^stage-[a-f0-9]{24}$",
                            },
                          },
                          replaces: {
                            type: "string",
                            pattern: "^stage-[a-f0-9]{24}$",
                          },
                        },
                      },
                    },
                  },
                },
              }
            : {}),
        },
      },
      validate(args) {
        const input = args as Record<string, unknown>;
        const { stage_links, ...baseArgs } = input ?? {};
        const checked = entry.validate(stageGraph ? baseArgs : args);
        if (!checked.ok) return checked;
        const plan = parseCollaborationDelegationPlanV1(checked.args.delegation_plan);
        if (plan.tasks.some((task) => !task.scope.length || !task.acceptance.length))
          return {
            ok: false,
            result: {
              ok: false,
              summary: "Long-task stages require explicit scope and nonempty acceptance criteria.",
              payload: { code: "E_SCHEMA_INVALID", executed: false },
            },
          };
        if (!stageGraph) return checked;
        try {
          const links = parseStageLinks(
            stage_links,
            plan.tasks.map((task) => task.id),
          );
          return {
            ...checked,
            args: Object.freeze({ ...checked.args, stage_links: links }),
          };
        } catch (error) {
          return {
            ok: false,
            result: {
              ok: false,
              summary: String(error),
              payload: { code: "E_SCHEMA_INVALID", executed: false },
            },
          };
        }
      },
      classify(args, root) {
        const classified = entry.classify(args, root);
        return {
          ...classified,
          concurrencyMode: "exclusive",
          resources: classified.resources.map((resource) => ({
            ...resource,
            access: "write",
          })),
        };
      },
    })),
  };
}

export function stageEvidenceIsCurrent(root: string, result: SubAgentResult): boolean {
  const audit = result.environmentAudit;
  if (result.status !== "completed" || audit?.status !== "verified" || !audit.inspected.length)
    return false;
  try {
    return audit.inspected.every(
      (file) => fingerprintAuditFile(root, file.path).hash === file.hash,
    );
  } catch {
    return false;
  }
}

/** Count durable admissions, including failed attempts; recovery of the same call spends no new slot. */
export function managerStageAdmissionAllowed(
  facts: readonly InputFactV1[],
  callId: string,
  planned: number,
): boolean {
  const feedback = new Set(
    facts.flatMap((f) =>
      f.type === "input.accepted" && f.callerId === "completion-review" ? [f.inputId] : [],
    ),
  );
  let boundary = -1;
  facts.forEach((f, index) => {
    if (f.type === "input.promoted" && f.delivery !== "steer" && !feedback.has(f.inputId))
      boundary = index;
  });
  const callIndex = facts.findIndex((f) => f.type === "tool.call_observed" && f.callId === callId);
  const starts = facts
    .map((fact, index) => ({ fact, index }))
    .filter(
      ({ fact, index }) =>
        index > boundary &&
        fact.type === "runtime.activity_started" &&
        fact.activityKind === "collaboration_child",
    );
  const other = starts.filter(({ fact: f, index }) => {
    if (f.type !== "runtime.activity_started") return false;
    const id = String((f.metadata as Record<string, unknown> | undefined)?.callId ?? "");
    return callIndex < 0 || index < callIndex || (id !== callId && !id.startsWith(`${callId}:`));
  });
  return other.length + planned <= LONG_HORIZON_MAX_STAGES;
}

export function createManagerStageLauncher(
  delegate: SubAgentLauncher,
  readFacts: () => Promise<readonly InputFactV1[]>,
): SubAgentLauncher {
  const launch: SubAgentLauncher["launch"] = async (goal, maxSteps, options) => {
    const plan = parseCollaborationDelegationPlanV1(options?.args?.delegation_plan);
    if (!managerStageAdmissionAllowed(await readFacts(), options?.agentId ?? "", plan.tasks.length))
      return {
        status: "failed",
        summary: `Long-task stage budget exhausted (${LONG_HORIZON_MAX_STAGES}); remaining work is unverified.`,
      };
    return delegate.launch(goal, maxSteps, options);
  };
  return {
    launch,
    launchStreaming: (options) => launch(options.goal, options.maxSteps, options),
  };
}
