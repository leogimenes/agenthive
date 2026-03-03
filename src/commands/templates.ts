import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import chalk from 'chalk';
import { EMBEDDED_TEMPLATES } from '../templates/embedded.js';
import { resolveHiveRoot } from '../core/config.js';

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

// ── Helpers ──────────────────────────────────────────────────────────

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

type TemplateStatus = 'not installed' | 'installed' | 'modified';

function getTemplateStatus(name: string, agentsDir: string): TemplateStatus {
  const installedPath = join(agentsDir, `${name}.md`);
  if (!existsSync(installedPath)) return 'not installed';

  const bundled = EMBEDDED_TEMPLATES[name];
  const installed = readFileSync(installedPath, 'utf-8');

  return md5(bundled) === md5(installed) ? 'installed' : 'modified';
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

function availableNames(): string {
  return Object.keys(EMBEDDED_TEMPLATES).join(', ');
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
    .description('List all bundled templates with installation status')
    .action(() => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      runList(cwd, cmd.opts().dir);
    });

  cmd
    .command('show <name>')
    .description('Print a bundled template to stdout')
    .action((name: string) => {
      runShow(name);
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
    .description('Show diff between installed and bundled template')
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

  console.log(chalk.bold('\n🐝 AgentHive — Bundled Templates\n'));

  const COL = { name: 12, description: 28 };

  console.log(
    chalk.gray(
      pad('NAME', COL.name) + pad('DESCRIPTION', COL.description) + 'STATUS',
    ),
  );
  console.log(chalk.gray('─'.repeat(56)));

  for (const name of Object.keys(EMBEDDED_TEMPLATES)) {
    const desc = TEMPLATE_DESCRIPTIONS[name] ?? name;
    const status = getTemplateStatus(name, agentsDir);

    const statusColor =
      status === 'installed'
        ? chalk.green
        : status === 'modified'
          ? chalk.yellow
          : chalk.gray;

    console.log(
      chalk.bold(pad(name, COL.name)) +
        pad(desc, COL.description) +
        statusColor(status),
    );
  }
  console.log('');
}

function runShow(name: string): void {
  const template = EMBEDDED_TEMPLATES[name];
  if (!template) {
    console.error(
      chalk.red(
        `Error: Unknown template "${name}". Available: ${availableNames()}`,
      ),
    );
    process.exit(1);
  }
  process.stdout.write(template);
}

function runInstall(
  cwd: string,
  names: string[],
  dirOverride?: string,
  force?: boolean,
): void {
  const agentsDir = resolveAgentsDir(cwd, dirOverride);
  mkdirSync(agentsDir, { recursive: true });

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    const template = EMBEDDED_TEMPLATES[name];
    if (!template) {
      console.error(
        chalk.red(
          `Error: Unknown template "${name}". Available: ${availableNames()}`,
        ),
      );
      process.exit(1);
    }

    const destPath = join(agentsDir, `${name}.md`);

    if (existsSync(destPath) && !force) {
      skipped.push(name);
      continue;
    }

    writeFileSync(destPath, template, 'utf-8');
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
  const template = EMBEDDED_TEMPLATES[name];
  if (!template) {
    console.error(
      chalk.red(
        `Error: Unknown template "${name}". Available: ${availableNames()}`,
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

  if (md5(template) === md5(installed)) {
    console.log(
      chalk.green(`Template "${name}" is identical to the bundled version.`),
    );
    return;
  }

  // Write bundled version to a temp file and diff against the installed file
  const tmpFile = join(tmpdir(), `hive-template-${name}-bundled.md`);
  writeFileSync(tmpFile, template, 'utf-8');

  try {
    // diff exits 1 when files differ — that's normal, not an error
    const output = execSync(
      `diff -u "${tmpFile}" "${installedPath}" || true`,
      { encoding: 'utf-8' },
    );

    for (const line of output.split('\n')) {
      if (line.startsWith('---')) {
        console.log(chalk.bold.red(line.replace(tmpFile, `bundled/${name}.md`)));
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
