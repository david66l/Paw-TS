import type { ModelRuntimeProfile } from "@paw/models";

export type SweCompareQualification =
  | "static_qualified"
  | "eligible"
  | "infra_excluded";

export interface SweCompareInstanceManifest {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly failToPassCount: number;
  readonly passToPassCount: number;
  readonly problemStatementSha256: string;
  readonly goalSha256: string;
  readonly localHistoryHits: readonly string[];
  readonly qualification: SweCompareQualification;
  readonly preflight?: {
    readonly checkedAt: string;
    readonly runId: string;
    readonly source: "swebench_harness" | "error";
    readonly baselineResolved: boolean;
    readonly completed: boolean;
    readonly emptyPatch: boolean;
    readonly harnessError: boolean;
    readonly detail?: string;
    readonly error?: string;
  };
}

export interface SweCompareManifest {
  readonly schemaVersion: 1;
  readonly protocol: "paw-vs-claude-public-swe" | "paw-only-seen-development";
  readonly createdAt: string;
  readonly dataset: {
    readonly name: "princeton-nlp/SWE-bench_Lite";
    readonly split: "test";
    readonly localPath: string;
    readonly rowCount: number;
    readonly sha256: string;
  };
  readonly selection: {
    readonly ruleVersion:
      | "formal-dev-v1"
      | "paw-seen-dev-v1"
      | "paw-fresh-dev-v2"
      | "paw-fresh-qualification-v3";
    readonly purpose:
      | "frozen_paired_dev_diagnostic_not_headline_score"
      | "paw_only_seen_architecture_diagnostic_not_holdout_or_headline_score";
    readonly ids: readonly string[];
    readonly excludedSeenIds: readonly string[];
  };
  readonly sourceTree: {
    readonly gitCommit: string;
    readonly gitDirty: boolean;
  };
  readonly environment: {
    readonly platform: NodeJS.Platform;
    readonly dockerServerVersion?: string;
  };
  readonly budget: {
    /** Paw internal safety cap; Claude Code CLI has no equivalent public flag. */
    readonly pawMaxSteps: number;
    /** Shared wall-clock cap used by both product runners. */
    readonly sharedTimeoutMs: number;
    readonly codingPhaseBudget: false;
  };
  readonly runners: {
    readonly paw: {
      readonly memory: "off";
      /** Legacy manifests omitted this and are interpreted as external. */
      readonly verificationAuthority?: "local" | "external";
      /** Host is legacy; instance_image is required before v3 may freeze. */
      readonly verificationEnvironment?: "host" | "instance_image";
      readonly runtimeProfile: ModelRuntimeProfile;
    };
    readonly claudeCode: {
      readonly version: string;
      readonly mode: "bare";
      readonly model: "deepseek-v4-flash[1m]";
      readonly effort: "max";
      readonly autocompact: "1m";
      readonly sessionPersistence: false;
    };
  };
  readonly instances: readonly SweCompareInstanceManifest[];
}
