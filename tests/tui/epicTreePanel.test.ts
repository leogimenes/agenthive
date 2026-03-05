import { describe, it, expect } from 'vitest';
import type { PlanTask } from '../../src/types/plan.js';
import {
  buildEpicTree,
  flattenTree,
  renderProgressBar,
  priorityColor,
  statusColor,
  STATUS_ICON,
} from '../../src/tui/utils/epicTree.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeTask(
  id: string,
  overrides: Partial<PlanTask> = {},
): PlanTask {
  return {
    id,
    title: `Task ${id}`,
    target: 'backend',
    priority: 'p1',
    status: 'open',
    depends_on: [],
    created_at: '2026-03-05T10:00:00Z',
    updated_at: '2026-03-05T10:00:00Z',
    ...overrides,
  };
}

// ── buildEpicTree ─────────────────────────────────────────────────────

describe('buildEpicTree', () => {
  it('should return empty array for empty task list', () => {
    expect(buildEpicTree([])).toHaveLength(0);
  });

  it('should return all tasks as roots when no parent fields are set', () => {
    const tasks = [makeTask('A'), makeTask('B'), makeTask('C')];
    const tree = buildEpicTree(tasks);
    expect(tree).toHaveLength(3);
    expect(tree.every((n) => n.depth === 0)).toBe(true);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
  });

  it('should nest children under their parent', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('TASK-1', { parent: 'EPIC-1' }),
      makeTask('TASK-2', { parent: 'EPIC-1' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree).toHaveLength(1);
    const epic = tree[0];
    expect(epic.task.id).toBe('EPIC-1');
    expect(epic.depth).toBe(0);
    expect(epic.children).toHaveLength(2);
    expect(epic.children[0].depth).toBe(1);
    expect(epic.children[1].depth).toBe(1);
    expect(epic.children.map((c) => c.task.id)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('should handle three-level hierarchy', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('STORY-1', { parent: 'EPIC-1' }),
      makeTask('TASK-1', { parent: 'STORY-1' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree).toHaveLength(1);
    const epic = tree[0];
    expect(epic.children).toHaveLength(1);
    const story = epic.children[0];
    expect(story.depth).toBe(1);
    expect(story.children).toHaveLength(1);
    expect(story.children[0].depth).toBe(2);
    expect(story.children[0].task.id).toBe('TASK-1');
  });

  it('should treat tasks with unknown parent as roots', () => {
    const tasks = [
      makeTask('TASK-1', { parent: 'NONEXISTENT' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree).toHaveLength(1);
    expect(tree[0].task.id).toBe('TASK-1');
    expect(tree[0].depth).toBe(0);
  });

  it('should compute progress as done=0,total=0 for leaf nodes', () => {
    const tasks = [makeTask('A', { status: 'done' })];
    const tree = buildEpicTree(tasks);
    expect(tree[0].progress).toEqual({ done: 0, total: 0, status: 'done' });
  });

  it('should compute progress done when all children are done', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1', status: 'done' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'done' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree[0].progress).toEqual({ done: 2, total: 2, status: 'done' });
  });

  it('should compute progress warning when any child failed', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1', status: 'done' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'failed' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree[0].progress.status).toBe('warning');
    expect(tree[0].progress.done).toBe(1);
    expect(tree[0].progress.total).toBe(2);
  });

  it('should compute progress running when any child is running', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1', status: 'done' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'running' }),
      makeTask('T-3', { parent: 'EPIC-1', status: 'open' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree[0].progress.status).toBe('running');
    expect(tree[0].progress.done).toBe(1);
    expect(tree[0].progress.total).toBe(3);
  });

  it('should count dispatched as running in progress', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1', status: 'dispatched' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree[0].progress.status).toBe('running');
  });

  it('should handle multiple epics at root level', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('EPIC-2'),
      makeTask('T-1', { parent: 'EPIC-1' }),
      makeTask('T-2', { parent: 'EPIC-2' }),
    ];
    const tree = buildEpicTree(tasks);
    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[1].children).toHaveLength(1);
  });
});

// ── flattenTree ───────────────────────────────────────────────────────

