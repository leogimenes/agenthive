import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import chalk from 'chalk';
import { EMBEDDED_TEMPLATES } from '../templates/embedded.js';
import { resolveHiveRoot, loadConfig } from '../core/config.js';

// ── Template metadata ────────────────────────────────────────────────

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  sre: 'Site Reliability Engineer',
  frontend: 'Frontend Developer',
  backend: 'Backend Engineer',
  qa: 'Quality Analyst',
  appsec: 'Security Engineer',
  devops: 'DevOps Engineer',
  pm: 'Product Manager',
};

// ── Types ────────────────────────────────────────────────────────────

export type TemplateSource = 'bundled' | 'global' | 'local';

export interface ResolvedTemplate {
  name: string;
  content: string;
  source: TemplateSource;
}

// ── Helpers ──────────────────────────────────────────────────────────

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

type TemplateStatus = 'not installed' | 'installed' | 'modified';

function getTemplateStatus(
  name: string,
  agentsDir: string,
  resolvedContent: string,
): TemplateStatus {
  const installedPath = join(agentsDir, `${name}.md`);
  if (!existsSync(installedPath)) return 'not installed';

  const installed = readFileSync(installedPath, 'utf-8');

  return md5(resolvedContent) === md5(installed) ? 'installed' : 'modified';
}

function resolveAgentsDir(cwd: string, dirOverride?: string): string {
  if (dirOverride) return resolve(dirOverride);

  let hiveRoot: string;
  try {
    hiveRoot = resolveHiveRoot(cwd);
  } catch {
    hiveRoot = cwd;
  }
  return join(hiveRoot, '.claude', 'agents');
}

/** The global user template directory (~/.config/agenthive/templates/). */
export function globalTemplatesDir(): string {
  return join(homedir(), '.config', 'agenthive', 'templates');
}

/** The project-local template directory, respecting the templates.dir config option. */
export function localTemplatesDir(cwd: string): string {
  let hiveRoot: string;
  try {
    hiveRoot = resolveHiveRoot(cwd);
  } catch {
    hiveRoot = cwd;
  }

  // Check if config has a templates.dir override
  try {
    const config = loadConfig(cwd);
    if (config.templates.dir) {
      return resolve(hiveRoot, config.templates.dir);
    }
  } catch {
    // No config or invalid config — use default
  }

  return join(hiveRoot, '.hive', 'templates');
}

/** Scan a directory for .md template files and return name→content map. */
function scanTemplateDir(dir: string): Record<string, string> {
  const templates: Record<string, string> = {};
  if (!existsSync(dir)) return templates;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.endsWith('.md')) {
        const name = basename(entry, '.md');
        templates[name] = readFileSync(join(dir, entry), 'utf-8');
      }
    }
  } catch {
    // Directory unreadable — skip
  }

  return templates;
}

/**
 * Discover all available templates using the resolution order:
 *   bundled → global (~/.config/agenthive/templates/) → project-local (.hive/templates/)
 * Later sources override earlier ones.
 */
export function discoverTemplates(cwd: string): Map<string, ResolvedTemplate> {
  const result = new Map<string, ResolvedTemplate>();

  // 1. Bundled templates
  for (const [name, content] of Object.entries(EMBEDDED_TEMPLATES)) {
    result.set(name, { name, content, source: 'bundled' });
  }

  // 2. Global user templates
  const globalDir = globalTemplatesDir();
  for (const [name, content] of Object.entries(scanTemplateDir(globalDir))) {
    result.set(name, { name, content, source: 'global' });
  }

  // 3. Project-local templates
  const localDir = localTemplatesDir(cwd);
  for (const [name, content] of Object.entries(scanTemplateDir(localDir))) {
    result.set(name, { name, content, source: 'local' });
  }

  return result;
}

// ── Command registration ─────────────────────────────────────────────

export function registerTemplatesCommand(program: Command): void {
  const cmd = program
    .command('templates')
    .description('List, preview, and install agent prompt templates')
    .option(
      '--dir <path>',
      'Override output directory (default: .claude/agents/)',
    );

  cmd
    .command('list')
    .description('List all available templates with source and installation status')
    .action(() => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      runList(cwd, cmd.opts().dir);
    });

  cmd
    .command('show <name>')
    .description('Print a template to stdout')
    .action((name: string) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      runShow(cwd, name);
    });

  cmd
    .command('install <names...>')
    .description('Install templates to .claude/agents/')
    .option('--force', 'Overwrite existing files')
    .action((names: string[], opts: { force?: boolean }) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      runInstall(cwd, names, cmd.opts().dir, opts.force);
    });

  cmd
    .command('diff <name>')
    .description('Show diff between installed and source template')
    .action((name: string) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      runDiff(cwd, name, cmd.opts().dir);
    });
}

// ── Subcommand implementations ───────────────────────────────────────

