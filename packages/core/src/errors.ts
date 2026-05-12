/** Cross-cutting error envelope (v2 §14 taxonomy — minimal subset for TS bootstrap). */

export type PawErrorCode =
  | "CONFIG"
  | "VALIDATION"
  | "WORKSPACE"
  | "POLICY"
  | "MODEL"
  | "INTERNAL";

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
