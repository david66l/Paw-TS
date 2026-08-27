import type {
  MemoryEvidenceAuthorityV2,
  MemoryEvidenceNotebookHitV1,
} from "./evidence-first.js";

export const PAW_MEMORY_STATE_REDUCER_VERSION_V1 =
  "paw.memory-state-reducer.v1:bitemporal-authority-aware" as const;

export type MemoryStateValueQualifierV1 =
  | "exact"
  | "approximate"
  | "range"
  | "lower_bound"
  | "upper_bound"
  | "unspecified";
export type MemoryStateEpistemicStatusV1 =
  | "asserted"
  | "uncertain"
  | "hypothetical";
export type MemoryStateKindV1 = "observed" | "goal" | "plan" | "forecast";

export interface MemoryStateObservationV1 extends MemoryEvidenceNotebookHitV1 {
  readonly stateKey: string;
  readonly unit?: string;
  readonly eventTime?: string;
  readonly episodeOrder?: number;
  readonly turnOrder?: number;
  readonly valueQualifier: MemoryStateValueQualifierV1;
  readonly epistemicStatus: MemoryStateEpistemicStatusV1;
  readonly stateKind: MemoryStateKindV1;
}

export interface MemoryStateResolutionV1 {
  readonly reducerVersion: typeof PAW_MEMORY_STATE_REDUCER_VERSION_V1;
  readonly current: readonly MemoryStateObservationV1[];
  readonly history: readonly MemoryStateObservationV1[];
  readonly ambiguous: readonly MemoryStateObservationV1[];
}

export function inferMemoryStateSemanticsV1(content: string): Readonly<{
  valueQualifier: MemoryStateValueQualifierV1;
  epistemicStatus: MemoryStateEpistemicStatusV1;
  stateKind: MemoryStateKindV1;
}> {
  const value = content.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 8_192) {
    throw namedError("MemoryStateObservationContentInvalid");
  }
  const valueQualifier: MemoryStateValueQualifierV1 =
    /\b(?:between|from)\b.{0,80}\b(?:and|to)\b|\d\s*[-–]\s*\d/iu.test(value)
      ? "range"
      : /\b(?:at\s+least|no\s+less\s+than|more\s+than|over)\b|(?:至少|不少于|超过)/iu.test(
            value,
          )
        ? "lower_bound"
        : /\b(?:at\s+most|no\s+more\s+than|less\s+than|under)\b|(?:至多|不超过|少于)/iu.test(
              value,
            )
          ? "upper_bound"
          : /\b(?:about|around|approximately|approx\.?|almost|close\s+to|nearly|roughly|circa)\b|(?:大约|约有|接近|将近|差不多|左右)/iu.test(
                value,
              )
            ? "approximate"
            : /\d/iu.test(value)
              ? "exact"
              : "unspecified";
  const epistemicStatus: MemoryStateEpistemicStatusV1 =
    /\b(?:if|would|could\s+be|suppose|assuming|hypothetically)\b|(?:如果|假如|假设)/iu.test(
      value,
    )
      ? "hypothetical"
      : /\b(?:i\s+think|maybe|perhaps|probably|possibly|seems?|appears?)\b|(?:我想|可能|也许|似乎)/iu.test(
            value,
          )
        ? "uncertain"
        : "asserted";
  const stateKind: MemoryStateKindV1 =
    /\b(?:goal|target|aim|hope|want\s+to)\b|(?:目标|希望|想要)/iu.test(value)
      ? "goal"
      : /\b(?:plan(?:ning|ned)?\s+to|intend\s+to|going\s+to|scheduled\s+to)\b|(?:计划|打算|准备)/iu.test(
            value,
          )
        ? "plan"
        : /\b(?:forecast|predict|expected\s+to|will\s+probably)\b|(?:预测|预计)/iu.test(
              value,
            )
          ? "forecast"
          : "observed";
  return Object.freeze({ valueQualifier, epistemicStatus, stateKind });
}

/**
 * Reduces observations independently per state key and unit. In current-state
 * mode, a later asserted/uncertain observation wins even when it is less
 * precise; goals, plans, forecasts, hypotheticals and context-only assistant
 * text cannot overwrite an observed user state.
 */
