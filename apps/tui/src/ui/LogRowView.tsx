import { Box, Text } from "ink";

import { WelcomeBanner } from "./WelcomeBanner.js";
import type { DisplayRow } from "./display-rows.js";
import { theme } from "./themes.js";

export function LogRowView({ row }: { readonly row: DisplayRow }) {
  switch (row.variant) {
    case "welcome":
      return <WelcomeBanner />;
    case "text":
      return <Text>{row.text}</Text>;
    case "muted":
      return <Text dimColor>{row.text}</Text>;
    case "headline":
      return (
        <Text bold color={theme.accent}>
          {row.text}
        </Text>
      );
    case "tool_panel":
      return (
        <Box
          borderStyle="round"
          borderColor={row.ok ? theme.ok : theme.fail}
          flexDirection="column"
          marginY={0}
          paddingX={1}
        >
          <Text bold color={theme.accent}>
            {row.tool}
            {row.ok ? "" : " · failed"}
          </Text>
          <Text dimColor>{row.summary}</Text>
          {row.detail ? <Text dimColor>{row.detail}</Text> : null}
        </Box>
      );
    case "plan_card":
      return (
        <Box
          borderStyle="single"
          borderColor={theme.warn}
          flexDirection="column"
          paddingX={1}
        >
          <Text bold color={theme.warn}>
            Plan rev {row.revision} · {row.itemCount} items
          </Text>
          <Text dimColor>{row.reason}</Text>
        </Box>
      );
    case "error_line":
      return (
        <Text color={theme.fail}>{row.text}</Text>
      );
    case "tool_stream": {
      const lines = row.chunk.split("\n");
      return (
        <Box flexDirection="column">
          {lines.map((line, i) =>
            line || i < lines.length - 1 ? (
              <Text
                key={i}
                dimColor
                color={row.isStderr ? theme.fail : undefined}
              >
                {line || " "}
              </Text>
            ) : null,
          )}
        </Box>
      );
    }
    default:
      return null;
  }
}
