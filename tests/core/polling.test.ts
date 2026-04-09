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
  syncWorktree: vi.fn().mockResolvedValue({ success: true }),
  rebaseAndPush: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/core/budget.js', () => ({
  checkDailyBudget: vi.fn(),
  recordSpending: vi.fn(),
  logTaskCost: vi.fn(),
}));

vi.mock('../../src/core/notify.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../src/core/gitlock.js', () => ({
  acquireGitLock: vi.fn().mockResolvedValue(true),
  releaseGitLock: vi.fn(),
}));

vi.mock('../../src/core/transcripts.js', () => ({
  rotateTranscripts: vi.fn().mockReturnValue({ deleted: 0 }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { syncWorktree, rebaseAndPush } from '../../src/core/worktree.js';
import { checkDailyBudget, recordSpending, logTaskCost } from '../../src/core/budget.js';
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
    delivery: {
      strategy: 'manual',
      base_branch: 'main',
      definition_of_done: { require_tests: false, require_review: false },
    },
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
function fakeChild(exitCode: number, stdoutData = ''): ReturnType<typeof spawn> {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const stdoutHandlers: Record<string, (arg?: unknown) => void> = {};

  const stdoutEmitter = {
    on: vi.fn().mockImplementation((event: string, handler: (arg?: unknown) => void) => {
      stdoutHandlers[event] = handler;
      if (event === 'data' && stdoutData) {
        setTimeout(() => handler(Buffer.from(stdoutData)), 5);
      }
      return stdoutEmitter;
    }),
  };

  const emitter = {
    stdout: stdoutEmitter,
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
  timeoutMs = 10000,
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

// ── Retry helper ─────────────────────────────────────────────────────

/**
 * Runs the AgentLoop for a fixed number of cycles (by time) then stops.
 * Returns the final plan from disk.
 */
async function runLoopForMs(
  hivePath: string,
  durationMs: number,
): Promise<Plan | null> {
  const hiveConfig = makeHiveConfig(hivePath);
  const agent = makeAgent(hivePath);
  const loop = new AgentLoop(agent, hiveConfig, hivePath);

  const startPromise = loop.start().catch(() => {});
  await new Promise<void>((r) => setTimeout(r, durationMs));
  loop.stop();
  await startPromise;
  releaseLock(hivePath, 'backend');

  return loadPlan(hivePath);
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

// ── BUG 9: retry policy for transient plan task failures ─────────────

describe('AgentLoop — retry policy for transient plan task failures (BUG 9)', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-polling-retry-test-'));
    mkdirSync(join(hivePath, 'state'), { recursive: true });
    writeFileSync(join(hivePath, 'chat.md'), '', 'utf-8');

    vi.mocked(checkDailyBudget).mockReturnValue({ allowed: true, spent: 0 });
    vi.mocked(syncWorktree).mockResolvedValue({ success: true });
    vi.mocked(rebaseAndPush).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    releaseLock(hivePath, 'backend');
    rmSync(hivePath, { recursive: true, force: true });
  });

  it('should reset plan task to open for retry when runTask fails (below max_retries)', async () => {
    // Arrange: max_retries: 2 so first failure resets to open
    const plan = makePlan([{
      id: 'BE-R1',
      title: 'Retry task',
      target: 'backend',
      status: 'ready',
      max_retries: 2,
    }]);
    savePlan(hivePath, plan);

    // First spawn call fails, second succeeds — so we can observe retry state
    vi.mocked(spawn)
      .mockReturnValueOnce(fakeChild(1))  // first attempt fails
      .mockReturnValue(fakeChild(0));     // subsequent succeed

    // Run until task reaches 'done' (after retry)
    await runLoopUntilTaskDone(hivePath, 'BE-R1', 16000);

    const finalPlan = loadPlan(hivePath);
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-R1');
    expect(task).toBeDefined();
    // Task should eventually succeed via retry
    expect(task!.status).toBe('done');
    // retry_count must be at least 1 (recorded the failed attempt)
    expect(task!.retry_count).toBeGreaterThanOrEqual(1);
  });

  it('should mark plan task as failed after exhausting max_retries', async () => {
    // Arrange: max_retries: 0 → immediate permanent failure on first attempt
    const plan = makePlan([{
      id: 'BE-R2',
      title: 'Always failing task',
      target: 'backend',
      status: 'ready',
      max_retries: 0,
    }]);
    savePlan(hivePath, plan);

    // Always fail
    vi.mocked(spawn).mockReturnValue(fakeChild(1));

    // Run until task reaches terminal state
    await runLoopUntilTaskDone(hivePath, 'BE-R2', 6000);

    const finalPlan = loadPlan(hivePath);
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-R2');
    expect(task).toBeDefined();
    expect(task!.status).toBe('failed');
  });

  it('should record last_error when a plan task fails transiently', async () => {
    // Arrange: spawn error (infrastructure failure) with max_retries: 0 to ensure fast terminal state
    const plan = makePlan([{
      id: 'BE-R3',
      title: 'Spawn error task',
      target: 'backend',
      status: 'ready',
      max_retries: 0,
    }]);
    savePlan(hivePath, plan);

    // Simulate spawn failure (infrastructure error — not a claude exit code)
    const errChild = (() => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const emitter = {
        on: vi.fn().mockImplementation((event: string, handler: (arg?: unknown) => void) => {
          handlers[event] = handler;
          if (event === 'error') {
            setTimeout(() => handler(new Error('spawn ENOENT')), 10);
          }
          return emitter;
        }),
      };
      return emitter as unknown as ReturnType<typeof spawn>;
    })();

    vi.mocked(spawn).mockReturnValue(errChild);

    await runLoopUntilTaskDone(hivePath, 'BE-R3', 6000);

    const finalPlan = loadPlan(hivePath);
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-R3');
    expect(task).toBeDefined();
    expect(task!.status).toBe('failed');
    expect(task!.last_error).toBeDefined();
    expect(task!.last_error).toContain('spawn');
  });

  it('should increment retry_count on each failed attempt', async () => {
    // Arrange: max_retries: 2 — allows 2 retries before failing permanently
    const plan = makePlan([{
      id: 'BE-R4',
      title: 'Counted retries task',
      target: 'backend',
      status: 'ready',
      max_retries: 2,
    }]);
    savePlan(hivePath, plan);

    // Always fail so we exhaust retries
    vi.mocked(spawn).mockReturnValue(fakeChild(1));

    await runLoopUntilTaskDone(hivePath, 'BE-R4', 16000);

    const finalPlan = loadPlan(hivePath);
    const task = finalPlan!.tasks.find((t) => t.id === 'BE-R4');
    expect(task).toBeDefined();
    expect(task!.status).toBe('failed');
    // retry_count should be max_retries + 1 (one final failing attempt)
    expect(task!.retry_count).toBe(3);
  });
});

// ── BE-10: Real cost tracking using claude CLI JSON output ────────────

const VALID_COST_JSON = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.04252125,
  duration_ms: 2169,
  num_turns: 1,
  session_id: 'test-session-uuid',
  usage: { input_tokens: 500, output_tokens: 200 },
  modelUsage: { 'claude-sonnet-4-5': { costUSD: 0.04252125 } },
});

describe('AgentLoop — real cost tracking (BE-10)', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-cost-test-'));
    mkdirSync(join(hivePath, 'state'), { recursive: true });
    writeFileSync(join(hivePath, 'chat.md'), '', 'utf-8');

    vi.mocked(checkDailyBudget).mockReturnValue({ allowed: true, spent: 0 });
    vi.mocked(syncWorktree).mockResolvedValue({ success: true });
    vi.mocked(rebaseAndPush).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    releaseLock(hivePath, 'backend');
    rmSync(hivePath, { recursive: true, force: true });
  });

  it('should include --output-format json in claude CLI args', async () => {
    // Arrange
    const plan = makePlan([{ id: 'COST-01', title: 'Cost task', target: 'backend', status: 'ready' }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0, VALID_COST_JSON));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-01');

    // Assert: spawn was called with --output-format json
    const spawnArgs = vi.mocked(spawn).mock.calls[0];
    const cliArgs = spawnArgs[1] as string[];
    expect(cliArgs).toContain('--output-format');
    const idx = cliArgs.indexOf('--output-format');
    expect(cliArgs[idx + 1]).toBe('json');
  });

  it('should call recordSpending with parsed total_cost_usd for successful plan task', async () => {
    // Arrange
    const plan = makePlan([{ id: 'COST-02', title: 'Cost task', target: 'backend', status: 'ready' }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0, VALID_COST_JSON));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-02');

    // Assert: recordSpending called with real cost (0.04252125), not flat budget (2)
    expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(
      hivePath,
      'backend',
      0.04252125,
    );
  });

  it('should call logTaskCost with parsed total_cost_usd for successful plan task', async () => {
    // Arrange
    const plan = makePlan([{ id: 'COST-03', title: 'Cost task', target: 'backend', status: 'ready' }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0, VALID_COST_JSON));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-03');

    // Assert: logTaskCost called with real cost
    const logCalls = vi.mocked(logTaskCost).mock.calls;
    expect(logCalls.length).toBeGreaterThan(0);
    const [, , , amount] = logCalls[logCalls.length - 1];
    expect(amount).toBe(0.04252125);
  });

  it('should fall back to config budget when stdout is empty', async () => {
    // Arrange: config budget = 2
    const plan = makePlan([{ id: 'COST-04', title: 'Cost task', target: 'backend', status: 'ready' }]);
    savePlan(hivePath, plan);

    // fakeChild with no stdout data → parseClaudeCost returns fallback
    vi.mocked(spawn).mockReturnValue(fakeChild(0, ''));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-04');

    // Assert: recordSpending called with fallback budget (2)
    expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'backend', 2);
  });

  it('should fall back to config budget when stdout JSON is missing total_cost_usd', async () => {
    // Arrange: JSON without total_cost_usd field
    const noTotalCost = JSON.stringify({ type: 'result', subtype: 'success' });
    const plan = makePlan([{ id: 'COST-05', title: 'Cost task', target: 'backend', status: 'ready' }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0, noTotalCost));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-05');

    // Assert: falls back to config budget
    expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'backend', 2);
  });

  it('should extract cost from last JSON line when stdout has warning text before JSON', async () => {
    // Arrange: stdout has some warning text followed by the JSON on the last line
    const withWarnings = `Warning: some deprecation notice\nAnother warning line\n${VALID_COST_JSON}`;
    const plan = makePlan([{ id: 'COST-06', title: 'Cost task', target: 'backend', status: 'ready' }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0, withWarnings));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-06');

    // Assert: real cost extracted despite warnings
    expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'backend', 0.04252125);
  });

  it('should fall back to config budget when stdout is not valid JSON', async () => {
    // Arrange: stdout is not parseable JSON
    const plan = makePlan([{ id: 'COST-07', title: 'Cost task', target: 'backend', status: 'ready' }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(0, '{not valid json}'));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-07');

    // Assert: falls back to config budget
    expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'backend', 2);
  });

  it('should use real cost in recordSpending for failed plan task when JSON is available', async () => {
    // Arrange: plan task with max_retries: 0 so it fails immediately
    const failCostJson = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      total_cost_usd: 0.01,
    });
    const plan = makePlan([{
      id: 'COST-08',
      title: 'Failing cost task',
      target: 'backend',
      status: 'ready',
      max_retries: 0,
    }]);
    savePlan(hivePath, plan);

    vi.mocked(spawn).mockReturnValue(fakeChild(1, failCostJson));

    // Act
    await runLoopUntilTaskDone(hivePath, 'COST-08', 6000);

    // Assert: real cost used even on failure
    expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'backend', 0.01);
  });
});
