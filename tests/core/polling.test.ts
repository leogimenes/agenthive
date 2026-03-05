/**
 * Tests for AgentLoop — focusing on BUG 10 (BUG 8):
 * Plan task status must be updated INLINE in the success path, not deferred to
 * reconcilePlanWithChat. Since the checkpoint advances past the agent's own DONE
 * message, reconcilePlanWithChat cannot see it — the primary update must happen
 * directly after runTask() resolves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Module mocks (must be declared before imports of mocked modules) ──

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/core/worktree.js', () => ({
  syncWorktree: vi.fn(),
  rebaseAndPush: vi.fn(),
}));

vi.mock('../../src/core/budget.js', () => ({
  checkDailyBudget: vi.fn(),
  recordSpending: vi.fn(),
  logTaskCost: vi.fn(),
}));

vi.mock('../../src/core/notify.js', () => ({
  notify: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { syncWorktree, rebaseAndPush } from '../../src/core/worktree.js';
import { checkDailyBudget } from '../../src/core/budget.js';
import { AgentLoop } from '../../src/core/polling.js';
import { savePlan, loadPlan } from '../../src/core/plan.js';
import { releaseLock } from '../../src/core/lock.js';
import type { Plan, PlanTask } from '../../src/types/plan.js';
import type { ResolvedAgentConfig, HiveConfig } from '../../src/types/config.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeHiveConfig(hivePath: string, chatFile = 'chat.md'): HiveConfig {
  return {
    session: 'test',
    defaults: {
      poll: 1,
      budget: 2,
      daily_max: 20,
      model: 'sonnet',
      skip_permissions: false,
      notifications: false,
      notify_on: [],
    },
    agents: {},
    chat: { file: chatFile, role_map: { backend: 'BACKEND' } },
    hooks: { safety: [], coordination: [] },
    templates: {},
  } as unknown as HiveConfig;
}

function makeAgent(
  hivePath: string,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: 'backend',
    description: 'Backend Engineer',
    agent: 'backend',
    chatRole: 'BACKEND',
    poll: 1,
    budget: 2,
    daily_max: 20,
    model: 'sonnet',
    skip_permissions: false,
    notifications: false,
    notify_on: [],
    worktreePath: hivePath,
    ...overrides,
  } as unknown as ResolvedAgentConfig;
}

function makePlan(tasks: Partial<PlanTask>[] = []): Plan {
  const now = new Date().toISOString();
  return {
    name: 'test-plan',
    created_at: now,
    updated_at: now,
    tasks: tasks.map((t, i) => ({
      id: `task-${i + 1}`,
      title: `Task ${i + 1}`,
      target: 'backend',
      priority: 'p1' as const,
      status: 'ready' as const,
      depends_on: [],
      created_at: now,
      updated_at: now,
      ...t,
    })),
  };
}

/** Returns a fake child_process EventEmitter that exits with the given code. */
function fakeChild(exitCode: number): ReturnType<typeof spawn> {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const emitter = {
    on: vi.fn().mockImplementation((event: string, handler: (arg?: unknown) => void) => {
      handlers[event] = handler;
      if (event === 'close') {
        // Schedule async so AgentLoop can attach the listener first
        setTimeout(() => handler(exitCode), 10);
      }
      return emitter;
    }),
  };
  return emitter as unknown as ReturnType<typeof spawn>;
}

/**
 * Runs one full cycle of the AgentLoop by starting it, waiting for the plan
 * task to reach a terminal state (or timeout), then stopping the loop.
 */
