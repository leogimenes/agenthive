import React from 'react';
import { Box, Text } from 'ink';
import type { Plan, PlanTask } from '../../types/plan.js';

const STATUS_ICON: Record<string, string> = {
  open: '\u25CB',
  ready: '\u25CE',
  dispatched: '\u2192',
  running: '\u25CF',
  done: '\u2713',
  failed: '\u2717',
  blocked: '\u25C9',
};

interface PlanTaskDetailProps {
  task: PlanTask;
  plan: Plan;
  focused: boolean;
}

function statusColor(s: string): string | undefined {
  switch (s) {
    case 'ready': return 'cyan';
    case 'dispatched': return 'blue';
    case 'running': return 'yellow';
    case 'done': return 'green';
    case 'failed': return 'red';
    case 'blocked': return 'yellow';
    default: return undefined;
  }
}

function priorityColor(p: string): string | undefined {
  switch (p) {
    case 'p0': return 'red';
    case 'p1': return 'yellow';
    case 'p3': return 'gray';
    default: return undefined;
  }
}

export function PlanTaskDetail({ task, plan, focused }: PlanTaskDetailProps): React.ReactElement {
  const icon = STATUS_ICON[task.status] ?? '?';

  // Find dependencies
  const deps = task.depends_on
    .map((id) => plan.tasks.find((t) => t.id === id))
    .filter(Boolean) as PlanTask[];

  // Find dependents (tasks that depend on this one)
  const dependents = plan.tasks.filter((t) => t.depends_on.includes(task.id));

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      flexGrow={1}
      paddingX={1}
    >
      {/* Header */}
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text color={statusColor(task.status)} bold>
            {icon} {task.id}
          </Text>
          <Text> </Text>
          <Text color={priorityColor(task.priority)} bold={task.priority === 'p0'}>
            {task.priority}
          </Text>
          <Text> </Text>
          <Text dimColor>-&gt; {task.target}</Text>
        </Box>
        <Text bold>{task.title}</Text>
      </Box>

      {/* Status */}
      <Box marginBottom={1}>
        <Text dimColor>Status: </Text>
        <Text color={statusColor(task.status)}>{task.status}</Text>
      </Box>

      {/* Description */}
      {task.description && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor bold>Description:</Text>
          <Text wrap="wrap">{task.description}</Text>
        </Box>
      )}

      {/* Dependencies */}
      {deps.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor bold>Dependencies ({deps.length}):</Text>
          {deps.map((dep) => (
            <Box key={dep.id}>
              <Text color={statusColor(dep.status)}>
                {STATUS_ICON[dep.status] ?? '?'}
              </Text>
              <Text> {dep.id} -- {dep.title}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Dependents */}
      {dependents.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor bold>Blocked by this ({dependents.length}):</Text>
          {dependents.map((dep) => (
            <Box key={dep.id}>
              <Text color={statusColor(dep.status)}>
                {STATUS_ICON[dep.status] ?? '?'}
              </Text>
              <Text> {dep.id} -- {dep.title}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Timeline */}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor bold>Timeline:</Text>
        <Text dimColor>  Created:    {new Date(task.created_at).toLocaleString()}</Text>
        {task.dispatched_at && (
          <Text dimColor>  Dispatched: {new Date(task.dispatched_at).toLocaleString()}</Text>
        )}
        {task.completed_at && (
          <Text dimColor>  Completed:  {new Date(task.completed_at).toLocaleString()}</Text>
        )}
      </Box>

      {/* Resolution */}
      {task.resolution && (
        <Box marginBottom={1}>
          <Text dimColor bold>Resolution: </Text>
          <Text>{task.resolution}</Text>
        </Box>
      )}

      {/* Labels */}
      {task.labels && task.labels.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>Labels: </Text>
          <Text>{task.labels.join(', ')}</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          d dispatch | r reset | Esc back
        </Text>
      </Box>
    </Box>
  );
}
