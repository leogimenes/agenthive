import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { acquireLock, releaseLock, getCheckpoint, setCheckpoint } from './lock.js';
import { checkDailyBudget, recordSpending } from './budget.js';
import { findRequests, appendMessage, getChatLineCount, resolveChatPath } from './chat.js';
import { syncWorktree, rebaseAndPush } from './worktree.js';
import type { ResolvedAgentConfig, HiveConfig } from '../types/config.js';

// ── Constants ───────────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILS = 3;
const BACKOFF_BASE_MS = 5 * 60 * 1000;   // 5 minutes
const BACKOFF_MAX_MS = 30 * 60 * 1000;   // 30 minutes
const BUDGET_EXHAUST_SLEEP_MS = 60 * 60 * 1000; // 1 hour

// ── AgentLoop ───────────────────────────────────────────────────────

export class AgentLoop {
  private agent: ResolvedAgentConfig;
  private hiveConfig: HiveConfig;
  private hivePath: string;
  private chatFilePath: string;
  private running = false;
  private consecutiveFails = 0;
  private consecutiveIdle = 0;

  constructor(
    agent: ResolvedAgentConfig,
    hiveConfig: HiveConfig,
    hivePath: string,
  ) {
    this.agent = agent;
    this.hiveConfig = hiveConfig;
    this.hivePath = hivePath;
    this.chatFilePath = resolveChatPath(hivePath, hiveConfig.chat.file);
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
      await sleep(BUDGET_EXHAUST_SLEEP_MS);
      return;
    }

    // 1. Sync worktree (fetch + rebase)
    const syncResult = await syncWorktree(this.agent.worktreePath);
    if (!syncResult.success) {
      this.log(`WARN: git sync failed: ${truncate(syncResult.error ?? '', 120)}`);
      await sleep(this.agent.poll * 1000);
      return;
    }

    // 2. Check chat for work
    const checkpoint = getCheckpoint(this.hivePath, this.agent.name);
    const requests = findRequests(
      this.chatFilePath,
      this.agent.chatRole,
      checkpoint,
    );

    // Advance checkpoint regardless
    const currentLines = getChatLineCount(this.chatFilePath);
    setCheckpoint(this.hivePath, this.agent.name, currentLines);

    if (requests.length > 0) {
      // Take the last request (most recent)
      const task = requests[requests.length - 1];
      this.log(`Found task: ${truncate(task.body, 120)}`);

      const success = await this.runTask(task.body);

      if (success) {
        this.consecutiveFails = 0;
        recordSpending(this.hivePath, this.agent.name, this.agent.budget);

        // Rebase and push after successful task
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

        await sleep(5000); // Brief pause before next check
      } else {
        this.consecutiveFails++;
        recordSpending(this.hivePath, this.agent.name, this.agent.budget);

        if (this.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          const power = this.consecutiveFails - MAX_CONSECUTIVE_FAILS;
          const backoff = Math.min(
            BACKOFF_BASE_MS * Math.pow(2, power),
            BACKOFF_MAX_MS,
          );
          this.log(
            `BACKOFF: ${this.consecutiveFails} consecutive failures. Sleeping ${Math.round(backoff / 1000)}s.`,
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

    // 3. Nothing to do — idle
    this.consecutiveIdle++;
    this.consecutiveFails = 0;

    if (this.consecutiveIdle % 10 === 0) {
      this.log(
        `Idle for ${this.consecutiveIdle * this.agent.poll}s (${this.consecutiveIdle} cycles)`,
      );
    }

    await sleep(this.agent.poll * 1000);
  }

  // ── Task execution ──────────────────────────────────────────────

  private async runTask(taskDescription: string): Promise<boolean> {
    const prompt = this.buildPrompt(taskDescription);

    this.log(`Executing: ${truncate(taskDescription, 100)}`);

    const args = [
      '-p',
      '--agent', this.agent.agent,
      '--no-session-persistence',
      '--max-budget-usd', String(this.agent.budget),
    ];

    if (this.agent.skip_permissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.agent.model) {
      args.push('--model', this.agent.model);
    }

    args.push(prompt);

    return new Promise<boolean>((resolve) => {
      const child = spawn('claude', args, {
        cwd: this.agent.worktreePath,
        stdio: 'inherit',
        env: {
          ...process.env,
          HIVE_CHAT_FILE: this.chatFilePath,
          HIVE_AGENT_NAME: this.agent.name,
          HIVE_AGENT_ROLE: this.agent.chatRole,
        },
      });

      child.on('error', (err) => {
        this.log(`ERROR: Failed to spawn claude: ${err.message}`);
        resolve(false);
      });

      child.on('close', (code) => {
        if (code === 0) {
          this.log('Task completed successfully.');
          resolve(true);
        } else {
          this.log(`Task exited with code ${code}.`);
          resolve(false);
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
   \`[${this.agent.chatRole}] DONE: <brief summary of what was completed>\`

If you cannot complete the task, append a BLOCKER message instead:
   \`[${this.agent.chatRole}] BLOCKER: <what went wrong and what is needed>\``;
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
