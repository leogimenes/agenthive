import { describe, it, expect } from 'vitest';
import type { PlanTask } from '../../src/types/plan.js';
import {
  getEpicDescendants,
  getEpicReadyTasks,
  buildEpicTree,
  flattenTree,
} from '../../src/tui/utils/epicTree.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<PlanTask> = {}): PlanTask {
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

// ── getEpicDescendants ─────────────────────────────────────────────────

describe('getEpicDescendants', () => {
  it('should return only the epic itself when it has no children', () => {
    const tasks = [makeTask('EPIC-1'), makeTask('EPIC-2')];
    const result = getEpicDescendants(tasks, 'EPIC-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('EPIC-1');
  });

  it('should return the epic and its direct children', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1' }),
      makeTask('T-2', { parent: 'EPIC-1' }),
      makeTask('EPIC-2'),
    ];
    const result = getEpicDescendants(tasks, 'EPIC-1');
    expect(result).toHaveLength(3);
    const ids = result.map((t) => t.id);
    expect(ids).toContain('EPIC-1');
    expect(ids).toContain('T-1');
    expect(ids).toContain('T-2');
    expect(ids).not.toContain('EPIC-2');
  });

  it('should return the epic and all nested descendants', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('STORY-1', { parent: 'EPIC-1' }),
      makeTask('TASK-1', { parent: 'STORY-1' }),
      makeTask('TASK-2', { parent: 'STORY-1' }),
    ];
    const result = getEpicDescendants(tasks, 'EPIC-1');
    expect(result).toHaveLength(4);
    const ids = result.map((t) => t.id);
    expect(ids).toContain('EPIC-1');
    expect(ids).toContain('STORY-1');
    expect(ids).toContain('TASK-1');
    expect(ids).toContain('TASK-2');
  });

  it('should return empty array for unknown epic ID', () => {
    const tasks = [makeTask('EPIC-1')];
    const result = getEpicDescendants(tasks, 'NONEXISTENT');
    expect(result).toHaveLength(0);
  });

  it('should return empty array for empty task list', () => {
    const result = getEpicDescendants([], 'EPIC-1');
    expect(result).toHaveLength(0);
  });

  it('should not include siblings or other epics', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('EPIC-2'),
      makeTask('T-1', { parent: 'EPIC-1' }),
      makeTask('T-2', { parent: 'EPIC-2' }),
    ];
    const result = getEpicDescendants(tasks, 'EPIC-1');
    const ids = result.map((t) => t.id);
    expect(ids).not.toContain('EPIC-2');
    expect(ids).not.toContain('T-2');
  });
});

// ── getEpicReadyTasks ──────────────────────────────────────────────────

describe('getEpicReadyTasks', () => {
  it('should return empty array when no children are ready', () => {
    const tasks = [
      makeTask('EPIC-1', { status: 'open' }),
      makeTask('T-1', { parent: 'EPIC-1', status: 'open' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'running' }),
    ];
    const result = getEpicReadyTasks(tasks, 'EPIC-1');
    expect(result).toHaveLength(0);
  });

  it('should return only ready children (not the epic itself)', () => {
    const tasks = [
      makeTask('EPIC-1', { status: 'ready' }),
      makeTask('T-1', { parent: 'EPIC-1', status: 'ready' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'open' }),
    ];
    const result = getEpicReadyTasks(tasks, 'EPIC-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('T-1');
    // The epic itself is excluded
    const ids = result.map((t) => t.id);
    expect(ids).not.toContain('EPIC-1');
  });

  it('should return all ready tasks across nested levels', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('STORY-1', { parent: 'EPIC-1', status: 'ready' }),
      makeTask('TASK-1', { parent: 'STORY-1', status: 'ready' }),
      makeTask('TASK-2', { parent: 'STORY-1', status: 'done' }),
    ];
    const result = getEpicReadyTasks(tasks, 'EPIC-1');
    expect(result).toHaveLength(2);
    const ids = result.map((t) => t.id);
    expect(ids).toContain('STORY-1');
    expect(ids).toContain('TASK-1');
  });

  it('should return empty for an epic with no children', () => {
    const tasks = [makeTask('EPIC-1', { status: 'ready' })];
    const result = getEpicReadyTasks(tasks, 'EPIC-1');
    expect(result).toHaveLength(0);
  });

  it('should return empty for unknown epic', () => {
    const tasks = [makeTask('T-1', { status: 'ready' })];
    const result = getEpicReadyTasks(tasks, 'NONEXISTENT');
    expect(result).toHaveLength(0);
  });

  it('should not include done, failed, running, or dispatched tasks', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1', status: 'done' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'failed' }),
      makeTask('T-3', { parent: 'EPIC-1', status: 'running' }),
      makeTask('T-4', { parent: 'EPIC-1', status: 'dispatched' }),
      makeTask('T-5', { parent: 'EPIC-1', status: 'ready' }),
    ];
    const result = getEpicReadyTasks(tasks, 'EPIC-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('T-5');
  });
});

