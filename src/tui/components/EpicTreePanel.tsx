import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { PlanTask } from '../../types/plan.js';
import {
  buildEpicTree,
  flattenTree,
  renderProgressBar,
  priorityColor,
  statusColor,
  STATUS_ICON,
  type FlattenedRow,
} from '../utils/epicTree.js';

interface EpicTreePanelProps {
  tasks: PlanTask[];
  selectedIndex: number;
  focused: boolean;
  scrollOffset: number;
  maxVisible: number;
  expanded: Set<string>;
}

function TreeRow({
  row,
  isSelected,
  focused,
}: {
  row: FlattenedRow;
  isSelected: boolean;
  focused: boolean;
}): React.ReactElement {
  const { node, expanded } = row;
  const { task, children, progress, depth } = node;

  const indent = '  '.repeat(depth);
  const hasChildren = children.length > 0;

  // Expand indicator
  const expandIcon = hasChildren ? (expanded ? '▼' : '▶') : ' ';

  // Status icon
  const icon = STATUS_ICON[task.status] ?? '?';
  const sColor = statusColor(task.status);
  const pColor = priorityColor(task.priority);

  // Progress bar (for parent nodes)
  const progressBar = hasChildren ? renderProgressBar(progress.done, progress.total) : '';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {/* Indent + expand icon */}
        <Box>
          <Text dimColor>{indent}</Text>
          <Text dimColor={!hasChildren} bold={hasChildren}>{expandIcon} </Text>
        </Box>

        {/* Status icon */}
        <Box width={2}>
          <Text color={sColor}>{icon}</Text>
        </Box>

        {/* Task ID */}
        <Box width={10}>
          <Text
            bold={isSelected || depth === 0}
            inverse={isSelected && focused}
            color={pColor}
          >
            {task.id.length > 9 ? task.id.slice(0, 8) + '…' : task.id}
          </Text>
        </Box>

        {/* Priority badge */}
        <Box width={4}>
          <Text color={pColor} bold={task.priority === 'p0'} dimColor={task.priority === 'p3'}>
            {task.priority}
          </Text>
        </Box>

        {/* Title */}
        <Box flexGrow={1}>
          <Text bold={isSelected || depth === 0} inverse={isSelected && focused}>
            {task.title}
          </Text>
        </Box>
      </Box>

      {/* Progress bar row for parent nodes */}
      {hasChildren && progressBar && (
        <Box marginLeft={depth * 2 + 4}>
          <Text
            color={
              progress.status === 'done'
                ? 'green'
                : progress.status === 'warning'
                  ? 'red'
                  : progress.status === 'running'
                    ? 'yellow'
                    : 'cyan'
            }
            dimColor={!isSelected}
          >
            {progressBar}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function EpicTreePanel({
  tasks,
  selectedIndex,
  focused,
  scrollOffset,
  maxVisible,
  expanded,
}: EpicTreePanelProps): React.ReactElement {
  const tree = useMemo(() => buildEpicTree(tasks), [tasks]);
  const allRows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  const visible = allRows.slice(scrollOffset, scrollOffset + maxVisible);

  const epicCount = tasks.filter((t) => !t.parent).length;
  const totalCount = tasks.length;

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
          {' '}Epic Tree{' '}
        </Text>
        <Text dimColor>
          {epicCount} epic{epicCount !== 1 ? 's' : ''} · {totalCount} tasks
        </Text>
      </Box>

      {/* Rows */}
      {visible.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No tasks in plan.</Text>
        </Box>
      ) : (
        visible.map((row) => (
          <TreeRow
            key={row.node.task.id}
            row={row}
            isSelected={row.index === selectedIndex}
            focused={focused}
          />
        ))
      )}

      {/* Scroll indicator */}
      {allRows.length > maxVisible && (
        <Box marginTop={1}>
          <Text dimColor>
            {scrollOffset + 1}–{Math.min(scrollOffset + maxVisible, allRows.length)} of{' '}
            {allRows.length}
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          j/k navigate · Space expand/collapse · Enter detail · e exit tree
        </Text>
      </Box>
    </Box>
  );
}
