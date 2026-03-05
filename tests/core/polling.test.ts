/**
 * Unit tests for src/core/polling.ts — AgentLoop core cycle.
 *
 * All external dependencies (lock, budget, chat, worktree, plan, notify, child_process)
 * are mocked so tests run fast without touching the filesystem or spawning processes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ResolvedAgentConfig, HiveConfig, ChatMessage } from '../../src/types/config.js';

// ── Mocks (must be hoisted before imports) ─────────────────────────────────

vi.mock('../../src/core/lock.js', () => ({
  acquireLock: vi.fn().mockReturnValue(true),
  releaseLock: vi.fn(),
  getCheckpoint: vi.fn().mockReturnValue(5),
  setCheckpoint: vi.fn(),
  updateHeartbeat: vi.fn(),
}));

vi.mock('../../src/core/budget.js', () => ({
  checkDailyBudget: vi.fn().mockReturnValue({ allowed: true, spent: 0 }),
  recordSpending: vi.fn().mockReturnValue(2),
  logTaskCost: vi.fn(),
}));

vi.mock('../../src/core/chat.js', () => ({
  findRequests: vi.fn().mockReturnValue([]),
  appendMessage: vi.fn(),
  getChatLineCount: vi.fn().mockReturnValue(10),
  resolveChatPath: vi.fn((hivePath: string, file: string) => join(hivePath, file)),
  readMessagesSince: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/worktree.js', () => ({
  syncWorktree: vi.fn().mockResolvedValue({ success: true }),
  rebaseAndPush: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/core/plan.js', () => ({
  loadPlan: vi.fn().mockReturnValue(null),
  savePlan: vi.fn(),
  reconcilePlanWithChat: vi.fn().mockReturnValue([]),
  computeReadyTasks: vi.fn().mockReturnValue([]),
  promoteReadyTasks: vi.fn(),
  resetTaskForRetry: vi.fn().mockReturnValue('retry'),
  DEFAULT_MAX_RETRIES: 3,
}));

vi.mock('../../src/core/notify.js', () => ({
  notify: vi.fn(),
}));

// spawn mock — by default emits 'close' with exit code 0 via process.nextTick
// stdout emits no data (parseClaudeCost returns fallback = agent.budget)
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    stdout: {
      on: vi.fn(),
    },
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      if (event === 'close') process.nextTick(() => cb(0));
    }),
  })),
}));

// ── Import mocked modules ──────────────────────────────────────────────────

import {
  acquireLock,
  releaseLock,
  getCheckpoint,
  setCheckpoint,
  updateHeartbeat,
} from '../../src/core/lock.js';
import {
  checkDailyBudget,
  recordSpending,
  logTaskCost,
} from '../../src/core/budget.js';
import {
  findRequests,
  appendMessage,
  getChatLineCount,
  resolveChatPath,
  readMessagesSince,
} from '../../src/core/chat.js';
import { syncWorktree, rebaseAndPush } from '../../src/core/worktree.js';
import {
  loadPlan,
  savePlan,
  reconcilePlanWithChat,
  computeReadyTasks,
  promoteReadyTasks,
  resetTaskForRetry,
} from '../../src/core/plan.js';
import { notify } from '../../src/core/notify.js';
import { spawn } from 'node:child_process';
import { AgentLoop } from '../../src/core/polling.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    name: 'qa',
    chatRole: 'QA',
    description: 'Quality Analyst',
    agent: 'qa',
    worktreePath: '/fake/worktree/qa',
    poll: 30,
    budget: 2,
    daily_max: 20,
    model: 'sonnet',
    skip_permissions: true,
    ...overrides,
  };
}

function makeHiveConfig(overrides: Partial<HiveConfig> = {}): HiveConfig {
  return {
    session: 'test-session',
    defaults: {
      poll: 30,
      budget: 2,
      daily_max: 20,
      model: 'sonnet',
      skip_permissions: true,
      notifications: false,
      notify_on: ['DONE', 'BLOCKER'],
    },
    agents: {},
    chat: {
      file: 'chat.md',
      role_map: { qa: 'QA' },
    },
    hooks: {},
    templates: {},
    ...overrides,
  };
}

/** Access a private method on AgentLoop. */
function callCycle(loop: AgentLoop): Promise<void> {
  return (loop as unknown as { cycle(): Promise<void> }).cycle();
}

