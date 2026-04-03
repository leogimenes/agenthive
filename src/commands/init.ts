import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { checkbox, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { createWorktree, isGitRepo, getMainBranch, syncAgentFilesToWorktree } from '../core/worktree.js';
import { initChatFile } from '../core/chat.js';
import { EMBEDDED_HOOKS } from '../hooks/embedded.js';
import { EMBEDDED_TEMPLATES } from '../templates/embedded.js';
import { EMBEDDED_PROFILES } from '../profiles/embedded.js';
import type { HiveConfig, AgentConfig, DefaultsConfig } from '../types/config.js';

// ── Agent definitions (for interactive & --agents modes) ────────────

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

// Default agent set for interactive --yes mode (fullstack profile agents)
const DEFAULT_AGENTS = ['sre', 'frontend', 'backend', 'qa', 'security'];

// ── Command registration ────────────────────────────────────────────

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize AgentHive in the current git repository')
    .option('--agents <list>', 'Comma-separated agent names to create')
    .option(
      '--preset <name>',
      `Use a configuration profile (run --list-presets to see options)`,
    )
    .option('--list-presets', 'Show available configuration profiles')
    .option('--yes', 'Skip interactive prompts, use defaults')
    .option('--templates [value]', 'Install agent prompt templates (default: auto, use "none" to skip)')
    .action(async (opts) => {
      if (opts.listPresets) {
        listPresets();
        return;
      }

      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runInit(cwd, opts);
    });
}

// ── Init logic ──────────────────────────────────────────────────────

async function runInit(
  cwd: string,
  opts: { agents?: string; preset?: string; yes?: boolean; templates?: string | boolean },
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
        'Error: .hive/ already exists. Use `hive add <name>` to add new agents, or edit .hive/config.yaml directly.',
      ),
    );
    process.exit(1);
  }

  // 3. Determine config: either from a profile or by building from agent names
  let config: HiveConfig;
  let selectedAgents: string[];

  if (opts.preset) {
    const profile = EMBEDDED_PROFILES[opts.preset];
    if (!profile) {
      console.error(
        chalk.red(
          `Unknown preset: ${opts.preset}. Run \`hive init --list-presets\` to see available profiles.`,
        ),
      );
      process.exit(1);
    }
    console.log(chalk.gray(`Using profile: ${chalk.bold(opts.preset)} — ${profile.description}`));
    config = buildConfigFromProfile(cwd, profile.yaml);
    selectedAgents = Object.keys(config.agents);
  } else if (opts.agents) {
    selectedAgents = opts.agents.split(',').map((a) => a.trim());
    validateAgentNames(selectedAgents);
    config = buildConfig(cwd, selectedAgents);
  } else if (opts.yes) {
    selectedAgents = DEFAULT_AGENTS;
    config = buildConfig(cwd, selectedAgents);
  } else {
    selectedAgents = await promptAgentSelection();
    config = buildConfig(cwd, selectedAgents);
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

  // 9. Install agent prompt templates
  const installedTemplates = await installTemplates(cwd, selectedAgents, config, opts);

  // 9b. Sync agent files (.claude/agents/, CLAUDE.md) into each worktree
  console.log(chalk.gray('\nSyncing agent files to worktrees...'));
  for (const worktreePath of createdWorktrees) {
    syncAgentFilesToWorktree(cwd, worktreePath);
  }

  // 10. Update .gitignore
  updateGitignore(cwd);

  // 11. Summary
  console.log(chalk.bold.green('\n✓ AgentHive initialized!\n'));
  console.log(`  Agents:   ${selectedAgents.join(', ')}`);
  console.log(`  Config:   ${chalk.gray('.hive/config.yaml')}`);
  console.log(`  Chat:     ${chalk.gray('.hive/chat.md')}`);
  console.log(`  Hooks:    ${chalk.gray('.hive/hooks/')}`);
  if (installedTemplates.length > 0) {
    console.log(`  Templates: ${chalk.gray(installedTemplates.map(t => `.claude/agents/${t}.md`).join(', '))}`);
  }
  console.log('');
  console.log(chalk.bold('Next steps:'));
  if (installedTemplates.length > 0) {
    console.log(
      `  1. Review agent definitions in ${chalk.cyan('.claude/agents/')} and customize as needed`,
    );
  } else {
    console.log(
      `  1. Create agent definitions in ${chalk.cyan('.claude/agents/<name>.md')}`,
    );
  }
  console.log(`  2. Edit ${chalk.cyan('.hive/config.yaml')} to tune budgets and poll intervals`);
  console.log(`  3. Run ${chalk.cyan('hive launch')} to start agents`);
  console.log(`  4. Run ${chalk.cyan('hive dispatch sre "your task"')} to assign work`);
  console.log('');
}

// ── Template installation ────────────────────────────────────────────

