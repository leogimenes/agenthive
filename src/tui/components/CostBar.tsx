import React from 'react';
import { Box, Text } from 'ink';
import type { StatusData } from '../hooks/useAgentStatus.js';
import { getSpendColor } from '../../core/colors.js';

interface CostBarProps {
  status: StatusData;
}

function buildProgressBar(pct: number, width: number): string {
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export function CostBar({ status }: CostBarProps): React.ReactElement {
  const totalPct = status.totalDailyMax > 0
    ? status.totalSpend / status.totalDailyMax
    : 0;
  const barColor = getSpendColor(totalPct);
  const anyWarning = status.agents.some(
    (a) => a.dailyMax > 0 && a.dailySpend / a.dailyMax > 0.9,
  );

  return (
    <Box flexDirection="row" paddingX={1} gap={1}>
      <Text dimColor>budget:</Text>
      <Text color={barColor}>{buildProgressBar(Math.min(totalPct, 1), 20)}</Text>
      <Text bold>${status.totalSpend.toFixed(2)}</Text>
      <Text dimColor>/ ${status.totalDailyMax.toFixed(2)}</Text>
      {anyWarning && <Text color="yellow"> ⚠</Text>}
      <Text dimColor> │ </Text>
      {status.agents.map((a, i) => {
        const pct = a.dailyMax > 0 ? a.dailySpend / a.dailyMax : 0;
        return (
          <React.Fragment key={a.name}>
            {i > 0 && <Text dimColor> </Text>}
            <Text color={getSpendColor(pct)}>{a.name}</Text>
            <Text dimColor>:</Text>
            <Text>${a.dailySpend.toFixed(2)}</Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