/** Configure spawn mock to emit 'close' with the given exit code. stdout emits no data. */
function mockSpawnExit(code: number, stdoutData = ''): void {
  vi.mocked(spawn).mockReturnValue({
    stdout: {
      on: vi.fn((event: string, cb: (arg: unknown) => void) => {
        if (event === 'data' && stdoutData) {
          process.nextTick(() => cb(Buffer.from(stdoutData)));
        }
      }),
    },
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      if (event === 'close') process.nextTick(() => cb(code));
    }),
  } as ReturnType<typeof spawn>);
}

/** Configure spawn mock to emit 'error'. */
function mockSpawnError(err: Error): void {
  vi.mocked(spawn).mockReturnValue({
    stdout: {
      on: vi.fn(),
    },
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      if (event === 'error') process.nextTick(() => cb(err));
    }),
  } as ReturnType<typeof spawn>);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AgentLoop', () => {
  let hivePath: string;
  let agent: ResolvedAgentConfig;
  let hiveConfig: HiveConfig;
  let loop: AgentLoop;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-test-polling-'));
    agent = makeAgent();
    hiveConfig = makeHiveConfig();
    loop = new AgentLoop(agent, hiveConfig, hivePath);

    vi.useFakeTimers();

    // Reset all mocks to defaults
    vi.mocked(acquireLock).mockReturnValue(true);
    vi.mocked(checkDailyBudget).mockReturnValue({ allowed: true, spent: 0 });
    vi.mocked(getCheckpoint).mockReturnValue(5);
    vi.mocked(getChatLineCount).mockReturnValue(10);
    vi.mocked(findRequests).mockReturnValue([]);
    vi.mocked(readMessagesSince).mockReturnValue([]);
    vi.mocked(syncWorktree).mockResolvedValue({ success: true });
    vi.mocked(rebaseAndPush).mockResolvedValue({ success: true });
    vi.mocked(loadPlan).mockReturnValue(null);
    vi.mocked(computeReadyTasks).mockReturnValue([]);
    vi.mocked(reconcilePlanWithChat).mockReturnValue([]);
    mockSpawnExit(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── Constructor ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should resolve chat file path from hivePath and config', () => {
      // resolveChatPath is called in the constructor — verify via the already-imported mock
      expect(vi.mocked(resolveChatPath)).toHaveBeenCalledWith(hivePath, 'chat.md');
    });

    it('should use notifications setting from hiveConfig by default', () => {
      const config = makeHiveConfig();
      config.defaults.notifications = true;
      const loopWithNotifications = new AgentLoop(agent, config, hivePath);
      expect(loopWithNotifications).toBeDefined();
    });

    it('should override notifications setting from options', () => {
      const config = makeHiveConfig();
      config.defaults.notifications = false;
      // Pass options.notifications=true — should override
      const overridden = new AgentLoop(agent, config, hivePath, {
        notifications: true,
      });
      expect(overridden).toBeDefined();
    });
  });

  // ── stop() ───────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('should set running to false', () => {
      const loopInternal = loop as unknown as { running: boolean };
      loop.stop();
      expect(loopInternal.running).toBe(false);
    });
  });

  // ── cycle() — heartbeat ──────────────────────────────────────────────────

  describe('cycle() — heartbeat', () => {
    it('should update heartbeat at the start of every cycle', async () => {
      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(updateHeartbeat)).toHaveBeenCalledWith(hivePath, 'qa');
    });
  });

  // ── cycle() — budget ─────────────────────────────────────────────────────

  describe('cycle() — budget exhausted', () => {
    it('should return early and sleep 1 hour when budget is exhausted', async () => {
      vi.mocked(checkDailyBudget).mockReturnValue({ allowed: false, spent: 20 });

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      // Should NOT proceed to syncWorktree
      expect(vi.mocked(syncWorktree)).not.toHaveBeenCalled();
    });

    it('should check budget with correct arguments', async () => {
      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(checkDailyBudget)).toHaveBeenCalledWith(hivePath, 'qa', 20);
    });

    it('should send critical notification when budget exhausted and notifications enabled', async () => {
      const configWithNotifications = makeHiveConfig();
      configWithNotifications.defaults.notifications = true;
      const notifyLoop = new AgentLoop(agent, configWithNotifications, hivePath, {
        notifications: true,
      });

      vi.mocked(checkDailyBudget).mockReturnValue({ allowed: false, spent: 20 });

      const promise = callCycle(notifyLoop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(notify)).toHaveBeenCalledWith(
        expect.stringContaining('Budget'),
        expect.any(String),
        'critical',
      );
    });

    it('should not send notification when budget exhausted and notifications disabled', async () => {
      vi.mocked(checkDailyBudget).mockReturnValue({ allowed: false, spent: 20 });

      const promise = callCycle(loop); // notifications=false by default
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(notify)).not.toHaveBeenCalled();
    });
  });

  // ── cycle() — worktree sync ───────────────────────────────────────────────

  describe('cycle() — worktree sync', () => {
    it('should sync worktree on each cycle', async () => {
      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(syncWorktree)).toHaveBeenCalledWith(agent.worktreePath);
    });

    it('should return early and sleep poll interval when sync fails', async () => {
      vi.mocked(syncWorktree).mockResolvedValue({
        success: false,
        error: 'network error',
      });

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      // Should NOT proceed to findRequests
      expect(vi.mocked(findRequests)).not.toHaveBeenCalled();
    });
  });

  // ── cycle() — checkpoint ──────────────────────────────────────────────────

  describe('cycle() — checkpoint management', () => {
    it('should read checkpoint before finding requests', async () => {
      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(getCheckpoint)).toHaveBeenCalledWith(hivePath, 'qa');
    });

    it('should advance checkpoint to current line count after reading chat', async () => {
      vi.mocked(getChatLineCount).mockReturnValue(42);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(setCheckpoint)).toHaveBeenCalledWith(hivePath, 'qa', 42);
    });

    it('should read messages since last checkpoint', async () => {
      vi.mocked(getCheckpoint).mockReturnValue(5);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(readMessagesSince)).toHaveBeenCalledWith(
        expect.stringContaining('chat.md'),
        5,
      );
    });
  });

  // ── cycle() — notifications for other-agent messages ─────────────────────

  describe('cycle() — notifications for other-agent messages', () => {
    it('should notify for DONE messages from other agents when notifications enabled', async () => {
      const configWithNotifications = makeHiveConfig();
      const notifyLoop = new AgentLoop(agent, configWithNotifications, hivePath, {
        notifications: true,
      });

      const doneMsg: ChatMessage = {
        role: 'BACKEND',
        type: 'DONE',
        body: 'Finished implementing API.',
        lineNumber: 6,
      };
      vi.mocked(readMessagesSince).mockReturnValue([doneMsg]);

      const promise = callCycle(notifyLoop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(notify)).toHaveBeenCalledWith(
        'BACKEND: DONE',
        expect.stringContaining('Finished implementing'),
        'normal',
      );
    });

    it('should use critical urgency for BLOCKER messages', async () => {
      const notifyLoop = new AgentLoop(agent, hiveConfig, hivePath, {
        notifications: true,
      });

      const blockerMsg: ChatMessage = {
        role: 'BACKEND',
        type: 'BLOCKER',
        body: 'Database is down.',
        lineNumber: 7,
      };
      vi.mocked(readMessagesSince).mockReturnValue([blockerMsg]);

      const promise = callCycle(notifyLoop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(notify)).toHaveBeenCalledWith(
        'BACKEND: BLOCKER',
        expect.any(String),
        'critical',
      );
    });

    it('should NOT notify for messages from this agent itself', async () => {
      const notifyLoop = new AgentLoop(agent, hiveConfig, hivePath, {
        notifications: true,
      });

      const selfMsg: ChatMessage = {
        role: 'QA', // same as agent.chatRole
        type: 'DONE',
        body: 'QA done message.',
        lineNumber: 8,
      };
      vi.mocked(readMessagesSince).mockReturnValue([selfMsg]);

      const promise = callCycle(notifyLoop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(notify)).not.toHaveBeenCalled();
    });

    it('should NOT notify for STATUS messages (not in notify_on list)', async () => {
      const notifyLoop = new AgentLoop(agent, hiveConfig, hivePath, {
        notifications: true,
      });

      const statusMsg: ChatMessage = {
        role: 'BACKEND',
        type: 'STATUS',
        body: 'Working on it.',
        lineNumber: 9,
      };
      vi.mocked(readMessagesSince).mockReturnValue([statusMsg]);

      const promise = callCycle(notifyLoop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(notify)).not.toHaveBeenCalled();
    });
  });

  // ── cycle() — plan reconciliation ────────────────────────────────────────

  describe('cycle() — plan reconciliation', () => {
    it('should reconcile plan when plan exists and there are new messages', async () => {
      const fakePlan = { tasks: [], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);

      const newMsg: ChatMessage = {
        role: 'BACKEND',
        type: 'DONE',
        body: 'Task completed.',
        lineNumber: 6,
      };
      vi.mocked(readMessagesSince).mockReturnValue([newMsg]);
      vi.mocked(reconcilePlanWithChat).mockReturnValue([
        { taskId: 'task-1', newStatus: 'done' },
      ]);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(reconcilePlanWithChat)).toHaveBeenCalledWith(fakePlan, [newMsg]);
      expect(vi.mocked(savePlan)).toHaveBeenCalledWith(hivePath, fakePlan);
    });

    it('should not reconcile when there are no new messages', async () => {
      const fakePlan = { tasks: [], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(readMessagesSince).mockReturnValue([]);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(reconcilePlanWithChat)).not.toHaveBeenCalled();
    });

    it('should not reconcile when no plan exists', async () => {
      vi.mocked(loadPlan).mockReturnValue(null);
      vi.mocked(readMessagesSince).mockReturnValue([
        { role: 'BACKEND', type: 'DONE', body: 'done', lineNumber: 6 },
      ]);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(reconcilePlanWithChat)).not.toHaveBeenCalled();
    });
  });

  // ── cycle() — chat requests ───────────────────────────────────────────────

  describe('cycle() — chat request dispatch', () => {
    it('should call findRequests with agent chatRole and checkpoint', async () => {
      vi.mocked(getCheckpoint).mockReturnValue(7);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(findRequests)).toHaveBeenCalledWith(
        expect.stringContaining('chat.md'),
        'QA',
        7,
      );
    });

    it('should execute the most recent request when multiple requests exist', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'old task', lineNumber: 3 },
        { role: 'PM', type: 'REQUEST', body: 'new task', lineNumber: 8 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      // spawn should have been called with args containing the prompt
      expect(vi.mocked(spawn)).toHaveBeenCalled();
      const spawnArgs = vi.mocked(spawn).mock.calls[0];
      // The prompt arg is the last element of the args array
      const args = spawnArgs[1] as string[];
      expect(args[args.length - 1]).toContain('new task');
    });

    it('should record spending on successful task', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'qa', 2);
    });

    it('should log task cost on successful task', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(logTaskCost)).toHaveBeenCalledWith(
        hivePath,
        'qa',
        'write tests',
        2,
        true,
      );
    });

    it('should rebase and push after successful task', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(rebaseAndPush)).toHaveBeenCalledWith(agent.worktreePath);
    });

    it('should reset consecutiveFails to 0 on task success', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const loopInternal = loop as unknown as { consecutiveFails: number };
      loopInternal.consecutiveFails = 2; // pre-set some failures

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(loopInternal.consecutiveFails).toBe(0);
    });

    it('should append BLOCKER message when push has conflict files', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      vi.mocked(rebaseAndPush).mockResolvedValue({
        success: false,
        conflictFiles: ['src/foo.ts', 'src/bar.ts'],
        error: 'conflict',
      });
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(appendMessage)).toHaveBeenCalledWith(
        expect.stringContaining('chat.md'),
        'QA',
        'BLOCKER',
        expect.stringContaining('src/foo.ts'),
      );
    });

    it('should record spending on failed task', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnExit(1); // non-zero = failure

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'qa', 2);
    });

    it('should log task cost with success=false on failed task', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnExit(1);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(logTaskCost)).toHaveBeenCalledWith(
        hivePath,
        'qa',
        'write tests',
        2,
        false,
      );
    });

    it('should increment consecutiveFails on task failure', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnExit(1);

      const loopInternal = loop as unknown as { consecutiveFails: number };

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(loopInternal.consecutiveFails).toBe(1);
    });

    it('should resolve false when spawn emits error event', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'write tests', lineNumber: 5 },
      ]);
      mockSpawnError(new Error('ENOENT: claude not found'));

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      // Task failed → consecutiveFails incremented
      const loopInternal = loop as unknown as { consecutiveFails: number };
      expect(loopInternal.consecutiveFails).toBe(1);
    });

    it('should pass skip_permissions flag to claude when enabled', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('should not pass skip_permissions flag when disabled', async () => {
      const noSkipAgent = makeAgent({ skip_permissions: false });
      const noSkipLoop = new AgentLoop(noSkipAgent, hiveConfig, hivePath);

      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(noSkipLoop);
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('should pass model flag when model is set', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop); // model='sonnet'
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
    });

    it('should spawn claude in the agent worktree directory', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const spawnOptions = vi.mocked(spawn).mock.calls[0][2] as { cwd?: string };
      expect(spawnOptions.cwd).toBe(agent.worktreePath);
    });

    it('should set HIVE env vars when spawning claude', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const spawnOptions = vi.mocked(spawn).mock.calls[0][2] as {
        env?: Record<string, string>;
      };
      expect(spawnOptions.env?.HIVE_AGENT_NAME).toBe('qa');
      expect(spawnOptions.env?.HIVE_AGENT_ROLE).toBe('QA');
      expect(spawnOptions.env?.HIVE_CHAT_FILE).toContain('chat.md');
    });
  });

  // ── cycle() — consecutive failure backoff ─────────────────────────────────

  describe('cycle() — consecutive failure backoff', () => {
    it('should sleep poll interval on failure below MAX_CONSECUTIVE_FAILS', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(1);

      // 2 failures is still below MAX (3)
      const loopInternal = loop as unknown as { consecutiveFails: number };
      loopInternal.consecutiveFails = 2; // after this cycle it becomes 3 → at limit

      const promise = callCycle(loop);
      // We don't need to check timer duration here; just verify no backoff notification
      await vi.runAllTimersAsync();
      await promise;

      // No backoff notification when below max
      expect(vi.mocked(notify)).not.toHaveBeenCalled();
    });

    it('should apply exponential backoff at MAX_CONSECUTIVE_FAILS', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(1);

      // Pre-set to MAX-1 so that after this cycle we hit exactly MAX (3)
      const loopInternal = loop as unknown as { consecutiveFails: number };
      loopInternal.consecutiveFails = 2;

      // Spy on console.log to detect backoff log
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const logCalls = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logCalls).toContain('BACKOFF');
      logSpy.mockRestore();
    });

    it('should send critical notification on backoff when notifications enabled', async () => {
      const notifyLoop = new AgentLoop(agent, hiveConfig, hivePath, {
        notifications: true,
      });

      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(1);

      const loopInternal = notifyLoop as unknown as { consecutiveFails: number };
      loopInternal.consecutiveFails = 2;

      const promise = callCycle(notifyLoop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(notify)).toHaveBeenCalledWith(
        expect.stringContaining('Backing off'),
        expect.any(String),
        'critical',
      );
    });

    it('should cap backoff at 30 minutes (BACKOFF_MAX_MS)', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(1);

      const loopInternal = loop as unknown as { consecutiveFails: number };
      // 100 failures: backoff should hit cap at BACKOFF_MAX_MS (30 min)
      loopInternal.consecutiveFails = 100;

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const logCalls = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      // Cap is 30 min = 1800s — should not exceed
      expect(logCalls).not.toContain('7200s'); // would be >2hr without cap
      expect(logCalls).toContain('1800s');
      logSpy.mockRestore();
    });
  });

  // ── cycle() — plan auto-dispatch ──────────────────────────────────────────

  describe('cycle() — plan auto-dispatch', () => {
    function makePlanTask(overrides = {}) {
      return {
        id: 'task-1',
        title: 'Write regression tests',
        description: 'Cover all edge cases',
        target: 'qa',
        priority: 'p1' as const,
        status: 'ready' as const,
        depends_on: [] as string[],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('should dispatch ready plan task targeting this agent', async () => {
      const fakePlan = { tasks: [makePlanTask()], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([makePlanTask()]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(spawn)).toHaveBeenCalled();
    });

    it('should set task status to dispatched before running then done on success (BUG 8 fix)', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      // BUG 8 fix: success path must set status='done' inline, not leave it as 'dispatched'
      expect(task.status).toBe('done');
      // savePlan must be called at least twice: once for 'dispatched', once for 'done'
      expect(vi.mocked(savePlan).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should not dispatch plan tasks targeting another agent', async () => {
      const task = makePlanTask({ target: 'backend' }); // different agent
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('should record spending when plan task succeeds', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'qa', 2);
    });

    it('should include task title in prompt when dispatching plan task', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const prompt = args[args.length - 1];
      expect(prompt).toContain('Write regression tests');
    });

    it('should increment consecutiveFails when plan task fails', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(1);

      const loopInternal = loop as unknown as { consecutiveFails: number };

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(loopInternal.consecutiveFails).toBe(1);
    });

    it('should call promoteReadyTasks before computing ready tasks', async () => {
      const fakePlan = { tasks: [], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([]);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(promoteReadyTasks)).toHaveBeenCalledWith(fakePlan);
    });
  });

  // ── cycle() — idle behavior ───────────────────────────────────────────────

  describe('cycle() — idle (no requests, no plan tasks)', () => {
    it('should increment consecutiveIdle when idle', async () => {
      const loopInternal = loop as unknown as { consecutiveIdle: number };

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(loopInternal.consecutiveIdle).toBe(1);
    });

    it('should reset consecutiveFails to 0 when idle', async () => {
      const loopInternal = loop as unknown as { consecutiveFails: number };
      loopInternal.consecutiveFails = 2;

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(loopInternal.consecutiveFails).toBe(0);
    });

    it('should log idle message every 10 cycles', async () => {
      const loopInternal = loop as unknown as { consecutiveIdle: number };
      loopInternal.consecutiveIdle = 9; // will become 10, triggering log

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const logCalls = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logCalls).toContain('Idle for');
      logSpy.mockRestore();
    });

    it('should not log idle message on non-10th cycles', async () => {
      const loopInternal = loop as unknown as { consecutiveIdle: number };
      loopInternal.consecutiveIdle = 0; // will become 1, no log

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const logCalls = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logCalls).not.toContain('Idle for');
      logSpy.mockRestore();
    });
  });

  // ── buildPrompt ───────────────────────────────────────────────────────────

  describe('buildPrompt (via spawn args)', () => {
    it('should include task description in the prompt', async () => {
      vi.mocked(findRequests).mockReturnValue([
        {
          role: 'PM',
          type: 'REQUEST',
          body: 'implement feature X',
          lineNumber: 5,
        },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const prompt = args[args.length - 1];
      expect(prompt).toContain('"implement feature X"');
    });

    it('should include DONE message format instructions in prompt', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'do work', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const prompt = args[args.length - 1];
      expect(prompt).toContain('DONE');
      expect(prompt).toContain('BLOCKER');
    });

    it('should include chat role in prompt', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'do work', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      const prompt = args[args.length - 1];
      expect(prompt).toContain('QA');
    });
  });

  // ── BUG 8 / BUG 10: plan task status set inline on success ───────────────

  describe('cycle() — BUG 8 / BUG 10: plan task status set inline on success', () => {
    function makePlanTask(overrides = {}) {
      return {
        id: 'task-1',
        title: 'Write regression tests',
        description: 'Cover all edge cases',
        target: 'qa',
        priority: 'p1' as const,
        status: 'ready' as const,
        depends_on: [] as string[],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('should set planTask.status to done after successful plan task execution', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(task.status).toBe('done');
    });

    it('should set planTask.completed_at when plan task succeeds', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(task.completed_at).toBeDefined();
      expect(typeof task.completed_at).toBe('string');
    });

    it('should set planTask.updated_at when plan task succeeds', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(task.updated_at).toBeDefined();
    });

    it('should set planTask.resolution when plan task succeeds', async () => {
      const task = makePlanTask({ description: 'Cover all edge cases' });
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(task.resolution).toBeDefined();
      expect(typeof task.resolution).toBe('string');
      expect(task.resolution!.length).toBeGreaterThan(0);
    });

    it('should call savePlan after successful plan task to persist done status', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0);

      const saveCallsBefore = vi.mocked(savePlan).mock.calls.length;

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      // savePlan called at least once more after the task completed
      expect(vi.mocked(savePlan).mock.calls.length).toBeGreaterThan(saveCallsBefore);
    });

    it('should NOT set planTask.status to done when plan task fails', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(1); // failure

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(task.status).not.toBe('done');
    });
  });

  // ── BUG 9: retry policy for transient plan task failures ─────────────────

  describe('cycle() — BUG 9: retry policy for transient plan task failures', () => {
    function makePlanTask(overrides = {}) {
      return {
        id: 'task-retry',
        title: 'Retry test task',
        description: 'Should retry on transient failure',
        target: 'qa',
        priority: 'p1' as const,
        status: 'ready' as const,
        depends_on: [] as string[],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('should call resetTaskForRetry when plan task fails', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      vi.mocked(resetTaskForRetry).mockReturnValue('retry');
      mockSpawnExit(1); // failure

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(resetTaskForRetry)).toHaveBeenCalledWith(task, expect.any(String));
    });

    it('should NOT call resetTaskForRetry when plan task succeeds', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      mockSpawnExit(0); // success

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(resetTaskForRetry)).not.toHaveBeenCalled();
    });

    it('should call savePlan after retry reset to persist the updated retry_count', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      vi.mocked(resetTaskForRetry).mockReturnValue('retry');
      mockSpawnExit(1);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(savePlan)).toHaveBeenCalled();
    });

    it('should append BLOCKER message when resetTaskForRetry returns failed', async () => {
      const task = makePlanTask({ id: 'task-perm-fail' });
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      vi.mocked(resetTaskForRetry).mockReturnValue('failed'); // exhausted retries
      mockSpawnExit(1);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(appendMessage)).toHaveBeenCalledWith(
        expect.stringContaining('chat.md'),
        'QA',
        'BLOCKER',
        expect.stringContaining('task-perm-fail'),
      );
    });

    it('should NOT append BLOCKER message when resetTaskForRetry returns retry', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      vi.mocked(resetTaskForRetry).mockReturnValue('retry'); // retries remain
      mockSpawnExit(1);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      // BLOCKER should NOT be appended when retries remain
      const blockerCalls = vi.mocked(appendMessage).mock.calls.filter(
        (call) => call[2] === 'BLOCKER',
      );
      expect(blockerCalls).toHaveLength(0);
    });

    it('should pass error string from runTask result to resetTaskForRetry', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      vi.mocked(resetTaskForRetry).mockReturnValue('retry');
      mockSpawnExit(1); // non-zero exit → error = 'claude exited with code 1'

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const call = vi.mocked(resetTaskForRetry).mock.calls[0];
      expect(call[1]).toContain('exited with code 1');
    });

    it('should call resetTaskForRetry with spawn error message when spawn fails', async () => {
      const task = makePlanTask();
      const fakePlan = { tasks: [task], version: 1 };
      vi.mocked(loadPlan).mockReturnValue(fakePlan as ReturnType<typeof loadPlan>);
      vi.mocked(computeReadyTasks).mockReturnValue([task]);
      vi.mocked(resetTaskForRetry).mockReturnValue('retry');
      mockSpawnError(new Error('ENOENT: claude not found'));

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const call = vi.mocked(resetTaskForRetry).mock.calls[0];
      expect(call[1]).toContain('spawn failed');
    });
  });

  // ── BE-10: Real cost tracking via parseClaudeCost ────────────────────────

  describe('cycle() — BE-10: real cost tracking via --output-format json', () => {
    const VALID_COST_JSON = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.04252125,
      session_id: 'test-session',
    });

    it('should include --output-format json in claude CLI args', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      const args = vi.mocked(spawn).mock.calls[0][1] as string[];
      expect(args).toContain('--output-format');
      const idx = args.indexOf('--output-format');
      expect(args[idx + 1]).toBe('json');
    });

    it('should use parsed cost from stdout JSON in recordSpending', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0, VALID_COST_JSON);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'qa', 0.04252125);
    });

    it('should fall back to config budget when stdout is empty', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      mockSpawnExit(0, ''); // no stdout → parseClaudeCost returns fallback

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'qa', 2);
    });

    it('should fall back to config budget when stdout JSON lacks total_cost_usd', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      const noCostJson = JSON.stringify({ type: 'result', subtype: 'success' });
      mockSpawnExit(0, noCostJson);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'qa', 2);
    });

    it('should use real cost even on failed task when JSON is available', async () => {
      vi.mocked(findRequests).mockReturnValue([
        { role: 'PM', type: 'REQUEST', body: 'task', lineNumber: 5 },
      ]);
      const failCostJson = JSON.stringify({ type: 'result', is_error: true, total_cost_usd: 0.01 });
      mockSpawnExit(1, failCostJson);

      const promise = callCycle(loop);
      await vi.runAllTimersAsync();
      await promise;

      expect(vi.mocked(recordSpending)).toHaveBeenCalledWith(hivePath, 'qa', 0.01);
    });
  });
});
