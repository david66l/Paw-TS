import type { ApprovalKeyAction, KeyLike } from "./footer-types.js";

export type { ApprovalKeyAction, KeyLike };

export function resolveApprovalKey(key: KeyLike): ApprovalKeyAction | null {
  if (key.ctrl) return null;
  switch (key.name) {
    case "up":
      return "select-allow";
    case "down":
      return "select-deny";
    case "return":
      return "confirm";
    case "y":
      return "approve";
    case "escape":
    case "n":
      return "deny";
    default:
      return null;
  }
}
