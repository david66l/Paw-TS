import type { MemoryWriterModelV1 } from "./model-port.js";

export const PAW_MEMORY_QUERY_EXPANDER_VERSION_V1 =
  "paw.memory-query-expander.v1:bounded-operands-and-aliases" as const;

export interface MemoryQueryExpansionPlanV1 {
  readonly plannerVersion: typeof PAW_MEMORY_QUERY_EXPANDER_VERSION_V1;
  readonly searches: readonly string[];
}

export interface MemoryQueryExpanderV1 {
  readonly plannerVersion: typeof PAW_MEMORY_QUERY_EXPANDER_VERSION_V1;
  expand(
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryQueryExpansionPlanV1>;
}

/** Opens the optional model planner only for questions likely to need several sources. */
export function shouldExpandMemoryQueryV1(query: string): boolean {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) return false;
  return /\b(?:compared\s+to|difference\s+between|how\s+(?:many|much\s+(?:more|less))|both|each|respectively|over\s+time|changed?)\b|\b(?:total|combined|altogether)\b/iu.test(
    value,
  );
}

export function createJsonMemoryQueryExpanderV1(input: {
  readonly model: MemoryWriterModelV1;
}): MemoryQueryExpanderV1 {
  if (!input.model || typeof input.model.complete !== "function") {
    throw namedError("MemoryQueryExpanderModelInvalid");
  }
  return Object.freeze({
    plannerVersion: PAW_MEMORY_QUERY_EXPANDER_VERSION_V1,
    async expand(query: string, signal: AbortSignal) {
      const request = buildMemoryQueryExpansionRequestV1(query);
      if (signal.aborted) throw abortError();
      const result = await input.model.complete(request, { signal });
      if (signal.aborted || result.status === "cancelled") throw abortError();
      if (result.status !== "completed") {
        throw namedError(stableName(result.errorCode));
      }
      return parseMemoryQueryExpansionV1(result.text, query);
    },
  });
}

export function buildMemoryQueryExpansionRequestV1(
  query: string,
): Readonly<{ system: string; user: string }> {
  const bounded = boundedQuery(query);
  return Object.freeze({
    system: [
      "You plan evidence retrieval, not the answer.",
      "Return up to four short independent searches so every comparison or aggregation operand can be recalled.",
      "For each named place, organization, product, or person, include common alternate or contained names that may appear in past notes even when the question uses a broader name. For example, a state query may need its islands or cities, and a company query may need a product name.",
      "Aliases are retrieval-only hints, never memory facts. Never invent a user event, preference, amount, date, or answer.",
      'Return exactly one JSON object: {"searches":["short search", "short search"]}.',
    ].join("\n"),
    user: JSON.stringify({
      schemaVersion: "paw.memory-query-expansion-input.v1",
      query: bounded,
      maxSearches: 4,
      maxSearchChars: 256,
    }),
  });
}

export function parseMemoryQueryExpansionV1(
  text: string,
  query: string,
): MemoryQueryExpansionPlanV1 {
  boundedQuery(query);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw namedError("MemoryQueryExpansionJsonInvalid");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "searches")
  ) {
    throw namedError("MemoryQueryExpansionShapeInvalid");
  }
  if (!Array.isArray(parsed.searches) || parsed.searches.length > 4) {
    throw namedError("MemoryQueryExpansionSearchesInvalid");
  }
  const searches: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed.searches) {
    if (typeof item !== "string") {
      throw namedError("MemoryQueryExpansionSearchInvalid");
    }
    const value = item.trim().replace(/\s+/gu, " ");
    if (!value || value.length > 256) {
      throw namedError("MemoryQueryExpansionSearchInvalid");
    }
    const normalized = value.toLocaleLowerCase("en-US");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    searches.push(value);
  }
  return Object.freeze({
    plannerVersion: PAW_MEMORY_QUERY_EXPANDER_VERSION_V1,
    searches: Object.freeze(searches),
  });
}

function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryQueryExpansionQueryInvalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value)
    ? value
    : "MemoryQueryExpanderFailed";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function abortError(): Error {
  return namedError("AbortError");
}
