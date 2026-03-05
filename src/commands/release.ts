import { Command } from 'commander';
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import chalk from 'chalk';

function readPackageVersion(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    throw new Error('Could not read version from package.json');
  }
}

function validateSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version);
}

function getLastTag(cwd: string): string | null {
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return tag || null;
  } catch {
    return null;
  }
}

function generateChangelog(cwd: string, lastTag: string | null): string {
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const format = '--format=%s (%h)';

  let log: string;
  try {
    log = execSync(`git log ${range} ${format}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    log = '';
  }

  if (!log) {
    return lastTag
      ? `No commits since ${lastTag}.`
      : 'Initial release.';
  }

  const lines = log
    .split('\n')
    .map((l) => `- ${l}`)
    .join('\n');

  const since = lastTag ? ` since \`${lastTag}\`` : '';
  return `## Changes${since}\n\n${lines}`;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  description: string,
): void {
  console.log(chalk.gray(`  $ ${cmd} ${args.join(' ')}`));
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${description} failed (exit ${result.status ?? 'unknown'})`);
  }
}

export function registerReleaseCommand(program: Command): void {
  program
    .command('release')
    .description('Build binary and create a GitHub release with auto-generated changelog')
    .option('--version <semver>', 'Release version (default: version from package.json)')
    .option('--dry-run', 'Show what would be done without creating the release')
    .option('--no-build', 'Skip npm run build:binary')
    .option('--prerelease', 'Mark as a pre-release on GitHub')
    .option('--title <title>', 'Custom release title (default: v<version>)')
    .action(async (opts: {
      version?: string;
      dryRun?: boolean;
      build: boolean;
      prerelease?: boolean;
      title?: string;
    }) => {
      const cwd = program.opts().cwd ? resolve(program.opts().cwd) : process.cwd();

      console.log(chalk.bold('\n🐝 AgentHive — Release\n'));

      // ── Resolve version ──────────────────────────────────────────────
      let version: string;
      if (opts.version) {
        version = opts.version.replace(/^v/, '');
        if (!validateSemver(version)) {
          console.error(chalk.red(`Invalid semver: "${opts.version}"`));
          process.exit(1);
        }
      } else {
        try {
          version = readPackageVersion(cwd);
        } catch (err: unknown) {
          console.error(chalk.red((err instanceof Error ? err.message : String(err))));
          process.exit(1);
        }
      }

      const tag = `v${version}`;
      const releaseTitle = opts.title ?? tag;

      // ── Auto-changelog ───────────────────────────────────────────────
      const lastTag = getLastTag(cwd);
      const changelog = generateChangelog(cwd, lastTag);

      console.log(`  Version:  ${chalk.cyan(tag)}`);
      console.log(`  Title:    ${chalk.cyan(releaseTitle)}`);
      if (lastTag) {
        console.log(`  Since:    ${chalk.gray(lastTag)}`);
      }
      if (opts.prerelease) {
        console.log(`  Type:     ${chalk.yellow('pre-release')}`);
      }
      if (opts.dryRun) {
        console.log(`  Mode:     ${chalk.yellow('dry-run')}`);
      }
      console.log('');

      console.log(chalk.bold('Changelog preview:'));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(changelog);
      console.log(chalk.gray('─'.repeat(50)));
      console.log('');

      if (opts.dryRun) {
        console.log(chalk.yellow('Dry run — no changes made.'));
        console.log('');
        console.log('Would run:');
        if (opts.build !== false) {
          console.log(`  ${chalk.cyan('npm run build:binary')}`);
        }
        const preFlag = opts.prerelease ? ' --prerelease' : '';
        console.log(
          `  ${chalk.cyan(`gh release create ${tag} --title "${releaseTitle}"${preFlag} --notes "..."`)}`,
        );
        console.log('');
        return;
      }

      // ── Build binary ─────────────────────────────────────────────────
      if (opts.build !== false) {
        console.log(chalk.bold('Building binary...'));
        try {
          run('npm', ['run', 'build:binary'], cwd, 'npm run build:binary');
        } catch (err: unknown) {
          console.error(chalk.red((err instanceof Error ? err.message : String(err))));
          process.exit(1);
        }
        console.log(chalk.green('  Binary built successfully.'));
        console.log('');
      } else {
        console.log(chalk.gray('  Skipping binary build (--no-build).'));
        console.log('');
      }

      // ── Create GitHub release ────────────────────────────────────────
      console.log(chalk.bold('Creating GitHub release...'));

      const ghArgs = [
        'release', 'create', tag,
        '--title', releaseTitle,
        '--notes', changelog,
      ];

      if (opts.prerelease) {
        ghArgs.push('--prerelease');
      }

      // Attach binary if it exists
      const binaryPath = join(cwd, 'bin', 'hive');
      try {
        readFileSync(binaryPath);
        ghArgs.push(binaryPath);
        console.log(chalk.gray(`  Attaching binary: bin/hive`));
      } catch {
        console.log(chalk.yellow('  Warning: bin/hive not found, skipping binary attachment.'));
      }

      try {
        run('gh', ghArgs, cwd, 'gh release create');
      } catch (err: unknown) {
        console.error(chalk.red((err instanceof Error ? err.message : String(err))));
        process.exit(1);
      }

      console.log('');
      console.log(chalk.green(`  Release ${chalk.bold(tag)} created successfully.`));
      console.log('');
    });
}
