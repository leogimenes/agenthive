import React from 'react';
import { Box, Text } from 'ink';
import type { StatusData } from '../hooks/useAgentStatus.js';

interface HeaderProps {
  status: StatusData;
}

export function Header({ status }: HeaderProps): React.ReactElement {
  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Text bold color="yellow">
        🐝 AgentHive
      </Text>
      <Text>
        <Text dimColor>session:</Text>{' '}
        <Text bold>{status.session}</Text>
        {'  '}
        <Text dimColor>agents:</Text>{' '}
        <Text color="green" bold>{status.running}</Text>
        <Text dimColor>/{status.total}</Text>
        {'  '}
        <Text dimColor>spend:</Text>{' '}
        <Text bold>${status.totalSpend.toFixed(2)}</Text>
      </Text>
    </Box>
  );
}
