/** Cross-cutting error envelope (v2 §14 taxonomy — minimal subset for TS bootstrap). */

export type PawErrorCode =
  | "CONFIG"
  | "VALIDATION"
  | "WORKSPACE"
  | "POLICY"
  | "MODEL"
  | "INTERNAL";

export type ToolErrorCode =
  | "E_SCHEMA_INVALID"
  | "E_RETRY"
  | "E_USER"
  | "E_FATAL"
  | "E_POLICY_DENIED";

export interface ToolErrorPayload {
  readonly error_code: ToolErrorCode;
  readonly error: string;
  readonly message: string;
  readonly field?: string;
  readonly expected?: string;
  readonly path?: string;
  readonly policy?: string;
}

export class PawError extends Error {
  readonly code: PawErrorCode;
  readonly causeDetail: unknown;

  constructor(code: PawErrorCode, message: string, causeDetail?: unknown) {
    super(message);
    this.name = "PawError";
    this.code = code;
    this.causeDetail = causeDetail;
  }
}

export function isPawError(e: unknown): e is PawError {
  return e instanceof PawError;
}

export function makeToolError(
  code: ToolErrorCode,
  message: string,
  detail?: Omit<ToolErrorPayload, "error_code" | "error" | "message">,
): ToolErrorPayload {
  return {
    error_code: code,
    error: message,
    message,
    ...(detail ?? {}),
  };
}
