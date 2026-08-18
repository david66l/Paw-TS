import { CORE_MODEL_ACTIONS } from "@paw/harness";
import type { ToolDefinition } from "@paw/models";

export const CAPABILITY_SET_SCHEMA_V1 = "paw.capability-set.v1" as const;

export interface CapabilitySetV1 {
  readonly schemaVersion: typeof CAPABILITY_SET_SCHEMA_V1;
  /** Provider tool schema visible to the model. */
  readonly modelToolDefinitions: readonly ToolDefinition[];
  /** Original MCP names represented by modelToolDefinitions. */
  readonly modelToolNames: readonly string[];
  /** The only tool names accepted from model-originated actions. */
  readonly executableToolNames: readonly string[];
  /** Registered capabilities reserved for trusted host/internal callers. */
  readonly internalToolNames: readonly string[];
  /** Agent control actions; never sent as MCP tool definitions. */
  readonly modelActions: readonly string[];
  /** Original and provider-sanitized names accepted by the action parser. */
  readonly knownToolNames: ReadonlySet<string>;
}

export function resolveCapabilitySetV1(input: {
  readonly definitions: readonly ToolDefinition[];
  readonly toolNameMap: ReadonlyMap<string, string>;
  /** null = explicitly expose all; arrays are exact deployment policy. */
  readonly configuredTools: readonly string[] | null;
}): CapabilitySetV1 {
  const entries = input.definitions.map((definition) => ({
    definition,
    sanitizedName: definition.function.name,
    originalName:
      input.toolNameMap.get(definition.function.name) ??
      definition.function.name,
  }));
  const available = new Set(entries.map((entry) => entry.originalName));
  const requested =
    input.configuredTools === null ? available : new Set(input.configuredTools);
  const selected = new Set(
    [...requested].filter((toolName) => available.has(toolName)),
  );
  const modelEntries = entries.filter((entry) =>
    selected.has(entry.originalName),
  );
  const modelToolNames = Object.freeze(
    modelEntries.map((entry) => entry.originalName),
  );
  const knownToolNames = new Set<string>();
  for (const entry of modelEntries) {
    knownToolNames.add(entry.originalName);
    knownToolNames.add(entry.sanitizedName);
  }

  return Object.freeze({
    schemaVersion: CAPABILITY_SET_SCHEMA_V1,
    modelToolDefinitions: Object.freeze(
      modelEntries.map((entry) => entry.definition),
    ),
    modelToolNames,
    executableToolNames: modelToolNames,
    internalToolNames: Object.freeze(
      entries
        .filter((entry) => !selected.has(entry.originalName))
        .map((entry) => entry.originalName),
    ),
    modelActions: Object.freeze([...CORE_MODEL_ACTIONS]),
    knownToolNames,
  });
}
