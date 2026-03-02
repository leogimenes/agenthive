import React from 'react';
import { Box, Text } from 'ink';

interface InputBarProps {
  value: string;
  focused: boolean;
  error?: string;
  agentNames: string[];
}

export function InputBar({ value, focused, error, agentNames }: InputBarProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Box flexDirection="row" gap={1}>
        <Text bold color={focused ? 'cyan' : 'white'}> Dispatch </Text>
        <Text dimColor>
          {'<target> <message>  │  /from <role> /warn /status'}
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text color="cyan">{focused ? '❯ ' : '  '}</Text>
        <Text>{value}</Text>
        {focused && <Text color="cyan">█</Text>}
      </Box>
      {error && (
        <Box>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
