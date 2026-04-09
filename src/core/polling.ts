import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { acquireLock, releaseLock, getCheckpoint, setCheckpoint, updateHeartbeat } from './lock.js';
import { checkDailyBudget, recordSpending, logTaskCost } from './budget.js';
import { findRequests, appendMessage, getChatLineCount, resolveChatPath, readMessagesSince } from './chat.js';
import { syncWorktree, rebaseAndPush } from './worktree.js';
import { acquireGitLock, releaseGitLock } from './gitlock.js';
import { loadPlan, savePlan, reconcilePlanWithChat, computeReadyTasks, promoteReadyTasks, resetTaskForRetry, DEFAULT_MAX_RETRIES, notifyEpicCompletions } from './plan.js';
import { notify } from './notify.js';
import { rotateTranscripts } from './transcripts.js';
import type { ResolvedAgentConfig, HiveConfig } from '../types/config.js';

// ── Constants ───────────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILS = 3;
const BACKOFF_BASE_MS = 5 * 60 * 1000;   // 5 minutes
const BACKOFF_MAX_MS = 30 * 60 * 1000;   // 30 minutes
const BUDGET_EXHAUST_SLEEP_MS = 60 * 60 * 1000; // 1 hour

// Git sync circuit breaker
const GIT_SYNC_MAX_FAILURES = 3;
const GIT_SYNC_BACKOFF_BASE_MS = 2 * 60 * 1000;   // 2 minutes
const GIT_SYNC_BACKOFF_MAX_MS = 15 * 60 * 1000;    // 15 minutes

// ── AgentLoop ───────────────────────────────────────────────────────

export interface AgentLoopOptions {
  /** Override notification setting from config. */
  notifications?: boolean;
}

export class AgentLoop {
  private agent: ResolvedAgentConfig;
  private hiveConfig: HiveConfig;
  private hivePath: string;
  private chatFilePath: string;
  private running = false;
  private consecutiveFails = 0;
  private consecutiveIdle = 0;
  private notificationsEnabled: boolean;
  private notifyOn: Set<string>;

  // Git sync circuit breaker state
  private gitSyncFailures = 0;
  private gitSyncCircuitOpen = false;
  private gitSyncBackoffUntil?: number;

  constructor(
    agent: ResolvedAgentConfig,
    hiveConfig: HiveConfig,
    hivePath: string,
    options?: AgentLoopOptions,
  ) {
    this.agent = agent;
    this.hiveConfig = hiveConfig;
    this.hivePath = hivePath;
    this.chatFilePath = resolveChatPath(hivePath, hiveConfig.chat.file);
    this.notificationsEnabled =
      options?.notifications ?? hiveConfig.defaults.notifications;
    this.notifyOn = new Set(
      hiveConfig.defaults.notify_on.map((t) => t.toUpperCase()),
    );
  }

  async start(): Promise<void> {
    // Acquire lock
    if (!acquireLock(this.hivePath, this.agent.name)) {
      this.log('ERROR: Another instance is already running. Exiting.');
      process.exit(1);
    }

    this.running = true;

    // Register cleanup
    const cleanup = () => {
      this.running = false;
      releaseLock(this.hivePath, this.agent.name);
    };
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);

    // Initialize checkpoint if missing
    const currentCheckpoint = getCheckpoint(this.hivePath, this.agent.name);
    if (currentCheckpoint === 0) {
      const lineCount = getChatLineCount(this.chatFilePath);
      setCheckpoint(this.hivePath, this.agent.name, lineCount);
      this.log(`Initialized checkpoint at line ${lineCount}`);
    }

    this.log('Starting autonomous loop (chat-driven)');
    this.log(`  Worktree: ${this.agent.worktreePath}`);
    this.log(`  Agent:    ${this.agent.agent} (${this.agent.chatRole})`);
    this.log(`  Poll:     ${this.agent.poll}s`);
    this.log(`  Budget:   $${this.agent.budget}/task, $${this.agent.daily_max}/day`);
    this.log('');

