import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { stringify as toYaml } from 'yaml';
import { createWorktree, isGitRepo, getMainBranch } from '../core/worktree.js';
import { initChatFile } from '../core/chat.js';
import { EMBEDDED_HOOKS } from '../hooks/embedded.js';
import type { HiveConfig, AgentConfig, DefaultsConfig } from '../types/config.js';

// ── Presets ─────────────────────────────────────────────────────────

interface AgentPreset {
  description: string;
  agent: string;
  poll?: number;
  budget?: number;
}

const AVAILABLE_AGENTS: Record<string, AgentPreset> = {
  sre: { description: 'Site Reliability Engineer', agent: 'sre' },
  frontend: { description: 'Frontend Developer', agent: 'frontend', poll: 90 },
  backend: { description: 'Backend Engineer', agent: 'backend' },
  qa: { description: 'Quality Analyst', agent: 'qa', poll: 90 },
  security: { description: 'Security Engineer', agent: 'appsec' },
  devops: { description: 'DevOps Engineer', agent: 'devops' },
  pm: { description: 'Product Manager', agent: 'pm', poll: 120, budget: 1.0 },
};

const PRESETS: Record<string, string[]> = {
  fullstack: ['sre', 'frontend', 'backend', 'qa', 'security'],
  'backend-only': ['sre', 'backend', 'qa', 'security'],
  minimal: ['backend', 'qa'],
};

// ── Command registration ────────────────────────────────────────────

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize AgentHive in the current git repository')
    .option('--agents <list>', 'Comma-separated agent names to create')
    .option(
      '--preset <name>',
      `Use a predefined agent set (${Object.keys(PRESETS).join(', ')})`,
    )
    .option('--yes', 'Skip interactive prompts, use defaults')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runInit(cwd, opts);
    });
}

// ── Init logic ──────────────────────────────────────────────────────

async function runInit(
  cwd: string,
  opts: { agents?: string; preset?: string; yes?: boolean },
): Promise<void> {
  console.log(chalk.bold('\n🐝 AgentHive — Initializing\n'));

  // 1. Verify git repo
  if (!(await isGitRepo(cwd))) {
    console.error(
      chalk.red('Error: Not a git repository. Run `git init` first.'),
    );
    process.exit(1);
  }

  // 2. Check for existing .hive/
  const hivePath = join(cwd, '.hive');
  if (existsSync(hivePath)) {
    console.error(
      chalk.red(
        'Error: .hive/ already exists. Edit .hive/config.yaml to add agents and create worktrees with `git worktree add`.',
      ),
    );
    process.exit(1);
  }

  // 3. Determine which agents to create
  let selectedAgents: string[];

  if (opts.agents) {
    selectedAgents = opts.agents.split(',').map((a) => a.trim());
    validateAgentNames(selectedAgents);
  } else if (opts.preset) {
    if (!PRESETS[opts.preset]) {
      console.error(
        chalk.red(
          `Unknown preset: ${opts.preset}. Available: ${Object.keys(PRESETS).join(', ')}`,
        ),
      );
      process.exit(1);
    }
    selectedAgents = PRESETS[opts.preset];
  } else if (opts.yes) {
    selectedAgents = PRESETS.fullstack;
  } else {
    selectedAgents = await promptAgentSelection();
  }

  if (selectedAgents.length === 0) {
    console.error(chalk.red('Error: At least one agent must be selected.'));
    process.exit(1);
  }

  const mainBranch = await getMainBranch(cwd);

  // 4. Create directory structure
  console.log(chalk.gray('Creating .hive/ directory structure...'));
  mkdirSync(hivePath, { recursive: true });
  mkdirSync(join(hivePath, 'hooks'), { recursive: true });
  mkdirSync(join(hivePath, 'state'), { recursive: true });
  mkdirSync(join(hivePath, 'worktrees'), { recursive: true });

  // 5. Copy hooks
  console.log(chalk.gray('Installing hooks...'));
  copyHooks(hivePath);

  // 6. Create config
  console.log(chalk.gray('Writing config.yaml...'));
  const config = buildConfig(cwd, selectedAgents);
  writeFileSync(
    join(hivePath, 'config.yaml'),
    toYaml(config, { lineWidth: 0 }),
    'utf-8',
  );

  // 7. Create chat file
  console.log(chalk.gray('Creating chat.md...'));
  initChatFile(hivePath);

  // 8. Create worktrees
  console.log(chalk.gray('Creating git worktrees...\n'));
  const createdWorktrees: string[] = [];
  for (const name of selectedAgents) {
    try {
      const path = await createWorktree(cwd, name, mainBranch);
      createdWorktrees.push(path);
      console.log(
        `  ${chalk.green('✓')} ${chalk.bold(name)} → ${chalk.gray(path)}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${chalk.red('✗')} ${chalk.bold(name)} — ${msg}`);
    }
  }

  // 8b. Register hooks with Claude Code in each worktree
  console.log(chalk.gray('\nRegistering hooks with Claude Code...'));
  for (const worktreePath of createdWorktrees) {
    registerHooksInWorktree(worktreePath, hivePath, config.hooks);
  }

  // 9. Update .gitignore
  updateGitignore(cwd);

  // 10. Summary
  console.log(chalk.bold.green('\n✓ AgentHive initialized!\n'));
  console.log(`  Agents:   ${selectedAgents.join(', ')}`);
  console.log(`  Config:   ${chalk.gray('.hive/config.yaml')}`);
  console.log(`  Chat:     ${chalk.gray('.hive/chat.md')}`);
  console.log(`  Hooks:    ${chalk.gray('.hive/hooks/')}`);
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log(
    `  1. Create agent definitions in ${chalk.cyan('.claude/agents/<name>.md')}`,
  );
  console.log(`  2. Edit ${chalk.cyan('.hive/config.yaml')} to tune budgets and poll intervals`);
  console.log(`  3. Run ${chalk.cyan('hive launch')} to start agents`);
  console.log(`  4. Run ${chalk.cyan('hive dispatch sre "your task"')} to assign work`);
  console.log('');
}

