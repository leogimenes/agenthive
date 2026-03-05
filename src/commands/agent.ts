import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { parseDocument, stringify as toYaml } from 'yaml';
import { loadConfig, resolveHiveRoot, resolveHivePath } from '../core/config.js';
import { createWorktree, removeWorktree, syncAgentFilesToWorktree } from '../core/worktree.js';
import { getLockStatus, releaseLock } from '../core/lock.js';
import { tmux, tmuxSessionExists } from '../core/tmux.js';
import type { HiveConfig } from '../types/config.js';

// ── Command registration ────────────────────────────────────────────

export function registerAddCommand(program: Command): void {
  program
    .command('add <name>')
    .description('Add a new agent to the hive')
    .option('--agent <file>', 'Agent definition file name (maps to .claude/agents/<file>.md)')
    .option('--poll <seconds>', 'Poll interval in seconds', parseFloat)
    .option('--budget <usd>', 'Max USD per task invocation', parseFloat)
    .option('--daily-max <usd>', 'Max USD per agent per day', parseFloat)
    .option('--description <text>', 'Human-readable description of the agent')
    .action(async (name: string, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runAdd(cwd, name, opts);
    });
}

export function registerRemoveCommand(program: Command): void {
  program
    .command('remove <name>')
    .description('Remove an agent from the hive')
    .option('--force', 'Remove even if the agent is currently running')
    .option('--delete-branch', 'Also delete the git branch (agent/<name>)')
    .action(async (name: string, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runRemove(cwd, name, opts);
    });
}

// ── Add logic ───────────────────────────────────────────────────────