    while (this.running) {
      await this.cycle();
    }
  }

  stop(): void {
    this.running = false;
  }

  // ── Main cycle ──────────────────────────────────────────────────

  private async cycle(): Promise<void> {
    // 0a. Update heartbeat in lock file
    updateHeartbeat(this.hivePath, this.agent.name);

    // 0b. Rotate old transcripts to keep storage bounded
    const retention = this.hiveConfig.defaults.transcript_retention;
    const rotated = rotateTranscripts(this.agent.worktreePath, retention);
    if (rotated.deleted > 0) {
      this.log(`Rotated transcripts: deleted ${rotated.deleted} old session(s) (retention=${retention})`);
    }

    // 0. Check daily budget
    const { allowed, spent } = checkDailyBudget(
      this.hivePath,
      this.agent.name,
      this.agent.daily_max,
    );
    if (!allowed) {
      this.log(
        `DAILY BUDGET EXHAUSTED: $${spent} spent of $${this.agent.daily_max} max. Sleeping 1 hour.`,
      );
      this.sendNotify(
        `${this.agent.name}: Budget exhausted`,
        `$${spent} spent of $${this.agent.daily_max} daily max. Agent sleeping 1 hour.`,
        'critical',
      );
      await sleep(BUDGET_EXHAUST_SLEEP_MS);
      return;
    }

    // 1. Check chat for work FIRST (before git sync — chat is always accessible)
    const checkpoint = getCheckpoint(this.hivePath, this.agent.name);
    const newMessages = readMessagesSince(this.chatFilePath, checkpoint);

    // Fire notifications for notable messages from other agents
    for (const msg of newMessages) {
      if (msg.role !== this.agent.chatRole && this.notifyOn.has(msg.type)) {
        this.sendNotify(
          `${msg.role}: ${msg.type}`,
          truncate(msg.body, 200),
          msg.type === 'BLOCKER' ? 'critical' : 'normal',
        );
      }
    }

    // Reconcile plan with new chat messages (if plan exists)
    const plan = loadPlan(this.hivePath);
    if (plan && newMessages.length > 0) {
      const updates = reconcilePlanWithChat(plan, newMessages);
      if (updates.length > 0) {
        const epicsDone = notifyEpicCompletions(plan, this.chatFilePath, this.hiveConfig.delivery.definition_of_done);
        savePlan(this.hivePath, plan);
        this.log(`Plan updated: ${updates.map((u) => `${u.taskId}→${u.newStatus}`).join(', ')}`);
        if (epicsDone.length > 0) {
          this.log(`Epic completions notified: ${epicsDone.join(', ')}`);
        }
      }
    }

    const requests = findRequests(
      this.chatFilePath,
      this.agent.chatRole,
      checkpoint,
    );

    const currentLines = getChatLineCount(this.chatFilePath);

    // If there are requests, attempt to process them
    if (requests.length > 0) {
      const task = requests[requests.length - 1]; // most recent
      this.log(`Found task: ${truncate(task.body, 120)}`);
      this.consecutiveIdle = 0;

      // 2. Sync worktree before running the task
      await this.syncWorktreeWithRecovery();

      const result = await this.runTask(task.body);

      if (result.success) {
        this.consecutiveFails = 0;
        recordSpending(this.hivePath, this.agent.name, result.cost);
        logTaskCost(this.hivePath, this.agent.name, task.body, result.cost, true);

        // Advance checkpoint AFTER successful processing (BUG 2 fix)
        setCheckpoint(this.hivePath, this.agent.name, currentLines);

        // Rebase and push after successful task
        const pushLocked = await acquireGitLock(this.hivePath, this.agent.name, 'push', 10000);
        if (pushLocked) {
          try {
            const pushResult = await rebaseAndPush(this.agent.worktreePath);
            if (!pushResult.success) {
              this.log(`WARN: push failed after task: ${truncate(pushResult.error ?? '', 120)}`);
              if (pushResult.conflictFiles?.length) {
                appendMessage(
                  this.chatFilePath,
                  this.agent.chatRole,
                  'BLOCKER',
                  `Rebase conflict on ${pushResult.conflictFiles.join(', ')}. Manual resolution needed.`,
                );
              }
            }
          } finally {
            releaseGitLock(this.hivePath, this.agent.name);
          }
        } else {
          this.log('WARN: could not acquire git lock for push — will retry next cycle');
        }

        await sleep(5000); // Brief pause before next check
      } else {
        this.consecutiveFails++;
        recordSpending(this.hivePath, this.agent.name, result.cost);
        logTaskCost(this.hivePath, this.agent.name, task.body, result.cost, false);

        // Post BLOCKER to chat so other agents and the plan have visibility (BUG 4 fix)
        appendMessage(
          this.chatFilePath,
          this.agent.chatRole,
          'BLOCKER',
          `Task failed (${this.consecutiveFails} consecutive failures): ${truncate(task.body, 200)}`,
        );

        // Advance checkpoint — we've acknowledged the failure publicly
        setCheckpoint(this.hivePath, this.agent.name, getChatLineCount(this.chatFilePath));

        if (this.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          const power = this.consecutiveFails - MAX_CONSECUTIVE_FAILS;
          const backoff = Math.min(
            BACKOFF_BASE_MS * Math.pow(2, power),
            BACKOFF_MAX_MS,
          );
          this.log(
            `BACKOFF: ${this.consecutiveFails} consecutive failures. Sleeping ${Math.round(backoff / 1000)}s.`,
          );
          this.sendNotify(
            `${this.agent.name}: Backing off`,
            `${this.consecutiveFails} consecutive failures. Sleeping ${Math.round(backoff / 1000)}s.`,
            'critical',
          );
          await sleep(backoff);
        } else {
          this.log(
            `Failure ${this.consecutiveFails}/${MAX_CONSECUTIVE_FAILS}. Sleeping ${this.agent.poll}s.`,
          );
          await sleep(this.agent.poll * 1000);
        }
      }
      return;
    }

    // No direct requests — advance checkpoint past non-request messages
    setCheckpoint(this.hivePath, this.agent.name, currentLines);

    // 3. Check plan for ready tasks targeting this agent (auto-dispatch)
    if (plan) {
      promoteReadyTasks(plan);
      const readyTasks = computeReadyTasks(plan).filter(
        (t) => t.target.toLowerCase() === this.agent.name.toLowerCase(),
      );

      if (readyTasks.length > 0) {
        const planTask = readyTasks[0]; // highest priority
        const now = new Date().toISOString();

        // Transition to running (BUG 5 fix)
        planTask.status = 'running';
        planTask.dispatched_at = planTask.dispatched_at ?? now;
        planTask.updated_at = now;
        savePlan(this.hivePath, plan);

        const desc = planTask.description
          ? `. ${planTask.description.split('\n')[0]}`
          : '';
        const taskBody = `[${planTask.id}] ${planTask.title}${desc}`;
        this.log(`Plan task: ${truncate(taskBody, 120)}`);

        // Sync worktree before running the task
        await this.syncWorktreeWithRecovery();

        const planResult = await this.runTask(taskBody);
        if (planResult.success) {
          this.consecutiveFails = 0;
          recordSpending(this.hivePath, this.agent.name, planResult.cost);
          logTaskCost(this.hivePath, this.agent.name, taskBody, planResult.cost, true);

          // BUG 10 fix: Update plan task status INLINE in the success path.
          // reconcilePlanWithChat is the backup for cross-agent DONE messages only.
          // The agent's own checkpoint advances past its own DONE message, so
          // reconcilePlanWithChat would never see it — primary update must happen here.
          const completedAt = new Date().toISOString();
          planTask.status = 'done';
          planTask.updated_at = completedAt;
          planTask.completed_at = completedAt;
          planTask.resolution = taskBody;
          const epicsDoneInline = notifyEpicCompletions(plan, this.chatFilePath, this.hiveConfig.delivery.definition_of_done);
          savePlan(this.hivePath, plan);
          if (epicsDoneInline.length > 0) {
            this.log(`Epic completions notified: ${epicsDoneInline.join(', ')}`);
          }

          const planPushLocked = await acquireGitLock(this.hivePath, this.agent.name, 'push', 10000);
          if (planPushLocked) {
            try {
              const pushResult = await rebaseAndPush(this.agent.worktreePath);
              if (!pushResult.success) {
                this.log(`WARN: push failed after task: ${truncate(pushResult.error ?? '', 120)}`);
              }
            } finally {
              releaseGitLock(this.hivePath, this.agent.name);
            }
          } else {
            this.log('WARN: could not acquire git lock for push — will retry next cycle');
          }

          await sleep(5000);
        } else {
          this.consecutiveFails++;
          recordSpending(this.hivePath, this.agent.name, planResult.cost);
          logTaskCost(this.hivePath, this.agent.name, taskBody, planResult.cost, false);

          // BUG 9 fix: Retry policy for transient failures.
          const outcome = resetTaskForRetry(planTask, planResult.error);
          if (outcome === 'failed') {
            const maxRetries = planTask.max_retries ?? DEFAULT_MAX_RETRIES;
            this.log(
              `Plan task ${planTask.id} exhausted all ${maxRetries} retries. Marking permanently failed.`,
            );
            appendMessage(
              this.chatFilePath,
              this.agent.chatRole,
              'BLOCKER',
              `[${planTask.id}] Task failed permanently after ${planTask.retry_count} attempt(s). Manual intervention required.`,
            );
          } else {
            const maxRetries = planTask.max_retries ?? DEFAULT_MAX_RETRIES;
            this.log(
              `Plan task ${planTask.id} failed transiently (attempt ${planTask.retry_count}/${maxRetries}). Will retry.`,
            );
          }
          savePlan(this.hivePath, plan);
          await sleep(this.agent.poll * 1000);
        }
        return;
      }
    }

    // 4. Nothing to do — idle
    this.consecutiveIdle++;
    this.consecutiveFails = 0;

    // Sync worktree during idle so it's ready for next task
    if (!this.isGitSyncCircuitOpen()) {
      const locked = await acquireGitLock(this.hivePath, this.agent.name, 'sync', 0);
      if (locked) {
        try {
          const syncResult = await syncWorktree(this.agent.worktreePath);
          if (syncResult.success) {
            this.resetGitSyncCircuit();
          } else {
            this.log(`WARN: idle git sync failed: ${truncate(syncResult.error ?? '', 120)}`);
            this.recordGitSyncFailure(syncResult.error);
          }
        } finally {
          releaseGitLock(this.hivePath, this.agent.name);
        }
      }
    }

    if (this.consecutiveIdle % 10 === 0) {
      this.log(
        `Idle for ${this.consecutiveIdle * this.agent.poll}s (${this.consecutiveIdle} cycles)`,
      );
    }

    await sleep(this.agent.poll * 1000);
  }

  // ── Worktree sync with recovery ─────────────────────────────────

  /**
   * Sync the worktree, recovering from dirty state if needed.
   * BUG 3 fix: dirty worktrees should not block autonomous development.
   *
   * Recovery strategy:
   * 1. Try normal sync (fetch + rebase) with smart strategies
   * 2. If that fails, stash changes and retry
   * 3. If still failing, commit WIP changes and retry
   * 4. If all else fails, log warning and continue (agent can still work)
   */
  private async syncWorktreeWithRecovery(): Promise<void> {
    if (this.isGitSyncCircuitOpen()) {
      this.log('Git sync circuit breaker is open — skipping pre-task sync');
      return;
    }

    const locked = await acquireGitLock(this.hivePath, this.agent.name, 'sync', 5000);
    if (!locked) {
      this.log('WARN: could not acquire git lock for pre-task sync — skipping');
      return;
    }

    try {
      await this.syncWorktreeWithRecoveryInner();
    } finally {
      releaseGitLock(this.hivePath, this.agent.name);
    }
  }

  private async syncWorktreeWithRecoveryInner(): Promise<void> {
    // First attempt: normal sync (now uses smart strategies internally)
    const result = await syncWorktree(this.agent.worktreePath);
    if (result.success) {
      this.resetGitSyncCircuit();
      return;
    }

    this.log(`WARN: git sync failed, attempting recovery: ${truncate(result.error ?? '', 120)}`);

    // Second attempt: stash dirty changes, sync, then pop
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);

      // Check if there are dirty changes
      const { stdout: status } = await exec(
        'git', ['status', '--porcelain'],
        { cwd: this.agent.worktreePath },
      );

      if (status.trim().length > 0) {
        // Stash everything including untracked files
        await exec(
          'git', ['stash', 'push', '-u', '-m', `hive-auto-stash-${Date.now()}`],
          { cwd: this.agent.worktreePath },
        );
        this.log('Stashed dirty changes for sync');

        const retryResult = await syncWorktree(this.agent.worktreePath);

        // Pop stash regardless of sync result
        try {
          await exec('git', ['stash', 'pop'], { cwd: this.agent.worktreePath });
          this.log('Restored stashed changes');
        } catch {
          this.log('WARN: could not pop stash — changes saved in git stash list');
        }

        if (retryResult.success) {
          this.resetGitSyncCircuit();
          return;
        }
      }

      // Third attempt: commit WIP and sync
      if (status.trim().length > 0) {
        await exec(
          'git', ['add', '-A'],
          { cwd: this.agent.worktreePath },
        );
        await exec(
          'git', ['commit', '-m', `wip: auto-commit by hive agent ${this.agent.name} for sync recovery`],
          { cwd: this.agent.worktreePath },
        );
        this.log('Auto-committed WIP changes for sync');

        const retryResult = await syncWorktree(this.agent.worktreePath);
        if (retryResult.success) {
          this.resetGitSyncCircuit();
          return;
        }
        this.log(`WARN: sync still failing after WIP commit: ${truncate(retryResult.error ?? '', 120)}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`WARN: sync recovery failed: ${truncate(msg, 120)}`);
    }

    // Continue anyway — the agent can still work on its current branch state
    this.log('Continuing with current worktree state despite sync failure');
    this.recordGitSyncFailure(result.error);
  }

  // ── Git sync circuit breaker ───────────────────────────────────

  private isGitSyncCircuitOpen(): boolean {
    if (!this.gitSyncCircuitOpen) return false;
    // Auto-reset after backoff expires
    if (this.gitSyncBackoffUntil && Date.now() > this.gitSyncBackoffUntil) {
      this.gitSyncCircuitOpen = false;
      this.gitSyncFailures = 0;
      this.gitSyncBackoffUntil = undefined;
      this.log('Git sync circuit breaker reset — will attempt sync again');
      return false;
    }
    return true;
  }

  private recordGitSyncFailure(error?: string): void {
    this.gitSyncFailures++;
    if (this.gitSyncFailures >= GIT_SYNC_MAX_FAILURES && !this.gitSyncCircuitOpen) {
      this.gitSyncCircuitOpen = true;
      const power = this.gitSyncFailures - GIT_SYNC_MAX_FAILURES;
      const backoff = Math.min(
        GIT_SYNC_BACKOFF_BASE_MS * Math.pow(2, power),
        GIT_SYNC_BACKOFF_MAX_MS,
      );
      this.gitSyncBackoffUntil = Date.now() + backoff;

      appendMessage(
        this.chatFilePath,
        this.agent.chatRole,
        'BLOCKER',
        `Git sync failing repeatedly (${this.gitSyncFailures} failures). ` +
        `Circuit breaker open for ${Math.round(backoff / 1000)}s. ` +
        `Last error: ${truncate(error ?? 'unknown', 200)}`,
      );

      this.sendNotify(
        `${this.agent.name}: Git sync circuit breaker`,
        `${this.gitSyncFailures} consecutive sync failures`,
        'critical',
      );
    }
  }

  private resetGitSyncCircuit(): void {
    if (this.gitSyncFailures > 0) {
      this.log(`Git sync recovered after ${this.gitSyncFailures} failure(s)`);
    }
    this.gitSyncFailures = 0;
    this.gitSyncCircuitOpen = false;
    this.gitSyncBackoffUntil = undefined;
  }

  // ── Task execution ──────────────────────────────────────────────

  /**
   * Run the claude agent for the given task description.
   * Returns { success: true, cost } on exit code 0,
   * or { success: false, error, cost } on spawn failure or non-zero exit.
   * The `cost` field holds the real USD spend from claude's JSON output,
   * falling back to this.agent.budget if parsing fails.
   */
  private async runTask(
    taskDescription: string,
  ): Promise<{ success: true; cost: number; sessionId?: string } | { success: false; error: string; cost: number }> {
    const prompt = this.buildPrompt(taskDescription);

    this.log(`Executing: ${truncate(taskDescription, 100)}`);

    const args = [
      '-p',
      '--agent', this.agent.agent,
      '--max-budget-usd', String(this.agent.budget),
      '--output-format', 'json',
    ];

    if (this.agent.skip_permissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.agent.model) {
      args.push('--model', this.agent.model);
    }

    args.push(prompt);

    return new Promise((resolve) => {
      // Remove CLAUDECODE env var to prevent "nested session" error —
      // hive agents are independent sessions, not nested ones.
      const { CLAUDECODE, ...cleanEnv } = process.env;
      const child = spawn('claude', args, {
        cwd: this.agent.worktreePath,
        // Capture stdout for JSON cost data; keep stderr visible in tmux
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...cleanEnv,
          HIVE_CHAT_FILE: this.chatFilePath,
          HIVE_AGENT_NAME: this.agent.name,
          HIVE_AGENT_ROLE: this.agent.chatRole,
        },
      });

      const stdoutChunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

      child.on('error', (err) => {
        this.log(`ERROR: Failed to spawn claude: ${(err as Error).message}`);
        resolve({ success: false, error: `spawn failed: ${(err as Error).message}`, cost: this.agent.budget });
      });

      child.on('close', (code) => {
        const rawOutput = Buffer.concat(stdoutChunks).toString('utf-8');
        const cost = parseClaudeCost(rawOutput, this.agent.budget);
        const sessionId = parseClaudeSessionId(rawOutput);
        if (code === 0) {
          this.log('Task completed successfully.');
          resolve({ success: true, cost, ...(sessionId ? { sessionId } : {}) });
        } else {
          this.log(`Task exited with code ${code}.`);
          resolve({ success: false, error: `claude exited with code ${code}`, cost });
        }
      });
    });
  }

  private buildPrompt(taskDescription: string): string {
    return `You are running in autonomous mode. A task has been dispatched to you via the coordination chat:

"${taskDescription}"

Implement this task following your workflow strictly.

After completing:
1. Run your build gate and test gate
2. Commit your changes with your standard commit message format
3. Append a DONE message to the chat file at \`${this.chatFilePath}\`:
   \`[${this.agent.chatRole}] DONE <ISO8601_TIMESTAMP>: <brief summary of what was completed>\`
   Example: \`[${this.agent.chatRole}] DONE <2026-03-02T12:34:56.789Z>: implemented pagination\`

If you cannot complete the task, append a BLOCKER message instead:
   \`[${this.agent.chatRole}] BLOCKER <ISO8601_TIMESTAMP>: <what went wrong and what is needed>\``;
  }

  // ── Notifications ──────────────────────────────────────────────

  private sendNotify(
    title: string,
    body: string,
    urgency: 'low' | 'normal' | 'critical' = 'normal',
  ): void {
    if (!this.notificationsEnabled) return;
    notify(title, body, urgency);
  }

  // ── Logging ─────────────────────────────────────────────────────

  private log(message: string): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] [${this.agent.chatRole}] ${message}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/**
 * Parse total_cost_usd from claude CLI --output-format json output.
 * Claude may emit warning text before the JSON object, so we scan backwards
 * for the last line that starts with '{' and try to parse it.
 * Returns the fallback value if parsing fails for any reason.
 */
export function parseClaudeCost(stdout: string, fallback: number): number {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed['total_cost_usd'] === 'number') {
          return parsed['total_cost_usd'] as number;
        }
      } catch {
        // Continue scanning
      }
    }
  }
  return fallback;
}

/**
 * Extract the session_id from claude CLI JSON output.
 * Returns undefined if not present or parsing fails.
 */
export function parseClaudeSessionId(stdout: string): string | undefined {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed['session_id'] === 'string') {
          return parsed['session_id'] as string;
        }
      } catch {
        // Continue scanning
      }
    }
  }
  return undefined;
}
