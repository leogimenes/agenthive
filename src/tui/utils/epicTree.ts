/**
 * Utilities for building and rendering the epic/story/task tree hierarchy
 * in the TUI EpicTreePanel.
 */

import type { Plan, PlanTask } from '../../types/plan.js';
import { getChildTasks, computeParentStatus } from '../../core/plan.js';

/** A node in the tree, with children resolved. */
export interface TreeNode {
  task: PlanTask;
  children: TreeNode[];
  /** Progress info (only meaningful if children.length > 0). */
  progress: { done: number; total: number; status: string };
  /** Depth in tree: 0 = root, 1 = child, 2 = grandchild. */
  depth: number;
}

/** A flattened row for rendering. */
export interface FlattenedRow {
  node: TreeNode;
  /** Whether this node is currently expanded (only relevant if it has children). */
  expanded: boolean;
  /** Visible index in the flattened list. */
  index: number;
}

/**
 * Build the tree from a flat task list.
 * Root nodes are tasks with no `parent` or whose parent isn't in the task list.
 */
export function buildEpicTree(tasks: PlanTask[]): TreeNode[] {
  const taskMap = new Map<string, PlanTask>(tasks.map((t) => [t.id, t]));

  function buildNode(task: PlanTask, depth: number): TreeNode {
    const children = tasks
      .filter((t) => t.parent === task.id)
      .map((t) => buildNode(t, depth + 1));

    // Compute progress inline from children
    let progress: TreeNode['progress'];
    if (children.length === 0) {
      progress = { done: 0, total: 0, status: task.status };
    } else {
      const done = children.filter((c) => c.task.status === 'done').length;
      const failed = children.filter((c) => c.task.status === 'failed').length;
      const running = children.filter(
        (c) => c.task.status === 'running' || c.task.status === 'dispatched',
      ).length;
      const total = children.length;
      let status: string;
      if (done === total) status = 'done';
      else if (failed > 0) status = 'warning';
      else if (running > 0) status = 'running';
      else status = 'progress';
      progress = { done, total, status };
    }

    return { task, children, progress, depth };
  }

  // Roots: tasks with no parent, or parent not in the map
  const roots = tasks.filter(
    (t) => !t.parent || !taskMap.has(t.parent),
  );

  return roots.map((t) => buildNode(t, 0));
}

/**
 * Flatten the tree into a list of visible rows, respecting expanded state.
 * @param nodes - Top-level tree nodes
 * @param expanded - Set of task IDs that are expanded
 */
export function flattenTree(nodes: TreeNode[], expanded: Set<string>): FlattenedRow[] {
  const rows: FlattenedRow[] = [];
  let index = 0;

  function visit(node: TreeNode): void {
    const isExpanded = node.children.length > 0 && expanded.has(node.task.id);
    rows.push({ node, expanded: isExpanded, index: index++ });
    if (isExpanded) {
      for (const child of node.children) {
        visit(child);
      }
    }
  }

  for (const root of nodes) {
    visit(root);
  }

  return rows;
}

/**
 * Render a progress bar string.
 * Example: [=========>......] 62% (8/13)
 * @param done - Number of done tasks
 * @param total - Total number of tasks
 * @param width - Width of the bar in characters (default: 16)
 */
export function renderProgressBar(done: number, total: number, width = 16): string {
  if (total === 0) return '';
  const pct = Math.floor((done / total) * 100);
  const filled = Math.round((done / total) * width);
  const empty = width - filled;

  const bar =
    filled > 0
      ? '='.repeat(Math.max(0, filled - 1)) + '>' + '.'.repeat(empty)
      : '.'.repeat(width);

  return `[${bar}] ${pct}% (${done}/${total})`;
}

/**
 * Return color name for a given priority.
 */
export function priorityColor(priority: string): string | undefined {
  switch (priority) {
    case 'p0': return 'red';
    case 'p1': return 'yellow';
    case 'p2': return undefined; // default/white
    case 'p3': return 'gray';
    default: return undefined;
  }
}

/**
 * Return color name for a given status.
 */
export function statusColor(status: string): string | undefined {
  switch (status) {
    case 'done': return 'green';
    case 'failed': return 'red';
    case 'blocked': return 'yellow';
    case 'running': return 'yellow';
    case 'dispatched': return 'blue';
    case 'ready': return 'cyan';
    default: return undefined;
  }
}

/** Status icons for rendering. */
export const STATUS_ICON: Record<string, string> = {
  open: '○',
  ready: '◎',
  dispatched: '→',
  running: '●',
  done: '✓',
  failed: '✗',
  blocked: '◉',
};
