import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  isGitRepo,
  getMainBranch,
  createWorktree,
  listWorktrees,
  removeWorktree,
  syncWorktree,
  diagnoseSyncFailure,
} from '../../src/core/worktree.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Initialise a real git repo in a temp directory and make an initial commit
 * so that HEAD is valid and branch operations work.
 */
function initRepo(dir: string, branch = 'main'): void {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  git(['init', '--initial-branch', branch]);
  git(['config', 'user.email', 'test@hive.local']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial commit']);
}

// ── Test suite ───────────────────────────────────────────────────────

describe('worktree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-wt-test-'));
    // Create .hive/worktrees directory structure expected by worktree.ts
    mkdirSync(join(tmpDir, '.hive', 'worktrees'), { recursive: true });
    initRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── isGitRepo ────────────────────────────────────────────────────

  describe('isGitRepo', () => {
    it('should return true for a directory inside a git repository', async () => {
      const result = await isGitRepo(tmpDir);
      expect(result).toBe(true);
    });

    it('should return false for a plain directory with no git repo', async () => {
      const plainDir = mkdtempSync(join(tmpdir(), 'hive-plain-'));
      try {
        const result = await isGitRepo(plainDir);
        expect(result).toBe(false);
      } finally {
        rmSync(plainDir, { recursive: true, force: true });
      }
    });
  });

  // ── getMainBranch ────────────────────────────────────────────────

  describe('getMainBranch', () => {
    it('should return "main" for a repo initialised on main branch', async () => {
      const result = await getMainBranch(tmpDir);
      expect(result).toBe('main');
    });

    it('should return "master" for a repo initialised on master branch', async () => {
      const masterDir = mkdtempSync(join(tmpdir(), 'hive-master-'));
      try {
        initRepo(masterDir, 'master');
        const result = await getMainBranch(masterDir);
        expect(result).toBe('master');
      } finally {
        rmSync(masterDir, { recursive: true, force: true });
      }
    });
  });

  // ── createWorktree ───────────────────────────────────────────────

  describe('createWorktree', () => {
    it('should create a worktree directory at .hive/worktrees/<name>', async () => {
      await createWorktree(tmpDir, 'backend');

      const worktreePath = join(tmpDir, '.hive', 'worktrees', 'backend');
      expect(existsSync(worktreePath)).toBe(true);
    });

    it('should create a branch named agent/<name>', async () => {
      await createWorktree(tmpDir, 'backend');

      const branches = execFileSync(
        'git',
        ['branch', '--list', 'agent/backend'],
        { cwd: tmpDir, stdio: 'pipe' },
      ).toString();

      // git branch --list may prefix the active worktree branch with '+' or '*'
      expect(branches.trim().replace(/^[+*]\s*/, '')).toBe('agent/backend');
    });

    it('should return the worktree path', async () => {
      const result = await createWorktree(tmpDir, 'backend');
      expect(result).toBe(join(tmpDir, '.hive', 'worktrees', 'backend'));
    });

    it('should create worktrees for multiple agents independently', async () => {
      await createWorktree(tmpDir, 'backend');
      await createWorktree(tmpDir, 'frontend');

      expect(existsSync(join(tmpDir, '.hive', 'worktrees', 'backend'))).toBe(true);
      expect(existsSync(join(tmpDir, '.hive', 'worktrees', 'frontend'))).toBe(true);
    });

    it('should throw when the worktree directory already exists', async () => {
      await createWorktree(tmpDir, 'backend');

      await expect(createWorktree(tmpDir, 'backend')).rejects.toThrow(
        /Worktree already exists/,
      );
    });

    it('should attach to existing branch when branch already exists', async () => {
      // Create the branch manually before calling createWorktree
      execFileSync('git', ['branch', 'agent/solo'], { cwd: tmpDir, stdio: 'pipe' });

      // Remove the worktree path so it does not trigger the "already exists" guard
      const worktreePath = join(tmpDir, '.hive', 'worktrees', 'solo');

      // Should not throw even though the branch exists — falls back to attach mode
      await expect(createWorktree(tmpDir, 'solo')).resolves.toBe(worktreePath);
    });
  });

  // ── listWorktrees ────────────────────────────────────────────────

  describe('listWorktrees', () => {
    it('should include the main worktree in the list', async () => {
      const worktrees = await listWorktrees(tmpDir);
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
    });

    it('should mark the primary worktree as isMain=true', async () => {
      const worktrees = await listWorktrees(tmpDir);
      const main = worktrees.find((wt) => wt.isMain);
      expect(main).toBeDefined();
    });

    it('should reflect a newly created worktree in the list', async () => {
      await createWorktree(tmpDir, 'qa');

      const worktrees = await listWorktrees(tmpDir);
      const qaWorktree = worktrees.find((wt) =>
        wt.path.endsWith('worktrees/qa'),
      );
      expect(qaWorktree).toBeDefined();
    });

    it('should return the branch name for each worktree', async () => {
      await createWorktree(tmpDir, 'qa');

      const worktrees = await listWorktrees(tmpDir);
      const qaWorktree = worktrees.find((wt) =>
        wt.path.endsWith('worktrees/qa'),
      );
      expect(qaWorktree?.branch).toBe('agent/qa');
    });

    it('should return a non-empty HEAD hash for each worktree', async () => {
      await createWorktree(tmpDir, 'qa');

      const worktrees = await listWorktrees(tmpDir);
      for (const wt of worktrees) {
        expect(wt.head.length).toBeGreaterThan(0);
      }
    });
  });

  // ── removeWorktree ───────────────────────────────────────────────

  describe('removeWorktree', () => {
    beforeEach(async () => {
      await createWorktree(tmpDir, 'backend');
    });

    it('should remove the worktree directory', async () => {
      await removeWorktree(tmpDir, 'backend');

      const worktreePath = join(tmpDir, '.hive', 'worktrees', 'backend');
      expect(existsSync(worktreePath)).toBe(false);
    });

    it('should delete the agent branch by default', async () => {
      await removeWorktree(tmpDir, 'backend');

      const branches = execFileSync(
        'git',
        ['branch', '--list', 'agent/backend'],
        { cwd: tmpDir, stdio: 'pipe' },
      ).toString();

      expect(branches.trim()).toBe('');
    });

    it('should preserve the agent branch when deleteBranch=false', async () => {
      await removeWorktree(tmpDir, 'backend', false);

      const branches = execFileSync(
        'git',
        ['branch', '--list', 'agent/backend'],
        { cwd: tmpDir, stdio: 'pipe' },
      ).toString();

      expect(branches.trim()).toBe('agent/backend');
    });

    it('should not throw when worktree directory does not exist', async () => {
      // Remove directory manually first
      rmSync(join(tmpDir, '.hive', 'worktrees', 'backend'), {
        recursive: true,
        force: true,
      });
      // Prune to avoid git's "gitdir file points to non-existent location" state
      execFileSync('git', ['worktree', 'prune'], { cwd: tmpDir, stdio: 'pipe' });

      await expect(removeWorktree(tmpDir, 'backend')).resolves.toBeUndefined();
    });

    it('should not throw when branch does not exist and deleteBranch=true', async () => {
      // Delete branch manually first
      execFileSync('git', ['worktree', 'remove', '--force',
        join(tmpDir, '.hive', 'worktrees', 'backend')], { cwd: tmpDir, stdio: 'pipe' });
      execFileSync('git', ['branch', '-D', 'agent/backend'], { cwd: tmpDir, stdio: 'pipe' });

      // removeWorktree should swallow the missing-branch error
      await expect(removeWorktree(tmpDir, 'backend')).resolves.toBeUndefined();
    });
  });
});