function runList(cwd: string, dirOverride?: string): void {
  const agentsDir = resolveAgentsDir(cwd, dirOverride);
  const templates = discoverTemplates(cwd);

  console.log(chalk.bold('\n🐝 AgentHive — Available Templates\n'));

  const COL = { name: 12, description: 28, source: 10 };

  console.log(
    chalk.gray(
      pad('NAME', COL.name) +
        pad('DESCRIPTION', COL.description) +
        pad('SOURCE', COL.source) +
        'STATUS',
    ),
  );
  console.log(chalk.gray('─'.repeat(66)));

  for (const [name, tmpl] of templates) {
    const desc = TEMPLATE_DESCRIPTIONS[name] ?? name;
    const status = getTemplateStatus(name, agentsDir, tmpl.content);

    const sourceColor =
      tmpl.source === 'local'
        ? chalk.blue
        : tmpl.source === 'global'
          ? chalk.magenta
          : chalk.gray;

    const statusColor =
      status === 'installed'
        ? chalk.green
        : status === 'modified'
          ? chalk.yellow
          : chalk.gray;

    console.log(
      chalk.bold(pad(name, COL.name)) +
        pad(desc, COL.description) +
        sourceColor(pad(tmpl.source, COL.source)) +
        statusColor(status),
    );
  }
  console.log('');
}

function runShow(cwd: string, name: string): void {
  const templates = discoverTemplates(cwd);
  const tmpl = templates.get(name);

  if (!tmpl) {
    const available = [...templates.keys()].join(', ');
    console.error(
      chalk.red(
        `Error: Unknown template "${name}". Available: ${available}`,
      ),
    );
    process.exit(1);
  }
  process.stdout.write(tmpl.content);
}

function runInstall(
  cwd: string,
  names: string[],
  dirOverride?: string,
  force?: boolean,
): void {
  const agentsDir = resolveAgentsDir(cwd, dirOverride);
  mkdirSync(agentsDir, { recursive: true });

  const templates = discoverTemplates(cwd);

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    const tmpl = templates.get(name);
    if (!tmpl) {
      const available = [...templates.keys()].join(', ');
      console.error(
        chalk.red(
          `Error: Unknown template "${name}". Available: ${available}`,
        ),
      );
      process.exit(1);
    }

    const destPath = join(agentsDir, `${name}.md`);

    if (existsSync(destPath) && !force) {
      skipped.push(name);
      continue;
    }

    writeFileSync(destPath, tmpl.content, 'utf-8');
    installed.push(name);
  }

  for (const name of installed) {
    console.log(
      `  ${chalk.green('✓')} ${chalk.bold(name)} → ${chalk.gray(join(agentsDir, `${name}.md`))}`,
    );
  }

  for (const name of skipped) {
    console.log(
      `  ${chalk.yellow('⚠')} ${chalk.bold(name)} — already exists, skipped (use --force to overwrite)`,
    );
  }

  if (installed.length > 0) {
    console.log(
      chalk.green(`\n${installed.length} template(s) installed.`),
    );
  }
}

function runDiff(cwd: string, name: string, dirOverride?: string): void {
  const templates = discoverTemplates(cwd);
  const tmpl = templates.get(name);

  if (!tmpl) {
    const available = [...templates.keys()].join(', ');
    console.error(
      chalk.red(
        `Error: Unknown template "${name}". Available: ${available}`,
      ),
    );
    process.exit(1);
  }

  const agentsDir = resolveAgentsDir(cwd, dirOverride);
  const installedPath = join(agentsDir, `${name}.md`);

  if (!existsSync(installedPath)) {
    console.error(
      chalk.red(
        `Error: Template "${name}" is not installed at ${installedPath}`,
      ),
    );
    process.exit(1);
  }

  const installed = readFileSync(installedPath, 'utf-8');

  if (md5(tmpl.content) === md5(installed)) {
    console.log(
      chalk.green(
        `Template "${name}" is identical to the ${tmpl.source} version.`,
      ),
    );
    return;
  }

  // Write source version to a temp file and diff against the installed file
  const tmpFile = join(tmpdir(), `hive-template-${name}-source.md`);
  writeFileSync(tmpFile, tmpl.content, 'utf-8');

  try {
    // diff exits 1 when files differ — that's normal, not an error
    const output = execSync(
      `diff -u "${tmpFile}" "${installedPath}" || true`,
      { encoding: 'utf-8' },
    );

    for (const line of output.split('\n')) {
      if (line.startsWith('---')) {
        console.log(
          chalk.bold.red(
            line.replace(tmpFile, `${tmpl.source}/${name}.md`),
          ),
        );
      } else if (line.startsWith('+++')) {
        console.log(
          chalk.bold.green(line.replace(installedPath, `installed/${name}.md`)),
        );
      } else if (line.startsWith('-')) {
        console.log(chalk.red(line));
      } else if (line.startsWith('+')) {
        console.log(chalk.green(line));
      } else if (line.startsWith('@@')) {
        console.log(chalk.cyan(line));
      } else {
        console.log(line);
      }
    }
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}
