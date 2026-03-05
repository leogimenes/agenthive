import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  execSync,
  ExecSyncOptionsWithStringEncoding,
} from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';

// Path to the built CLI entry point
const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString().trim();
}

function gitSilent(args: string, cwd: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'ignore' });
}

function makeConfig(agents: Record<string, unknown> = {}, delivery?: Record<string, unknown>) {
  return {
    session: 'test-merge',
    defaults: {
      poll: 60,
      budget: 2,
      daily_max: 20,
      model: 'sonnet',
      skip_permissions: true,
    },
    agents,
    chat: {
      file: 'chat.md',
      role_map: Object.fromEntries(
        Object.keys(agents).map((k) => [k, k.toUpperCase()]),
      ),
    },
    hooks: { safety: [], coordination: [] },
    templates: {},
    ...(delivery ? { delivery } : {}),
  };
}

describe('hive merge (CLI integration)', () => {
  let tmpDir: string;         // main hive root
  let originDir: string;      // bare "remote" repo

  function runCli(
    args: string,
    opts: { expectError?: boolean; cwd?: string } = {},
  ): { stdout: string; stderr: string; code: number } {
    const execOpts: ExecSyncOptionsWithStringEncoding = {
      cwd: opts.cwd ?? tmpDir,
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 30000,
    };

    try {
      const stdout = execSync(`node ${CLI} ${args}`, execOpts);
      return { stdout: stdout.toString(), stderr: '', code: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      if (!opts.expectError) {
        throw err;
      }
      return {
        stdout: (e.stdout ?? '').toString(),
        stderr: (e.stderr ?? '').toString(),
        code: e.status ?? 1,
      };
    }
  }

  /**
   * Set up:
   *   originDir  — bare repo (acts as remote "origin")
   *   tmpDir     — clone of origin (hive root)
   */
  function setupRepos(agents: string[] = ['alpha', 'beta']): void {
    // 1. Create a bare origin repo with an initial commit
    originDir = mkdtempSync(join(tmpdir(), 'hive-merge-origin-'));
    gitSilent('init --bare', originDir);
    // Set default branch to 'main' so clones check out main
    gitSilent('symbolic-ref HEAD refs/heads/main', originDir);

    // 2. Bootstrap origin: clone, commit, push main
    const bootstrap = mkdtempSync(join(tmpdir(), 'hive-merge-boot-'));
    gitSilent(`clone ${originDir} .`, bootstrap);
    gitSilent('config user.email "test@test.com"', bootstrap);
    gitSilent('config user.name "Test"', bootstrap);
    writeFileSync(join(bootstrap, 'README.md'), '# project\n', 'utf-8');
    gitSilent('add README.md', bootstrap);
    gitSilent('commit -m "initial commit"', bootstrap);
    gitSilent('push origin HEAD:main', bootstrap);
    rmSync(bootstrap, { recursive: true, force: true });

    // 3. Clone origin to tmpDir (the hive root)
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-merge-main-'));
    gitSilent(`clone ${originDir} .`, tmpDir);
    gitSilent('config user.email "test@test.com"', tmpDir);
    gitSilent('config user.name "Test"', tmpDir);

    // 4. Create .hive directory
    const hivePath = join(tmpDir, '.hive');
    mkdirSync(hivePath, { recursive: true });
    mkdirSync(join(hivePath, 'state'), { recursive: true });

    const agentConfigs: Record<string, unknown> = {};
    for (const name of agents) {
      agentConfigs[name] = { description: `${name} agent`, agent: name };
    }
    writeFileSync(
      join(hivePath, 'config.yaml'),
      yamlStringify(makeConfig(agentConfigs)),
      'utf-8',
    );
    writeFileSync(join(hivePath, 'chat.md'), '# HIVE chat\n', 'utf-8');

    // 5. Create worktrees for each agent
    const worktreesDir = join(hivePath, 'worktrees');
    mkdirSync(worktreesDir, { recursive: true });

    for (const name of agents) {
      const wt = join(worktreesDir, name);
      gitSilent(`worktree add -b agent/${name} ${wt}`, tmpDir);
      gitSilent('config user.email "test@test.com"', wt);
      gitSilent('config user.name "Test"', wt);
    }
  }

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      // Remove worktrees before wiping to avoid git complaints
      try {
        gitSilent('worktree prune', tmpDir);
      } catch {
        // ignore
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
    if (originDir && existsSync(originDir)) {
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  // ── Help / options ───────────────────────────────────────────────────

  describe('help text', () => {
    beforeEach(() => {
      setupRepos();
    });

    it('should show merge command in help', () => {
      const { stdout } = runCli('merge --help');
      expect(stdout).toContain('merge');
      expect(stdout).toContain('[agents...]');
    });

    it('should show --dry-run option', () => {
      const { stdout } = runCli('merge --help');
      expect(stdout).toContain('--dry-run');
    });

    it('should show --continue option', () => {
      const { stdout } = runCli('merge --help');
      expect(stdout).toContain('--continue');
    });
  });

  // ── Skip: no commits ahead of main ───────────────────────────────────

  describe('skip when no commits ahead of main', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('should skip agent with no new commits and exit zero', () => {
      const { stdout, code } = runCli('merge');
      expect(code).toBe(0);
      expect(stdout).toContain('no new commits');
    });

    it('should show agent name in skip output', () => {
      const { stdout } = runCli('merge');
      expect(stdout).toContain('alpha');
    });
  });

  // ── Skip: dirty worktree ────────────────────────────────────────────

  describe('skip when worktree is dirty', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('should skip agent with uncommitted changes in worktree', () => {
      // Add an uncommitted file to the agent worktree
      const worktreePath = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted\n', 'utf-8');

      // Also add a commit so it would otherwise be mergeable
      const agentFile = join(worktreePath, 'agent-work.txt');
      writeFileSync(agentFile, 'agent work\n', 'utf-8');
      gitSilent('add agent-work.txt', worktreePath);
      gitSilent('commit -m "agent: add work"', worktreePath);

      const { stdout, code } = runCli('merge');
      expect(code).toBe(0);
      expect(stdout).toContain('uncommitted changes');
    });
  });

  // ── Dry run ──────────────────────────────────────────────────────────

  describe('--dry-run flag', () => {
    beforeEach(() => {
      setupRepos(['alpha', 'beta']);
    });

    it('should show agents with commits but not push in dry-run mode', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'feature.ts'), 'export const x = 1;\n', 'utf-8');
      gitSilent('add feature.ts', alphaWt);
      gitSilent('commit -m "feat: add feature"', alphaWt);

      const { stdout, code } = runCli('merge --dry-run');
      expect(code).toBe(0);
      expect(stdout).toContain('Dry run');
      expect(stdout).toContain('alpha');
      expect(stdout).toContain('1 commit');
    });

    it('should not actually merge in dry-run mode', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'feature.ts'), 'export const x = 1;\n', 'utf-8');
      gitSilent('add feature.ts', alphaWt);
      gitSilent('commit -m "feat: add feature"', alphaWt);

      runCli('merge --dry-run');

      // Verify origin/main was NOT updated
      const mainHead = git('rev-parse origin/main', tmpDir);
      const alphaHead = git('rev-parse agent/alpha', alphaWt);
      expect(mainHead).not.toBe(alphaHead);
    });

    it('should list skipped agents in dry-run mode', () => {
      // alpha has no commits, beta has none either
      const { stdout } = runCli('merge --dry-run');
      expect(stdout).toContain('no new commits');
    });
  });

  // ── Successful merge ─────────────────────────────────────────────────

  describe('successful merge (rebase + push)', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('should merge agent branch onto main and print summary', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'api.ts'), 'export const api = true;\n', 'utf-8');
      gitSilent('add api.ts', alphaWt);
      gitSilent('commit -m "feat: add api"', alphaWt);

      const { stdout, code } = runCli('merge');
      expect(code).toBe(0);
      expect(stdout).toContain('alpha');
      expect(stdout).toContain('1 commit');
    });

    it('should fast-forward push to origin main after rebase', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'api.ts'), 'export const api = true;\n', 'utf-8');
      gitSilent('add api.ts', alphaWt);
      gitSilent('commit -m "feat: add api endpoint"', alphaWt);

      runCli('merge');

      // Fetch and verify origin/main was advanced with our commit
      gitSilent('fetch origin', tmpDir);
      const logOutput = git('log --oneline origin/main', tmpDir);
      expect(logOutput).toContain('feat: add api endpoint');
    });

    it('should show summary with merged status', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'work.ts'), 'const x = 1;\n', 'utf-8');
      gitSilent('add work.ts', alphaWt);
      gitSilent('commit -m "feat: work"', alphaWt);

      const { stdout } = runCli('merge');
      expect(stdout).toContain('Summary');
    });
  });

  // ── Agent filter ─────────────────────────────────────────────────────

  describe('agent filter (named agents)', () => {
    beforeEach(() => {
      setupRepos(['alpha', 'beta']);
    });

    it('should only merge named agent when filter provided', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      const betaWt = join(tmpDir, '.hive', 'worktrees', 'beta');

      writeFileSync(join(alphaWt, 'a.ts'), 'const a = 1;\n', 'utf-8');
      gitSilent('add a.ts', alphaWt);
      gitSilent('commit -m "feat: alpha work"', alphaWt);

      writeFileSync(join(betaWt, 'b.ts'), 'const b = 2;\n', 'utf-8');
      gitSilent('add b.ts', betaWt);
      gitSilent('commit -m "feat: beta work"', betaWt);

      // Only merge alpha
      const { stdout, code } = runCli('merge alpha');
      expect(code).toBe(0);
      expect(stdout).toContain('alpha');
      // beta should not appear in the main output (only alpha is processed)
      // beta won't be in the summary since we only requested alpha
      expect(stdout).not.toContain('beta');
    });

    it('should exit with error for unknown agent', () => {
      const { stderr, code } = runCli('merge nonexistent', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('nonexistent');
    });
  });

  // ── Conflict detection ────────────────────────────────────────────────

  describe('conflict detection', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('should exit non-zero and print conflict files when rebase conflicts', () => {
      // Create a conflict:
      // 1. Add a commit to origin/main via alpha worktree push directly
      // 2. Modify the same file in alpha's branch

      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');

      // First: push a change to main from a second clone (so it diverges)
      const otherDir = mkdtempSync(join(tmpdir(), 'hive-merge-other-'));
      try {
        gitSilent(`clone ${originDir} ${otherDir}`, tmpDir);
        gitSilent('config user.email "other@test.com"', otherDir);
        gitSilent('config user.name "Other"', otherDir);
        writeFileSync(join(otherDir, 'conflict.ts'), 'const x = "main version";\n', 'utf-8');
        gitSilent('add conflict.ts', otherDir);
        gitSilent('commit -m "main: conflict file"', otherDir);
        gitSilent('push origin HEAD:main', otherDir);
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }

      // Now add a conflicting change in the alpha worktree
      // (alpha's branch was created before the above commit to main)
      writeFileSync(join(alphaWt, 'conflict.ts'), 'const x = "agent version";\n', 'utf-8');
      gitSilent('add conflict.ts', alphaWt);
      gitSilent('commit -m "agent: conflict file"', alphaWt);

      const { stdout, stderr, code } = runCli('merge', { expectError: true });
      expect(code).not.toBe(0);
      // Should mention conflict
      const combined = stdout + stderr;
      expect(combined).toContain('conflict');
    });
  });

  // ── No args: merge all agents ─────────────────────────────────────────

  describe('no arguments: all agents', () => {
    beforeEach(() => {
      setupRepos(['alpha', 'beta']);
    });

    it('should process all agents when no agent filter is given', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'a.ts'), 'const a = 1;\n', 'utf-8');
      gitSilent('add a.ts', alphaWt);
      gitSilent('commit -m "feat: alpha"', alphaWt);

      // beta has no commits — should be skipped but processed
      const { stdout, code } = runCli('merge');
      expect(code).toBe(0);
      expect(stdout).toContain('alpha');
      expect(stdout).toContain('beta');
    });

    it('should report no agents to merge when all are up-to-date', () => {
      const { stdout, code } = runCli('merge');
      expect(code).toBe(0);
      expect(stdout).toContain('no new commits');
    });
  });

  // ── --continue flag ─────────────────────────────────────────────────

  describe('--continue with no prior conflict', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('should exit with error when no merge is in progress', () => {
      const { stderr, code } = runCli('merge --continue', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('No merge in progress');
    });
  });

  // ── Multiple commits ahead ────────────────────────────────────────────

  describe('multiple commits', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('should report correct commit count when multiple commits ahead', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');

      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(alphaWt, `work${i}.ts`), `const x${i} = ${i};\n`, 'utf-8');
        gitSilent(`add work${i}.ts`, alphaWt);
        gitSilent(`commit -m "feat: work ${i}"`, alphaWt);
      }

      const { stdout } = runCli('merge --dry-run');
      expect(stdout).toContain('3 commit');
    });
  });

  // ── delivery strategy config ──────────────────────────────────────────

  describe('delivery strategy (config-driven)', () => {
    /**
     * Create a config with a specific delivery strategy and an epic plan,
     * then run `hive merge --epic <id>` to verify delivery behaviour.
     *
     * We only need to confirm the strategy is read and acted on;
     * actual git/gh side-effects are verified separately.
     */
    function setupReposWithDelivery(
      agents: string[],
      deliveryCfg: Record<string, unknown>,
    ): void {
      setupRepos(agents);
      // Overwrite config.yaml with delivery section
      const agentConfigs: Record<string, unknown> = {};
      for (const name of agents) {
        agentConfigs[name] = { description: `${name} agent`, agent: name };
      }
      const hivePath = join(tmpDir, '.hive');
      writeFileSync(
        join(hivePath, 'config.yaml'),
        yamlStringify(makeConfig(agentConfigs, deliveryCfg)),
        'utf-8',
      );
    }

    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('config.yaml with delivery.strategy=manual is loaded without error', () => {
      setupReposWithDelivery(['alpha'], { strategy: 'manual', base_branch: 'main' });
      // Running any merge command against a clean repo should succeed
      const { code } = runCli('merge');
      expect(code).toBe(0);
    });

    it('config.yaml with delivery.strategy=auto-merge is loaded without error', () => {
      setupReposWithDelivery(['alpha'], { strategy: 'auto-merge', base_branch: 'main' });
      const { code } = runCli('merge');
      expect(code).toBe(0);
    });

    it('config.yaml with delivery.strategy=pull-request is loaded without error', () => {
      setupReposWithDelivery(['alpha'], { strategy: 'pull-request', base_branch: 'main' });
      const { code } = runCli('merge');
      expect(code).toBe(0);
    });

    it('invalid delivery.strategy value should be rejected by config validation', () => {
      setupReposWithDelivery(['alpha'], { strategy: 'invalid-strategy' });
      // Config validation should fail — hive config should error
      const { stderr, code } = runCli('config', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('delivery.strategy');
    });
  });

  // ── delivery strategy: manual (epic merge) ────────────────────────────

  describe('delivery strategy manual on epic completion', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('prints push instructions in manual mode', () => {
      // Add a commit referencing an epic task ID pattern
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'epic.ts'), 'export const epic = true;\n', 'utf-8');
      gitSilent('add epic.ts', alphaWt);
      gitSilent('commit -m "feat(EPIC-1): implement epic task"', alphaWt);

      // Write a plan with the epic task
      const hivePath = join(tmpDir, '.hive');
      writeFileSync(
        join(hivePath, 'plan.json'),
        JSON.stringify({
          tasks: [
            { id: 'EPIC-1', title: 'Epic task', status: 'done', type: 'epic', deps: [] },
          ],
        }),
        'utf-8',
      );

      // Overwrite config with manual delivery
      const agentConfigs = { alpha: { description: 'alpha agent', agent: 'alpha' } };
      writeFileSync(
        join(hivePath, 'config.yaml'),
        yamlStringify(makeConfig(agentConfigs, { strategy: 'manual', base_branch: 'main' })),
        'utf-8',
      );

      const { stdout, code } = runCli('merge --epic EPIC-1');
      expect(code).toBe(0);
      // Manual mode: should print push instructions
      expect(stdout).toContain('git push origin epic/EPIC-1');
    });
  });

  // ── delivery strategy: auto-merge (epic merge) ────────────────────────

  describe('delivery strategy auto-merge on epic completion', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('pushes epic branch to base_branch in auto-merge mode', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'epic.ts'), 'export const epic = true;\n', 'utf-8');
      gitSilent('add epic.ts', alphaWt);
      gitSilent('commit -m "feat(EPIC-2): auto-merge epic"', alphaWt);

      const hivePath = join(tmpDir, '.hive');
      writeFileSync(
        join(hivePath, 'plan.json'),
        JSON.stringify({
          tasks: [
            { id: 'EPIC-2', title: 'Auto-merge epic', status: 'done', type: 'epic', deps: [] },
          ],
        }),
        'utf-8',
      );

      const agentConfigs = { alpha: { description: 'alpha agent', agent: 'alpha' } };
      writeFileSync(
        join(hivePath, 'config.yaml'),
        yamlStringify(makeConfig(agentConfigs, { strategy: 'auto-merge', base_branch: 'main' })),
        'utf-8',
      );

      const { stdout, code } = runCli('merge --epic EPIC-2');
      expect(code).toBe(0);
      // auto-merge mode: should indicate it merged or attempted to merge
      expect(stdout).toContain('auto-merge');
    });

    it('shows merge result in auto-merge mode', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'epic2.ts'), 'export const x = 2;\n', 'utf-8');
      gitSilent('add epic2.ts', alphaWt);
      gitSilent('commit -m "feat(EPIC-3): auto-merge delivery"', alphaWt);

      const hivePath = join(tmpDir, '.hive');
      writeFileSync(
        join(hivePath, 'plan.json'),
        JSON.stringify({
          tasks: [
            { id: 'EPIC-3', title: 'Another epic', status: 'done', type: 'epic', deps: [] },
          ],
        }),
        'utf-8',
      );

      const agentConfigs = { alpha: { description: 'alpha agent', agent: 'alpha' } };
      writeFileSync(
        join(hivePath, 'config.yaml'),
        yamlStringify(makeConfig(agentConfigs, { strategy: 'auto-merge', base_branch: 'main' })),
        'utf-8',
      );

      const { stdout } = runCli('merge --epic EPIC-3');
      // After auto-merge, output should show the delivery strategy was invoked
      expect(stdout).toContain('Delivery strategy');
    });
  });

  // ── delivery strategy: pull-request (epic merge) ──────────────────────

  describe('delivery strategy pull-request on epic completion', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('attempts PR creation in pull-request mode (fails gracefully without gh)', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'epic.ts'), 'export const pr = true;\n', 'utf-8');
      gitSilent('add epic.ts', alphaWt);
      gitSilent('commit -m "feat(EPIC-4): pull-request epic"', alphaWt);

      const hivePath = join(tmpDir, '.hive');
      writeFileSync(
        join(hivePath, 'plan.json'),
        JSON.stringify({
          tasks: [
            { id: 'EPIC-4', title: 'PR epic', status: 'done', type: 'epic', deps: [] },
          ],
        }),
        'utf-8',
      );

      const agentConfigs = { alpha: { description: 'alpha agent', agent: 'alpha' } };
      writeFileSync(
        join(hivePath, 'config.yaml'),
        yamlStringify(makeConfig(agentConfigs, { strategy: 'pull-request', base_branch: 'main' })),
        'utf-8',
      );

      const { stdout, code } = runCli('merge --epic EPIC-4');
      expect(code).toBe(0);
      // pull-request mode: should show delivery strategy label and attempt PR creation
      expect(stdout).toContain('pull-request');
    });
  });

  // ── --pr flag ─────────────────────────────────────────────────────────

  describe('--pr flag', () => {
    beforeEach(() => {
      setupRepos(['alpha']);
    });

    it('should show --pr option in help', () => {
      const { stdout } = runCli('merge --help');
      expect(stdout).toContain('--pr');
    });

    it('should skip agents with no commits in --pr mode', () => {
      // alpha has no commits — should be skipped
      const { stdout, code } = runCli('merge --pr', { expectError: false });
      expect(code).toBe(0);
      expect(stdout).toContain('no new commits');
    });

    it('should attempt PR creation when agent has commits (fails gracefully without gh)', () => {
      const alphaWt = join(tmpDir, '.hive', 'worktrees', 'alpha');
      writeFileSync(join(alphaWt, 'feat.ts'), 'export const x = 1;\n', 'utf-8');
      gitSilent('add feat.ts', alphaWt);
      gitSilent('commit -m "feat(BE-26): add pr support"', alphaWt);

      // gh is not configured against our local bare repo, so it will fail gracefully
      const result = runCli('merge --pr', { expectError: false });
      const combined = result.stdout + result.stderr;
      // Should mention the agent and attempt PR creation
      expect(combined).toContain('alpha');
    });
  });
});
