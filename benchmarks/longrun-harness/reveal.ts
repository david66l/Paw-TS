/**
 * SlopCodeBench-style successive requirement reveal.
 *
 * The fixture feature list is the full contract. In iterative mode the
 * agent-visible feature_list.json and the canonical ledger contain only the
 * revealed prefix; later requirements wait in a harness-private hidden store.
 * The next batch is revealed only when every revealed feature passes full
 * E2E with no regression; a regression flips the feature back to open and
 * becomes the next work item instead of revealing more work.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type FeatureItem, saveHarnessLedger } from "./artifacts.ts";

const HIDDEN_SCHEMA = "paw.longrun-hidden-features";
const HIDDEN_VERSION = 1;

interface HiddenEnvelope {
  readonly schema: typeof HIDDEN_SCHEMA;
  readonly version: typeof HIDDEN_VERSION;
  readonly updatedAt: string;
  readonly features: readonly FeatureItem[];
}

export function hiddenFeaturesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".paw", "longrun-hidden-features.json");
}

export function saveHiddenFeatures(
  workspaceRoot: string,
  features: readonly FeatureItem[],
): void {
  const target = hiddenFeaturesPath(workspaceRoot);
  mkdirSync(path.dirname(target), { recursive: true });
  const envelope: HiddenEnvelope = {
    schema: HIDDEN_SCHEMA,
    version: HIDDEN_VERSION,
    updatedAt: new Date().toISOString(),
    features,
  };
  writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

export function loadHiddenFeatures(workspaceRoot: string): FeatureItem[] {
  const target = hiddenFeaturesPath(workspaceRoot);
  if (!existsSync(target)) return [];
  const parsed = JSON.parse(
    readFileSync(target, "utf8"),
  ) as Partial<HiddenEnvelope>;
  if (parsed.schema !== HIDDEN_SCHEMA || parsed.version !== HIDDEN_VERSION) {
    throw new Error("hidden features envelope schema/version unsupported");
  }
  if (!Array.isArray(parsed.features)) {
    throw new Error("hidden features must be an array");
  }
  return parsed.features as FeatureItem[];
}

export function takeNextBatch(
  hidden: readonly FeatureItem[],
  batchSize: number,
): { readonly batch: FeatureItem[]; readonly rest: FeatureItem[] } {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("reveal batch size must be a positive integer");
  }
  return {
    batch: hidden.slice(0, batchSize),
    rest: hidden.slice(batchSize),
  };
}

/**
 * Append the next batch to the canonical ledger (revealing it to the agent
 * through the refreshed mirror) and persist the shortened hidden store.
 * Pure with respect to the inputs; disk effects are ledger + hidden store.
 */
export function revealBatch(
  workspaceRoot: string,
  canonical: readonly FeatureItem[],
  hidden: readonly FeatureItem[],
  batchSize: number,
): {
  readonly canonical: FeatureItem[];
  readonly hidden: FeatureItem[];
  readonly revealed: FeatureItem[];
} {
  const { batch, rest } = takeNextBatch(hidden, batchSize);
  if (batch.length === 0) {
    return { canonical: [...canonical], hidden: [...hidden], revealed: [] };
  }
  const nextCanonical = [...canonical, ...batch];
  saveHarnessLedger(workspaceRoot, nextCanonical);
  saveHiddenFeatures(workspaceRoot, rest);
  return { canonical: nextCanonical, hidden: rest, revealed: batch };
}

export interface RevealCheckpointRecord {
  /** 1-based index of the completed batch checkpoint. */
  readonly checkpointIndex: number;
  readonly revealedIds: readonly string[];
  readonly revealedTotal: number;
  readonly hiddenRemaining: number;
  /** Features that flipped from passing to failing at this checkpoint. */
  readonly regressions: readonly string[];
  readonly sessionsUsed: number;
  readonly elapsedMs: number;
}
