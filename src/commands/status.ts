import { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../core/config.js';
import { getLockStatus } from '../core/lock.js';
import { getDailySpend } from '../core/budget.js';
import { readMessages, resolveChatPath } from '../core/chat.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show the state of all agents')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runStatus(cwd, opts);
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

    return {
      name: agent.name,
      role: agent.chatRole,
      status,
      pid: lock.pid,
      dailySpend: spent,
      dailyMax: agent.daily_max,
      lastActivity: lastMsg
        ? `${lastMsg.type}: ${truncate(lastMsg.body, 60)}`
        : undefined,
    };
  });

  // ── JSON output ────────────────────────────────────────────────────

  if (opts.json) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  // ── Table output ───────────────────────────────────────────────────

  console.log(chalk.bold('\n🐝 AgentHive — Agent Status\n'));

  const COL = { name: 14, status: 24, spend: 18 };

  console.log(
    chalk.gray(
      pad('AGENT', COL.name) +
        pad('STATUS', COL.status) +
        pad('DAILY SPEND', COL.spend) +
        'LAST ACTIVITY',
    ),
  );
  console.log(chalk.gray('─'.repeat(78)));

  for (const s of statuses) {
    // Name
    const nameCol = chalk.bold(pad(s.name, COL.name));

    // Status
    let statusPlain: string;
    let statusStyled: string;
    if (s.status === 'RUNNING') {
      statusPlain = `RUNNING (PID ${s.pid})`;
      statusStyled = chalk.green(statusPlain);
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
    const activityCol = s.lastActivity ?? chalk.gray('—');

    console.log(`${nameCol}${statusCol}${spendCol}${activityCol}`);
  }

  // Summary
  const running = statuses.filter((s) => s.status === 'RUNNING').length;
  const stale = statuses.filter((s) => s.status === 'STALE_LOCK').length;
  const total = statuses.length;

  console.log('');
  const parts = [`${running}/${total} agents running`];
  if (stale > 0) parts.push(chalk.yellow(`${stale} stale lock(s)`));
  parts.push(`session: ${config.session}`);
  console.log(chalk.gray(`  ${parts.join(' · ')}`));
  console.log('');
}

// ── Helpers ─────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
