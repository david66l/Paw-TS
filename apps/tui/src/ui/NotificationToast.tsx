import { Box, Text } from "ink";
import { theme } from "./themes.js";

export type ToastType = "ok" | "fail" | "warn" | "info";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly type: ToastType;
}

function colorForType(t: ToastType): string {
  switch (t) {
    case "ok":
      return theme.ok;
    case "fail":
      return theme.fail;
    case "warn":
      return theme.warn;
    default:
      return theme.accent;
  }
}

function iconForType(t: ToastType): string {
  switch (t) {
    case "ok":
      return "✓";
    case "fail":
      return "✗";
    case "warn":
      return "⚠";
    default:
      return "ℹ";
  }
}

/** Transient notification banner — auto-dismissed by the caller. */
export function NotificationToast({ toasts }: { readonly toasts: readonly Toast[] }) {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {toasts.map((t) => (
        <Text key={t.id} color={colorForType(t.type)}>
          {iconForType(t.type)} {t.message}
        </Text>
      ))}
    </Box>
  );
}