async function runLoopUntilTaskDone(
  hivePath: string,
  taskId: string,
  timeoutMs = 4000,
): Promise<void> {
  const hiveConfig = makeHiveConfig(hivePath);
  const agent = makeAgent(hivePath);
  const loop = new AgentLoop(agent, hiveConfig, hivePath);

  const done = new Promise<void>((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const updated = loadPlan(hivePath);
      const task = updated?.tasks.find((t) => t.id === taskId);
      const isTerminal = task?.status === 'done' || task?.status === 'failed';
      const timedOut = Date.now() - start > timeoutMs;
      if (isTerminal || timedOut) {
        clearInterval(interval);
        loop.stop();
        resolve();
      }
    }, 30);
  });

  // start() is non-blocking in test — we drive it forward via the polled loop
  const startPromise = loop.start().catch(() => {});
  await done;
  loop.stop();
  await startPromise;

  // Release the lock the loop acquired so subsequent tests are not affected
  releaseLock(hivePath, 'backend');
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('AgentLoop — plan task inline status update (BUG 10 / BUG 8)', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-polling-test-'));
    mkdirSync(join(hivePath, 'state'), { recursive: true });
    writeFileSync(join(hivePath, 'chat.md'), '', 'utf-8');

    // Default mocks
    vi.mocked(checkDailyBudget).mockReturnValue({ allowed: true, spent: 0 });
    vi.mocked(syncWorktree).mockResolvedValue({ success: true });
    vi.mocked(rebaseAndPush).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    releaseLock(hivePath, 'backend');
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── BUG 10 primary assertion ────────────────────────────────────────

  it('should set plan task status to done inline when runTask succeeds', async () => {
    // Arrange
    const plan = makePlan([{
      id: 'BE-01',
      title: 'Fix auth',
      target: 'backend',
      status: 'ready',
    }]);
    savePlan(hivePath, plan);

    // Simulate successful task (claude exits 0)
    vi.mocked(spawn).mockReturnValue(fakeChild(0));

    // Act
    await runLoopUntilTaskDone(hivePath, 'BE-01');

    // Assert: plan task should be marked done
    const finalPlan = loadPlan(hivePath);
    expect(finalPlan).not.toBeNull();
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-01');
    expect(task).toBeDefined();
    expect(task!.status).toBe('done');
    expect(task!.completed_at).toBeDefined();
    expect(task!.updated_at).toBeDefined();
    expect(task!.resolution).toBeDefined();
  });

  it('should NOT set plan task status to done when runTask fails', async () => {
    // Arrange
    const plan = makePlan([{
      id: 'BE-02',
      title: 'Failing task',
      target: 'backend',
      status: 'ready',
    }]);
    savePlan(hivePath, plan);

    // Simulate failing task (claude exits non-zero)
    vi.mocked(spawn).mockReturnValue(fakeChild(1));

    const hiveConfig = makeHiveConfig(hivePath);
    const agent = makeAgent(hivePath);
    const loop = new AgentLoop(agent, hiveConfig, hivePath);

    // Run briefly — one cycle should dispatch and fail
    let cycles = 0;
    const done = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        cycles++;
        if (cycles > 40) {
          clearInterval(interval);
          loop.stop();
          resolve();
        }
      }, 50);
    });

    const startPromise = loop.start().catch(() => {});
    await done;
    loop.stop();
    await startPromise;
    releaseLock(hivePath, 'backend');

    // Assert: status must NOT be 'done' after a failure
    const finalPlan = loadPlan(hivePath);
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-02');
    expect(task).toBeDefined();
    expect(task!.status).not.toBe('done');
  });

  it('should set completed_at timestamp when plan task succeeds', async () => {
    // Arrange
    const plan = makePlan([{
      id: 'BE-03',
      title: 'Timed task',
      target: 'backend',
      status: 'ready',
    }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0));

    const before = new Date().toISOString();

    // Act
    await runLoopUntilTaskDone(hivePath, 'BE-03');

    const after = new Date().toISOString();

    // Assert: completed_at should be between before and after
    const finalPlan = loadPlan(hivePath);
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-03');
    expect(task?.status).toBe('done');
    expect(task?.completed_at).toBeDefined();
    expect(task!.completed_at! >= before).toBe(true);
    expect(task!.completed_at! <= after).toBe(true);
  });

  it('should save resolution string when plan task succeeds', async () => {
    // Arrange
    const plan = makePlan([{
      id: 'BE-04',
      title: 'Resolution task',
      target: 'backend',
      status: 'ready',
      description: 'Do the thing',
    }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0));

    // Act
    await runLoopUntilTaskDone(hivePath, 'BE-04');

    // Assert: resolution should be a non-empty string
    const finalPlan = loadPlan(hivePath);
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-04');
    expect(task?.status).toBe('done');
    expect(task?.resolution).toBeDefined();
    expect(typeof task!.resolution).toBe('string');
    expect(task!.resolution!.length).toBeGreaterThan(0);
  });
});
