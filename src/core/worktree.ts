import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, symlinkSync, readlinkSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorktreeInfo, RebaseResult, SyncResult, SyncDiagnosis } from '../types/config.js';

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

  // Prune stale worktree registrations (e.g. from a previous failed init
  // that removed directories but left git's internal tracking intact).
  try {
    await exec('git', ['worktree', 'prune'], { cwd: hiveRoot });
  } catch { /* best-effort */ }

  if (existsSync(worktreePath)) {
    throw new Error(
      `Worktree already exists at ${worktreePath}. Remove it with \`hive remove ${name}\` or \`git worktree remove ${worktreePath}\` and retry.`,
    );
  }

  // Disable custom git hooks during worktree creation — third-party hooks
  // (e.g. Dolt, Husky) can fail and block worktree setup.
  // Use -f to force creation if worktree path was previously registered.
  const args = ['-c', 'core.hooksPath=', 'worktree', 'add', '-f', worktreePath, '-b', branchName];
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
        ['-c', 'core.hooksPath=', 'worktree', 'add', '-f', worktreePath, branchName],
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
 * Diagnose why a rebase failed by inspecting branch divergence.
 * Must be called AFTER aborting any in-progress rebase.
 */
export async function diagnoseSyncFailure(
  worktreePath: string,
  targetBranch: string,
): Promise<SyncDiagnosis> {
  const target = `origin/${targetBranch}`;
  try {
    // Count commits ahead/behind
    const { stdout: aheadOut } = await exec(
      'git', ['log', '--oneline', `${target}..HEAD`],
      { cwd: worktreePath },
    );
    const { stdout: behindOut } = await exec(
      'git', ['log', '--oneline', `HEAD..${target}`],
      { cwd: worktreePath },
    );
    const aheadCount = aheadOut.trim() ? aheadOut.trim().split('\n').length : 0;
    const behindCount = behindOut.trim() ? behindOut.trim().split('\n').length : 0;

    if (aheadCount === 0 && behindCount === 0) {
      return { type: 'clean' };
    }

    if (aheadCount === 0) {
      return { type: 'branch_diverged', aheadCount: 0, behindCount };
    }

    // Use `git cherry` to detect already-applied commits
    // Lines starting with `-` are already in upstream, `+` are unique
    const { stdout: cherryOut } = await exec(
      'git', ['cherry', target, 'HEAD'],
      { cwd: worktreePath },
    );
    const lines = cherryOut.trim().split('\n').filter(Boolean);
    const duplicateCount = lines.filter((l) => l.startsWith('-')).length;
    const uniqueCount = lines.filter((l) => l.startsWith('+')).length;

    if (duplicateCount > 0) {
      return { type: 'cherry_pick_duplicates', duplicateCount, uniqueCount };
    }

    if (aheadCount > 0 && behindCount > 0) {
      return { type: 'branch_diverged', aheadCount, behindCount };
    }

    return { type: 'clean' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { type: 'unknown', error: msg };
  }
}

/**
 * Abort any in-progress rebase. Silently succeeds if not rebasing.
 */
async function abortRebase(worktreePath: string): Promise<void> {
  try {
    await exec('git', ['rebase', '--abort'], { cwd: worktreePath });
  } catch {
    // May not be in a rebase state
  }
}

/**
 * Fetch latest from remote and sync the worktree's branch onto target.
 * Uses cascading strategies to handle cherry-pick duplicates and divergence.
 *
 * Strategies (tried in order):
 * 1. Standard rebase
 * 2. Rebase with --reapply-cherry-picks (git 2.37+)
 * 3. Diagnose and apply targeted fix:
 *    - Cherry-pick duplicates → reset + cherry-pick unique commits
 *    - No unique commits → reset to target
 *    - Real conflict → return failure with diagnosis
 */
export async function syncWorktree(
  worktreePath: string,
  targetBranch = 'main',
): Promise<SyncResult> {
  const target = `origin/${targetBranch}`;

  try {
    await exec('git', ['fetch', 'origin'], { cwd: worktreePath });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }

  // Strategy 1: Standard rebase
  try {
    await exec('git', ['rebase', target], { cwd: worktreePath });
    return { success: true, strategy: 'rebase' };
  } catch {
    await abortRebase(worktreePath);
  }

  // Strategy 2: Rebase with --reapply-cherry-picks (handles duplicate commits)
  try {
    await exec('git', ['rebase', '--reapply-cherry-picks', target], { cwd: worktreePath });
    return { success: true, strategy: 'rebase-reapply' };
  } catch {
    await abortRebase(worktreePath);
  }

  // Strategy 3: Diagnose and apply targeted fix
  const diagnosis = await diagnoseSyncFailure(worktreePath, targetBranch);

  if (diagnosis.type === 'cherry_pick_duplicates' || diagnosis.type === 'branch_diverged') {
    if (diagnosis.type === 'cherry_pick_duplicates' && diagnosis.uniqueCount === 0) {
      // All commits already in upstream — safe to reset
      try {
        await exec('git', ['reset', '--hard', target], { cwd: worktreePath });
        return { success: true, strategy: 'reset-to-target', diagnosis };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg, diagnosis };
      }
    }

    if (diagnosis.type === 'branch_diverged' && diagnosis.aheadCount === 0) {
      // Behind only — fast-forward via reset
      try {
        await exec('git', ['reset', '--hard', target], { cwd: worktreePath });
        return { success: true, strategy: 'reset-to-target', diagnosis };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg, diagnosis };
      }
    }

    // Has unique commits mixed with duplicates — cherry-pick only unique ones
    if (diagnosis.type === 'cherry_pick_duplicates' && diagnosis.uniqueCount > 0) {
      try {
        // Get the unique commit SHAs (lines starting with '+' from git cherry)
        const { stdout: cherryOut } = await exec(
          'git', ['cherry', target, 'HEAD'],
          { cwd: worktreePath },
        );
        const uniqueShas = cherryOut.trim().split('\n')
          .filter((l) => l.startsWith('+ '))
          .map((l) => l.slice(2));

        // Reset to target, then cherry-pick unique commits
        await exec('git', ['reset', '--hard', target], { cwd: worktreePath });
        for (const sha of uniqueShas) {
          await exec('git', ['cherry-pick', sha], { cwd: worktreePath });
        }
        return { success: true, strategy: 'cherry-pick-unique', diagnosis };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await abortRebase(worktreePath);
        // Also abort cherry-pick if in progress
        try {
          await exec('git', ['cherry-pick', '--abort'], { cwd: worktreePath });
        } catch { /* not cherry-picking */ }
        return { success: false, error: msg, diagnosis };
      }
    }
  }

  // All strategies exhausted
  return {
    success: false,
    error: `All sync strategies failed. Diagnosis: ${diagnosis.type}`,
    diagnosis,
  };
}

