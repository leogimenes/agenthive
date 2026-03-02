import React from 'react';
import { Box, Text } from 'ink';
import { HELP_ENTRIES } from '../keybindings.js';

export function HelpOverlay(): React.ReactElement {
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

      {HELP_ENTRIES.map((entry, i) => {
        if (!entry.key && !entry.desc) {
          return <Text key={i}>{' '}</Text>;
        }
        if (!entry.desc) {
          return (
            <Text key={i} bold dimColor>
              {entry.key}
            </Text>
          );
        }
        return (
          <Box key={i} gap={2}>
            <Box width={20}>
              <Text bold color="yellow">{entry.key}</Text>
            </Box>
            <Text>{entry.desc}</Text>
          </Box>
        );
      })}

      <Box marginTop={1} justifyContent="center">
        <Text dimColor>Press ? to close</Text>
      </Box>
    </Box>
  );
}
