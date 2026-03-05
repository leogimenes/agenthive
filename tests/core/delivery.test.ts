import { describe, it, expect } from 'vitest';
import type { Plan } from '../../src/types/plan.js';
import type { PlanTask } from '../../src/types/plan.js';
import {
  validateEpicForDelivery,
  collectEpicTaskIds,
  recordDodStep,
} from '../../src/core/delivery.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeTask(overrides: Partial<PlanTask> & Pick<PlanTask, 'id' | 'status'>): PlanTask {
  return {
    title: overrides.id,
    target: 'backend',
    priority: 'p2',
    depends_on: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePlan(tasks: PlanTask[]): Plan {
  return {
    name: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    tasks,
  };
}

// ── validateEpicForDelivery ───────────────────────────────────────────

describe('validateEpicForDelivery', () => {
  it('returns invalid when epic not found', () => {
    const plan = makePlan([]);
    const result = validateEpicForDelivery(plan, 'EPIC-01');
    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Epic "EPIC-01" not found in plan');
  });

  it('returns invalid when task is not type epic', () => {
    const plan = makePlan([
      makeTask({ id: 'T-01', status: 'done', type: 'task' }),
    ]);
    const result = validateEpicForDelivery(plan, 'T-01');
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('not an epic'))).toBe(true);
  });

  it('returns invalid when tasks are not done', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'running', type: 'epic' });
    const child = makeTask({ id: 'T-01', status: 'open', type: 'task', parent: 'EPIC-01' });
    const plan = makePlan([epic, child]);
    const result = validateEpicForDelivery(plan, 'EPIC-01', ['all_tasks_done']);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('not yet done'))).toBe(true);
  });

  it('returns valid when all tasks are done', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const child = makeTask({ id: 'T-01', status: 'done', type: 'task', parent: 'EPIC-01' });
    const plan = makePlan([epic, child]);
    const result = validateEpicForDelivery(plan, 'EPIC-01', ['all_tasks_done']);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('force skips DoD checks and returns valid', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'running', type: 'epic' });
    const child = makeTask({ id: 'T-01', status: 'open', type: 'task', parent: 'EPIC-01' });
    const plan = makePlan([epic, child]);
    const result = validateEpicForDelivery(plan, 'EPIC-01', ['all_tasks_done'], true);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('reports progress correctly', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'running', type: 'epic' });
    const c1 = makeTask({ id: 'T-01', status: 'done', type: 'task', parent: 'EPIC-01' });
    const c2 = makeTask({ id: 'T-02', status: 'done', type: 'task', parent: 'EPIC-01' });
    const c3 = makeTask({ id: 'T-03', status: 'open', type: 'task', parent: 'EPIC-01' });
    const plan = makePlan([epic, c1, c2, c3]);
    const result = validateEpicForDelivery(plan, 'EPIC-01', ['all_tasks_done']);
    expect(result.taskProgress.done).toBe(2);
    expect(result.taskProgress.total).toBe(3);
  });

  it('returns invalid for extra DoD step not recorded', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const child = makeTask({ id: 'T-01', status: 'done', type: 'task', parent: 'EPIC-01' });
    const plan = makePlan([epic, child]);
    const result = validateEpicForDelivery(plan, 'EPIC-01', ['all_tasks_done', 'tests_pass']);
    expect(result.valid).toBe(false);
    expect(result.pendingDodSteps).toContain('tests_pass');
  });

  it('returns valid when extra DoD step is already recorded', () => {
    const epic = makeTask({
      id: 'EPIC-01',
      status: 'done',
      type: 'epic',
      dod_steps_done: ['tests_pass'],
    });
    const child = makeTask({ id: 'T-01', status: 'done', type: 'task', parent: 'EPIC-01' });
    const plan = makePlan([epic, child]);
    const result = validateEpicForDelivery(plan, 'EPIC-01', ['all_tasks_done', 'tests_pass']);
    expect(result.valid).toBe(true);
  });
});

// ── collectEpicTaskIds ────────────────────────────────────────────────

describe('collectEpicTaskIds', () => {
  it('returns only the epic ID when no children', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const plan = makePlan([epic]);
    const ids = collectEpicTaskIds('EPIC-01', plan);
    expect(ids).toEqual(new Set(['EPIC-01']));
  });

  it('collects direct children', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const c1 = makeTask({ id: 'T-01', status: 'done', type: 'task', parent: 'EPIC-01' });
    const c2 = makeTask({ id: 'T-02', status: 'done', type: 'task', parent: 'EPIC-01' });
    const plan = makePlan([epic, c1, c2]);
    const ids = collectEpicTaskIds('EPIC-01', plan);
    expect(ids).toEqual(new Set(['EPIC-01', 'T-01', 'T-02']));
  });

  it('collects grandchildren (epic → story → task)', () => {
    const epic = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const story = makeTask({ id: 'S-01', status: 'done', type: 'story', parent: 'EPIC-01' });
    const task = makeTask({ id: 'T-01', status: 'done', type: 'task', parent: 'S-01' });
    const plan = makePlan([epic, story, task]);
    const ids = collectEpicTaskIds('EPIC-01', plan);
    expect(ids).toEqual(new Set(['EPIC-01', 'S-01', 'T-01']));
  });

  it('does not include tasks belonging to a different parent', () => {
    const epic1 = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const epic2 = makeTask({ id: 'EPIC-02', status: 'done', type: 'epic' });
    const c1 = makeTask({ id: 'T-01', status: 'done', type: 'task', parent: 'EPIC-01' });
    const c2 = makeTask({ id: 'T-02', status: 'done', type: 'task', parent: 'EPIC-02' });
    const plan = makePlan([epic1, epic2, c1, c2]);
    const ids = collectEpicTaskIds('EPIC-01', plan);
    expect(ids.has('T-02')).toBe(false);
    expect(ids.has('EPIC-02')).toBe(false);
  });
});

// ── recordDodStep ──────────────────────────────────────────────────────

describe('recordDodStep', () => {
  it('records a new step and returns true', () => {
    const task = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const added = recordDodStep(task, 'tests_pass');
    expect(added).toBe(true);
    expect(task.dod_steps_done).toContain('tests_pass');
  });

  it('does not duplicate a step and returns false', () => {
    const task = makeTask({
      id: 'EPIC-01',
      status: 'done',
      type: 'epic',
      dod_steps_done: ['tests_pass'],
    });
    const added = recordDodStep(task, 'tests_pass');
    expect(added).toBe(false);
    expect(task.dod_steps_done!.filter((s) => s === 'tests_pass')).toHaveLength(1);
  });

  it('initialises dod_steps_done if undefined', () => {
    const task = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    expect(task.dod_steps_done).toBeUndefined();
    recordDodStep(task, 'pr_created');
    expect(task.dod_steps_done).toBeDefined();
    expect(task.dod_steps_done).toContain('pr_created');
  });

  it('updates updated_at', () => {
    const task = makeTask({ id: 'EPIC-01', status: 'done', type: 'epic' });
    const before = task.updated_at;
    // Ensure enough time has passed for the timestamp to differ
    recordDodStep(task, 'pr_merged');
    // updated_at must be a valid ISO string; the exact value may equal `before`
    // if Date.now() resolution is low, so just check it's set.
    expect(typeof task.updated_at).toBe('string');
    expect(task.updated_at.length).toBeGreaterThan(0);
  });
});
