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
  dispatchTask,
  resetTaskForRetry,
  DEFAULT_MAX_RETRIES,
  getChildren,
  getAncestors,
  validateParentType,
  notifyEpicCompletions,
  evaluateDefinitionOfDone,
} from '../../src/core/plan.js';
import type { Plan, PlanTask, TaskType } from '../../src/types/plan.js';
import type { ChatMessage } from '../../src/types/config.js';
import { initChatFile, readMessages } from '../../src/core/chat.js';

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

  // ── savePlan auto-updates parent statuses ───────────────────────────

  describe('savePlan auto-updates parent statuses', () => {
    it('should set parent status to done when all children are done', () => {
      const plan = makePlan([
        makeTask({ id: 'story-1', status: 'open' }),
        makeTask({ id: 'task-1', parent: 'story-1', status: 'done' }),
        makeTask({ id: 'task-2', parent: 'story-1', status: 'done' }),
      ]);
      savePlan(hivePath, plan);
      const loaded = loadPlan(hivePath);
      expect(loaded!.tasks.find((t) => t.id === 'story-1')!.status).toBe('done');
    });

    it('should set parent status to blocked when a child has failed', () => {
      const plan = makePlan([
        makeTask({ id: 'story-1', status: 'open' }),
        makeTask({ id: 'task-1', parent: 'story-1', status: 'failed' }),
        makeTask({ id: 'task-2', parent: 'story-1', status: 'open' }),
      ]);
      savePlan(hivePath, plan);
      const loaded = loadPlan(hivePath);
      expect(loaded!.tasks.find((t) => t.id === 'story-1')!.status).toBe('blocked');
    });

    it('should set parent status to running when a child is running', () => {
      const plan = makePlan([
        makeTask({ id: 'story-1', status: 'open' }),
        makeTask({ id: 'task-1', parent: 'story-1', status: 'running' }),
        makeTask({ id: 'task-2', parent: 'story-1', status: 'open' }),
      ]);
      savePlan(hivePath, plan);
      const loaded = loadPlan(hivePath);
      expect(loaded!.tasks.find((t) => t.id === 'story-1')!.status).toBe('running');
    });

    it('should propagate parent status up multi-level hierarchy', () => {
      const plan = makePlan([
        makeTask({ id: 'epic-1', status: 'open' }),
        makeTask({ id: 'story-1', parent: 'epic-1', status: 'open' }),
        makeTask({ id: 'task-1', parent: 'story-1', status: 'done' }),
        makeTask({ id: 'task-2', parent: 'story-1', status: 'done' }),
      ]);
      savePlan(hivePath, plan);
      const loaded = loadPlan(hivePath);
      expect(loaded!.tasks.find((t) => t.id === 'story-1')!.status).toBe('done');
      expect(loaded!.tasks.find((t) => t.id === 'epic-1')!.status).toBe('done');
    });

    it('should not change status of tasks with no children', () => {
      const plan = makePlan([
        makeTask({ id: 'task-1', status: 'dispatched' }),
      ]);
      savePlan(hivePath, plan);
      const loaded = loadPlan(hivePath);
      expect(loaded!.tasks.find((t) => t.id === 'task-1')!.status).toBe('dispatched');
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

    it('should not promote child task to ready when parent is blocked', () => {
      const plan = makePlan([
        makeTask({ id: 'story-1', status: 'blocked', depends_on: [] }),
        makeTask({ id: 'task-1', parent: 'story-1', status: 'open', depends_on: [] }),
      ]);
      promoteReadyTasks(plan);
      expect(plan.tasks.find((t) => t.id === 'task-1')!.status).toBe('open');
    });

    it('should promote child task to ready when parent is not blocked', () => {
      const plan = makePlan([
        makeTask({ id: 'story-1', status: 'open', depends_on: [] }),
        makeTask({ id: 'task-1', parent: 'story-1', status: 'open', depends_on: [] }),
      ]);
      promoteReadyTasks(plan);
      expect(plan.tasks.find((t) => t.id === 'task-1')!.status).toBe('ready');
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

    it('should compute parent status: blocked when a child has failed', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'failed' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('blocked');
    });

    it('should compute parent status: ready when some children are ready (no running/failed)', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'ready' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('ready');
    });

    it('should compute parent status: open when all children are open', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'open' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('open');
    });

    it('should include running, failed, blocked counts in progress', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'running' }),
        makeTask({ id: 'child-3', parent: 'parent', status: 'failed' }),
        makeTask({ id: 'child-4', parent: 'parent', status: 'blocked' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.done).toBe(1);
      expect(ps.total).toBe(4);
      expect(ps.running).toBe(1);
      expect(ps.failed).toBe(1);
      expect(ps.blocked).toBe(1);
    });

    it('should prioritise blocked over running in parent status', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'running' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'failed' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('blocked');
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

  // ── dispatchTask ──────────────────────────────────────────────────

  describe('dispatchTask', () => {
    it('should set task status to dispatched', () => {
      const chatFile = initChatFile(hivePath);
      const task = makeTask({ id: 'BE-01', status: 'ready', title: 'Build API' });

      dispatchTask(chatFile, task, 'BACKEND');

      expect(task.status).toBe('dispatched');
      expect(task.dispatched_at).toBeTruthy();
      expect(task.updated_at).toBeTruthy();
    });

    it('should append a REQUEST message to the chat file', () => {
      const chatFile = initChatFile(hivePath);
      const task = makeTask({ id: 'BE-01', status: 'ready', title: 'Build API' });

      dispatchTask(chatFile, task, 'BACKEND');

      const messages = readMessages(chatFile);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('USER');
      expect(messages[0].type).toBe('REQUEST');
      expect(messages[0].body).toContain('@BACKEND');
      expect(messages[0].body).toContain('[BE-01]');
      expect(messages[0].body).toContain('Build API');
    });

    it('should include first line of description in the message', () => {
      const chatFile = initChatFile(hivePath);
      const task = makeTask({
        id: 'FE-01',
        status: 'ready',
        title: 'Build login page',
        description: 'Add JWT token handling.\nAlso add refresh token logic.',
      });

      dispatchTask(chatFile, task, 'FRONTEND');

      const messages = readMessages(chatFile);
      expect(messages[0].body).toContain('. Add JWT token handling.');
      // Should NOT include the second line
      expect(messages[0].body).not.toContain('refresh token');
    });

    it('should work without a description', () => {
      const chatFile = initChatFile(hivePath);
      const task = makeTask({ id: 'QA-01', status: 'ready', title: 'Write tests' });

      dispatchTask(chatFile, task, 'QA');

      const messages = readMessages(chatFile);
      expect(messages[0].body).toBe('@QA: [QA-01] Write tests');
    });

    it('should dispatch multiple tasks to the same chat file', () => {
      const chatFile = initChatFile(hivePath);
      const task1 = makeTask({ id: 'BE-01', status: 'ready', title: 'Build API' });
      const task2 = makeTask({ id: 'FE-01', status: 'ready', title: 'Build UI' });

      dispatchTask(chatFile, task1, 'BACKEND');
      dispatchTask(chatFile, task2, 'FRONTEND');

      const messages = readMessages(chatFile);
      expect(messages).toHaveLength(2);
      expect(messages[0].body).toContain('[BE-01]');
      expect(messages[1].body).toContain('[FE-01]');
    });
  });

  // ── resetTaskForRetry ──────────────────────────────────────────────

  describe('resetTaskForRetry', () => {
    it('should reset task to open and increment retry_count when below max_retries', () => {
      const task = makeTask({ id: 'BE-01', status: 'dispatched', retry_count: 0, max_retries: 3 });
      const result = resetTaskForRetry(task, 'spawn failed');
      expect(result).toBe('retry');
      expect(task.status).toBe('open');
      expect(task.retry_count).toBe(1);
    });

    it('should mark task failed when retry_count has reached max_retries', () => {
      const task = makeTask({ id: 'BE-01', status: 'dispatched', retry_count: 3, max_retries: 3 });
      const result = resetTaskForRetry(task);
      expect(result).toBe('failed');
      expect(task.status).toBe('failed');
    });

    it('should still increment retry_count when marking failed', () => {
      const task = makeTask({ id: 'BE-01', status: 'dispatched', retry_count: 3, max_retries: 3 });
      resetTaskForRetry(task);
      expect(task.retry_count).toBe(4);
    });

    it('should use DEFAULT_MAX_RETRIES when max_retries is not set on the task', () => {
      const task = makeTask({ id: 'BE-01', status: 'dispatched' });

      // Call DEFAULT_MAX_RETRIES times — all should succeed
      for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
        const result = resetTaskForRetry(task);
        expect(result).toBe('retry');
        expect(task.status).toBe('open');
      }

      // One more should exhaust retries
      const result = resetTaskForRetry(task);
      expect(result).toBe('failed');
      expect(task.status).toBe('failed');
    });

    it('should set last_error when error message is provided', () => {
      const task = makeTask({ id: 'BE-01', status: 'dispatched' });
      resetTaskForRetry(task, 'spawn failed: ENOENT');
      expect(task.last_error).toBe('spawn failed: ENOENT');
    });

    it('should update last_error on subsequent retries', () => {
      const task = makeTask({ id: 'BE-01', status: 'dispatched', max_retries: 5 });
      resetTaskForRetry(task, 'first error');
      expect(task.last_error).toBe('first error');
      resetTaskForRetry(task, 'second error');
      expect(task.last_error).toBe('second error');
    });

    it('should update updated_at timestamp on retry', () => {
      const oldTime = '2026-01-01T00:00:00Z';
      const task = makeTask({ id: 'BE-01', status: 'dispatched', updated_at: oldTime });
      resetTaskForRetry(task);
      expect(task.updated_at).not.toBe(oldTime);
    });

    it('should update updated_at timestamp even when marking failed', () => {
      const oldTime = '2026-01-01T00:00:00Z';
      const task = makeTask({ id: 'BE-01', status: 'dispatched', retry_count: 3, max_retries: 3, updated_at: oldTime });
      resetTaskForRetry(task);
      expect(task.updated_at).not.toBe(oldTime);
    });

    it('should allow retry with max_retries: 0 — immediately fail on first attempt', () => {
      const task = makeTask({ id: 'BE-01', status: 'dispatched', retry_count: 0, max_retries: 0 });
      const result = resetTaskForRetry(task);
      expect(result).toBe('failed');
      expect(task.status).toBe('failed');
    });
  });

  // ── TaskType field ──────────────────────────────────────────────────

  describe('TaskType field', () => {
    it('should accept epic type on a task', () => {
      const task = makeTask({ id: 'EP-01', type: 'epic' as TaskType });
      expect(task.type).toBe('epic');
    });

    it('should accept story type on a task', () => {
      const task = makeTask({ id: 'ST-01', type: 'story' as TaskType });
      expect(task.type).toBe('story');
    });

    it('should accept task type on a task', () => {
      const task = makeTask({ id: 'TA-01', type: 'task' as TaskType });
      expect(task.type).toBe('task');
    });

    it('should default to undefined when type is not set', () => {
      const task = makeTask({ id: 'TA-01' });
      expect(task.type).toBeUndefined();
    });

    it('should persist type through save/load', () => {
      const plan = makePlan([makeTask({ id: 'EP-01', type: 'epic' as TaskType })]);
      savePlan(hivePath, plan);
      const loaded = loadPlan(hivePath);
      expect(loaded!.tasks[0].type).toBe('epic');
    });
  });

  // ── getChildren ────────────────────────────────────────────────────

  describe('getChildren', () => {
    it('should return direct children of a task', () => {
      const plan = makePlan([
        makeTask({ id: 'epic-1', type: 'epic' as TaskType }),
        makeTask({ id: 'story-1', type: 'story' as TaskType, parent: 'epic-1' }),
        makeTask({ id: 'story-2', type: 'story' as TaskType, parent: 'epic-1' }),
        makeTask({ id: 'task-1', type: 'task' as TaskType, parent: 'story-1' }),
      ]);
      const children = getChildren(plan, 'epic-1');
      expect(children).toHaveLength(2);
      expect(children.map((t) => t.id).sort()).toEqual(['story-1', 'story-2']);
    });

    it('should return empty array when task has no children', () => {
      const plan = makePlan([
        makeTask({ id: 'task-1', type: 'task' as TaskType }),
      ]);
      expect(getChildren(plan, 'task-1')).toHaveLength(0);
    });

    it('should only return direct children (not grandchildren)', () => {
      const plan = makePlan([
        makeTask({ id: 'epic-1', type: 'epic' as TaskType }),
        makeTask({ id: 'story-1', type: 'story' as TaskType, parent: 'epic-1' }),
        makeTask({ id: 'task-1', type: 'task' as TaskType, parent: 'story-1' }),
      ]);
      const children = getChildren(plan, 'epic-1');
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe('story-1');
    });
  });

  // ── getAncestors ───────────────────────────────────────────────────

  describe('getAncestors', () => {
    it('should return empty array for a root task', () => {
      const plan = makePlan([
        makeTask({ id: 'epic-1', type: 'epic' as TaskType }),
      ]);
      expect(getAncestors(plan, 'epic-1')).toHaveLength(0);
    });

    it('should return parent for a task one level deep', () => {
      const plan = makePlan([
        makeTask({ id: 'epic-1', type: 'epic' as TaskType }),
        makeTask({ id: 'story-1', type: 'story' as TaskType, parent: 'epic-1' }),
      ]);
      const ancestors = getAncestors(plan, 'story-1');
      expect(ancestors).toHaveLength(1);
      expect(ancestors[0].id).toBe('epic-1');
    });

    it('should return full ancestor chain ordered from root to direct parent', () => {
      const plan = makePlan([
        makeTask({ id: 'epic-1', type: 'epic' as TaskType }),
        makeTask({ id: 'story-1', type: 'story' as TaskType, parent: 'epic-1' }),
        makeTask({ id: 'task-1', type: 'task' as TaskType, parent: 'story-1' }),
      ]);
      const ancestors = getAncestors(plan, 'task-1');
      expect(ancestors).toHaveLength(2);
      expect(ancestors[0].id).toBe('epic-1');
      expect(ancestors[1].id).toBe('story-1');
    });

    it('should return empty for a task with unknown parent', () => {
      const plan = makePlan([
        makeTask({ id: 'task-1', parent: 'nonexistent' }),
      ]);
      expect(getAncestors(plan, 'task-1')).toHaveLength(0);
    });

    it('should stop traversal at cycles to avoid infinite loops', () => {
      const plan = makePlan([
        makeTask({ id: 'a', parent: 'b' }),
        makeTask({ id: 'b', parent: 'a' }),
      ]);
      // Should not throw; just return what it can
      const ancestors = getAncestors(plan, 'a');
      expect(ancestors.length).toBeLessThanOrEqual(2);
    });
  });

  // ── validateParentType ─────────────────────────────────────────────

  describe('validateParentType', () => {
    it('should allow epic as parent of story', () => {
      const parent = makeTask({ id: 'epic-1', type: 'epic' as TaskType });
      const child = makeTask({ id: 'story-1', type: 'story' as TaskType });
      expect(validateParentType(parent, child)).toBe(true);
    });

    it('should allow epic as parent of task', () => {
      const parent = makeTask({ id: 'epic-1', type: 'epic' as TaskType });
      const child = makeTask({ id: 'task-1', type: 'task' as TaskType });
      expect(validateParentType(parent, child)).toBe(true);
    });

    it('should allow story as parent of task', () => {
      const parent = makeTask({ id: 'story-1', type: 'story' as TaskType });
      const child = makeTask({ id: 'task-1', type: 'task' as TaskType });
      expect(validateParentType(parent, child)).toBe(true);
    });

    it('should disallow task as parent of any typed child', () => {
      const parent = makeTask({ id: 'task-1', type: 'task' as TaskType });
      const child = makeTask({ id: 'task-2', type: 'task' as TaskType });
      expect(validateParentType(parent, child)).toBe(false);
    });

    it('should disallow story as parent of story', () => {
      const parent = makeTask({ id: 'story-1', type: 'story' as TaskType });
      const child = makeTask({ id: 'story-2', type: 'story' as TaskType });
      expect(validateParentType(parent, child)).toBe(false);
    });

    it('should disallow story as parent of epic', () => {
      const parent = makeTask({ id: 'story-1', type: 'story' as TaskType });
      const child = makeTask({ id: 'epic-1', type: 'epic' as TaskType });
      expect(validateParentType(parent, child)).toBe(false);
    });

    it('should disallow epic as parent of epic', () => {
      const parent = makeTask({ id: 'epic-1', type: 'epic' as TaskType });
      const child = makeTask({ id: 'epic-2', type: 'epic' as TaskType });
      expect(validateParentType(parent, child)).toBe(false);
    });

    it('should allow any parent when child type is not set', () => {
      const parent = makeTask({ id: 'task-1', type: 'task' as TaskType });
      const child = makeTask({ id: 'child-1' }); // no type
      expect(validateParentType(parent, child)).toBe(true);
    });

    it('should allow any child when parent type is not set', () => {
      const parent = makeTask({ id: 'parent-1' }); // no type
      const child = makeTask({ id: 'child-1', type: 'task' as TaskType });
      expect(validateParentType(parent, child)).toBe(true);
    });
  });

  // ── notifyEpicCompletions ───────────────────────────────────────────

  describe('notifyEpicCompletions', () => {
    it('should append a STATUS message to chat when an epic is done', () => {
      const chatPath = initChatFile(hivePath);
      const epic = makeTask({ id: 'EP-01', type: 'epic' as TaskType, status: 'done', title: 'My Epic' });
      const child1 = makeTask({ id: 'T-01', parent: 'EP-01', status: 'done' });
      const child2 = makeTask({ id: 'T-02', parent: 'EP-01', status: 'done' });
      const plan = makePlan([epic, child1, child2]);

      const notified = notifyEpicCompletions(plan, chatPath);

      expect(notified).toEqual(['EP-01']);
      expect(epic.completion_notified).toBe(true);
      const messages = readMessages(chatPath);
      const statusMsg = messages.find((m) => m.type === 'STATUS' && m.body.includes('EP-01'));
      expect(statusMsg).toBeDefined();
      expect(statusMsg?.body).toContain('2/2');
    });

    it('should not notify again if already notified', () => {
      const chatPath = initChatFile(hivePath);
      const epic = makeTask({ id: 'EP-02', type: 'epic' as TaskType, status: 'done', completion_notified: true });
      const child = makeTask({ id: 'T-03', parent: 'EP-02', status: 'done' });
      const plan = makePlan([epic, child]);

      const notified = notifyEpicCompletions(plan, chatPath);

      expect(notified).toHaveLength(0);
      const messages = readMessages(chatPath);
      expect(messages.filter((m) => m.body.includes('EP-02'))).toHaveLength(0);
    });

    it('should not notify if epic is not done', () => {
      const chatPath = initChatFile(hivePath);
      const epic = makeTask({ id: 'EP-03', type: 'epic' as TaskType, status: 'running' });
      const child1 = makeTask({ id: 'T-04', parent: 'EP-03', status: 'done' });
      const child2 = makeTask({ id: 'T-05', parent: 'EP-03', status: 'running' });
      const plan = makePlan([epic, child1, child2]);

      const notified = notifyEpicCompletions(plan, chatPath);

      expect(notified).toHaveLength(0);
    });

    it('should include cost in message when children have actual_cost', () => {
      const chatPath = initChatFile(hivePath);
      const epic = makeTask({ id: 'EP-04', type: 'epic' as TaskType, status: 'done' });
      const child1 = makeTask({ id: 'T-06', parent: 'EP-04', status: 'done', actual_cost: 0.5 });
      const child2 = makeTask({ id: 'T-07', parent: 'EP-04', status: 'done', actual_cost: 0.3 });
      const plan = makePlan([epic, child1, child2]);

      notifyEpicCompletions(plan, chatPath);

      const messages = readMessages(chatPath);
      const statusMsg = messages.find((m) => m.body.includes('EP-04'));
      expect(statusMsg?.body).toContain('$0.80');
    });

    it('should not notify epics with no children', () => {
      const chatPath = initChatFile(hivePath);
      const epic = makeTask({ id: 'EP-05', type: 'epic' as TaskType, status: 'done' });
      const plan = makePlan([epic]);

      const notified = notifyEpicCompletions(plan, chatPath);
      expect(notified).toHaveLength(0);
    });

    it('should not notify when extra DoD steps are not yet confirmed', () => {
      const chatPath = initChatFile(hivePath);
      const epic = makeTask({ id: 'EP-06', type: 'epic' as TaskType, status: 'done' });
      const child = makeTask({ id: 'T-08', parent: 'EP-06', status: 'done' });
      const plan = makePlan([epic, child]);

      // tests_pass not recorded on epic.dod_steps_done
      const notified = notifyEpicCompletions(plan, chatPath, ['all_tasks_done', 'tests_pass']);
      expect(notified).toHaveLength(0);
    });

    it('should notify when all DoD steps including external ones are confirmed', () => {
      const chatPath = initChatFile(hivePath);
      const epic = makeTask({
        id: 'EP-07',
        type: 'epic' as TaskType,
        status: 'done',
        dod_steps_done: ['tests_pass', 'pr_created'],
      });
      const child = makeTask({ id: 'T-09', parent: 'EP-07', status: 'done' });
      const plan = makePlan([epic, child]);

      const notified = notifyEpicCompletions(plan, chatPath, ['all_tasks_done', 'tests_pass', 'pr_created']);
      expect(notified).toHaveLength(1);
      expect(notified[0]).toBe('EP-07');
    });
  });

  // ── evaluateDefinitionOfDone ──────────────────────────────────────

  describe('evaluateDefinitionOfDone', () => {
    it('should be satisfied with all_tasks_done when all children are done', () => {
      const epic = makeTask({ id: 'EPIC-A', type: 'epic' as TaskType, status: 'done' });
      const child = makeTask({ id: 'T-A1', parent: 'EPIC-A', status: 'done' });
      const plan = makePlan([epic, child]);

      const result = evaluateDefinitionOfDone(epic, plan, ['all_tasks_done']);
      expect(result.satisfied).toBe(true);
      expect(result.pending).toHaveLength(0);
    });

    it('should be pending all_tasks_done when a child is not done', () => {
      const epic = makeTask({ id: 'EPIC-B', type: 'epic' as TaskType, status: 'running' });
      const child1 = makeTask({ id: 'T-B1', parent: 'EPIC-B', status: 'done' });
      const child2 = makeTask({ id: 'T-B2', parent: 'EPIC-B', status: 'open' });
      const plan = makePlan([epic, child1, child2]);

      const result = evaluateDefinitionOfDone(epic, plan, ['all_tasks_done']);
      expect(result.satisfied).toBe(false);
      expect(result.pending).toContain('all_tasks_done');
    });

    it('should be pending external steps not recorded on dod_steps_done', () => {
      const epic = makeTask({ id: 'EPIC-C', type: 'epic' as TaskType, status: 'done' });
      const child = makeTask({ id: 'T-C1', parent: 'EPIC-C', status: 'done' });
      const plan = makePlan([epic, child]);

      const result = evaluateDefinitionOfDone(epic, plan, ['all_tasks_done', 'pr_merged']);
      expect(result.satisfied).toBe(false);
      expect(result.pending).toContain('pr_merged');
    });

    it('should be satisfied when all steps including external ones are confirmed', () => {
      const epic = makeTask({
        id: 'EPIC-D',
        type: 'epic' as TaskType,
        status: 'done',
        dod_steps_done: ['tests_pass', 'pr_merged', 'released'],
      });
      const child = makeTask({ id: 'T-D1', parent: 'EPIC-D', status: 'done' });
      const plan = makePlan([epic, child]);

      const result = evaluateDefinitionOfDone(epic, plan, ['all_tasks_done', 'tests_pass', 'pr_merged', 'released']);
      expect(result.satisfied).toBe(true);
      expect(result.pending).toHaveLength(0);
    });

    it('should return only the unmet steps as pending', () => {
      const epic = makeTask({
        id: 'EPIC-E',
        type: 'epic' as TaskType,
        status: 'done',
        dod_steps_done: ['tests_pass'],
      });
      const child = makeTask({ id: 'T-E1', parent: 'EPIC-E', status: 'done' });
      const plan = makePlan([epic, child]);

      const result = evaluateDefinitionOfDone(epic, plan, ['all_tasks_done', 'tests_pass', 'pr_created', 'pr_merged']);
      expect(result.satisfied).toBe(false);
      expect(result.pending).toEqual(['pr_created', 'pr_merged']);
    });
  });
});