describe('flattenTree', () => {
  it('should return empty array for empty tree', () => {
    expect(flattenTree([], new Set())).toHaveLength(0);
  });

  it('should return all roots when tree has no children', () => {
    const tasks = [makeTask('A'), makeTask('B')];
    const tree = buildEpicTree(tasks);
    const rows = flattenTree(tree, new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0].node.task.id).toBe('A');
    expect(rows[1].node.task.id).toBe('B');
  });

  it('should not show children when parent is not expanded', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1' }),
    ];
    const tree = buildEpicTree(tasks);
    const rows = flattenTree(tree, new Set()); // nothing expanded
    expect(rows).toHaveLength(1);
    expect(rows[0].node.task.id).toBe('EPIC-1');
    expect(rows[0].expanded).toBe(false);
  });

  it('should show children when parent is expanded', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1' }),
      makeTask('T-2', { parent: 'EPIC-1' }),
    ];
    const tree = buildEpicTree(tasks);
    const rows = flattenTree(tree, new Set(['EPIC-1']));
    expect(rows).toHaveLength(3);
    expect(rows[0].node.task.id).toBe('EPIC-1');
    expect(rows[0].expanded).toBe(true);
    expect(rows[1].node.task.id).toBe('T-1');
    expect(rows[2].node.task.id).toBe('T-2');
  });

  it('should assign sequential index values', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1' }),
    ];
    const tree = buildEpicTree(tasks);
    const rows = flattenTree(tree, new Set(['EPIC-1']));
    expect(rows[0].index).toBe(0);
    expect(rows[1].index).toBe(1);
  });

  it('should not expand nodes with no children even if in expanded set', () => {
    const tasks = [makeTask('A')];
    const tree = buildEpicTree(tasks);
    const rows = flattenTree(tree, new Set(['A']));
    expect(rows).toHaveLength(1);
    expect(rows[0].expanded).toBe(false); // no children → not expanded
  });

  it('should handle nested expansion correctly', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('STORY-1', { parent: 'EPIC-1' }),
      makeTask('TASK-1', { parent: 'STORY-1' }),
    ];
    const tree = buildEpicTree(tasks);
    // Only EPIC-1 expanded → STORY-1 visible but not expanded
    const rows = flattenTree(tree, new Set(['EPIC-1']));
    expect(rows).toHaveLength(2);
    expect(rows[1].node.task.id).toBe('STORY-1');
    expect(rows[1].expanded).toBe(false);

    // Both expanded → TASK-1 visible
    const rows2 = flattenTree(tree, new Set(['EPIC-1', 'STORY-1']));
    expect(rows2).toHaveLength(3);
    expect(rows2[2].node.task.id).toBe('TASK-1');
  });
});

// ── renderProgressBar ─────────────────────────────────────────────────

describe('renderProgressBar', () => {
  it('should return empty string when total is 0', () => {
    expect(renderProgressBar(0, 0)).toBe('');
  });

  it('should render 0% when done=0', () => {
    const bar = renderProgressBar(0, 10);
    expect(bar).toContain('0%');
    expect(bar).toContain('(0/10)');
    expect(bar).toMatch(/^\[/);
    expect(bar).toContain(']');
  });

  it('should render 100% when done=total', () => {
    const bar = renderProgressBar(10, 10);
    expect(bar).toContain('100%');
    expect(bar).toContain('(10/10)');
  });

  it('should render approximately 50% when done=half of total', () => {
    const bar = renderProgressBar(5, 10);
    expect(bar).toContain('50%');
    expect(bar).toContain('(5/10)');
  });

  it('should render bar with correct width', () => {
    const bar = renderProgressBar(4, 8, 8);
    // Extract the bar content between [ and ]
    const match = bar.match(/\[(.+)\]/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(8);
  });

  it('should use default width of 16', () => {
    const bar = renderProgressBar(8, 16);
    const match = bar.match(/\[(.+)\]/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(16);
  });

  it('should show ">" separator between filled and empty regions', () => {
    const bar = renderProgressBar(1, 2, 10);
    // Some filled + ">" + some empty
    expect(bar).toMatch(/[=>]/);
  });

  it('should round percentage correctly', () => {
    const bar = renderProgressBar(1, 3); // 33.3...%
    expect(bar).toContain('33%');
  });
});

// ── priorityColor ─────────────────────────────────────────────────────

describe('priorityColor', () => {
  it('should return red for p0', () => {
    expect(priorityColor('p0')).toBe('red');
  });

  it('should return yellow for p1', () => {
    expect(priorityColor('p1')).toBe('yellow');
  });

  it('should return undefined for p2', () => {
    expect(priorityColor('p2')).toBeUndefined();
  });

  it('should return gray for p3', () => {
    expect(priorityColor('p3')).toBe('gray');
  });

  it('should return undefined for unknown priority', () => {
    expect(priorityColor('unknown')).toBeUndefined();
  });
});

// ── statusColor ───────────────────────────────────────────────────────

describe('statusColor', () => {
  it('should return green for done', () => {
    expect(statusColor('done')).toBe('green');
  });

  it('should return red for failed', () => {
    expect(statusColor('failed')).toBe('red');
  });

  it('should return yellow for blocked', () => {
    expect(statusColor('blocked')).toBe('yellow');
  });

  it('should return yellow for running', () => {
    expect(statusColor('running')).toBe('yellow');
  });

  it('should return blue for dispatched', () => {
    expect(statusColor('dispatched')).toBe('blue');
  });

  it('should return cyan for ready', () => {
    expect(statusColor('ready')).toBe('cyan');
  });

  it('should return undefined for open', () => {
    expect(statusColor('open')).toBeUndefined();
  });

  it('should return undefined for unknown status', () => {
    expect(statusColor('unknown')).toBeUndefined();
  });
});

// ── STATUS_ICON ───────────────────────────────────────────────────────

describe('STATUS_ICON', () => {
  it('should have icons for all standard statuses', () => {
    const expected = ['open', 'ready', 'dispatched', 'running', 'done', 'failed', 'blocked'];
    for (const status of expected) {
      expect(STATUS_ICON[status]).toBeDefined();
      expect(STATUS_ICON[status].length).toBeGreaterThan(0);
    }
  });
});
