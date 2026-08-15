import type { ToolDefinition } from "@paw/models";

export const CAPABILITY_EXPOSURE_SCHEMA_V1 =
  "paw.capability-exposure.v1" as const;

export type CapabilityCategoryV1 =
  | "workspace_read"
  | "workspace_write"
  | "execution"
  | "verification"
  | "context"
  | "collaboration"
  | "external"
  | "unknown";

export interface CapabilityInventoryEntryV1 {
  readonly name: string;
  readonly description: string;
  readonly category: CapabilityCategoryV1;
  readonly core: boolean;
}

export interface CapabilityExposureSnapshotV1 {
  readonly schemaVersion: typeof CAPABILITY_EXPOSURE_SCHEMA_V1;
  readonly mode: "shadow";
  readonly fullToolCount: number;
  readonly fullToolTokens: number;
  readonly suggestedToolCount: number;
  readonly suggestedToolTokens: number;
  readonly estimatedSavingsTokens: number;
  readonly suggestedTools: readonly string[];
  readonly deferredTools: readonly string[];
}

export interface CapabilitySelectionObservationV1 {
  readonly schemaVersion: typeof CAPABILITY_EXPOSURE_SCHEMA_V1;
  readonly mode: "shadow";
  readonly turn: number;
  readonly actualTools: readonly string[];
  readonly suggestedTools: readonly string[];
  readonly outsideSuggestion: readonly string[];
  readonly outcome: "hit" | "fallback" | "no_tool";
  /** Shadow mode never changes the provider-visible definitions. */
  readonly exposedToolCount: number;
}

export interface CapabilityTaskPhaseFactsV1 {
  readonly mutationRevision?: number;
  readonly diffInspectedRevision?: number;
}

/** Add temporal tools without turning them into permanently exposed core. */
export function capabilityPhaseToolsV1(
  state: CapabilityTaskPhaseFactsV1,
): readonly string[] {
  const revision = state.mutationRevision ?? 0;
  if (revision === 0 || (state.diffInspectedRevision ?? 0) >= revision) {
    return Object.freeze(["workspace.git_status"]);
  }
  return Object.freeze([]);
}

const CORE_TOOLS = new Set([
  "workspace.read_file",
  "workspace.edit_file",
  "workspace.apply_patch",
  "workspace.glob",
  "workspace.grep",
  "workspace.list_dir",
  "workspace.run_shell",
  "workspace.job_start",
  "workspace.job_list",
  "workspace.job_read",
  "workspace.job_wait",
  "workspace.job_kill",
  "workspace.git_diff",
  "workspace.todo_write",
  "context.recall",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "tool",
  "use",
  "with",
  "workspace",
  "请",
  "一下",
  "这个",
  "可以",
  "需要",
]);

function originalName(
  definition: ToolDefinition,
  toolNameMap: ReadonlyMap<string, string>,
): string {
  return toolNameMap.get(definition.function.name) ?? definition.function.name;
}