// ── State transition scenarios ─────────────────────────────────────────

describe('Epic dispatch state transitions', () => {
  it('should show no ready tasks when all children are done', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1', status: 'done' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'done' }),
    ];
    expect(getEpicReadyTasks(tasks, 'EPIC-1')).toHaveLength(0);
  });

  it('should correctly identify an epic with mixed task statuses for start action', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1', status: 'done' }),
      makeTask('T-2', { parent: 'EPIC-1', status: 'ready' }),
      makeTask('T-3', { parent: 'EPIC-1', status: 'ready' }),
      makeTask('T-4', { parent: 'EPIC-1', status: 'open' }),
    ];
    const readyTasks = getEpicReadyTasks(tasks, 'EPIC-1');
    expect(readyTasks).toHaveLength(2);
    expect(readyTasks.map((t) => t.id)).toEqual(
      expect.arrayContaining(['T-2', 'T-3']),
    );
  });

  it('should track paused state transition correctly via Set operations', () => {
    // Simulate toggling paused state
    let pausedEpics = new Set<string>();

    // Pause EPIC-1
    const next1 = new Set(pausedEpics);
    next1.add('EPIC-1');
    pausedEpics = next1;
    expect(pausedEpics.has('EPIC-1')).toBe(true);

    // Pause EPIC-2
    const next2 = new Set(pausedEpics);
    next2.add('EPIC-2');
    pausedEpics = next2;
    expect(pausedEpics.has('EPIC-2')).toBe(true);

    // Resume EPIC-1
    const next3 = new Set(pausedEpics);
    next3.delete('EPIC-1');
    pausedEpics = next3;
    expect(pausedEpics.has('EPIC-1')).toBe(false);
    expect(pausedEpics.has('EPIC-2')).toBe(true);
  });

  it('should allow navigating to epic detail and back (via tree rows)', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1' }),
      makeTask('EPIC-2'),
    ];
    const tree = buildEpicTree(tasks);

    // Start with nothing expanded — only roots visible
    const rows = flattenTree(tree, new Set());
    expect(rows).toHaveLength(2); // EPIC-1, EPIC-2

    // Select EPIC-1 (index 0)
    const selectedRow = rows[0];
    expect(selectedRow.node.task.id).toBe('EPIC-1');

    // epicDetailMode: true → show EpicDispatchPanel for EPIC-1
    const epicId = selectedRow.node.task.id;
    const descendants = getEpicDescendants(tasks, epicId);
    expect(descendants).toHaveLength(2); // EPIC-1 + T-1
  });

  it('should expand/collapse independently of epic detail mode', () => {
    const tasks = [
      makeTask('EPIC-1'),
      makeTask('T-1', { parent: 'EPIC-1' }),
    ];
    const tree = buildEpicTree(tasks);

    // Not expanded → 1 row
    const rows = flattenTree(tree, new Set());
    expect(rows).toHaveLength(1);

    // Expanded → 2 rows, but entering detail doesn't change expansion
    const rowsExpanded = flattenTree(tree, new Set(['EPIC-1']));
    expect(rowsExpanded).toHaveLength(2);

    // In detail mode, the selected epic ID is determined by the selected index
    const selectedInExpanded = rowsExpanded[0];
    expect(selectedInExpanded.node.task.id).toBe('EPIC-1');
  });
});
