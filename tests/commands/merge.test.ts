import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';

// Path to built CLI
const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

// Git identity env vars — avoid requiring ~/.gitconfig in CI
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

// ── Git helpers ──────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    env: GIT_ENV,
  }).trim();
}

function gitq(args: string, cwd: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'ignore', env: GIT_ENV });
}

// ── CLI runner ────────────────────────────────────────────────────────

function runCli(
  args: string,
  cwd: string,
  opts: { expectError?: boolean } = {},
): { stdout: string; stderr: string; code: number } {
  const execOpts = {
    cwd,
    encoding: 'utf-8' as const,
    env: { ...GIT_ENV, NO_COLOR: '1', FORCE_COLOR: '0' },
    timeout: 30000,
  };

  try {
    const stdout = execSync(`node ${CLI} ${args}`, execOpts);
    return { stdout: stdout.toString(), stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (!opts.expectError) throw err;
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: e.status ?? 1,
    };
  }
}

// ── Fixture factory ───────────────────────────────────────────────────

interface HiveFixture {
  rootTmp: string;
  remoteDir: string;
  localDir: string;
  hiveDir: string;
}

function makeConfig(agentNames: string[]): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  const roleMap: Record<string, string> = {};
  for (const name of agentNames) {
    agents[name] = { description: `${name} agent`, agent: name };
    roleMap[name] = name.toUpperCase();
  }
  return {
    session: 'test-session',
    defaults: { poll: 60, budget: 2, daily_max: 20, model: 'sonnet', skip_permissions: true },
    agents,
    chat: { file: 'chat.md', role_map: roleMap },
    hooks: { safety: [], coordination: [] },
    templates: {},
  };
}

/**
 * Creates a complete hive fixture:
 *  - bare remote repo (the "origin")
 *  - local repo cloned from it (the hive root)
 *  - git worktrees for each agent at .hive/worktrees/<name> on branch agent/<name>
 */
function createFixture(agentNames: string[]): HiveFixture {
  const rootTmp = mkdtempSync(join(tmpdir(), 'hive-merge-test-'));

  // 1. Bare remote (origin)
  const remoteDir = join(rootTmp, 'remote.git');
  mkdirSync(remoteDir);
  gitq('init --bare', remoteDir);

  // 2. Local repo — seed with an initial commit on main
  const localDir = join(rootTmp, 'local');
  mkdirSync(localDir);
  gitq('init', localDir);
  gitq('config user.email "test@test.com"', localDir);
  gitq('config user.name "Test"', localDir);
  writeFileSync(join(localDir, 'README.md'), '# AgentHive Test\n');
  gitq('add README.md', localDir);
  gitq('commit -m "init"', localDir);
  // Ensure branch is named 'main'
  try { gitq('branch -M main', localDir); } catch { /* already main */ }
  gitq(`remote add origin ${remoteDir}`, localDir);
  gitq('push -u origin main', localDir);

  // Set the bare remote's HEAD to 'main' so clones check out 'main' by default
  gitq('symbolic-ref HEAD refs/heads/main', remoteDir);

  // 3. .hive directory structure
  const hiveDir = join(localDir, '.hive');
  mkdirSync(join(hiveDir, 'state'), { recursive: true });
  mkdirSync(join(hiveDir, 'worktrees'), { recursive: true });
  writeFileSync(join(hiveDir, 'chat.md'), '# HIVE chat\n');
  writeFileSync(join(hiveDir, 'config.yaml'), yamlStringify(makeConfig(agentNames)));

  // 4. Git worktrees for each agent
  for (const name of agentNames) {
    const wtPath = join(hiveDir, 'worktrees', name);
    gitq(`worktree add ${wtPath} -b agent/${name}`, localDir);
  }

  return { rootTmp, remoteDir, localDir, hiveDir };
}

