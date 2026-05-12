import { Box, Text } from "ink";

import { theme } from "./themes.js";

const OPTIONS: readonly { readonly title: string; readonly hint: string }[] = [
  { title: "Allow", hint: "run this tool" },
  { title: "Deny", hint: "skip execution" },
];

export function ApprovalPicker({ selectedIndex }: { selectedIndex: number }) {
  return (
    <Box
      borderColor={theme.warn}
      borderStyle="round"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text color={theme.muted}>
        Tool approval · ↑↓ move highlight · Enter confirm
      </Text>
      {OPTIONS.map((o, i) => {
        const on = i === selectedIndex;
        return (
          <Text bold={on} color={on ? theme.accent : theme.muted} key={o.title}>
            {on ? "❯ " : "  "}
            {o.title} — {o.hint}
          </Text>
        );
      })}
    </Box>
  );
}
