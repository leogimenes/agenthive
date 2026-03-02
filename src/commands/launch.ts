import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../core/config.js';
import { getLockStatus } from '../core/lock.js';
import { tmux, tmuxSessionExists, shellQuote } from '../core/tmux.js';
import type { ResolvedAgentConfig } from '../types/config.js';

export function registerLaunchCommand(program: Command): void {
  program
    .command('launch [agents...]')
    .description('Start agent polling daemons in a tmux session')
    .option('--dry-run', 'Show what would be launched without starting')
    .option('--attach', 'Attach to tmux session after launching')
    .option('--force', 'Kill existing session before launching')
    .option('--notify', 'Enable desktop notifications for agent events')
    .option('--no-notify', 'Disable desktop notifications')
    .action(async (agents: string[], opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runLaunch(cwd, agents, opts);
    });
}

// ── Internal command: _loop (not shown in --help) ───────────────────

export function registerLoopCommand(program: Command): void {
  program
    .command('_loop <agent>', { hidden: true })
    .description('Internal: run a single agent polling loop')
    .action(async (agentName: string) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runLoop(cwd, agentName);
    });
}

// ── Launch logic ────────────────────────────────────────────────────

async function runLaunch(
  cwd: string,
  agentFilter: string[],
  opts: { dryRun?: boolean; attach?: boolean; force?: boolean; notify?: boolean },
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

  // Filter agents if names were provided
  let selected: ResolvedAgentConfig[];
  if (agentFilter.length > 0) {
    selected = [];
    for (const name of agentFilter) {
      const agent = allAgents.find((a) => a.name === name);
      if (!agent) {
        console.error(
          chalk.red(`Unknown agent: "${name}". Available: ${allAgents.map((a) => a.name).join(', ')}`),
        );
        process.exit(1);
      }
      selected.push(agent);
    }
  } else {
    selected = allAgents;
  }

  const sessionName = config.session;

  console.log(chalk.bold(`\n🐝 AgentHive — Launching ${selected.length} agent(s)\n`));

  // Dry run — just show what would happen
  if (opts.dryRun) {
    for (const agent of selected) {
      const lock = getLockStatus(hivePath, agent.name);
      const lockInfo = lock.locked
        ? lock.stale
          ? chalk.yellow('(stale lock)')
          : chalk.red(`(running PID ${lock.pid})`)
        : chalk.green('(available)');

      console.log(
        `  ${chalk.bold(agent.name)} ${lockInfo}`,
      );
      console.log(
        chalk.gray(`    worktree: ${agent.worktreePath}`),
      );
      console.log(
        chalk.gray(`    poll: ${agent.poll}s, budget: $${agent.budget}/task, $${agent.daily_max}/day`),
      );
    }
    console.log(chalk.gray('\n  --dry-run: no agents were started.\n'));
    return;
  }

  // Check / kill existing tmux session
  if (tmuxSessionExists(sessionName)) {
    if (opts.force) {
      tmux(['kill-session', '-t', sessionName], { stdio: 'ignore' });
      console.log(chalk.gray(`Killed existing tmux session: ${sessionName}`));
    } else {
      console.error(
        chalk.red(
          `tmux session "${sessionName}" already exists. Use --force to replace it.`,
        ),
      );
      process.exit(1);
    }
  }

  // Find the hive CLI path — we invoke ourselves via `hive _loop <agent>`
  const hiveBin = process.argv[1]; // path to our entry point

  // Launch each agent in a tmux window
  let first = true;
  for (const agent of selected) {
    // Skip if already running (PID alive)
    const lock = getLockStatus(hivePath, agent.name);
    if (lock.locked && !lock.stale) {
      console.log(
        `  ${chalk.yellow('⊘')} ${chalk.bold(agent.name)} — already running (PID ${lock.pid}), skipping`,
      );
      continue;
    }

    // Build the loop command
    // Use tsx in dev or node in production
    const notifyOverride = opts.notify !== undefined ? opts.notify : undefined;
    const loopCmd = buildLoopCommand(hiveBin, agent.name, hiveRoot, notifyOverride);

    if (first) {
      tmux(
        ['new-session', '-d', '-s', sessionName, '-n', agent.name, loopCmd],
        { stdio: 'ignore' },
      );
      first = false;
    } else {
      tmux(
        ['new-window', '-t', sessionName, '-n', agent.name, loopCmd],
        { stdio: 'ignore' },
      );
    }

    console.log(
      `  ${chalk.green('✓')} ${chalk.bold(agent.name)} → ${chalk.gray(`poll: ${agent.poll}s, $${agent.budget}/task, $${agent.daily_max}/day`)}`,
    );
  }

  if (first) {
    // No agents were launched (all were already running)
    console.log(chalk.yellow('\nNo new agents launched — all were already running.\n'));
    return;
  }

  console.log(chalk.bold.green(`\n✓ Agents launched in tmux session "${sessionName}"\n`));
  console.log(`  Attach:   ${chalk.cyan(`tmux attach -t ${sessionName}`)}`);
  console.log(`  Windows:  ${chalk.gray('Ctrl-b + n (next) / p (prev) / <number>')}`);
  console.log(`  Status:   ${chalk.cyan('hive status')}`);
  console.log(`  Kill all: ${chalk.cyan('hive kill')}`);
  console.log('');

  if (opts.attach) {
    tmux(['attach', '-t', sessionName], { stdio: 'inherit' });
  }
}

// ── Loop logic (internal) ───────────────────────────────────────────

async function runLoop(cwd: string, agentName: string): Promise<void> {
  // Dynamic import to avoid loading polling module for non-loop commands
  const { AgentLoop } = await import('../core/polling.js');

  let config;
  let hiveRoot: string;
  let hivePath: string;

  try {
    hiveRoot = resolveHiveRoot(cwd);
    hivePath = resolveHivePath(cwd);
    config = loadConfig(cwd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] ${msg}`);
    process.exit(1);
  }

  const allAgents = resolveAllAgents(config, hiveRoot);
  const agent = allAgents.find((a) => a.name === agentName);

  if (!agent) {
    console.error(`[ERROR] Unknown agent: "${agentName}"`);
    process.exit(1);
  }

  // Read notification override from environment (set by `hive launch --notify`)
  const notifyEnv = process.env.HIVE_NOTIFY;
  const notifyOverride = notifyEnv === '1' ? true : notifyEnv === '0' ? false : undefined;

  const loop = new AgentLoop(agent, config, hivePath, {
    notifications: notifyOverride,
  });
  await loop.start();
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

function buildLoopCommand(
  hiveBin: string,
  agentName: string,
  hiveRoot: string,
  notifyOverride?: boolean,
): string {
  // Detect if running via tsx (development) or compiled
  const isTsx = hiveBin.endsWith('.ts') || process.argv[0].includes('tsx');
  const q = shellQuote;

  // Pass notification override via environment variable
  const envPrefix = notifyOverride !== undefined
    ? `HIVE_NOTIFY=${notifyOverride ? '1' : '0'} `
    : '';

  if (isTsx) {
    // Dev mode: use tsx to run the TS source
    return `${envPrefix}npx tsx ${q(hiveBin)} --cwd ${q(hiveRoot)} _loop ${q(agentName)}`;
  }

  // Production: run the compiled JS directly
  return `${envPrefix}node ${q(hiveBin)} --cwd ${q(hiveRoot)} _loop ${q(agentName)}`;
}