/**
 * After task completion: rebase onto target branch and push.
 * Uses smart sync strategies and retries push once on race.
 */
export async function rebaseAndPush(
  worktreePath: string,
  targetBranch = 'main',
): Promise<RebaseResult> {
  // Sync first using smart strategies
  const syncResult = await syncWorktree(worktreePath, targetBranch);
  if (!syncResult.success) {
    // Try to identify conflict files from diagnosis
    const conflictFiles = syncResult.diagnosis?.type === 'merge_conflict'
      ? syncResult.diagnosis.conflictFiles
      : undefined;
    return { success: false, conflictFiles, error: syncResult.error };
  }

  // Push with single retry on race
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout: currentBranch } = await exec(
        'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: worktreePath },
      );
      await exec(
        'git', ['push', 'origin', `${currentBranch.trim()}:${targetBranch}`],
        { cwd: worktreePath },
      );
      return { success: true };
    } catch (err: unknown) {
      if (attempt === 0) {
        // First push failed — re-sync and retry
        const retrySync = await syncWorktree(worktreePath, targetBranch);
        if (!retrySync.success) {
          return { success: false, error: retrySync.error };
        }
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  return { success: false, error: 'Push failed after retry' };
}

// ── Agent file syncing ──────────────────────────────────────────────

/**
 * Symlink .claude/agents/ and CLAUDE.md from the main repo into a worktree.
 *
 * Agent definition files live in the main repo's .claude/agents/ but are
 * typically untracked, so git worktrees don't get them. This function
 * creates symlinks so `claude --agent <name>` can find the definitions
 * when running from the worktree's cwd.
 */
export function syncAgentFilesToWorktree(
  hiveRoot: string,
  worktreePath: string,
): void {
  // Symlink .claude/agents/ directory
  const mainAgentsDir = join(hiveRoot, '.claude', 'agents');
  if (existsSync(mainAgentsDir)) {
    const worktreeClaudeDir = join(worktreePath, '.claude');
    mkdirSync(worktreeClaudeDir, { recursive: true });

    const worktreeAgentsDir = join(worktreeClaudeDir, 'agents');
    createSymlinkIfNeeded(mainAgentsDir, worktreeAgentsDir);
  }

  // Symlink CLAUDE.md
  const mainClaudeMd = join(hiveRoot, 'CLAUDE.md');
  if (existsSync(mainClaudeMd)) {
    const worktreeClaudeMd = join(worktreePath, 'CLAUDE.md');
    createSymlinkIfNeeded(mainClaudeMd, worktreeClaudeMd);
  }
}

/**
 * Create a symlink if it doesn't already exist (or exists but points elsewhere).
 * If a regular file/directory already exists at linkPath, remove it first and
 * replace with the symlink (worktrees may have real files from git checkout).
 */
function createSymlinkIfNeeded(target: string, linkPath: string): void {
  if (existsSync(linkPath) || lstatExistsSafe(linkPath)) {
    try {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink() && readlinkSync(linkPath) === target) {
        return; // Already a correct symlink
      }
      // Exists but is not a correct symlink — remove and replace
      if (stat.isDirectory()) {
        rmSync(linkPath, { recursive: true, force: true });
      } else {
        unlinkSync(linkPath);
      }
    } catch {
      // Can't inspect — try creating anyway
    }
  }

  symlinkSync(target, linkPath);
}

/**
 * Check if a path exists as a symlink (even if dangling).
 */
function lstatExistsSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
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
