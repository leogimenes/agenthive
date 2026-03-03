import { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../core/config.js';
import { getLockStatus } from '../core/lock.js';
import { getDailySpend } from '../core/budget.js';
import { readMessages, resolveChatPath } from '../core/chat.js';
import { timeAgo } from '../core/colors.js';
import { checkAgentHealth, healthLabel } from '../core/watchdog.js';
import type { AgentHealthState } from '../core/watchdog.js';
import { notify } from '../core/notify.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show the state of all agents')
    .option('--json', 'Output as JSON')
    .option('--watch', 'Continuously monitor agent health with desktop notifications')
    .option('--interval <seconds>', 'Watch interval in seconds (default: 30)', '30')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      if (opts.watch) {
        await runWatch(cwd, opts);
      } else {
        await runStatus(cwd, opts);
      }
    });
}

async function runStatus(
  cwd: string,
  opts: { json?: boolean },
): Promise<void> {
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
  const chatFilePath = resolveChatPath(hivePath, config.chat.file);
  const allMessages = readMessages(chatFilePath);

  // Build status for each agent
  const statuses = allAgents.map((agent) => {
    const lock = getLockStatus(hivePath, agent.name);
    const { spent } = getDailySpend(hivePath, agent.name);
    const health = checkAgentHealth(hivePath, agent.name, agent.poll);

    // Find last message from this agent
    const agentMessages = allMessages.filter(
      (m) => m.role === agent.chatRole,
    );
    const lastMsg =
      agentMessages.length > 0
        ? agentMessages[agentMessages.length - 1]
        : undefined;

    let status: 'RUNNING' | 'STOPPED' | 'STALE_LOCK';
    if (lock.locked && !lock.stale) {
      status = 'RUNNING';
    } else if (lock.locked && lock.stale) {
      status = 'STALE_LOCK';
    } else {
      status = 'STOPPED';
    }

    const lastActivityTime = lastMsg?.timestamp
      ? new Date(lastMsg.timestamp)
      : undefined;

    const timeStr = lastMsg?.timestamp
      ? timeAgo(lastMsg.timestamp)
      : undefined;

    return {
      name: agent.name,
      role: agent.chatRole,
      status,
      health: health.state,
      pid: lock.pid,
      dailySpend: spent,
      dailyMax: agent.daily_max,
      lastActivity: lastMsg
        ? `${lastMsg.type}: ${truncate(lastMsg.body, 60)}`
        : undefined,
      lastActivityTime,
      lastActivityAgo: timeStr,
    };
  });

  // ── JSON output ────────────────────────────────────────────────────

  if (opts.json) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  // ── Table output ───────────────────────────────────────────────────

  console.log(chalk.bold('\n🐝 AgentHive — Agent Status\n'));

  const COL = { name: 14, status: 28, spend: 18 };

  console.log(
    chalk.gray(
      pad('AGENT', COL.name) +
        pad('STATUS', COL.status) +
        pad('DAILY SPEND', COL.spend) +
        'LAST ACTIVITY',
    ),
  );
  console.log(chalk.gray('─'.repeat(82)));

  for (const s of statuses) {
    // Name
    const nameCol = chalk.bold(pad(s.name, COL.name));

    // Status with health indicator
    let statusPlain: string;
    let statusStyled: string;
    if (s.status === 'RUNNING') {
      const hlabel = healthLabel(s.health);
      statusPlain = `RUNNING (${hlabel})`;
      if (s.health === 'healthy') {
        statusStyled = chalk.green(statusPlain);
      } else if (s.health === 'unresponsive' || s.health === 'stuck') {
        statusStyled = chalk.yellow(statusPlain);
      } else {
        statusStyled = chalk.red(statusPlain);
      }
    } else if (s.status === 'STALE_LOCK') {
      statusPlain = `STALE (PID ${s.pid})`;
      statusStyled = chalk.yellow(statusPlain);
    } else {
      statusPlain = 'STOPPED';
      statusStyled = chalk.gray(statusPlain);
    }
    const statusCol =
      statusStyled + ' '.repeat(Math.max(0, COL.status - statusPlain.length));

    // Spend
    const spendPlain = `$${s.dailySpend.toFixed(2)}/$${s.dailyMax.toFixed(2)}`;
    const pct = s.dailyMax > 0 ? s.dailySpend / s.dailyMax : 0;
    const spendColor =
      pct > 0.8 ? chalk.red : pct > 0.5 ? chalk.yellow : chalk.green;
    const spendStyled = spendColor(spendPlain);
    const spendCol =
      spendStyled + ' '.repeat(Math.max(0, COL.spend - spendPlain.length));

    // Activity
    const agoSuffix = s.lastActivityAgo ? chalk.gray(` (${s.lastActivityAgo})`) : '';
    const activityCol = s.lastActivity
      ? `${s.lastActivity}${agoSuffix}`
      : chalk.gray('—');

    console.log(`${nameCol}${statusCol}${spendCol}${activityCol}`);
  }

  // Summary
  const running = statuses.filter((s) => s.status === 'RUNNING').length;
  const stale = statuses.filter((s) => s.status === 'STALE_LOCK').length;
  const unhealthy = statuses.filter(
    (s) => s.status === 'RUNNING' && s.health !== 'healthy',
  ).length;
  const total = statuses.length;

  console.log('');
  const parts = [`${running}/${total} agents running`];
  if (stale > 0) parts.push(chalk.yellow(`${stale} stale lock(s)`));
  if (unhealthy > 0) parts.push(chalk.yellow(`${unhealthy} unhealthy`));
  parts.push(`session: ${config.session}`);
  console.log(chalk.gray(`  ${parts.join(' · ')}`));
  console.log('');
}

