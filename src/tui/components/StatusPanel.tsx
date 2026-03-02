import React from 'react';
import { Box, Text } from 'ink';
import type { AgentStatusInfo } from '../hooks/useAgentStatus.js';
import { getSpendColor, getRoleColorName } from '../../core/colors.js';

interface StatusPanelProps {
  agents: AgentStatusInfo[];
  selectedIndex: number;
  focused: boolean;
}

function statusColor(status: string): string {
  switch (status) {
    case 'RUNNING': return 'green';
    case 'STALE_LOCK': return 'yellow';
    default: return 'gray';
  }
}

function statusLabel(agent: AgentStatusInfo): string {
  switch (agent.status) {
    case 'RUNNING': return `RUNNING (${agent.pid})`;
    case 'STALE_LOCK': return `STALE (${agent.pid})`;
    default: return 'STOPPED';
  }
}

export function StatusPanel({ agents, selectedIndex, focused }: StatusPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} flexGrow={1} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={focused ? 'cyan' : 'white'}> Agents </Text>
      </Box>

      {/* Header row */}
      <Box flexDirection="row" gap={1}>
        <Box width={12}><Text dimColor bold>AGENT</Text></Box>
        <Box width={18}><Text dimColor bold>STATUS</Text></Box>
        <Box width={14}><Text dimColor bold>SPEND</Text></Box>
        <Box flexGrow={1}><Text dimColor bold>LAST ACTIVITY</Text></Box>
      </Box>

      {agents.map((agent, i) => {
        const isSelected = i === selectedIndex;
        const spendPct = agent.dailyMax > 0 ? agent.dailySpend / agent.dailyMax : 0;

        return (
          <Box key={agent.name} flexDirection="row" gap={1}>
            <Box width={12}>
              <Text
                bold={isSelected}
                inverse={isSelected && focused}
                color={getRoleColorName(agent.role)}
              >
                {agent.name}
              </Text>
            </Box>
            <Box width={18}>
              <Text color={statusColor(agent.status)}>
                {statusLabel(agent)}
              </Text>
            </Box>
            <Box width={14}>
              <Text color={getSpendColor(spendPct)}>
                ${agent.dailySpend.toFixed(2)}/${agent.dailyMax.toFixed(2)}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor={!agent.lastActivity}>
                {agent.lastActivity ?? '—'}
              </Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>
          {agents.filter((a) => a.status === 'RUNNING').length}/{agents.length} running
          {' · '}
          {agents.filter((a) => a.status === 'STALE_LOCK').length > 0 &&
            <Text color="yellow">{agents.filter((a) => a.status === 'STALE_LOCK').length} stale · </Text>
          }
          j/k select · Enter detail
        </Text>
      </Box>
    </Box>
  );
}
