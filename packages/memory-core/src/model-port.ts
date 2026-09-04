/** Minimal model boundary shared by memory extraction and evidence planning. */
export interface MemoryWriterModelV1 {
  complete(
    request: Readonly<{ system: string; user: string }>,
    options: Readonly<{
      signal: AbortSignal;
      /** Optional, purpose-owned ceiling; callers must not share it globally. */
      maxOutputTokens?: number;
    }>,
  ): Promise<
    | Readonly<{ status: "completed"; text: string }>
    | Readonly<{
        status: "failed" | "cancelled" | "truncated";
        errorCode: string;
      }>
  >;
}
