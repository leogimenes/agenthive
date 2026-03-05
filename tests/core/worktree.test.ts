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
