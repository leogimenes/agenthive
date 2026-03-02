import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadPlan,
  savePlan,
  createPlan,
  generateId,
  computeReadyTasks,
  computeBlockedTasks,
  getTasksByAgent,
  getDependencyChain,
  validateDAG,
  promoteReadyTasks,
  extractTaskId,
  reconcilePlanWithChat,
  findCriticalPath,
  getChildTasks,
  computeParentStatus,
  sortByPriority,
} from '../../src/core/plan.js';
import type { Plan, PlanTask } from '../../src/types/plan.js';
import type { ChatMessage } from '../../src/types/config.js';

describe('plan', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-test-plan-'));
  });

  afterEach(() => {
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── Helper to make tasks ────────────────────────────────────────────

  function makeTask(overrides: Partial<PlanTask> = {}): PlanTask {
    const now = new Date().toISOString();
    return {
      id: 'test-01',
      title: 'Test task',
      target: 'backend',
      priority: 'p2',
      status: 'open',
      depends_on: [],
      created_at: now,
      updated_at: now,
      ...overrides,
    };
  }

  function makePlan(tasks: PlanTask[] = []): Plan {
    const now = new Date().toISOString();
    return {
      name: 'test-plan',
      created_at: now,
      updated_at: now,
      tasks,
    };
  }

  // ── loadPlan / savePlan ─────────────────────────────────────────────

  describe('loadPlan / savePlan', () => {
    it('should return null when no plan file exists', () => {
      expect(loadPlan(hivePath)).toBeNull();
    });

    it('should save and load a plan', () => {
      const plan = makePlan([makeTask()]);
      savePlan(hivePath, plan);

      const loaded = loadPlan(hivePath);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('test-plan');
      expect(loaded!.tasks).toHaveLength(1);
      expect(loaded!.tasks[0].id).toBe('test-01');
    });

    it('should sort tasks by ID when saving', () => {
      const plan = makePlan([
        makeTask({ id: 'c-task' }),
        makeTask({ id: 'a-task' }),
        makeTask({ id: 'b-task' }),
      ]);
      savePlan(hivePath, plan);

      const loaded = loadPlan(hivePath);
      expect(loaded!.tasks.map((t) => t.id)).toEqual([
        'a-task',
        'b-task',
        'c-task',
      ]);
    });

    it('should write atomically (tmp + rename)', () => {
      const plan = makePlan([makeTask()]);
      savePlan(hivePath, plan);

      // .tmp file should not exist after save
      expect(existsSync(join(hivePath, 'plan.json.tmp'))).toBe(false);
      expect(existsSync(join(hivePath, 'plan.json'))).toBe(true);
    });
  });

  // ── createPlan ──────────────────────────────────────────────────────

  describe('createPlan', () => {
    it('should create an empty plan with name and timestamps', () => {
      const plan = createPlan('my-project');
      expect(plan.name).toBe('my-project');
      expect(plan.tasks).toEqual([]);
      expect(plan.created_at).toBeTruthy();
      expect(plan.updated_at).toBeTruthy();
    });
  });

  // ── generateId ──────────────────────────────────────────────────────

  describe('generateId', () => {
    it('should generate an ID with target prefix', () => {
      const id = generateId('my task', 'backend');
      expect(id).toMatch(/^back-[0-9a-f]{4}$/);
    });

    it('should use custom prefix when provided', () => {
      const id = generateId('my task', 'backend', 'BE');
      expect(id).toMatch(/^BE-[0-9a-f]{4}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId(`task ${i}`, 'backend'));
      }
      // Should have mostly unique IDs (small chance of collision with 4 hex chars)
      expect(ids.size).toBeGreaterThan(90);
    });
  });

  // ── computeReadyTasks ──────────────────────────────────────────────

  describe('computeReadyTasks', () => {
    it('should return open tasks with no deps', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'open', depends_on: [] }),
      ]);
      const ready = computeReadyTasks(plan);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('a');
    });

    it('should return open tasks whose deps are all done', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'done', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      const ready = computeReadyTasks(plan);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('b');
    });

    it('should not return tasks with unmet deps', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'open', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      const ready = computeReadyTasks(plan);
      expect(ready).toHaveLength(1);
      expect(ready[0].id).toBe('a');
    });

    it('should include tasks with ready status', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'ready', depends_on: [] }),
      ]);
      const ready = computeReadyTasks(plan);
      expect(ready).toHaveLength(1);
    });

    it('should sort by priority then creation time', () => {
      const plan = makePlan([
        makeTask({
          id: 'a',
          status: 'open',
          priority: 'p2',
          created_at: '2026-01-01T00:00:00Z',
        }),
        makeTask({
          id: 'b',
          status: 'open',
          priority: 'p0',
          created_at: '2026-01-02T00:00:00Z',
        }),
        makeTask({
          id: 'c',
          status: 'open',
          priority: 'p2',
          created_at: '2026-01-01T00:00:01Z',
        }),
      ]);
      const ready = computeReadyTasks(plan);
      expect(ready.map((t) => t.id)).toEqual(['b', 'a', 'c']);
    });

    it('should not return done, dispatched, or running tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'done' }),
        makeTask({ id: 'b', status: 'dispatched' }),
        makeTask({ id: 'c', status: 'running' }),
      ]);
      const ready = computeReadyTasks(plan);
      expect(ready).toHaveLength(0);
    });
  });

  // ── computeBlockedTasks ────────────────────────────────────────────

  describe('computeBlockedTasks', () => {
    it('should return empty when no failed tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'open' }),
      ]);
      expect(computeBlockedTasks(plan)).toHaveLength(0);
    });

    it('should return tasks depending on failed tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed' }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      const blocked = computeBlockedTasks(plan);
      expect(blocked).toHaveLength(1);
      expect(blocked[0].id).toBe('b');
    });

    it('should cascade blocks transitively', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed' }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
        makeTask({ id: 'c', status: 'open', depends_on: ['b'] }),
      ]);
      const blocked = computeBlockedTasks(plan);
      expect(blocked.map((t) => t.id).sort()).toEqual(['b', 'c']);
    });

    it('should not block done tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed' }),
        makeTask({ id: 'b', status: 'done', depends_on: ['a'] }),
      ]);
      const blocked = computeBlockedTasks(plan);
      expect(blocked).toHaveLength(0);
    });
  });

  // ── getTasksByAgent ────────────────────────────────────────────────

  describe('getTasksByAgent', () => {
    it('should filter tasks by agent name (case-insensitive)', () => {
      const plan = makePlan([
        makeTask({ id: 'a', target: 'backend' }),
        makeTask({ id: 'b', target: 'frontend' }),
        makeTask({ id: 'c', target: 'backend' }),
      ]);
      const result = getTasksByAgent(plan, 'BACKEND');
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.id).sort()).toEqual(['a', 'c']);
    });
  });

  // ── getDependencyChain ─────────────────────────────────────────────

  describe('getDependencyChain', () => {
    it('should return the full chain to roots', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: [] }),
        makeTask({ id: 'b', depends_on: ['a'] }),
        makeTask({ id: 'c', depends_on: ['b'] }),
      ]);
      const chain = getDependencyChain(plan, 'c');
      expect(chain.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('should handle tasks with no deps', () => {
      const plan = makePlan([makeTask({ id: 'a', depends_on: [] })]);
      const chain = getDependencyChain(plan, 'a');
      expect(chain.map((t) => t.id)).toEqual(['a']);
    });
  });

  // ── validateDAG ────────────────────────────────────────────────────

  describe('validateDAG', () => {
    it('should validate a valid DAG', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: [] }),
        makeTask({ id: 'b', depends_on: ['a'] }),
        makeTask({ id: 'c', depends_on: ['a', 'b'] }),
      ]);
      const result = validateDAG(plan);
      expect(result.valid).toBe(true);
      expect(result.cycles).toBeUndefined();
    });

    it('should detect a direct cycle', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: ['b'] }),
        makeTask({ id: 'b', depends_on: ['a'] }),
      ]);
      const result = validateDAG(plan);
      expect(result.valid).toBe(false);
      expect(result.cycles).toBeDefined();
      expect(result.cycles!.length).toBeGreaterThan(0);
    });

    it('should detect an indirect cycle', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: ['c'] }),
        makeTask({ id: 'b', depends_on: ['a'] }),
        makeTask({ id: 'c', depends_on: ['b'] }),
      ]);
      const result = validateDAG(plan);
      expect(result.valid).toBe(false);
    });

    it('should pass with no tasks', () => {
      const plan = makePlan([]);
      expect(validateDAG(plan).valid).toBe(true);
    });
  });

  // ── promoteReadyTasks ──────────────────────────────────────────────

  describe('promoteReadyTasks', () => {
    it('should promote open tasks with no deps to ready', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'open', depends_on: [] }),
      ]);
      const promoted = promoteReadyTasks(plan);
      expect(promoted).toBe(1);
      expect(plan.tasks[0].status).toBe('ready');
    });

    it('should promote open tasks when deps are done', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'done', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      const promoted = promoteReadyTasks(plan);
      expect(promoted).toBe(1);
      expect(plan.tasks.find((t) => t.id === 'b')!.status).toBe('ready');
    });

    it('should not promote tasks with unmet deps', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'open', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      promoteReadyTasks(plan);
      expect(plan.tasks.find((t) => t.id === 'b')!.status).toBe('open');
    });

    it('should block tasks when dependencies fail', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      promoteReadyTasks(plan);
      expect(plan.tasks.find((t) => t.id === 'b')!.status).toBe('blocked');
    });
  });

  // ── extractTaskId ──────────────────────────────────────────────────

  describe('extractTaskId', () => {
    it('should extract bracketed task IDs', () => {
      const plan = makePlan([makeTask({ id: 'BE-06' })]);
      expect(extractTaskId('Completed [BE-06] pagination', plan)).toBe(
        'BE-06',
      );
    });

    it('should find known IDs in message body', () => {
      const plan = makePlan([makeTask({ id: 'BE-06' })]);
      expect(
        extractTaskId('implemented BE-06 pagination endpoint', plan),
      ).toBe('BE-06');
    });

    it('should be case-insensitive', () => {
      const plan = makePlan([makeTask({ id: 'BE-06' })]);
      expect(extractTaskId('completed be-06', plan)).toBe('BE-06');
    });

    it('should return null when no ID matches', () => {
      const plan = makePlan([makeTask({ id: 'BE-06' })]);
      expect(extractTaskId('did something', plan)).toBeNull();
    });
  });

  // ── reconcilePlanWithChat ──────────────────────────────────────────

  describe('reconcilePlanWithChat', () => {
    it('should mark task done on DONE message', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-06', status: 'dispatched', target: 'backend' }),
      ]);

      const messages: ChatMessage[] = [
        {
          role: 'BACKEND',
          type: 'DONE',
          body: 'Completed [BE-06] pagination',
          lineNumber: 1,
        },
      ];

      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(1);
      expect(updates[0].taskId).toBe('BE-06');
      expect(updates[0].newStatus).toBe('done');
      expect(plan.tasks[0].status).toBe('done');
      expect(plan.tasks[0].completed_at).toBeTruthy();
    });

    it('should mark task failed on BLOCKER message', () => {
      const plan = makePlan([
        makeTask({ id: 'FE-06', status: 'running', target: 'frontend' }),
      ]);

      const messages: ChatMessage[] = [
        {
          role: 'FRONTEND',
          type: 'BLOCKER',
          body: 'Rebase conflict on [FE-06]',
          lineNumber: 1,
        },
      ];

      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(1);
      expect(updates[0].newStatus).toBe('failed');
    });

    it('should infer task when agent has exactly one active task', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-06', status: 'dispatched', target: 'backend' }),
      ]);

      const messages: ChatMessage[] = [
        {
          role: 'BACKEND',
          type: 'DONE',
          body: 'Implemented pagination',
          lineNumber: 1,
        },
      ];

      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(1);
      expect(updates[0].taskId).toBe('BE-06');
    });

    it('should cascade ready promotions after completion', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'dispatched', target: 'backend' }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);

      const messages: ChatMessage[] = [
        {
          role: 'BACKEND',
          type: 'DONE',
          body: 'Completed [a]',
          lineNumber: 1,
        },
      ];

      reconcilePlanWithChat(plan, messages);
      expect(plan.tasks.find((t) => t.id === 'a')!.status).toBe('done');
      expect(plan.tasks.find((t) => t.id === 'b')!.status).toBe('ready');
    });

    it('should not update already-done tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-06', status: 'done' }),
      ]);

      const messages: ChatMessage[] = [
        {
          role: 'BACKEND',
          type: 'DONE',
          body: 'Completed [BE-06]',
          lineNumber: 1,
        },
      ];

      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(0);
    });
  });

  // ── findCriticalPath ───────────────────────────────────────────────

  describe('findCriticalPath', () => {
    it('should find the longest chain of non-done tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'ready', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
        makeTask({ id: 'c', status: 'open', depends_on: ['b'] }),
        makeTask({ id: 'd', status: 'ready', depends_on: [] }),
      ]);
      const cp = findCriticalPath(plan);
      expect(cp.length).toBe(3);
      expect(cp.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('should return empty for all-done plan', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'done' }),
      ]);
      expect(findCriticalPath(plan)).toHaveLength(0);
    });
  });

  // ── getChildTasks / computeParentStatus ────────────────────────────

  describe('hierarchical tasks', () => {
    it('should get child tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent' }),
        makeTask({ id: 'child-2', parent: 'parent' }),
        makeTask({ id: 'other' }),
      ]);
      const children = getChildTasks(plan, 'parent');
      expect(children).toHaveLength(2);
    });

    it('should compute parent status: all done', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'done' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('done');
      expect(ps.done).toBe(2);
      expect(ps.total).toBe(2);
    });

    it('should compute parent status: running', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'running' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('running');
    });

    it('should compute parent status: warning on failed child', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'failed' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('warning');
    });
  });

  // ── sortByPriority ─────────────────────────────────────────────────

  describe('sortByPriority', () => {
    it('should sort p0 before p3', () => {
      const tasks = [
        makeTask({ id: 'a', priority: 'p3' }),
        makeTask({ id: 'b', priority: 'p0' }),
      ];
      const sorted = sortByPriority(tasks);
      expect(sorted[0].id).toBe('b');
      expect(sorted[1].id).toBe('a');
    });
  });
});
