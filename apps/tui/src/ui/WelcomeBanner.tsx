import { Box, Text } from "ink";

import { theme } from "./themes.js";

/** RFC §25 Phase E — compact branded header (full polish later). */
export function WelcomeBanner() {
  return (
    <Box
      borderStyle="double"
      borderColor={theme.panelBorder}
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text bold color={theme.bannerTitle}>
        Paw
      </Text>
      <Text color={theme.muted}>
        Type a goal or /help · TS AgentOrchestrator (canonical)
      </Text>
    </Box>
  );
}
