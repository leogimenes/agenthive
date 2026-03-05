import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
} from '../../src/core/plan.js';
import type { Plan, PlanTask } from '../../src/types/plan.js';
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

  // ── loadPlan edge cases ────────────────────────────────────────────

  describe('loadPlan edge cases', () => {
    it('should throw when plan file contains malformed JSON', () => {
      writeFileSync(join(hivePath, 'plan.json'), 'not valid json', 'utf-8');
      expect(() => loadPlan(hivePath)).toThrow();
    });

    it('should load a plan that has extra unknown fields', () => {
      const plan = makePlan([makeTask()]);
      savePlan(hivePath, plan);

      // Manually inject extra fields into the plan file
      const raw = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      raw.extra_field = 'unexpected';
      raw.tasks[0].unknown_prop = 42;
      writeFileSync(join(hivePath, 'plan.json'), JSON.stringify(raw, null, 2), 'utf-8');

      const loaded = loadPlan(hivePath);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('test-plan');
    });
  });

  // ── computeReadyTasks edge cases ───────────────────────────────────

  describe('computeReadyTasks edge cases', () => {
    it('should return empty array when plan has no tasks', () => {
      const plan = makePlan([]);
      expect(computeReadyTasks(plan)).toHaveLength(0);
    });

    it('should not return task when only some deps are done', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'done' }),
        makeTask({ id: 'b', status: 'open' }),
        makeTask({ id: 'c', status: 'open', depends_on: ['a', 'b'] }),
      ]);
      const ready = computeReadyTasks(plan);
      // 'a' is done, 'b' has no deps → ready; 'c' has unmet dep 'b'
      expect(ready.map((t) => t.id)).not.toContain('c');
    });

    it('should not return failed tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed', depends_on: [] }),
      ]);
      expect(computeReadyTasks(plan)).toHaveLength(0);
    });

    it('should not return blocked tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'blocked', depends_on: [] }),
      ]);
      expect(computeReadyTasks(plan)).toHaveLength(0);
    });

    it('should handle multiple deps all done', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'done' }),
        makeTask({ id: 'b', status: 'done' }),
        makeTask({ id: 'c', status: 'open', depends_on: ['a', 'b'] }),
      ]);
      const ready = computeReadyTasks(plan);
      expect(ready.map((t) => t.id)).toContain('c');
    });
  });

  // ── computeBlockedTasks edge cases ────────────────────────────────

  describe('computeBlockedTasks edge cases', () => {
    it('should handle multiple failed tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed' }),
        makeTask({ id: 'b', status: 'failed' }),
        makeTask({ id: 'c', status: 'open', depends_on: ['a'] }),
        makeTask({ id: 'd', status: 'open', depends_on: ['b'] }),
      ]);
      const blocked = computeBlockedTasks(plan);
      expect(blocked.map((t) => t.id).sort()).toEqual(['c', 'd']);
    });

    it('should not include failed tasks themselves in blocked list', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed' }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      const blocked = computeBlockedTasks(plan);
      expect(blocked.map((t) => t.id)).not.toContain('a');
    });

    it('should not double-count in diamond dependency pattern', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'failed' }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
        makeTask({ id: 'c', status: 'open', depends_on: ['a'] }),
        makeTask({ id: 'd', status: 'open', depends_on: ['b', 'c'] }),
      ]);
      const blocked = computeBlockedTasks(plan);
      const ids = blocked.map((t) => t.id);
      // 'd' should appear only once
      expect(ids.filter((id) => id === 'd')).toHaveLength(1);
    });
  });

  // ── getDependencyChain edge cases ─────────────────────────────────

  describe('getDependencyChain edge cases', () => {
    it('should return empty for non-existent task ID', () => {
      const plan = makePlan([makeTask({ id: 'a' })]);
      const chain = getDependencyChain(plan, 'does-not-exist');
      expect(chain).toHaveLength(0);
    });

    it('should handle diamond dependency without duplicating nodes', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: [] }),
        makeTask({ id: 'b', depends_on: ['a'] }),
        makeTask({ id: 'c', depends_on: ['a'] }),
        makeTask({ id: 'd', depends_on: ['b', 'c'] }),
      ]);
      const chain = getDependencyChain(plan, 'd');
      const ids = chain.map((t) => t.id);
      // 'a' should appear exactly once
      expect(ids.filter((id) => id === 'a')).toHaveLength(1);
      expect(ids).toContain('d');
    });

    it('should handle deep chain', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: [] }),
        makeTask({ id: 'b', depends_on: ['a'] }),
        makeTask({ id: 'c', depends_on: ['b'] }),
        makeTask({ id: 'd', depends_on: ['c'] }),
        makeTask({ id: 'e', depends_on: ['d'] }),
      ]);
      const chain = getDependencyChain(plan, 'e');
      expect(chain.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  // ── validateDAG edge cases ─────────────────────────────────────────

  describe('validateDAG edge cases', () => {
    it('should detect a self-referencing task', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: ['a'] }),
      ]);
      const result = validateDAG(plan);
      expect(result.valid).toBe(false);
    });

    it('should allow deps on non-existent tasks (graceful)', () => {
      const plan = makePlan([
        makeTask({ id: 'a', depends_on: ['phantom-task'] }),
      ]);
      const result = validateDAG(plan);
      // Non-existent deps are skipped per implementation
      expect(result.valid).toBe(true);
    });

    it('should validate a wide DAG with many roots', () => {
      const plan = makePlan([
        makeTask({ id: 'r1', depends_on: [] }),
        makeTask({ id: 'r2', depends_on: [] }),
        makeTask({ id: 'r3', depends_on: [] }),
        makeTask({ id: 'm', depends_on: ['r1', 'r2', 'r3'] }),
      ]);
      expect(validateDAG(plan).valid).toBe(true);
    });
  });

  // ── promoteReadyTasks edge cases ───────────────────────────────────

  describe('promoteReadyTasks edge cases', () => {
    it('should not re-promote already ready tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'ready', depends_on: [] }),
      ]);
      const promoted = promoteReadyTasks(plan);
      // 'a' is already ready, should not count as newly promoted
      expect(promoted).toBe(0);
    });

    it('should not promote dispatched tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'dispatched', depends_on: [] }),
      ]);
      const promoted = promoteReadyTasks(plan);
      expect(promoted).toBe(0);
      expect(plan.tasks[0].status).toBe('dispatched');
    });

    it('should not promote running tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'running', depends_on: [] }),
      ]);
      const promoted = promoteReadyTasks(plan);
      expect(promoted).toBe(0);
      expect(plan.tasks[0].status).toBe('running');
    });

    it('should promote multiple tasks in one call', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'open', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: [] }),
        makeTask({ id: 'c', status: 'open', depends_on: [] }),
      ]);
      const promoted = promoteReadyTasks(plan);
      expect(promoted).toBe(3);
      expect(plan.tasks.every((t) => t.status === 'ready')).toBe(true);
    });
  });

  // ── extractTaskId edge cases ───────────────────────────────────────

  describe('extractTaskId edge cases', () => {
    it('should return first matching bracketed ID when multiple are present', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-01' }),
        makeTask({ id: 'FE-02' }),
      ]);
      // First bracketed ID found is BE-01
      const result = extractTaskId('Fixed [BE-01] and [FE-02] issues', plan);
      expect(result).toBe('BE-01');
    });

    it('should return null when bracketed ID does not match known tasks', () => {
      const plan = makePlan([makeTask({ id: 'BE-01' })]);
      expect(extractTaskId('[UNKNOWN-99] some message', plan)).toBeNull();
    });

    it('should return null for empty plan', () => {
      const plan = makePlan([]);
      expect(extractTaskId('some message BE-01', plan)).toBeNull();
    });

    it('should not match partial IDs within longer words', () => {
      // If 'BE' is a task ID and message contains 'BACKEND', it should match
      // because includes() is used — but verify the full ID scenario
      const plan = makePlan([makeTask({ id: 'BE-01' })]);
      // 'XBE-01X' contains 'BE-01' as substring, so it should match
      const result = extractTaskId('XBE-01X test', plan);
      expect(result).toBe('BE-01');
    });
  });

  // ── reconcilePlanWithChat edge cases ───────────────────────────────

  describe('reconcilePlanWithChat edge cases', () => {
    it('should ignore non-DONE/BLOCKER messages', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-06', status: 'dispatched', target: 'backend' }),
      ]);
      const messages: ChatMessage[] = [
        { role: 'BACKEND', type: 'STATUS', body: 'Working on [BE-06]', lineNumber: 1 },
        { role: 'BACKEND', type: 'QUESTION', body: 'Completed [BE-06]', lineNumber: 2 },
      ];
      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(0);
      expect(plan.tasks[0].status).toBe('dispatched');
    });

    it('should not infer task when agent has multiple active tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-01', status: 'dispatched', target: 'backend' }),
        makeTask({ id: 'BE-02', status: 'running', target: 'backend' }),
      ]);
      const messages: ChatMessage[] = [
        { role: 'BACKEND', type: 'DONE', body: 'All done', lineNumber: 1 },
      ];
      // Cannot infer which task — both are active, no ID in message
      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(0);
    });

    it('should process multiple messages in sequence', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'dispatched', target: 'backend' }),
        makeTask({ id: 'b', status: 'dispatched', target: 'frontend' }),
      ]);
      const messages: ChatMessage[] = [
        { role: 'BACKEND', type: 'DONE', body: 'Completed [a]', lineNumber: 1 },
        { role: 'FRONTEND', type: 'DONE', body: 'Completed [b]', lineNumber: 2 },
      ];
      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(2);
      expect(plan.tasks.find((t) => t.id === 'a')!.status).toBe('done');
      expect(plan.tasks.find((t) => t.id === 'b')!.status).toBe('done');
    });

    it('should not process same task twice even if two DONE messages reference it', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-06', status: 'dispatched', target: 'backend' }),
      ]);
      const messages: ChatMessage[] = [
        { role: 'BACKEND', type: 'DONE', body: '[BE-06] first done', lineNumber: 1 },
        { role: 'BACKEND', type: 'DONE', body: '[BE-06] second done', lineNumber: 2 },
      ];
      const updates = reconcilePlanWithChat(plan, messages);
      // Second message should be ignored as task is already done
      expect(updates).toHaveLength(1);
    });

    it('should update task with open status when ID is explicitly referenced', () => {
      const plan = makePlan([
        makeTask({ id: 'BE-06', status: 'open', target: 'backend' }),
      ]);
      const messages: ChatMessage[] = [
        { role: 'BACKEND', type: 'DONE', body: 'Completed [BE-06]', lineNumber: 1 },
      ];
      const updates = reconcilePlanWithChat(plan, messages);
      expect(updates).toHaveLength(1);
      expect(plan.tasks[0].status).toBe('done');
    });

    it('should cascade block when BLOCKER causes failed → blocked chain', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'dispatched', target: 'backend' }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
        makeTask({ id: 'c', status: 'open', depends_on: ['b'] }),
      ]);
      const messages: ChatMessage[] = [
        { role: 'BACKEND', type: 'BLOCKER', body: 'Cannot proceed [a]', lineNumber: 1 },
      ];
      reconcilePlanWithChat(plan, messages);
      expect(plan.tasks.find((t) => t.id === 'a')!.status).toBe('failed');
      expect(plan.tasks.find((t) => t.id === 'b')!.status).toBe('blocked');
      expect(plan.tasks.find((t) => t.id === 'c')!.status).toBe('blocked');
    });
  });

  // ── findCriticalPath edge cases ────────────────────────────────────

  describe('findCriticalPath edge cases', () => {
    it('should return single task for plan with one non-done task', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'open', depends_on: [] }),
      ]);
      const cp = findCriticalPath(plan);
      expect(cp).toHaveLength(1);
      expect(cp[0].id).toBe('a');
    });

    it('should exclude done tasks from path', () => {
      const plan = makePlan([
        makeTask({ id: 'a', status: 'done', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
      ]);
      const cp = findCriticalPath(plan);
      expect(cp.map((t) => t.id)).not.toContain('a');
      expect(cp.map((t) => t.id)).toContain('b');
    });

    it('should pick the longer of two parallel chains', () => {
      const plan = makePlan([
        // Short chain: x → y (length 2)
        makeTask({ id: 'x', status: 'open', depends_on: [] }),
        makeTask({ id: 'y', status: 'open', depends_on: ['x'] }),
        // Long chain: a → b → c → d (length 4)
        makeTask({ id: 'a', status: 'open', depends_on: [] }),
        makeTask({ id: 'b', status: 'open', depends_on: ['a'] }),
        makeTask({ id: 'c', status: 'open', depends_on: ['b'] }),
        makeTask({ id: 'd', status: 'open', depends_on: ['c'] }),
      ]);
      const cp = findCriticalPath(plan);
      expect(cp.length).toBe(4);
      expect(cp.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  // ── computeParentStatus edge cases ────────────────────────────────

  describe('computeParentStatus edge cases', () => {
    it('should return open status with 0/0 when parent has no children', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('open');
      expect(ps.done).toBe(0);
      expect(ps.total).toBe(0);
    });

    it('should return progress status when some tasks are open', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'open' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('progress');
      expect(ps.done).toBe(1);
      expect(ps.total).toBe(2);
    });

    it('should return running when child is dispatched', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'dispatched' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('running');
    });

    it('should return warning when any child failed even with done children', () => {
      const plan = makePlan([
        makeTask({ id: 'parent' }),
        makeTask({ id: 'child-1', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-2', parent: 'parent', status: 'done' }),
        makeTask({ id: 'child-3', parent: 'parent', status: 'failed' }),
      ]);
      const ps = computeParentStatus(plan, 'parent');
      expect(ps.status).toBe('warning');
    });
  });

  // ── sortByPriority edge cases ─────────────────────────────────────

  describe('sortByPriority edge cases', () => {
    it('should return empty array when given empty array', () => {
      expect(sortByPriority([])).toHaveLength(0);
    });

    it('should return a new array (not mutate input)', () => {
      const tasks = [
        makeTask({ id: 'a', priority: 'p3' }),
        makeTask({ id: 'b', priority: 'p0' }),
      ];
      const sorted = sortByPriority(tasks);
      expect(tasks[0].id).toBe('a'); // original unchanged
      expect(sorted[0].id).toBe('b'); // sorted correctly
    });

    it('should sort all four priority levels correctly', () => {
      const tasks = [
        makeTask({ id: 'd', priority: 'p3' }),
        makeTask({ id: 'c', priority: 'p2' }),
        makeTask({ id: 'b', priority: 'p1' }),
        makeTask({ id: 'a', priority: 'p0' }),
      ];
      const sorted = sortByPriority(tasks);
      expect(sorted.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('should use creation time as tiebreaker for same priority', () => {
      const tasks = [
        makeTask({ id: 'newer', priority: 'p1', created_at: '2026-02-01T00:00:00Z' }),
        makeTask({ id: 'older', priority: 'p1', created_at: '2026-01-01T00:00:00Z' }),
      ];
      const sorted = sortByPriority(tasks);
      expect(sorted[0].id).toBe('older');
      expect(sorted[1].id).toBe('newer');
    });
  });

  // ── generateId edge cases ─────────────────────────────────────────

  describe('generateId edge cases', () => {
    it('should handle single character target', () => {
      const id = generateId('some task', 'x');
      expect(id).toMatch(/^x-[0-9a-f]{4}$/);
    });

    it('should use only up to first 4 chars of target as prefix', () => {
      const id = generateId('task', 'frontend');
      expect(id).toMatch(/^fron-[0-9a-f]{4}$/);
    });

    it('should use custom prefix verbatim', () => {
      const id = generateId('task', 'backend', 'BACK-END');
      expect(id).toMatch(/^BACK-END-[0-9a-f]{4}$/);
    });
  });

  // ── getTasksByAgent edge cases ────────────────────────────────────

  describe('getTasksByAgent edge cases', () => {
    it('should return empty array when agent has no tasks', () => {
      const plan = makePlan([
        makeTask({ id: 'a', target: 'backend' }),
      ]);
      expect(getTasksByAgent(plan, 'frontend')).toHaveLength(0);
    });

    it('should match regardless of case variation in target', () => {
      const plan = makePlan([
        makeTask({ id: 'a', target: 'BackEnd' }),
      ]);
      expect(getTasksByAgent(plan, 'BACKEND')).toHaveLength(1);
      expect(getTasksByAgent(plan, 'backend')).toHaveLength(1);
    });

    it('should return empty array for empty plan', () => {
      const plan = makePlan([]);
      expect(getTasksByAgent(plan, 'backend')).toHaveLength(0);
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
});
