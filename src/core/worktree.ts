import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorktreeInfo, RebaseResult } from '../types/config.js';

const exec = promisify(execFile);

// ── Worktree CRUD ───────────────────────────────────────────────────

/**
 * Create a git worktree for an agent.
 * Creates `.hive/worktrees/<name>` on branch `agent/<name>`.
 */
export async function createWorktree(
  hiveRoot: string,
  name: string,
  baseBranch?: string,
): Promise<string> {
  const worktreePath = join(hiveRoot, '.hive', 'worktrees', name);
  const branchName = `agent/${name}`;

  if (existsSync(worktreePath)) {
    throw new Error(
      `Worktree already exists at ${worktreePath}. Remove it with \`hive remove ${name}\` or \`git worktree remove ${worktreePath}\` and retry.`,
    );
  }

  const args = ['worktree', 'add', worktreePath, '-b', branchName];
  if (baseBranch) {
    args.push(baseBranch);
  }

  try {
    await exec('git', args, { cwd: hiveRoot });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Branch already exists — try without -b (attach to existing branch)
    if (message.includes('already exists')) {
      await exec(
        'git',
        ['worktree', 'add', worktreePath, branchName],
        { cwd: hiveRoot },
      );
    } else {
      throw new Error(`Failed to create worktree "${name}": ${message}`);
    }
  }

  return worktreePath;
}

/**
 * List all git worktrees in the repository.
 */
export async function listWorktrees(
  repoDir: string,
): Promise<WorktreeInfo[]> {
  const { stdout } = await exec(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: repoDir },
  );

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.isMain = true;
    } else if (line === '') {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? '(detached)',
          head: current.head ?? '',
          isMain: current.isMain ?? worktrees.length === 0,
        });
      }
      current = {};
    }
  }

  return worktrees;
}

/**
 * Remove a git worktree and optionally delete its branch.
 */
export async function removeWorktree(
  hiveRoot: string,
  name: string,
  deleteBranch = true,
): Promise<void> {
  const worktreePath = join(hiveRoot, '.hive', 'worktrees', name);
  const branchName = `agent/${name}`;

  if (existsSync(worktreePath)) {
    await exec('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: hiveRoot,
    });
  }

  if (deleteBranch) {
    try {
      await exec('git', ['branch', '-D', branchName], { cwd: hiveRoot });
    } catch {
      // Branch may not exist — that's fine
    }
  }
}

// ── Sync operations ─────────────────────────────────────────────────

/**
 * Fetch latest from remote and rebase the worktree's branch onto target.
 * Used before dispatching a task to ensure the agent starts from latest code.
 */
export async function syncWorktree(
  worktreePath: string,
  targetBranch = 'main',
): Promise<{ success: boolean; error?: string }> {
  try {
    await exec('git', ['fetch', 'origin'], { cwd: worktreePath });
    await exec('git', ['rebase', `origin/${targetBranch}`], {
      cwd: worktreePath,
    });
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Abort the rebase if it failed
    try {
      await exec('git', ['rebase', '--abort'], { cwd: worktreePath });
    } catch {
      // May not be in a rebase state
    }

    return { success: false, error: message };
  }
}

/**
 * After task completion: rebase onto target branch and push.
 * Returns success or conflict details.
 */
export async function rebaseAndPush(
  worktreePath: string,
  targetBranch = 'main',
): Promise<RebaseResult> {
  try {
    // Fetch latest
    await exec('git', ['fetch', 'origin'], { cwd: worktreePath });

    // Rebase onto target
    await exec('git', ['rebase', `origin/${targetBranch}`], {
      cwd: worktreePath,
    });

    // Push to target branch
    const { stdout: currentBranch } = await exec(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: worktreePath },
    );

    await exec(
      'git',
      ['push', 'origin', `${currentBranch.trim()}:${targetBranch}`],
      { cwd: worktreePath },
    );

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Try to identify conflict files
    let conflictFiles: string[] | undefined;
    try {
      const { stdout } = await exec(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        { cwd: worktreePath },
      );
      conflictFiles = stdout
        .split('\n')
        .filter((f) => f.trim().length > 0);
    } catch {
      // Can't get conflict files
    }

    // Abort the rebase
    try {
      await exec('git', ['rebase', '--abort'], { cwd: worktreePath });
    } catch {
      // May not be in a rebase state
    }

    return { success: false, conflictFiles, error: message };
  }
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Check if a directory is inside a git repository.
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--git-dir'], {
      cwd: resolve(dir),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the main branch name (main or master).
 */
export async function getMainBranch(repoDir: string): Promise<string> {
  try {
    // Check if origin/main exists
    await exec('git', ['rev-parse', '--verify', 'origin/main'], {
      cwd: repoDir,
    });
    return 'main';
  } catch {
    try {
      await exec('git', ['rev-parse', '--verify', 'origin/master'], {
        cwd: repoDir,
      });
      return 'master';
    } catch {
      // No remote — check local branches
      try {
        await exec('git', ['rev-parse', '--verify', 'main'], {
          cwd: repoDir,
        });
        return 'main';
      } catch {
        return 'master';
      }
    }
  }
}