// ── Watch mode ──────────────────────────────────────────────────────

async function runWatch(
  cwd: string,
  opts: { interval?: string },
): Promise<void> {
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

  const intervalSec = parseInt(opts.interval ?? '30', 10);
  const intervalMs = (isNaN(intervalSec) ? 30 : intervalSec) * 1000;

  // Track previous health states to detect transitions
  const previousStates = new Map<string, AgentHealthState>();

  console.log(
    chalk.bold(`\n🐝 AgentHive — Health Watchdog (every ${intervalSec}s, Ctrl-C to stop)\n`),
  );

  const check = () => {
    const allAgents = resolveAllAgents(config, hiveRoot);

    for (const agent of allAgents) {
      const health = checkAgentHealth(hivePath, agent.name, agent.poll);
      const prev = previousStates.get(agent.name);

      // Detect unhealthy state changes
      if (
        prev !== health.state &&
        health.state !== 'healthy' &&
        health.state !== 'stopped'
      ) {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const label = healthLabel(health.state);

        console.log(
          `[${ts}] ${chalk.bold(agent.name)}: ${stateColor(health.state)(label)}` +
            (health.pid ? ` (PID ${health.pid})` : ''),
        );

        // Desktop notification
        notify(
          `AgentHive: ${agent.name} ${label}`,
          `Agent ${agent.name} is ${label}. PID: ${health.pid ?? 'unknown'}`,
          health.state === 'dead' ? 'critical' : 'normal',
        );
      }

      // Detect recovery
      if (
        prev !== undefined &&
        prev !== 'healthy' &&
        prev !== 'stopped' &&
        health.state === 'healthy'
      ) {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        console.log(
          `[${ts}] ${chalk.bold(agent.name)}: ${chalk.green('recovered')}`,
        );
      }

      previousStates.set(agent.name, health.state);
    }
  };

  // Initial check
  check();

  // Schedule periodic checks
  const timer = setInterval(check, intervalMs);

  // Clean exit
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\nWatchdog stopped.');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {}); // never resolves
}

// ── Helpers ─────────────────────────────────────────────────────────

function stateColor(state: AgentHealthState) {
  switch (state) {
    case 'healthy':
      return chalk.green;
    case 'unresponsive':
    case 'stuck':
      return chalk.yellow;
    case 'dead':
      return chalk.red;
    case 'stopped':
      return chalk.gray;
  }
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
