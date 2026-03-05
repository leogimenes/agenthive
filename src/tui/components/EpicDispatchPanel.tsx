import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { PlanTask } from '../../types/plan.js';
import {
  buildEpicTree,
  flattenTree,
  renderProgressBar,
  statusColor,
  STATUS_ICON,
  getEpicDescendants,
  getEpicReadyTasks,
} from '../utils/epicTree.js';

export type EpicAction = 'start' | 'pause' | 'deliver';

interface EpicDispatchPanelProps {
  tasks: PlanTask[];
  selectedEpicId: string;
  focused: boolean;
  confirmAction: EpicAction | null;
  pausedEpics: Set<string>;
}

function TaskRow({ task }: { task: PlanTask }): React.ReactElement {
  const icon = STATUS_ICON[task.status] ?? '?';
  const sColor = statusColor(task.status);

  return (
    <Box flexDirection="row" gap={1}>
      <Box width={2}>
        <Text color={sColor}>{icon}</Text>
      </Box>
      <Box width={12}>
        <Text bold color={sColor}>
          {task.id.length > 11 ? task.id.slice(0, 10) + '…' : task.id}
        </Text>
      </Box>
      <Box width={10}>
        <Text dimColor>{task.status}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text>{task.title}</Text>
      </Box>
    </Box>
  );
}

export function EpicDispatchPanel({
  tasks,
  selectedEpicId,
  focused,
  confirmAction,
  pausedEpics,
}: EpicDispatchPanelProps): React.ReactElement {
  const epicTask = useMemo(
    () => tasks.find((t) => t.id === selectedEpicId),
    [tasks, selectedEpicId],
  );

  const descendants = useMemo(
    () => getEpicDescendants(tasks, selectedEpicId),
    [tasks, selectedEpicId],
  );

  // Direct children only for the task list (exclude the epic itself)
  const childTasks = useMemo(
    () => descendants.filter((t) => t.id !== selectedEpicId),
    [descendants, selectedEpicId],
  );

  const readyTasks = useMemo(
    () => getEpicReadyTasks(tasks, selectedEpicId),
    [tasks, selectedEpicId],
  );

  const isPaused = pausedEpics.has(selectedEpicId);

  // Progress computation
  const done = childTasks.filter((t) => t.status === 'done').length;
  const total = childTasks.length;
  const progressBar = total > 0 ? renderProgressBar(done, total) : '';
  const progressStatus =
    done === total && total > 0
      ? 'done'
      : childTasks.some((t) => t.status === 'failed')
        ? 'warning'
        : childTasks.some((t) => t.status === 'running' || t.status === 'dispatched')
          ? 'running'
          : 'progress';

  const confirmMessages: Record<EpicAction, string> = {
    start: `Start: dispatch ${readyTasks.length} ready task(s) for epic "${selectedEpicId}"? [y/n]`,
    pause: isPaused
      ? `Resume auto-dispatch for epic "${selectedEpicId}"? [y/n]`
      : `Pause auto-dispatch for epic "${selectedEpicId}"? [y/n]`,
    deliver: `Deliver: trigger completion workflow for epic "${selectedEpicId}"? [y/n]`,
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? 'cyan' : 'gray'}
      flexGrow={1}
      paddingX={1}
    >
      {/* Header */}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={focused ? 'cyan' : 'white'}>
          {' '}Epic: {selectedEpicId}{' '}
        </Text>
        {isPaused && <Text color="yellow"> ⏸ PAUSED</Text>}
      </Box>

      {/* Epic title and status */}
      {epicTask && (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={statusColor(epicTask.status) ?? undefined}>
              {STATUS_ICON[epicTask.status] ?? '?'}
            </Text>
            <Text bold>{epicTask.title}</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>Status:</Text>
            <Text color={statusColor(epicTask.status) ?? undefined}>{epicTask.status}</Text>
            <Text dimColor> · Target:</Text>
            <Text dimColor>{epicTask.target}</Text>
          </Box>
        </Box>
      )}

      {/* Progress bar */}
      {total > 0 && (
        <Box marginBottom={1}>
          <Text
            color={
              progressStatus === 'done'
                ? 'green'
                : progressStatus === 'warning'
                  ? 'red'
                  : progressStatus === 'running'
                    ? 'yellow'
                    : 'cyan'
            }
          >
            {progressBar}
          </Text>
        </Box>
      )}

      {/* Task breakdown */}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor bold>
          Task Breakdown ({childTasks.length}):
        </Text>
        {childTasks.length === 0 ? (
          <Text dimColor>  No child tasks.</Text>
        ) : (
          childTasks.map((t) => <TaskRow key={t.id} task={t} />)
        )}
      </Box>

      {/* Action summary */}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor bold>Actions:</Text>
        <Box gap={2}>
          <Text color={readyTasks.length > 0 ? 'green' : 'gray'}>
            s=start ({readyTasks.length} ready)
          </Text>
          <Text color={isPaused ? 'yellow' : 'cyan'}>
            {isPaused ? 'p=resume' : 'p=pause'}
          </Text>
          <Text color="magenta">d=deliver</Text>
          <Text dimColor>Esc=back</Text>
        </Box>
      </Box>

      {/* Confirmation prompt */}
      {confirmAction && (
        <Box
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
          marginTop={1}
        >
          <Text color="yellow">{confirmMessages[confirmAction]}</Text>
        </Box>
      )}
    </Box>
  );
}
