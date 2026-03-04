import React from 'react';
import { Box, Text } from 'ink';
import type { PlanTask } from '../../types/plan.js';

const STATUS_ICON: Record<string, string> = {
  open: '\u25CB',
  ready: '\u25CE',
  dispatched: '\u2192',
  running: '\u25CF',
  done: '\u2713',
  failed: '\u2717',
  blocked: '\u25C9',
};

interface PlanPanelProps {
  tasks: PlanTask[];
  selectedIndex: number;
  focused: boolean;
  scrollOffset: number;
  maxVisible: number;
  statusFilter?: string;
  agentFilter?: string;
}

export function PlanPanel({
  tasks,
  selectedIndex,
  focused,
  scrollOffset,
  maxVisible,
  statusFilter,
  agentFilter,
}: PlanPanelProps): React.ReactElement {
  // Apply filters
  let filtered = tasks;
  if (statusFilter) {
    filtered = filtered.filter((t) => t.status === statusFilter);
  }
  if (agentFilter) {
    filtered = filtered.filter((t) => t.target === agentFilter);
  }

  const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible);
  const filterLabel = statusFilter ?? agentFilter ?? 'all';

  function priorityColor(p: string): string | undefined {
    switch (p) {
      case 'p0': return 'red';
      case 'p1': return 'yellow';
      case 'p2': return undefined;
      case 'p3': return 'gray';
      default: return undefined;
    }
  }

  function statusColor(s: string): string | undefined {
    switch (s) {
      case 'open': return undefined;
      case 'ready': return 'cyan';
      case 'dispatched': return 'blue';
      case 'running': return 'yellow';
      case 'done': return 'green';
      case 'failed': return 'red';
      case 'blocked': return 'yellow';
      default: return undefined;
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      flexGrow={1}
      paddingX={1}
    >
      {/* Title bar */}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={focused ? 'cyan' : 'white'}>
          {' '}Plan ({filtered.length} tasks){' '}
        </Text>
        <Text dimColor>filter: {filterLabel}</Text>
      </Box>

      {/* Header row */}
      <Box flexDirection="row" gap={1}>
        <Box width={3}><Text dimColor bold> </Text></Box>
        <Box width={10}><Text dimColor bold>ID</Text></Box>
        <Box width={4}><Text dimColor bold>PRI</Text></Box>
        <Box width={10}><Text dimColor bold>AGENT</Text></Box>
        <Box flexGrow={1}><Text dimColor bold>TITLE</Text></Box>
      </Box>

      {/* Task rows */}
      {visible.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No tasks{statusFilter ? ` with status "${statusFilter}"` : ''}.</Text>
        </Box>
      ) : (
        visible.map((task, i) => {
          const globalIdx = scrollOffset + i;
          const isSelected = globalIdx === selectedIndex;
          const icon = STATUS_ICON[task.status] ?? '?';
          const sColor = statusColor(task.status);
          const pColor = priorityColor(task.priority);

          return (
            <Box key={task.id} flexDirection="row" gap={1}>
              <Box width={3}>
                <Text color={sColor}>{icon}</Text>
              </Box>
              <Box width={10}>
                <Text bold={isSelected} inverse={isSelected && focused}>
                  {task.id.length > 9 ? task.id.slice(0, 8) + '\u2026' : task.id}
                </Text>
              </Box>
              <Box width={4}>
                <Text color={pColor} bold={task.priority === 'p0'}>
                  {task.priority}
                </Text>
              </Box>
              <Box width={10}>
                <Text dimColor>{task.target.length > 9 ? task.target.slice(0, 8) + '\u2026' : task.target}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text bold={isSelected} inverse={isSelected && focused}>
                  {task.title}
                </Text>
              </Box>
            </Box>
          );
        })
      )}

      {/* Scroll indicator */}
      {filtered.length > maxVisible && (
        <Box marginTop={1}>
          <Text dimColor>
            {scrollOffset + 1}--{Math.min(scrollOffset + maxVisible, filtered.length)} of {filtered.length}
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          j/k select | Enter detail | d dispatch | f filter | a agent
        </Text>
      </Box>
    </Box>
  );
}