function categoryForTool(name: string): CapabilityCategoryV1 {
  if (name.startsWith("mcp:") || name.includes("web_")) return "external";
  if (name.startsWith("memory.") || name === "context.recall") {
    return "context";
  }
  if (name.includes("agent") || name.includes("skill")) {
    return "collaboration";
  }
  if (name.includes("shell")) return "execution";
  if (
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("patch") ||
    name.includes("notebook")
  ) {
    return "workspace_write";
  }
  if (
    name.includes("git_diff") ||
    name.includes("lsp") ||
    name.includes("acceptance")
  ) {
    return "verification";
  }
  if (name.startsWith("workspace.")) return "workspace_read";
  return "unknown";
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.:/+-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function searchableName(name: string): string {
  return name.toLowerCase().replace(/[._:/-]+/g, " ");
}

function scoreEntry(entry: CapabilityInventoryEntryV1, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  const select = normalizedQuery.startsWith("select:")
    ? normalizedQuery.slice("select:".length).trim()
    : "";
  if (select && entry.name.toLowerCase() === select) return 10_000;
  if (entry.name.toLowerCase() === normalizedQuery) return 9_000;

  const name = searchableName(entry.name);
  const description = entry.description.toLowerCase();
  let score = 0;
  for (const term of tokenize(query)) {
    if (name.split(" ").includes(term)) score += 40;
    else if (name.includes(term)) score += 20;
    if (description.includes(term)) score += 6;
  }
  return score;
}

export function inventoryCapabilitiesV1(
  definitions: readonly ToolDefinition[],
  toolNameMap: ReadonlyMap<string, string>,
): readonly CapabilityInventoryEntryV1[] {
  return Object.freeze(
    definitions
      .map((definition) => {
        const name = originalName(definition, toolNameMap);
        return Object.freeze({
          name,
          description: definition.function.description ?? "",
          category: categoryForTool(name),
          core: CORE_TOOLS.has(name),
        });
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

export function searchCapabilitiesV1(
  inventory: readonly CapabilityInventoryEntryV1[],
  query: string,
  maxResults = 5,
): readonly CapabilityInventoryEntryV1[] {
  const boundedMax = Math.max(1, Math.min(20, Math.floor(maxResults)));
  return Object.freeze(
    inventory
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
      )
      .slice(0, boundedMax)
      .map((candidate) => candidate.entry),
  );
}

export class CapabilityExposureShadowV1 {
  readonly inventory: readonly CapabilityInventoryEntryV1[];
  private readonly definitionsByName: ReadonlyMap<string, ToolDefinition>;
  private readonly fullToolTokens: number;
  private readonly countTokens: (
    definitions: readonly ToolDefinition[],
  ) => number;

  constructor(input: {
    readonly definitions: readonly ToolDefinition[];
    readonly toolNameMap: ReadonlyMap<string, string>;
    readonly countTokens: (definitions: readonly ToolDefinition[]) => number;
  }) {
    this.inventory = inventoryCapabilitiesV1(
      input.definitions,
      input.toolNameMap,
    );
    this.definitionsByName = new Map(
      input.definitions.map((definition) => [
        originalName(definition, input.toolNameMap),
        definition,
      ]),
    );
    this.countTokens = input.countTokens;
    this.fullToolTokens = input.countTokens(input.definitions);
  }

  suggestedTools(
    query: string,
    phaseTools: readonly string[] = [],
  ): readonly string[] {
    const selected = new Set(
      this.inventory.filter((entry) => entry.core).map((entry) => entry.name),
    );
    for (const name of phaseTools) {
      if (this.definitionsByName.has(name)) selected.add(name);
    }
    for (const entry of searchCapabilitiesV1(this.inventory, query, 6)) {
      selected.add(entry.name);
    }
    return Object.freeze([...selected].sort());
  }

  snapshot(
    query: string,
    phaseTools: readonly string[] = [],
  ): CapabilityExposureSnapshotV1 {
    const suggestedTools = this.suggestedTools(query, phaseTools);
    const suggestedDefinitions = suggestedTools
      .map((name) => this.definitionsByName.get(name))
      .filter((definition): definition is ToolDefinition =>
        Boolean(definition),
      );
    const suggestedToolTokens = this.countTokens(suggestedDefinitions);
    const suggestedSet = new Set(suggestedTools);
    return Object.freeze({
      schemaVersion: CAPABILITY_EXPOSURE_SCHEMA_V1,
      mode: "shadow",
      fullToolCount: this.inventory.length,
      fullToolTokens: this.fullToolTokens,
      suggestedToolCount: suggestedTools.length,
      suggestedToolTokens,
      estimatedSavingsTokens: Math.max(
        0,
        this.fullToolTokens - suggestedToolTokens,
      ),
      suggestedTools,
      deferredTools: Object.freeze(
        this.inventory
          .map((entry) => entry.name)
          .filter((name) => !suggestedSet.has(name)),
      ),
    });
  }

  observe(
    turn: number,
    query: string,
    actualTools: readonly string[],
    phaseTools: readonly string[] = [],
  ): CapabilitySelectionObservationV1 {
    const suggestedTools = this.suggestedTools(query, phaseTools);
    const suggestedSet = new Set(suggestedTools);
    const uniqueActual = Object.freeze([...new Set(actualTools)].sort());
    const outsideSuggestion = Object.freeze(
      uniqueActual.filter((name) => !suggestedSet.has(name)),
    );
    return Object.freeze({
      schemaVersion: CAPABILITY_EXPOSURE_SCHEMA_V1,
      mode: "shadow",
      turn,
      actualTools: uniqueActual,
      suggestedTools,
      outsideSuggestion,
      outcome:
        uniqueActual.length === 0
          ? "no_tool"
          : outsideSuggestion.length === 0
            ? "hit"
            : "fallback",
      exposedToolCount: this.inventory.length,
    });
  }
}