// ── syncWorktree smart strategies ───────────────────────────────────

describe('syncWorktree — smart strategies', () => {
  let originDir: string;
  let cloneDir: string;
  let worktreePath: string;

  const git = (dir: string, args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();

  /**
   * Set up a bare origin + clone with an agent worktree.
   * This mimics the real hive setup: origin (bare), clone (hive root), worktree (agent).
   */
  function setupOriginAndClone(): void {
    const base = mkdtempSync(join(tmpdir(), 'hive-sync-'));

    // Create a non-bare "upstream" repo to serve as origin
    originDir = join(base, 'origin');
    mkdirSync(originDir, { recursive: true });
    git(originDir, ['init', '--initial-branch', 'main']);
    git(originDir, ['config', 'user.email', 'test@hive.local']);
    git(originDir, ['config', 'user.name', 'Test']);
    writeFileSync(join(originDir, 'file.txt'), 'initial\n');
    git(originDir, ['add', 'file.txt']);
    git(originDir, ['commit', '-m', 'initial']);

    // Clone it
    cloneDir = join(base, 'clone');
    git(base, ['clone', originDir, 'clone']);
    git(cloneDir, ['config', 'user.email', 'test@hive.local']);
    git(cloneDir, ['config', 'user.name', 'Test']);

    // Create an agent worktree
    mkdirSync(join(cloneDir, '.hive', 'worktrees'), { recursive: true });
    worktreePath = join(cloneDir, '.hive', 'worktrees', 'backend');
    git(cloneDir, ['worktree', 'add', worktreePath, '-b', 'agent/backend']);
    git(worktreePath, ['config', 'user.email', 'test@hive.local']);
    git(worktreePath, ['config', 'user.name', 'Test']);
  }

  afterEach(() => {
    // Clean up all temp dirs
    if (originDir) {
      const base = join(originDir, '..');
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('should succeed with standard rebase when branch is clean', async () => {
    setupOriginAndClone();

    const result = await syncWorktree(worktreePath, 'main');
    expect(result.success).toBe(true);
    expect(result.strategy).toBe('rebase');
  });

  it('should succeed when origin has new commits (fast-forward)', async () => {
    setupOriginAndClone();

    // Add a commit to origin
    writeFileSync(join(originDir, 'new.txt'), 'new\n');
    git(originDir, ['add', 'new.txt']);
    git(originDir, ['commit', '-m', 'new file on origin']);

    const result = await syncWorktree(worktreePath, 'main');
    expect(result.success).toBe(true);
    // File should now exist in worktree
    expect(existsSync(join(worktreePath, 'new.txt'))).toBe(true);
  });

  it('should handle cherry-pick duplicates via reapply or unique strategy', async () => {
    setupOriginAndClone();

    // Make a commit on agent branch
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
    git(worktreePath, ['add', 'feature.txt']);
    git(worktreePath, ['commit', '-m', 'feat: add feature']);

    // Diverge origin first, then apply the same patch (simulates hive merge)
    writeFileSync(join(originDir, 'diverge.txt'), 'diverge\n');
    git(originDir, ['add', 'diverge.txt']);
    git(originDir, ['commit', '-m', 'chore: diverge']);
    writeFileSync(join(originDir, 'feature.txt'), 'feature\n');
    git(originDir, ['add', 'feature.txt']);
    git(originDir, ['commit', '-m', 'feat: add feature']);

    const result = await syncWorktree(worktreePath, 'main');
    expect(result.success).toBe(true);
    expect(['rebase', 'rebase-reapply', 'cherry-pick-unique', 'reset-to-target']).toContain(result.strategy);
  });

  it('should reset to target when agent has no unique commits', async () => {
    setupOriginAndClone();

    // Make a commit on agent branch
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
    git(worktreePath, ['add', 'feature.txt']);
    git(worktreePath, ['commit', '-m', 'feat: add feature']);

    // Diverge origin, apply same patch, add extra commit
    writeFileSync(join(originDir, 'diverge.txt'), 'diverge\n');
    git(originDir, ['add', 'diverge.txt']);
    git(originDir, ['commit', '-m', 'chore: diverge']);
    writeFileSync(join(originDir, 'feature.txt'), 'feature\n');
    git(originDir, ['add', 'feature.txt']);
    git(originDir, ['commit', '-m', 'feat: add feature']);
    writeFileSync(join(originDir, 'extra.txt'), 'extra\n');
    git(originDir, ['add', 'extra.txt']);
    git(originDir, ['commit', '-m', 'extra commit on origin']);

    const result = await syncWorktree(worktreePath, 'main');
    expect(result.success).toBe(true);
    // Extra file should be in worktree now
    expect(existsSync(join(worktreePath, 'extra.txt'))).toBe(true);
  });

  it('should use cherry-pick-unique when there are mixed unique and duplicate commits', async () => {
    setupOriginAndClone();

    // Commit 1: will be duplicated on origin
    writeFileSync(join(worktreePath, 'shared.txt'), 'shared\n');
    git(worktreePath, ['add', 'shared.txt']);
    git(worktreePath, ['commit', '-m', 'feat: shared work']);

    // Commit 2: unique to agent
    writeFileSync(join(worktreePath, 'unique.txt'), 'unique\n');
    git(worktreePath, ['add', 'unique.txt']);
    git(worktreePath, ['commit', '-m', 'feat: unique work']);

    // Diverge origin, then apply same shared patch
    writeFileSync(join(originDir, 'diverge.txt'), 'diverge\n');
    git(originDir, ['add', 'diverge.txt']);
    git(originDir, ['commit', '-m', 'chore: diverge']);
    writeFileSync(join(originDir, 'shared.txt'), 'shared\n');
    git(originDir, ['add', 'shared.txt']);
    git(originDir, ['commit', '-m', 'feat: shared work']);

    const result = await syncWorktree(worktreePath, 'main');
    expect(result.success).toBe(true);
    // Unique file should still be present
    expect(existsSync(join(worktreePath, 'unique.txt'))).toBe(true);
    // Shared file should also be present
    expect(existsSync(join(worktreePath, 'shared.txt'))).toBe(true);
  });

  // ── diagnoseSyncFailure ──────────────────────────────────────────

  describe('diagnoseSyncFailure', () => {
    it('should detect cherry-pick duplicates', async () => {
      setupOriginAndClone();

      // Make a commit on agent branch
      writeFileSync(join(worktreePath, 'dup.txt'), 'dup\n');
      git(worktreePath, ['add', 'dup.txt']);
      git(worktreePath, ['commit', '-m', 'feat: dup']);

      // On origin, add a different commit first (to diverge history),
      // then apply the same patch. This creates different SHAs for the
      // same patch (different parent), which is what hive merge produces.
      writeFileSync(join(originDir, 'diverge.txt'), 'diverge\n');
      git(originDir, ['add', 'diverge.txt']);
      git(originDir, ['commit', '-m', 'chore: diverge']);
      writeFileSync(join(originDir, 'dup.txt'), 'dup\n');
      git(originDir, ['add', 'dup.txt']);
      git(originDir, ['commit', '-m', 'feat: dup']);

      // Fetch so origin/main is up-to-date
      git(cloneDir, ['fetch', 'origin']);

      const diagnosis = await diagnoseSyncFailure(worktreePath, 'main');
      expect(diagnosis.type).toBe('cherry_pick_duplicates');
      if (diagnosis.type === 'cherry_pick_duplicates') {
        expect(diagnosis.duplicateCount).toBe(1);
        expect(diagnosis.uniqueCount).toBe(0);
      }
    });

    it('should detect branch diverged with no agent commits', async () => {
      setupOriginAndClone();

      // Add commits only to origin
      writeFileSync(join(originDir, 'origin-only.txt'), 'origin\n');
      git(originDir, ['add', 'origin-only.txt']);
      git(originDir, ['commit', '-m', 'origin only']);
      git(cloneDir, ['fetch', 'origin']);

      const diagnosis = await diagnoseSyncFailure(worktreePath, 'main');
      expect(diagnosis.type).toBe('branch_diverged');
      if (diagnosis.type === 'branch_diverged') {
        expect(diagnosis.aheadCount).toBe(0);
        expect(diagnosis.behindCount).toBe(1);
      }
    });

    it('should report clean when branch is up-to-date', async () => {
      setupOriginAndClone();
      // No divergence — agent branch == origin/main
      // Need to ensure we've fetched after clone
      git(cloneDir, ['fetch', 'origin']);

      const diagnosis = await diagnoseSyncFailure(worktreePath, 'main');
      // With no commits ahead or behind, and no cherry dups, should be clean
      expect(diagnosis.type).toBe('clean');
    });
  });
});
