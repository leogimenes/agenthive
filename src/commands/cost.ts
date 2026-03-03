import { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../core/config.js';
import { readCostLog, readCostLogSince, getDailySpend, type CostLogEntry } from '../core/budget.js';

export function registerCostCommand(program: Command): void {
  program
    .command('cost')
    .description('Show per-agent and aggregate cost summary')
    .option('--agent <name>', 'Show task-by-task breakdown for one agent')
    .option('--since <date>', 'Filter by date (YYYY-MM-DD)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runCost(cwd, opts);
    });
}

async function runCost(
  cwd: string,
  opts: { agent?: string; since?: string; json?: boolean },
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

  // ── Single agent detail view ──────────────────────────────────────

  if (opts.agent) {
    const agent = allAgents.find(
      (a) => a.name.toLowerCase() === opts.agent!.toLowerCase(),
    );
    if (!agent) {
      console.error(chalk.red(`Error: Unknown agent "${opts.agent}"`));
      process.exit(1);
    }

    const entries = opts.since
      ? readCostLogSince(hivePath, agent.name, opts.since)
      : readCostLog(hivePath, agent.name);

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    console.log(chalk.bold(`\nCost breakdown for ${agent.name}\n`));

    if (entries.length === 0) {
      console.log(chalk.gray('  No cost entries recorded.'));
      console.log('');
      return;
    }

    const COL = { time: 22, task: 50, amount: 10 };
    console.log(
      chalk.gray(
        pad('TIMESTAMP', COL.time) +
          pad('TASK', COL.task) +
          pad('AMOUNT', COL.amount) +
          'STATUS',
      ),
    );
    console.log(chalk.gray('─'.repeat(90)));

    let total = 0;
    for (const e of entries) {
      total += e.amount;
      const ts = e.timestamp.replace('T', ' ').slice(0, 19);
      const taskTrunc = truncate(e.task, COL.task - 2);
      const amountStr = `$${e.amount.toFixed(2)}`;
      const statusStr = e.success
        ? chalk.green('OK')
        : chalk.red('FAIL');

      console.log(
        pad(ts, COL.time) +
          pad(taskTrunc, COL.task) +
          pad(amountStr, COL.amount) +
          statusStr,
      );
    }

    console.log(chalk.gray('─'.repeat(90)));
    console.log(
      chalk.bold(
        `  Total: $${total.toFixed(2)} across ${entries.length} task(s)`,
      ),
    );
    console.log(
      chalk.gray(
        '\n  Note: Costs are estimated based on per-task budget caps',
      ),
    );
    console.log('');
    return;
  }

  // ── Summary view (all agents) ──────────────────────────────────────

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = getDateDaysAgo(7);

  const summaries = allAgents.map((agent) => {
    const allEntries = readCostLog(hivePath, agent.name);
    const todayEntries = allEntries.filter(
      (e) => e.timestamp.slice(0, 10) === today,
    );
    const weekEntries = allEntries.filter(
      (e) => e.timestamp.slice(0, 10) >= weekAgo,
    );
    const { spent: dailySpend } = getDailySpend(hivePath, agent.name);

    return {
      name: agent.name,
      dailyMax: agent.daily_max,
      todaySpend: sum(todayEntries.map((e) => e.amount)),
      todayTasks: todayEntries.length,
      weekSpend: sum(weekEntries.map((e) => e.amount)),
      weekTasks: weekEntries.length,
      dailySpend,
    };
  });

  if (opts.json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  console.log(chalk.bold('\nAgentHive — Cost Summary\n'));

  const COL = { name: 14, today: 22, week: 22, budget: 16 };
  console.log(
    chalk.gray(
      pad('AGENT', COL.name) +
        pad('TODAY', COL.today) +
        pad('THIS WEEK', COL.week) +
        'DAILY BUDGET',
    ),
  );
  console.log(chalk.gray('─'.repeat(74)));

  let totalToday = 0;
  let totalWeek = 0;
  let totalTodayTasks = 0;
  let totalWeekTasks = 0;

  for (const s of summaries) {
    totalToday += s.todaySpend;
    totalWeek += s.weekSpend;
    totalTodayTasks += s.todayTasks;
    totalWeekTasks += s.weekTasks;

    const nameCol = chalk.bold(pad(s.name, COL.name));
    const todayStr = `$${s.todaySpend.toFixed(2)} (${s.todayTasks} tasks)`;
    const weekStr = `$${s.weekSpend.toFixed(2)} (${s.weekTasks} tasks)`;
    const budgetStr = `$${s.dailySpend.toFixed(2)}/$${s.dailyMax.toFixed(2)}`;

    const pct = s.dailyMax > 0 ? s.dailySpend / s.dailyMax : 0;
    const budgetColor =
      pct > 0.8 ? chalk.red : pct > 0.5 ? chalk.yellow : chalk.green;

    console.log(
      nameCol +
        pad(todayStr, COL.today) +
        pad(weekStr, COL.week) +
        budgetColor(budgetStr),
    );
  }

  console.log(chalk.gray('─'.repeat(74)));
  console.log(
    chalk.bold(
      `  Total: $${totalToday.toFixed(2)} today (${totalTodayTasks} tasks) · $${totalWeek.toFixed(2)} this week (${totalWeekTasks} tasks)`,
    ),
  );
  console.log(
    chalk.gray(
      '\n  Note: Costs are estimated based on per-task budget caps',
    ),
  );
  console.log('');
}

// ── Helpers ─────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function sum(nums: number[]): number {
  return Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
}

function getDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
