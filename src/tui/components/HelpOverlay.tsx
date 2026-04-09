import React from 'react';
import { Box, Text } from 'ink';
import { HELP_TABS } from '../keybindings.js';

interface HelpOverlayProps {
  activeTab: number;
}

export function HelpOverlay({ activeTab }: HelpOverlayProps): React.ReactElement {
  const tab = HELP_TABS[activeTab] ?? HELP_TABS[0];

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      alignSelf="center"
    >
      <Box marginBottom={1} justifyContent="center">
        <Text bold color="cyan"> Keyboard Shortcuts </Text>
      </Box>

      {/* Tab bar */}
      <Box marginBottom={1} gap={1} flexWrap="wrap">
        {HELP_TABS.map((t, i) => (
          <Text key={t.name} bold={i === activeTab} color={i === activeTab ? 'cyan' : undefined} dimColor={i !== activeTab}>
            {i === activeTab ? `[${t.name}]` : t.name}
          </Text>
        ))}
      </Box>

      {/* Entries for active tab */}
      {tab.entries.map((entry, i) => (
        <Box key={i} gap={2}>
          <Box width={22}>
            <Text bold color="yellow">{entry.key}</Text>
          </Box>
          <Text>{entry.desc}</Text>
        </Box>
      ))}

      <Box marginTop={1} justifyContent="center">
        <Text dimColor>h/[ prev tab  l/] next tab  ? close</Text>
      </Box>
    </Box>
  );
}
