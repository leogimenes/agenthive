import { Command } from 'commander';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  loadConfig,
  resolveHiveRoot,
  resolveHivePath,
  resolveAllAgents,
} from '../core/config.js';

export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('Show the resolved configuration')
    .option('--raw', 'Show the raw config.yaml without resolving defaults')
    .option('--json', 'Output as JSON instead of YAML')
    .option('--agents', 'Show only the resolved agents table')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runConfig(cwd, opts);
    });
}

async function runConfig(
  cwd: string,
  opts: { raw?: boolean; json?: boolean; agents?: boolean },
): Promise<void> {
  // ── Mutual exclusivity check ──────────────────────────────────────
  if (opts.raw && opts.agents) {
    console.error(
      chalk.red('Error: --raw and --agents are mutually exclusive'),
    );
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

  // ── Raw mode ─────────────────────────────────────────────────────
  if (opts.raw) {
    const configPath = resolve(hivePath, 'config.yaml');
    const raw = readFileSync(configPath, 'utf-8');

    if (opts.json) {
      const parsed = yamlParse(raw);
      console.log(JSON.stringify(parsed, null, 2));
      return;
    }

    console.log(raw);
    return;
  }

  // ── Agents-only mode ───────────────────────────────────────────────

  if (opts.agents) {
    const allAgents = resolveAllAgents(config, hiveRoot);

    if (opts.json) {
      console.log(JSON.stringify(allAgents, null, 2));
      return;
    }

    console.log(chalk.bold('\n🐝 AgentHive — Resolved Agents\n'));

    const COL = { name: 14, role: 12, agent: 18, poll: 8, budget: 10, daily: 10 };

    console.log(
      chalk.gray(
        pad('NAME', COL.name) +
          pad('ROLE', COL.role) +
          pad('AGENT FILE', COL.agent) +
          pad('POLL', COL.poll) +
          pad('BUDGET', COL.budget) +
          pad('DAILY', COL.daily) +
          'WORKTREE',
      ),
    );
    console.log(chalk.gray('─'.repeat(96)));

    for (const a of allAgents) {
      console.log(
        chalk.bold(pad(a.name, COL.name)) +
          chalk.cyan(pad(a.chatRole, COL.role)) +
          pad(a.agent + '.md', COL.agent) +
          pad(a.poll + 's', COL.poll) +
          pad('$' + a.budget.toFixed(2), COL.budget) +
          pad('$' + a.daily_max.toFixed(2), COL.daily) +
          chalk.gray(a.worktreePath),
      );
    }
    console.log('');
    return;
  }

  // ── Full resolved config ───────────────────────────────────────────

  const allAgents = resolveAllAgents(config, hiveRoot);

  // Build a "resolved" view that shows effective values
  const resolved = {
    session: config.session,
    hive_root: hiveRoot,
    hive_path: hivePath,
    defaults: config.defaults,
    agents: Object.fromEntries(
      allAgents.map((a) => [
        a.name,
        {
          description: a.description,
          agent: a.agent,
          chat_role: a.chatRole,
          poll: a.poll,
          budget: a.budget,
          daily_max: a.daily_max,
          model: a.model,
          skip_permissions: a.skip_permissions,
          worktree: a.worktreePath,
        },
      ]),
    ),
    chat: config.chat,
    hooks: config.hooks,
  };

  if (opts.json) {
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }

  // Pretty YAML output with header
  console.log(chalk.bold('\n🐝 AgentHive — Resolved Configuration\n'));
  console.log(chalk.gray(`  Root: ${hiveRoot}`));
  console.log(chalk.gray(`  Config: ${hivePath}/config.yaml`));
  console.log('');

  const yamlOutput = yamlStringify(resolved, {
    indent: 2,
    lineWidth: 120,
  });

  // Colorize the YAML output
  for (const line of yamlOutput.split('\n')) {
    if (line.match(/^\s*#/)) {
      // Comment
      console.log(chalk.gray(line));
    } else if (line.match(/^[a-z_]+:/)) {
      // Top-level key
      console.log(chalk.bold.cyan(line));
    } else if (line.match(/^\s+[a-z_]+:/)) {
      // Nested key
      const [key, ...rest] = line.split(':');
      console.log(chalk.cyan(key) + ':' + rest.join(':'));
    } else {
      console.log(line);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}
