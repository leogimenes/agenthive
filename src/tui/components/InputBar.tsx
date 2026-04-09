import React from 'react';
import { Box, Text } from 'ink';

interface InputBarProps {
  value: string;
  focused: boolean;
  error?: string;
  agentNames: string[];
}

export function InputBar({ value, focused, error, agentNames }: InputBarProps): React.ReactElement {
  const allTargets = [...agentNames, 'ALL'];

  // Determine partial target being typed (only the first token, before any space)
  const hasSpace = value.includes(' ');
  const partialTarget = !hasSpace ? value.toLowerCase() : '';
  const isTypingTarget = focused && !hasSpace;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
    >
      <Box flexDirection="row" gap={1}>
        <Text bold color={focused ? 'cyan' : 'white'}> Dispatch </Text>
        <Text dimColor>{'<target> <message>  │  /from <role> /warn /status'}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{focused ? 'Targets:' : 'Targets:'}</Text>
        {allTargets.map((name, i) => {
          const matches = isTypingTarget && partialTarget.length > 0
            ? name.toLowerCase().startsWith(partialTarget)
            : false;
          const isActive = isTypingTarget && partialTarget.length > 0;
          return (
            <Text
              key={name}
              bold={matches}
              color={isActive ? (matches ? 'cyan' : undefined) : undefined}
              dimColor={isActive ? !matches : !focused}
            >
              {name}{i < allTargets.length - 1 ? ' ' : ''}
            </Text>
          );
        })}
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