async function runAdd(
  cwd: string,
  name: string,
  opts: {
    agent?: string;
    poll?: number;
    budget?: number;
    dailyMax?: number;
    description?: string;
  },
): Promise<void> {
  let config: HiveConfig;
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

  // Validate name doesn't already exist
  if (config.agents[name]) {
    console.error(
      chalk.red(`Error: Agent "${name}" already exists in config. Use a different name.`),
    );
    process.exit(1);
  }

  // Validate no ID collision in role map
  const newRole = name.toUpperCase().replace(/-/g, '_');
  const existingRoles = Object.values(config.chat.role_map);
  if (existingRoles.includes(newRole)) {
    const conflicting = Object.entries(config.chat.role_map).find(
      ([, role]) => role === newRole,
    );
    console.error(
      chalk.red(
        `Error: Role tag "${newRole}" would collide with agent "${conflicting?.[0]}". Use a different name.`,
      ),
    );
    process.exit(1);
  }

  const agentFile = opts.agent ?? name;
  const description = opts.description ?? name;

  console.log(chalk.bold(`\n🐝 AgentHive — Adding agent "${name}"\n`));

  // 1. Create worktree and branch
  console.log(chalk.gray('Creating git worktree...'));
  try {
    const worktreePath = await createWorktree(hiveRoot, name);
    console.log(
      `  ${chalk.green('✓')} Worktree → ${chalk.gray(worktreePath)}`,
    );

    // 2. Register hooks in worktree
    registerHooksInWorktree(worktreePath, hivePath, config.hooks);
    console.log(`  ${chalk.green('✓')} Hooks registered in worktree`);

    // 2b. Sync agent files (.claude/agents/, CLAUDE.md) into worktree
    syncAgentFilesToWorktree(hiveRoot, worktreePath);
    console.log(`  ${chalk.green('✓')} Agent files synced to worktree`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error creating worktree: ${msg}`));
    process.exit(1);
  }

  // 3. Update config.yaml
  console.log(chalk.gray('Updating config.yaml...'));
  const configPath = join(hivePath, 'config.yaml');
  const rawYaml = readFileSync(configPath, 'utf-8');
  const doc = parseDocument(rawYaml);

  // Add agent entry
  const agentEntry: Record<string, unknown> = {
    description,
    agent: agentFile,
  };
  if (opts.poll !== undefined) agentEntry.poll = opts.poll;
  if (opts.budget !== undefined) agentEntry.budget = opts.budget;
  if (opts.dailyMax !== undefined) agentEntry.daily_max = opts.dailyMax;

  doc.setIn(['agents', name], agentEntry);

  // Add role mapping
  doc.setIn(['chat', 'role_map', name], newRole);

  writeFileSync(configPath, doc.toString(), 'utf-8');
  console.log(`  ${chalk.green('✓')} Config updated`);

  // 4. Summary
  console.log(chalk.bold.green(`\n✓ Agent "${name}" added!\n`));
  console.log(`  Worktree:  ${chalk.gray(`.hive/worktrees/${name}`)}`);
  console.log(`  Branch:    ${chalk.gray(`agent/${name}`)}`);
  console.log(`  Role:      ${chalk.gray(newRole)}`);
  console.log(`  Agent def: ${chalk.gray(`.claude/agents/${agentFile}.md`)}`);
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log(
    `  1. Create agent definition at ${chalk.cyan(`.claude/agents/${agentFile}.md`)} (if it doesn't exist)`,
  );
  console.log(`  2. Run ${chalk.cyan(`hive launch ${name}`)} to start the agent`);
  console.log('');
}

// ── Remove logic ────────────────────────────────────────────────────

async function runRemove(
  cwd: string,
  name: string,
  opts: { force?: boolean; deleteBranch?: boolean },
): Promise<void> {
  let config: HiveConfig;
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

  // Validate agent exists
  if (!config.agents[name]) {
    console.error(
      chalk.red(
        `Error: Agent "${name}" not found in config. Available: ${Object.keys(config.agents).join(', ')}`,
      ),
    );
    process.exit(1);
  }

  // Check if agent is running
  const lock = getLockStatus(hivePath, name);
  if (lock.locked && !lock.stale && !opts.force) {
    console.error(
      chalk.red(
        `Error: Agent "${name}" is currently running (PID ${lock.pid}). Use --force to remove anyway.`,
      ),
    );
    process.exit(1);
  }

  console.log(chalk.bold(`\n🐝 AgentHive — Removing agent "${name}"\n`));

  // 1. Kill tmux window if running
  if (lock.locked) {
    const sessionName = config.session;
    if (tmuxSessionExists(sessionName)) {
      try {
        tmux(['kill-window', '-t', `${sessionName}:${name}`], {
          stdio: 'ignore',
        });
        console.log(`  ${chalk.green('✓')} Killed tmux window`);
      } catch {
        console.log(`  ${chalk.gray('⊘')} No tmux window found`);
      }
    }

    // Kill process and release lock
    if (lock.pid && !lock.stale) {
      try {
        process.kill(lock.pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }
    releaseLock(hivePath, name);
    console.log(`  ${chalk.green('✓')} Lock released`);
  }

  // 2. Remove worktree
  console.log(chalk.gray('Removing git worktree...'));
  try {
    await removeWorktree(hiveRoot, name, opts.deleteBranch ?? false);
    console.log(`  ${chalk.green('✓')} Worktree removed`);
    if (opts.deleteBranch) {
      console.log(`  ${chalk.green('✓')} Branch agent/${name} deleted`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(chalk.yellow(`  Warning: Could not remove worktree: ${msg}`));
  }

  // 3. Update config.yaml
  console.log(chalk.gray('Updating config.yaml...'));
  const configPath = join(hivePath, 'config.yaml');
  const rawYaml = readFileSync(configPath, 'utf-8');
  const doc = parseDocument(rawYaml);

  doc.deleteIn(['agents', name]);
  doc.deleteIn(['chat', 'role_map', name]);

  writeFileSync(configPath, doc.toString(), 'utf-8');
  console.log(`  ${chalk.green('✓')} Config updated`);

  // 4. Clean up state files
  const stateFiles = [`${name}.lock`, `${name}.checkpoint`, `${name}.spend`];
  for (const file of stateFiles) {
    const filePath = join(hivePath, 'state', file);
    if (existsSync(filePath)) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(filePath);
    }
  }

  console.log(chalk.bold.green(`\n✓ Agent "${name}" removed.\n`));
}

// ── Helpers ─────────────────────────────────────────────────────────

interface ClaudeHookEntry {
  type: 'command';
  command: string;
}

interface ClaudeSettings {
  hooks: Record<string, ClaudeHookEntry[]>;
}

function registerHooksInWorktree(
  worktreePath: string,
  hivePath: string,
  hooks: HiveConfig['hooks'],
): void {
  const hooksDir = join(hivePath, 'hooks');
  const settings: ClaudeSettings = { hooks: {} };

  const resolveHookPath = (hookName: string): string =>
    resolve(join(hooksDir, `${hookName}.sh`));

  if (hooks.safety?.length) {
    settings.hooks.PreToolUse = hooks.safety.map((name) => ({
      type: 'command' as const,
      command: resolveHookPath(name),
    }));
  }

  if (hooks.coordination?.length) {
    const entries = hooks.coordination.map((name) => ({
      type: 'command' as const,
      command: resolveHookPath(name),
    }));
    settings.hooks.UserPromptSubmit = entries;
    settings.hooks.PostToolUse = entries;
  }

  if (hooks.custom?.length) {
    const customEntries = hooks.custom.map((name) => ({
      type: 'command' as const,
      command: resolveHookPath(name),
    }));
    if (settings.hooks.PreToolUse) {
      settings.hooks.PreToolUse.push(...customEntries);
    } else {
      settings.hooks.PreToolUse = customEntries;
    }
  }

  const claudeDir = join(worktreePath, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf-8',
  );
}