export function resolveMemoryStateObservationsV1(input: {
  readonly observations: readonly MemoryStateObservationV1[];
  readonly mode: "latest" | "as_of" | "history";
  readonly asOf?: string;
  readonly allowContextOnly?: boolean;
}): MemoryStateResolutionV1 {
  const asOf = input.asOf?.trim();
  if (input.mode === "as_of" && !asOf) {
    throw namedError("MemoryStateReducerAsOfRequired");
  }
  const groups = new Map<string, MemoryStateObservationV1[]>();
  for (const observation of input.observations) {
    assertObservation(observation);
    if (observation.authority === "context_only" && !input.allowContextOnly) {
      continue;
    }
    const effectiveTime = observation.eventTime ?? observation.observedAt;
    if (
      input.mode === "as_of" &&
      effectiveTime &&
      asOf !== undefined &&
      effectiveTime > asOf
    ) {
      continue;
    }
    const key = `${observation.stateKey.trim().toLocaleLowerCase("en-US")}\0${
      observation.unit?.trim().toLocaleLowerCase("en-US") ?? ""
    }`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const current: MemoryStateObservationV1[] = [];
  const history: MemoryStateObservationV1[] = [];
  const ambiguous: MemoryStateObservationV1[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(compareStateObservationV1);
    if (input.mode === "history") {
      history.push(...ordered);
      continue;
    }
    const eligible = ordered.filter(
      (item) =>
        item.stateKind === "observed" &&
        item.epistemicStatus !== "hypothetical",
    );
    const winner = eligible[0];
    if (!winner) {
      history.push(...ordered);
      continue;
    }
    current.push(winner);
    const tied = eligible.filter(
      (item) =>
        item !== winner &&
        compareStatePositionV1(item, winner) === 0 &&
        item.content !== winner.content,
    );
    ambiguous.push(...tied);
    history.push(
      ...ordered.filter((item) => item !== winner && !tied.includes(item)),
    );
  }
  current.sort(compareStateObservationV1);
  history.sort(compareStateObservationV1);
  ambiguous.sort(compareStateObservationV1);
  return Object.freeze({
    reducerVersion: PAW_MEMORY_STATE_REDUCER_VERSION_V1,
    current: Object.freeze(current),
    history: Object.freeze(history),
    ambiguous: Object.freeze(ambiguous),
  });
}

export function compareStateObservationV1(
  left: MemoryStateObservationV1,
  right: MemoryStateObservationV1,
): number {
  return (
    compareStatePositionV1(right, left) ||
    authorityRank(right.authority) - authorityRank(left.authority) ||
    left.evidenceRef.localeCompare(right.evidenceRef)
  );
}

function compareStatePositionV1(
  left: MemoryStateObservationV1,
  right: MemoryStateObservationV1,
): number {
  const event = (left.eventTime ?? left.observedAt ?? "").localeCompare(
    right.eventTime ?? right.observedAt ?? "",
  );
  if (event !== 0) return event;
  const observed = (left.observedAt ?? "").localeCompare(
    right.observedAt ?? "",
  );
  if (observed !== 0) return observed;
  return (
    (left.episodeOrder ?? Number.MIN_SAFE_INTEGER) -
      (right.episodeOrder ?? Number.MIN_SAFE_INTEGER) ||
    (left.turnOrder ?? left.observedOrder ?? Number.MIN_SAFE_INTEGER) -
      (right.turnOrder ?? right.observedOrder ?? Number.MIN_SAFE_INTEGER)
  );
}

function authorityRank(authority: MemoryEvidenceAuthorityV2): number {
  if (authority === "user_asserted") return 5;
  if (authority === "user_confirmed_dialogue") return 4;
  if (authority === "derived") return 3;
  if (authority === "mixed") return 2;
  return 1;
}

function assertObservation(observation: MemoryStateObservationV1): void {
  if (
    !observation.stateKey.trim() ||
    !observation.evidenceRef.trim() ||
    !observation.sourceId.trim() ||
    !observation.content.trim() ||
    [observation.episodeOrder, observation.turnOrder, observation.observedOrder]
      .filter((value): value is number => value !== undefined)
      .some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw namedError("MemoryStateObservationInvalid");
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