function cleanup(fixture: HiveFixture): void {
  rmSync(fixture.rootTmp, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('hive merge (CLI integration)', () => {
  let fixture: HiveFixture;

  afterEach(() => {
    if (fixture) cleanup(fixture);
  });

  // ── Basic rebase + push ─────────────────────────────────────────────

  describe('basic rebase + push', () => {
    beforeEach(() => {
      fixture = createFixture(['alpha']);

      // Make a commit in the alpha worktree
      const wtPath = join(fixture.hiveDir, 'worktrees', 'alpha');
      writeFileSync(join(wtPath, 'alpha.txt'), 'alpha work\n');
      gitq('add alpha.txt', wtPath);
      gitq('commit -m "alpha: add alpha.txt"', wtPath);
    });

    it('should exit with code 0 when a branch is merged successfully', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      expect(result.code).toBe(0);
    });

    it('should output a success indicator for the merged agent', () => {
      const result = runCli('merge', fixture.localDir);
      expect(result.stdout).toMatch(/alpha/);
      expect(result.stdout).toMatch(/✓|merged|1 commit/i);
    });

    it('should push the agent commit to origin main', () => {
      runCli('merge', fixture.localDir);

      // Fetch in a fresh clone to verify origin/main advanced
      const checkDir = join(fixture.rootTmp, 'check');
      mkdirSync(checkDir);
      gitq(`clone ${fixture.remoteDir} ${checkDir}`, fixture.rootTmp);
      const log = git('log --oneline', checkDir);
      expect(log).toContain('alpha: add alpha.txt');
    });

    it('should include a Summary section in the output', () => {
      const result = runCli('merge', fixture.localDir);
      expect(result.stdout).toContain('Summary');
    });
  });

  // ── --dry-run flag ──────────────────────────────────────────────────

  describe('--dry-run', () => {
    beforeEach(() => {
      fixture = createFixture(['alpha']);

      const wtPath = join(fixture.hiveDir, 'worktrees', 'alpha');
      writeFileSync(join(wtPath, 'alpha.txt'), 'dry run test\n');
      gitq('add alpha.txt', wtPath);
      gitq('commit -m "alpha: dry run commit"', wtPath);
    });

    it('should output "Dry run" when --dry-run is passed', () => {
      const result = runCli('merge --dry-run', fixture.localDir);
      expect(result.stdout).toMatch(/dry run/i);
    });

    it('should list the agent and its commit count without merging', () => {
      const result = runCli('merge --dry-run', fixture.localDir);
      expect(result.stdout).toContain('alpha');
      expect(result.stdout).toMatch(/1 commit/i);
    });

    it('should NOT push any commits to origin when --dry-run is passed', () => {
      // Capture origin/main HEAD before dry-run
      const beforeHead = git('rev-parse main', fixture.remoteDir);

      runCli('merge --dry-run', fixture.localDir);

      const afterHead = git('rev-parse main', fixture.remoteDir);
      expect(afterHead).toBe(beforeHead);
    });

    it('should exit with code 0 on --dry-run', () => {
      const result = runCli('merge --dry-run', fixture.localDir, { expectError: true });
      expect(result.code).toBe(0);
    });
  });

  // ── Skip: no new commits ────────────────────────────────────────────

  describe('skip when no new commits', () => {
    beforeEach(() => {
      fixture = createFixture(['alpha']);
      // Do NOT make any commits in the alpha worktree — it's identical to main
    });

    it('should exit with code 0 when there is nothing to merge', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      expect(result.code).toBe(0);
    });

    it('should report that no agents have commits to merge', () => {
      const result = runCli('merge', fixture.localDir);
      expect(result.stdout).toMatch(/no new commits|no agents have commits/i);
    });

    it('should indicate the agent was skipped', () => {
      const result = runCli('merge', fixture.localDir);
      expect(result.stdout).toContain('alpha');
    });
  });

  // ── Dirty worktree skipped ──────────────────────────────────────────

  describe('dirty worktree handling', () => {
    beforeEach(() => {
      fixture = createFixture(['alpha']);

      // Make a committed change to establish the agent branch
      const wtPath = join(fixture.hiveDir, 'worktrees', 'alpha');
      writeFileSync(join(wtPath, 'alpha.txt'), 'alpha work\n');
      gitq('add alpha.txt', wtPath);
      gitq('commit -m "alpha: initial work"', wtPath);

      // Add an UNCOMMITTED change (dirty worktree)
      writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted change\n');
    });

    it('should skip the agent with uncommitted changes', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      // May exit 0 (all skipped) or just output the skip reason
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/alpha/);
      expect(combined).toMatch(/uncommitted|dirty|skip/i);
    });

    it('should NOT push anything to origin when worktree is dirty', () => {
      const beforeHead = git('rev-parse main', fixture.remoteDir);

      runCli('merge', fixture.localDir, { expectError: true });

      const afterHead = git('rev-parse main', fixture.remoteDir);
      expect(afterHead).toBe(beforeHead);
    });
  });

  // ── Conflict detection ──────────────────────────────────────────────

  describe('conflict detection', () => {
    beforeEach(() => {
      fixture = createFixture(['alpha']);

      const wtPath = join(fixture.hiveDir, 'worktrees', 'alpha');

      // Agent commits a change to README.md (on top of original main)
      writeFileSync(join(wtPath, 'README.md'), '# Agent Version\n');
      gitq('add README.md', wtPath);
      gitq('commit -m "alpha: change README"', wtPath);

      // Advance origin/main with a CONFLICTING change to README.md
      // Use a separate temp clone to push to origin
      const seedDir = join(fixture.rootTmp, 'seed');
      mkdirSync(seedDir);
      gitq(`clone ${fixture.remoteDir} ${seedDir}`, fixture.rootTmp);
      gitq('config user.email "test@test.com"', seedDir);
      gitq('config user.name "Test"', seedDir);
      writeFileSync(join(seedDir, 'README.md'), '# Remote Version\n');
      gitq('add README.md', seedDir);
      gitq('commit -m "remote: change README"', seedDir);
      gitq('push origin main', seedDir);
    });

    it('should exit with non-zero code on conflict', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      expect(result.code).not.toBe(0);
    });

    it('should report a conflict in the output', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/conflict/i);
    });

    it('should mention the conflicting agent name', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('alpha');
    });

    it('should provide instructions for resolving the conflict', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      // Should mention --continue or resolution steps
      expect(result.stdout).toMatch(/continue|resolve/i);
    });
  });

  // ── Multi-agent merge order ─────────────────────────────────────────

  describe('multi-agent merge order', () => {
    beforeEach(() => {
      fixture = createFixture(['zebra', 'alpha', 'mango']);

      // Give each agent a unique file commit
      for (const name of ['zebra', 'alpha', 'mango']) {
        const wtPath = join(fixture.hiveDir, 'worktrees', name);
        writeFileSync(join(wtPath, `${name}.txt`), `${name} work\n`);
        gitq(`add ${name}.txt`, wtPath);
        gitq(`commit -m "${name}: add ${name}.txt"`, wtPath);
      }
    });

    it('should merge all agents when no filter is given', () => {
      const result = runCli('merge', fixture.localDir);
      expect(result.stdout).toContain('alpha');
      expect(result.stdout).toContain('mango');
      expect(result.stdout).toContain('zebra');
    });

    it('should process agents in alphabetical order by default', () => {
      const result = runCli('merge', fixture.localDir);
      const alphaIdx = result.stdout.indexOf('alpha');
      const mangoIdx = result.stdout.indexOf('mango');
      const zebraIdx = result.stdout.indexOf('zebra');

      // All should appear in output
      expect(alphaIdx).toBeGreaterThanOrEqual(0);
      expect(mangoIdx).toBeGreaterThanOrEqual(0);
      expect(zebraIdx).toBeGreaterThanOrEqual(0);

      // alpha < mango < zebra alphabetically
      expect(alphaIdx).toBeLessThan(mangoIdx);
      expect(mangoIdx).toBeLessThan(zebraIdx);
    });

    it('should push all agent commits to origin main', () => {
      runCli('merge', fixture.localDir);

      const checkDir = join(fixture.rootTmp, 'check');
      mkdirSync(checkDir);
      gitq(`clone ${fixture.remoteDir} ${checkDir}`, fixture.rootTmp);
      const log = git('log --oneline', checkDir);

      expect(log).toContain('alpha: add alpha.txt');
      expect(log).toContain('mango: add mango.txt');
      expect(log).toContain('zebra: add zebra.txt');
    });

    it('should merge only specified agents when filter args are given', () => {
      // Only merge alpha
      const result = runCli('merge alpha', fixture.localDir);

      // alpha should be merged
      expect(result.stdout).toMatch(/alpha.*✓|✓.*alpha/);

      // Only alpha's commit should be in origin main
      const checkDir = join(fixture.rootTmp, 'check');
      mkdirSync(checkDir);
      gitq(`clone ${fixture.remoteDir} ${checkDir}`, fixture.rootTmp);
      const log = git('log --oneline', checkDir);

      expect(log).toContain('alpha: add alpha.txt');
      expect(log).not.toContain('mango: add mango.txt');
      expect(log).not.toContain('zebra: add zebra.txt');
    });

    it('should exit non-zero for unknown agent name', () => {
      const result = runCli('merge unknown-agent', fixture.localDir, { expectError: true });
      expect(result.code).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/unknown.agent|unknown-agent/i);
    });
  });

  // ── In-progress merge guard ─────────────────────────────────────────

  describe('in-progress merge guard', () => {
    beforeEach(() => {
      fixture = createFixture(['alpha']);

      // Create a fake merge-state.json to simulate in-progress merge
      const stateDir = join(fixture.hiveDir, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'merge-state.json'),
        JSON.stringify({
          mainBranch: 'main',
          currentAgent: 'alpha',
          remainingAgents: [],
          completedResults: [],
        }),
      );
    });

    it('should refuse to start a new merge if one is already in progress', () => {
      const wtPath = join(fixture.hiveDir, 'worktrees', 'alpha');
      writeFileSync(join(wtPath, 'alpha.txt'), 'alpha work\n');
      gitq('add alpha.txt', wtPath);
      gitq('commit -m "alpha: work"', wtPath);

      const result = runCli('merge', fixture.localDir, { expectError: true });
      expect(result.code).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/already in progress|merge.*in progress/i);
    });
  });

  // ── Branch does not exist ───────────────────────────────────────────

  describe('branch does not exist', () => {
    beforeEach(() => {
      fixture = createFixture(['alpha']);
      // Remove the worktree and branch that was created, simulating a missing branch
      // We do this by removing the worktree directory and deleting the branch
      const wtPath = join(fixture.hiveDir, 'worktrees', 'alpha');
      gitq(`worktree remove ${wtPath} --force`, fixture.localDir);
      gitq('branch -D agent/alpha', fixture.localDir);
    });

    it('should skip agents whose branches do not exist', () => {
      const result = runCli('merge', fixture.localDir, { expectError: true });
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/alpha/);
      expect(combined).toMatch(/branch does not exist|skip/i);
    });
  });
});