// ── Helpers ─────────────────────────────────────────────────────────

async function promptAgentSelection(): Promise<string[]> {
  const choices = Object.entries(AVAILABLE_AGENTS).map(([name, preset]) => ({
    name: `${name} — ${preset.description}`,
    value: name,
    checked: PRESETS.fullstack.includes(name),
  }));

  return checkbox({
    message: 'Which agents do you want to create?',
    choices,
  });
}

function validateAgentNames(names: string[]): void {
  for (const name of names) {
    if (!AVAILABLE_AGENTS[name]) {
      console.warn(
        chalk.yellow(
          `Warning: "${name}" is not a built-in agent. It will be created with default settings.`,
        ),
      );
    }
  }
}

function buildConfig(
  cwd: string,
  agentNames: string[],
): HiveConfig {
  const defaults: DefaultsConfig = {
    poll: 60,
    budget: 2.0,
    daily_max: 20.0,
    model: 'sonnet',
    skip_permissions: true,
  };

  const agents: Record<string, AgentConfig> = {};
  const roleMap: Record<string, string> = {};

  for (const name of agentNames) {
    const preset = AVAILABLE_AGENTS[name];
    agents[name] = {
      description: preset?.description ?? name,
      agent: preset?.agent ?? name,
      ...(preset?.poll !== undefined ? { poll: preset.poll } : {}),
      ...(preset?.budget !== undefined ? { budget: preset.budget } : {}),
    };
    roleMap[name] = name.toUpperCase().replace(/-/g, '_');
  }

  return {
    session: basename(cwd),
    defaults,
    agents,
    chat: {
      file: 'chat.md',
      role_map: roleMap,
    },
    hooks: {
      safety: ['destructive-guard'],
      coordination: ['check-chat'],
    },
  };
}

function copyHooks(hivePath: string): void {
  const hooksDest = join(hivePath, 'hooks');
  const hookNames = ['destructive-guard', 'check-chat'];

  for (const hookName of hookNames) {
    const destPath = join(hooksDest, `${hookName}.sh`);
    const embedded = EMBEDDED_HOOKS[hookName];

    if (embedded) {
      writeFileSync(destPath, embedded, 'utf-8');
      chmodSync(destPath, 0o755);
    } else {
      console.warn(
        chalk.yellow(`Warning: hook "${hookName}" not found in embedded hooks — skipping`),
      );
    }
  }
}

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

  // Resolve hook name → absolute path to the .sh file in .hive/hooks/
  const resolveHookPath = (hookName: string): string =>
    resolve(join(hooksDir, `${hookName}.sh`));

  // Safety hooks → PreToolUse
  if (hooks.safety?.length) {
    settings.hooks.PreToolUse = hooks.safety.map((name) => ({
      type: 'command' as const,
      command: resolveHookPath(name),
    }));
  }

  // Coordination hooks → UserPromptSubmit + PostToolUse
  if (hooks.coordination?.length) {
    const entries = hooks.coordination.map((name) => ({
      type: 'command' as const,
      command: resolveHookPath(name),
    }));
    settings.hooks.UserPromptSubmit = entries;
    settings.hooks.PostToolUse = entries;
  }

  // Custom hooks → PreToolUse (most common use case for user-defined guards)
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

  // Write .claude/settings.json in the worktree
  const claudeDir = join(worktreePath, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf-8',
  );
}

function updateGitignore(cwd: string): void {
  const gitignorePath = join(cwd, '.gitignore');
  const entriesToAdd = ['.hive/worktrees/', '.hive/state/'];

  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }

  const lines = content.split('\n');
  const toAppend: string[] = [];

  for (const entry of entriesToAdd) {
    if (!lines.some((line) => line.trim() === entry)) {
      toAppend.push(entry);
    }
  }

  if (toAppend.length > 0) {
    const addition =
      (content.endsWith('\n') ? '' : '\n') +
      '\n# AgentHive (auto-generated)\n' +
      toAppend.join('\n') +
      '\n';
    writeFileSync(gitignorePath, content + addition, 'utf-8');
    console.log(chalk.gray(`Updated .gitignore with: ${toAppend.join(', ')}`));
  }
}
