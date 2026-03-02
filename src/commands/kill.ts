import { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath } from '../core/config.js';
import { getLockStatus, releaseLock } from '../core/lock.js';
import { tmux, tmuxSessionExists } from '../core/tmux.js';

export function registerKillCommand(program: Command): void {
  program
    .command('kill [agents...]')
    .description('Stop agent daemons')
    .action(async (agents: string[]) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runKill(cwd, agents);
    });
}

async function runKill(cwd: string, agentFilter: string[]): Promise<void> {
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

  const sessionName = config.session;

  if (agentFilter.length === 0) {
    // Kill entire tmux session
    if (tmuxSessionExists(sessionName)) {
      tmux(['kill-session', '-t', sessionName], { stdio: 'ignore' });
      console.log(chalk.green(`✓ Killed tmux session: ${sessionName}`));
    } else {
      console.log(chalk.gray(`No tmux session found: ${sessionName}`));
    }

    // Clean up all lock files
    for (const name of Object.keys(config.agents)) {
      const lock = getLockStatus(hivePath, name);
      if (lock.locked) {
        if (lock.pid && !lock.stale) {
          try {
            process.kill(lock.pid, 'SIGTERM');
          } catch {
            // Process may have already exited
          }
        }
        releaseLock(hivePath, name);
      }
    }

    console.log(chalk.gray('All locks released.'));
  } else {
    // Kill specific agent windows
    for (const name of agentFilter) {
      if (!config.agents[name]) {
        console.error(
          chalk.red(`Unknown agent: "${name}". Available: ${Object.keys(config.agents).join(', ')}`),
        );
        continue;
      }

      // Kill tmux window
      if (tmuxSessionExists(sessionName)) {
        try {
          tmux(['kill-window', '-t', `${sessionName}:${name}`], {
            stdio: 'ignore',
          });
          console.log(`  ${chalk.green('✓')} Killed window: ${name}`);
        } catch {
          console.log(`  ${chalk.gray('⊘')} No window found: ${name}`);
        }
      }

      // Clean up lock
      const lock = getLockStatus(hivePath, name);
      if (lock.locked) {
        if (lock.pid && !lock.stale) {
          try {
            process.kill(lock.pid, 'SIGTERM');
          } catch {
            // Already exited
          }
        }
        releaseLock(hivePath, name);
        console.log(`  ${chalk.gray('  Lock released')}`);
      }
    }
  }
}
