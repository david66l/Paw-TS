/** Tool observation wire values. */
import type { DurableJsonPayloadV1 } from "./primitives.js";
import type { TOOL_OBSERVATION_SCHEMA_VERSION_V1 } from "./versions.js";

/** Model-visible, status-preserving tool evidence. */
export interface ToolObservationV1 {
  readonly schemaVersion: typeof TOOL_OBSERVATION_SCHEMA_VERSION_V1;
  readonly summary: string;
  readonly isError: boolean;
  readonly payload?: DurableJsonPayloadV1;
}

export type ToolSettlementStatusV1 = "completed" | "failed" | "cancelled" | "unknown" | "rejected";