async function installTemplates(
  cwd: string,
  selectedAgents: string[],
  config: HiveConfig,
  opts: { yes?: boolean; templates?: string | boolean },
): Promise<string[]> {
  // --templates=none → skip
  if (opts.templates === 'none') {
    return [];
  }

  // Determine whether to install:
  // --templates (flag present with no value) or --yes → install
  // Interactive mode (no --yes, no --templates flag) → ask
  let shouldInstall: boolean;

  if (opts.templates === true || opts.templates === '') {
    // --templates flag passed explicitly
    shouldInstall = true;
  } else if (opts.yes) {
    // --yes mode → install by default
    shouldInstall = true;
  } else if (opts.templates === undefined) {
    // Interactive mode — ask the user
    shouldInstall = await confirm({
      message: 'Install agent prompt templates?',
      default: true,
    });
  } else {
    shouldInstall = false;
  }

  if (!shouldInstall) {
    return [];
  }

  console.log(chalk.gray('\nInstalling agent prompt templates...'));

  const agentsDir = join(cwd, '.claude', 'agents');
  mkdirSync(agentsDir, { recursive: true });

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const agentName of selectedAgents) {
    const agentConfig = config.agents[agentName];
    const templateName = agentConfig?.agent ?? AVAILABLE_AGENTS[agentName]?.agent ?? agentName;
    const template = EMBEDDED_TEMPLATES[templateName];

    if (!template) {
      continue; // No bundled template for this agent
    }

    const destPath = join(agentsDir, `${templateName}.md`);

    if (existsSync(destPath)) {
      skipped.push(templateName);
      continue;
    }

    writeFileSync(destPath, template, 'utf-8');
    installed.push(templateName);
    console.log(
      `  ${chalk.green('✓')} ${chalk.bold(templateName)} → ${chalk.gray(`.claude/agents/${templateName}.md`)}`,
    );
  }

  for (const name of skipped) {
    console.log(
      `  ${chalk.yellow('⚠')} ${chalk.bold(name)} — .claude/agents/${name}.md already exists, skipped`,
    );
  }

  return installed;
}

// ── Helpers ─────────────────────────────────────────────────────────

function listPresets(): void {
  console.log(chalk.bold('\nAvailable configuration profiles:\n'));
  for (const [name, profile] of Object.entries(EMBEDDED_PROFILES)) {
    const parsed = parseYaml(profile.yaml) as { agents?: Record<string, unknown> };
    const agentNames = parsed?.agents ? Object.keys(parsed.agents) : [];
    console.log(`  ${chalk.cyan(name)}`);
    console.log(`    ${profile.description}`);
    console.log(`    Agents: ${chalk.gray(agentNames.join(', '))}`);
    console.log('');
  }
  console.log(chalk.gray('Usage: hive init --preset <name>'));
  console.log('');
}

async function promptAgentSelection(): Promise<string[]> {
  const choices = Object.entries(AVAILABLE_AGENTS).map(([name, preset]) => ({
    name: `${name} — ${preset.description}`,
    value: name,
    checked: DEFAULT_AGENTS.includes(name),
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
    notifications: false,
    notify_on: ['DONE', 'BLOCKER'],
    transcript_retention: 20,
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
    templates: {},
    delivery: {
      strategy: 'manual',
      require_ci: true,
      base_branch: 'main',
      auto_release: false,
      definition_of_done: ['all_tasks_done'],
    },
  };
}

function buildConfigFromProfile(
  cwd: string,
  profileYaml: string,
): HiveConfig {
  const parsed = parseYaml(profileYaml) as Record<string, unknown>;

  // Extract defaults from profile, falling back to standard defaults
  const rawDefaults = (parsed.defaults ?? {}) as Record<string, unknown>;
  const defaults: DefaultsConfig = {
    poll: typeof rawDefaults.poll === 'number' ? rawDefaults.poll : 60,
    budget: typeof rawDefaults.budget === 'number' ? rawDefaults.budget : 2.0,
    daily_max: typeof rawDefaults.daily_max === 'number' ? rawDefaults.daily_max : 20.0,
    model: typeof rawDefaults.model === 'string' ? rawDefaults.model : 'sonnet',
    skip_permissions: typeof rawDefaults.skip_permissions === 'boolean' ? rawDefaults.skip_permissions : true,
    notifications: typeof rawDefaults.notifications === 'boolean' ? rawDefaults.notifications : false,
    notify_on: Array.isArray(rawDefaults.notify_on) ? rawDefaults.notify_on as string[] : ['DONE', 'BLOCKER'],
    transcript_retention: typeof rawDefaults.transcript_retention === 'number' ? rawDefaults.transcript_retention : 20,
  };

  // Extract agents from profile
  const rawAgents = (parsed.agents ?? {}) as Record<string, Record<string, unknown>>;
  const agents: Record<string, AgentConfig> = {};
  const roleMap: Record<string, string> = {};

  for (const [name, agentRaw] of Object.entries(rawAgents)) {
    agents[name] = {
      description: typeof agentRaw.description === 'string' ? agentRaw.description : name,
      agent: typeof agentRaw.agent === 'string' ? agentRaw.agent : name,
      ...(typeof agentRaw.poll === 'number' ? { poll: agentRaw.poll } : {}),
      ...(typeof agentRaw.budget === 'number' ? { budget: agentRaw.budget } : {}),
      ...(typeof agentRaw.daily_max === 'number' ? { daily_max: agentRaw.daily_max } : {}),
      ...(typeof agentRaw.model === 'string' ? { model: agentRaw.model } : {}),
    };
    roleMap[name] = name.toUpperCase().replace(/-/g, '_');
  }

  // Extract hooks from profile
  const rawHooks = (parsed.hooks ?? {}) as Record<string, unknown>;
  const toStringArray = (val: unknown): string[] | undefined =>
    Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string') : undefined;

  return {
    session: basename(cwd),
    defaults,
    agents,
    chat: {
      file: 'chat.md',
      role_map: roleMap,
    },
    hooks: {
      safety: toStringArray(rawHooks.safety) ?? ['destructive-guard'],
      coordination: toStringArray(rawHooks.coordination) ?? ['check-chat'],
      custom: toStringArray(rawHooks.custom),
    },
    templates: {},
    delivery: {
      strategy: 'manual',
      require_ci: true,
      base_branch: 'main',
      auto_release: false,
      definition_of_done: ['all_tasks_done'],
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
