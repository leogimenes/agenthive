import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../core/config.js';
import { getLockStatus, releaseLock } from '../core/lock.js';
import { tmux, tmuxSessionExists, shellQuote } from '../core/tmux.js';
import type { ResolvedAgentConfig } from '../types/config.js';

type AgentState = 'running' | 'stale' | 'stopped';

interface RecoveryAction {
  agent: ResolvedAgentConfig;
  state: AgentState;
  pid?: number;
  action: 'skip' | 'relaunch' | 'launch' | 'restart';
  reason: string;
}

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .description('Detect orphaned state and relaunch dead agents')
    .option('--yes', 'Skip confirmation prompt')
    .option('--force', 'Restart even running agents')
    .option('--dry-run', 'Show recovery plan without executing')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runResume(cwd, opts);
    });
}

async function runResume(
  cwd: string,
  opts: { yes?: boolean; force?: boolean; dryRun?: boolean },
): Promise<void> {
  // Verify tmux is available
  if (!commandExists('tmux')) {
    console.error(chalk.red('Error: tmux is not installed. Install it first.'));
    process.exit(1);
  }

  // Verify claude CLI is available
  if (!commandExists('claude')) {
    console.error(chalk.red('Error: claude CLI is not installed or not in PATH.'));
    process.exit(1);
  }

  let config;
  let hiveRoot: string;
  let hivePath: string;

  try {
    hiveRoot = resolveHiveRoot(cwd);
    hivePath = resolveHivePath(cwd);
    config = loadConfig(cwd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }

  const allAgents = resolveAllAgents(config, hiveRoot);
  const sessionName = config.session;
  const sessionExists = tmuxSessionExists(sessionName);
  const tmuxWindows = sessionExists ? listTmuxWindows(sessionName) : [];

  console.log(chalk.bold('\n🐝 AgentHive — Session Recovery\n'));

  // Build recovery plan
  const plan: RecoveryAction[] = [];

  for (const agent of allAgents) {
    const lock = getLockStatus(hivePath, agent.name);
    const hasWindow = tmuxWindows.includes(agent.name);

    if (lock.locked && !lock.stale) {
      // PID alive — agent is truly running
      if (opts.force) {
        plan.push({
          agent,
          state: 'running',
          pid: lock.pid,
          action: 'restart',
          reason: `Running (PID ${lock.pid}) — will restart (--force)`,
        });
      } else {
        plan.push({
          agent,
          state: 'running',
          pid: lock.pid,
          action: 'skip',
          reason: `Running (PID ${lock.pid})`,
        });
      }
    } else if (lock.locked && lock.stale) {
      // Stale lock — PID dead, lock remains
      plan.push({
        agent,
        state: 'stale',
        pid: lock.pid,
        action: 'relaunch',
        reason: `Stale lock (PID ${lock.pid} dead)${hasWindow ? ', tmux window exists' : ''} — will clean and relaunch`,
      });
    } else {
      // No lock — agent is stopped
      plan.push({
        agent,
        state: 'stopped',
        action: 'launch',
        reason: 'No state — will launch',
      });
    }
  }

  // Display recovery plan
  const toSkip = plan.filter(p => p.action === 'skip');
  const toLaunch = plan.filter(p => p.action === 'launch' || p.action === 'relaunch' || p.action === 'restart');

  console.log(chalk.gray('  Recovery plan:\n'));

  for (const entry of plan) {
    let icon: string;
    let color: (s: string) => string;

    switch (entry.action) {
      case 'skip':
        icon = '⊘';
        color = chalk.gray;
        break;
      case 'relaunch':
        icon = '↻';
        color = chalk.yellow;
        break;
      case 'restart':
        icon = '⟳';
        color = chalk.magenta;
        break;
      case 'launch':
        icon = '+';
        color = chalk.green;
        break;
    }

    console.log(`  ${color(icon)} ${chalk.bold(entry.agent.name)} — ${color(entry.reason)}`);
  }

  console.log('');

  if (toLaunch.length === 0) {
    console.log(chalk.green('All agents are running. Nothing to recover.\n'));
    return;
  }

  console.log(chalk.gray(`  ${toSkip.length} running, ${toLaunch.length} to (re)launch\n`));

  // Dry run — stop here
  if (opts.dryRun) {
    console.log(chalk.gray('  --dry-run: no changes made.\n'));
    return;
  }

  // Prompt for confirmation
  if (!opts.yes) {
    const confirmed = await promptConfirm(`Proceed with recovery? (${toLaunch.length} agent(s) to launch)`);
    if (!confirmed) {
      console.log(chalk.gray('\nAborted.\n'));
      return;
    }
    console.log('');
  }

  // Execute recovery
  const hiveBin = process.argv[1];
  let needsNewSession = !sessionExists;

  for (const entry of toLaunch) {
    const { agent } = entry;

    // Clean up stale state
    if (entry.action === 'relaunch') {
      releaseLock(hivePath, agent.name);
      // Kill stale tmux window if it exists
      if (sessionExists && tmuxWindows.includes(agent.name)) {
        try {
          tmux(['kill-window', '-t', `${sessionName}:${agent.name}`], { stdio: 'ignore' });
        } catch {
          // Window may already be gone
        }
      }
    }

    // For --force restart: kill running process and window
    if (entry.action === 'restart') {
      if (entry.pid) {
        try {
          process.kill(entry.pid, 'SIGTERM');
        } catch {
          // Process may have already exited
        }
      }
      releaseLock(hivePath, agent.name);
      if (sessionExists) {
        try {
          tmux(['kill-window', '-t', `${sessionName}:${agent.name}`], { stdio: 'ignore' });
        } catch {
          // Window may already be gone
        }
      }
    }

    // Launch agent in tmux
    const loopCmd = buildLoopCommand(hiveBin, agent.name, hiveRoot);

    if (needsNewSession) {
      tmux(
        ['new-session', '-d', '-s', sessionName, '-n', agent.name, loopCmd],
        { stdio: 'ignore' },
      );
      needsNewSession = false;
    } else {
      tmux(
        ['new-window', '-t', sessionName, '-n', agent.name, loopCmd],
        { stdio: 'ignore' },
      );
    }

    console.log(`  ${chalk.green('✓')} ${chalk.bold(agent.name)} — relaunched`);
  }

  console.log(chalk.bold.green(`\n✓ Recovery complete — ${toLaunch.length} agent(s) (re)launched\n`));
  console.log(`  Attach:  ${chalk.cyan(`tmux attach -t ${sessionName}`)}`);
  console.log(`  Status:  ${chalk.cyan('hive status')}`);
  console.log('');
}

// ── Helpers ─────────────────────────────────────────────────────────

function commandExists(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function listTmuxWindows(sessionName: string): string[] {
  try {
    const output = execFileSync(
      'tmux',
      ['list-windows', '-t', sessionName, '-F', '#{window_name}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function buildLoopCommand(
  hiveBin: string,
  agentName: string,
  hiveRoot: string,
): string {
  const isTsx = hiveBin.endsWith('.ts') || process.argv[0].includes('tsx');
  const q = shellQuote;

  if (isTsx) {
    return `npx tsx ${q(hiveBin)} --cwd ${q(hiveRoot)} _loop ${q(agentName)}`;
  }

  return `node ${q(hiveBin)} --cwd ${q(hiveRoot)} _loop ${q(agentName)}`;
}

async function promptConfirm(message: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`  ${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
