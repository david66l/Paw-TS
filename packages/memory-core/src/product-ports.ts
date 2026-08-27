/**
 * Structural ports required by the evidence-first product adapter.
 *
 * They deliberately describe capabilities, not Paw implementations. A host
 * can satisfy these interfaces with PostgreSQL, SQLite, files, or a remote
 * service without pulling runtime packages into the memory core.
 */
export interface MemoryProductScopeV1 {
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
}

export interface MemoryProductProfileV1 {
  readonly scope: MemoryProductScopeV1;
  readonly maxCards: number;
  readonly maxInjectedTokens: number;
}

export interface MemoryProductCardV1 {
  readonly id: string;
  readonly sources: readonly Readonly<{ ref: string }>[];
  readonly validFrom?: string;
}

export interface MemoryProductProviderV1 {
  readonly providerVersion: string;
  retrieve(
    query: Readonly<{
      queryId: string;
      trigger: "task_start" | "work_segment_start";
      text: string;
      inputId: string;
      inputContentHash: string;
      scope: MemoryProductScopeV1;
      maxCards: number;
      maxInjectedTokens: number;
    }>,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      status: "completed" | "degraded";
      cards: readonly MemoryProductCardV1[];
    }>
  >;
}

export interface MemoryProductRawEvidenceV1 {
  readonly evidenceRef: string;
  readonly sourceKind:
    | "user_input"
    | "assistant_output"
    | "tool_observation"
    | "verification"
    | "outcome"
    | "source_document";
  readonly sourceSeq: number;
  readonly authority:
    | "user_asserted"
    | "user_confirmed_dialogue"
    | "context_only";
  readonly hitContent: string;
  readonly createdAt: string;
}

export interface MemoryProductArchiveV1 {
  readonly scope: MemoryProductScopeV1;
  search?(
    query: Readonly<{
      query: string;
      maxSpans: number;
      maxChars: number;
    }>,
    signal: AbortSignal,
  ): Promise<readonly MemoryProductRawEvidenceV1[]>;
}
