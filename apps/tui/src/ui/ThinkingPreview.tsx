import { Box, Text } from "ink";

import { theme } from "./themes.js";

/** RFC §25 — last N lines of model output, dim (Kimi-style preview). */
export function ThinkingPreview({
  visible,
  lines,
  elapsedSec,
  label,
}: {
  readonly visible: boolean;
  readonly lines: readonly string[];
  readonly elapsedSec: number;
  readonly label: string;
}) {
  if (!visible) {
    return null;
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text italic dimColor color={theme.thinking}>
        Thinking… {elapsedSec.toFixed(1)}s · {label}
      </Text>
      {lines.length > 0 ? (
        <Text dimColor italic>
          {lines.join("\n")}
        </Text>
      ) : null}
    </Box>
  );
}
