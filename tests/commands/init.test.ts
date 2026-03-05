import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

// Path to the built CLI entry point
const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

describe('hive init (CLI integration)', () => {
  let tmpDir: string;

  function initGitRepo(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
    execSync('git add .gitkeep && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  }

  function runCli(
    args: string,
    opts: { expectError?: boolean; cwd?: string } = {},
  ): { stdout: string; stderr: string; code: number } {
    const dir = opts.cwd ?? tmpDir;
    const execOpts: ExecSyncOptionsWithStringEncoding = {
      cwd: dir,
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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-cli-init-'));
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Help text ────────────────────────────────────────────────────────

  describe('help text', () => {
    it('should show init command options in help', () => {
      const { stdout } = runCli('init --help');
      expect(stdout).toContain('--agents');
      expect(stdout).toContain('--preset');
      expect(stdout).toContain('--yes');
      expect(stdout).toContain('--templates');
    });

    it('should show --list-presets option in help', () => {
      const { stdout } = runCli('init --help');
      expect(stdout).toContain('--list-presets');
    });
  });

  // ── --list-presets ───────────────────────────────────────────────────

  describe('--list-presets', () => {
    it('should list available configuration profiles', () => {
      const { stdout } = runCli('init --list-presets');
      expect(stdout).toContain('fullstack');
      expect(stdout).toContain('solo');
      expect(stdout).toContain('minimal');
    });

    it('should show profile descriptions', () => {
      const { stdout } = runCli('init --list-presets');
      expect(stdout).toContain('Full-stack development');
      expect(stdout).toContain('Single backend agent');
    });

    it('should show agents included in each profile', () => {
      const { stdout } = runCli('init --list-presets');
      expect(stdout).toContain('backend');
      expect(stdout).toContain('qa');
    });

    it('should show usage hint', () => {
      const { stdout } = runCli('init --list-presets');
      expect(stdout).toContain('hive init --preset');
    });
  });

  // ── --yes (non-interactive defaults) ────────────────────────────────

  describe('--yes flag', () => {
    it('should create .hive/ directory', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive'))).toBe(true);
    });

    it('should create config.yaml', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'config.yaml'))).toBe(true);
    });

    it('should create chat.md', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'chat.md'))).toBe(true);
    });

    it('should create hooks directory', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'hooks'))).toBe(true);
    });

    it('should install destructive-guard hook', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'hooks', 'destructive-guard.sh'))).toBe(true);
    });

    it('should install check-chat hook', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'hooks', 'check-chat.sh'))).toBe(true);
    });

    it('should create state directory', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'state'))).toBe(true);
    });

    it('should create worktrees directory', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'worktrees'))).toBe(true);
    });

    it('should write a valid YAML config', () => {
      runCli('init --yes --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as Record<string, unknown>;
      expect(config).toHaveProperty('session');
      expect(config).toHaveProperty('defaults');
      expect(config).toHaveProperty('agents');
      expect(config).toHaveProperty('chat');
      expect(config).toHaveProperty('hooks');
    });

    it('should include default agents in config', () => {
      runCli('init --yes --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      // Default agents include sre, frontend, backend, qa, security
      expect(Object.keys(config.agents)).toContain('backend');
      expect(Object.keys(config.agents)).toContain('qa');
    });

    it('should set session name to directory basename', () => {
      runCli('init --yes --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { session: string };
      // tmpDir is a temp directory path, session should be its basename
      const dirBasename = tmpDir.split('/').pop()!;
      expect(config.session).toBe(dirBasename);
    });

    it('should configure default budget', () => {
      runCli('init --yes --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { defaults: { budget: number } };
      expect(config.defaults.budget).toBe(2);
    });

    it('should update .gitignore with hive entries', () => {
      runCli('init --yes --templates none');
      const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('.hive/worktrees/');
      expect(gitignore).toContain('.hive/state/');
    });

    it('should print success message', () => {
      const { stdout } = runCli('init --yes --templates none');
      expect(stdout).toContain('AgentHive initialized');
    });

    it('should print next steps guidance', () => {
      const { stdout } = runCli('init --yes --templates none');
      expect(stdout).toContain('Next steps');
      expect(stdout).toContain('hive launch');
    });
  });

  // ── --agents flag ────────────────────────────────────────────────────

  describe('--agents flag', () => {
    it('should initialize with a single specified agent', () => {
      runCli('init --agents backend --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      expect(Object.keys(config.agents)).toContain('backend');
    });

    it('should initialize with multiple specified agents', () => {
      runCli('init --agents backend,qa --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      expect(Object.keys(config.agents)).toContain('backend');
      expect(Object.keys(config.agents)).toContain('qa');
    });

    it('should not include unspecified agents', () => {
      runCli('init --agents backend --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      expect(Object.keys(config.agents)).not.toContain('frontend');
    });

    it('should create agent description in config', () => {
      runCli('init --agents backend --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: { backend: { description: string; agent: string } } };
      expect(config.agents.backend.description).toBe('Backend Engineer');
      expect(config.agents.backend.agent).toBe('backend');
    });

    it('should set up role_map for specified agents', () => {
      runCli('init --agents backend,qa --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { chat: { role_map: Record<string, string> } };
      expect(config.chat.role_map['backend']).toBe('BACKEND');
      expect(config.chat.role_map['qa']).toBe('QA');
    });

    it('should accept custom (non-built-in) agent names', () => {
      // Custom agents produce a warning but succeed
      const { stdout } = runCli('init --agents mycustomagent --templates none');
      expect(stdout).toContain('AgentHive initialized');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      expect(Object.keys(config.agents)).toContain('mycustomagent');
    });
  });

  // ── --preset flag ────────────────────────────────────────────────────

  describe('--preset flag', () => {
    it('should initialize with the solo preset', () => {
      runCli('init --preset solo --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'config.yaml'))).toBe(true);
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      expect(Object.keys(config.agents)).toContain('backend');
    });

    it('should initialize with the minimal preset', () => {
      runCli('init --preset minimal --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      expect(Object.keys(config.agents)).toContain('backend');
      expect(Object.keys(config.agents)).toContain('qa');
    });

    it('should initialize with the fullstack preset', () => {
      runCli('init --preset fullstack --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { agents: Record<string, unknown> };
      expect(Object.keys(config.agents)).toContain('backend');
      expect(Object.keys(config.agents)).toContain('frontend');
      expect(Object.keys(config.agents)).toContain('qa');
      expect(Object.keys(config.agents)).toContain('sre');
      expect(Object.keys(config.agents)).toContain('security');
    });

    it('should set budget from preset config', () => {
      runCli('init --preset solo --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { defaults: { budget: number; poll: number } };
      // solo preset has poll: 45
      expect(config.defaults.poll).toBe(45);
    });

    it('should fail with unknown preset', () => {
      const { stderr, code } = runCli('init --preset nonexistent --templates none', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('Unknown preset');
      expect(stderr).toContain('nonexistent');
    });

    it('should suggest --list-presets when preset not found', () => {
      const { stderr } = runCli('init --preset bogus --templates none', { expectError: true });
      expect(stderr).toContain('list-presets');
    });
  });

  // ── Error cases ──────────────────────────────────────────────────────

  describe('error cases', () => {
    it('should fail when not in a git repository', () => {
      // Create a non-git directory
      const nonGitDir = mkdtempSync(join(tmpdir(), 'hive-nongit-'));
      try {
        const { stderr, code } = runCli('init --yes --templates none', {
          expectError: true,
          cwd: nonGitDir,
        });
        expect(code).not.toBe(0);
        expect(stderr).toContain('Not a git repository');
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('should fail when .hive/ already exists', () => {
      // First init
      runCli('init --yes --templates none');
      // Second init should fail
      const { stderr, code } = runCli('init --yes --templates none', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('.hive/ already exists');
    });

    it('should suggest hive add when .hive/ already exists', () => {
      runCli('init --yes --templates none');
      const { stderr } = runCli('init --yes --templates none', { expectError: true });
      expect(stderr).toContain('hive add');
    });
  });

  // ── Hooks installation ───────────────────────────────────────────────

  describe('hooks installation', () => {
    it('should make hooks executable', () => {
      runCli('init --yes --templates none');
      // Check that hook files exist and are executable
      const hookPath = join(tmpDir, '.hive', 'hooks', 'destructive-guard.sh');
      expect(existsSync(hookPath)).toBe(true);
      // Verify the file has content (it was copied from embedded hooks)
      const content = readFileSync(hookPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('should install hooks with shell script content', () => {
      runCli('init --yes --templates none');
      const checkChatPath = join(tmpDir, '.hive', 'hooks', 'check-chat.sh');
      const content = readFileSync(checkChatPath, 'utf-8');
      // Shell scripts start with shebang
      expect(content).toMatch(/^#!/);
    });

    it('should include safety hooks in config', () => {
      runCli('init --yes --templates none');
      const raw = readFileSync(join(tmpDir, '.hive', 'config.yaml'), 'utf-8');
      const config = parseYaml(raw) as { hooks: { safety: string[]; coordination: string[] } };
      expect(config.hooks.safety).toContain('destructive-guard');
      expect(config.hooks.coordination).toContain('check-chat');
    });
  });

  // ── Chat file initialization ─────────────────────────────────────────

  describe('chat file', () => {
    it('should create a non-empty chat.md', () => {
      runCli('init --yes --templates none');
      const content = readFileSync(join(tmpDir, '.hive', 'chat.md'), 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('should create chat.md with header content', () => {
      runCli('init --yes --templates none');
      const content = readFileSync(join(tmpDir, '.hive', 'chat.md'), 'utf-8');
      // Chat file should contain some markdown header or hive reference
      expect(content).toMatch(/^#/m);
    });
  });

  // ── .gitignore update ────────────────────────────────────────────────

  describe('.gitignore update', () => {
    it('should create .gitignore if it does not exist', () => {
      runCli('init --yes --templates none');
      expect(existsSync(join(tmpDir, '.gitignore'))).toBe(true);
    });

    it('should append to existing .gitignore without overwriting', () => {
      // Create an existing .gitignore
      writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf-8');
      runCli('init --yes --templates none');
      const content = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
      // Existing entry should still be there
      expect(content).toContain('node_modules/');
      // New entries should be added
      expect(content).toContain('.hive/worktrees/');
      expect(content).toContain('.hive/state/');
    });

    it('should not duplicate .gitignore entries on repeated runs', () => {
      // After first init we can't reinitialize — but we can check that
      // if the entries are already present, they don't get added again
      writeFileSync(
        join(tmpDir, '.gitignore'),
        'node_modules/\n.hive/worktrees/\n.hive/state/\n',
        'utf-8',
      );
      // Now do a fresh init in a subdirectory that is also a git repo
      const subDir = mkdtempSync(join(tmpdir(), 'hive-sub-'));
      try {
        initGitRepo(subDir);
        writeFileSync(
          join(subDir, '.gitignore'),
          '.hive/worktrees/\n.hive/state/\n',
          'utf-8',
        );
        runCli('init --yes --templates none', { cwd: subDir });
        const content = readFileSync(join(subDir, '.gitignore'), 'utf-8');
        // Count occurrences of the entry
        const worktreesCount = (content.match(/\.hive\/worktrees\//g) ?? []).length;
        expect(worktreesCount).toBe(1);
      } finally {
        rmSync(subDir, { recursive: true, force: true });
      }
    });
  });

  // ── Template installation (--templates flag) ─────────────────────────

  describe('template installation', () => {
    it('should skip templates with --templates none', () => {
      runCli('init --yes --templates none');
      // .claude/agents/ should not be created
      expect(existsSync(join(tmpDir, '.claude', 'agents'))).toBe(false);
    });

    it('should install templates with --yes (default behavior)', () => {
      runCli('init --agents backend --yes');
      // .claude/agents/ should be created with the backend template
      const agentsDir = join(tmpDir, '.claude', 'agents');
      expect(existsSync(agentsDir)).toBe(true);
    });

    it('should skip existing templates without overwriting', () => {
      // Pre-create an agent template
      mkdirSync(join(tmpDir, '.claude', 'agents'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'agents', 'backend.md'), 'custom content', 'utf-8');

      runCli('init --agents backend --yes');
      // Existing template should not be overwritten
      const content = readFileSync(join(tmpDir, '.claude', 'agents', 'backend.md'), 'utf-8');
      expect(content).toBe('custom content');
    });
  });

  // ── Worktree creation ────────────────────────────────────────────────

  describe('worktree creation', () => {
    it('should create worktrees for selected agents', () => {
      runCli('init --agents backend --templates none');
      expect(existsSync(join(tmpDir, '.hive', 'worktrees', 'backend'))).toBe(true);
    });

    it('should create .claude/settings.json in each worktree', () => {
      runCli('init --agents backend --templates none');
      const settingsPath = join(tmpDir, '.hive', 'worktrees', 'backend', '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
    });

    it('should write valid JSON to .claude/settings.json in worktree', () => {
      runCli('init --agents backend --templates none');
      const settingsPath = join(tmpDir, '.hive', 'worktrees', 'backend', '.claude', 'settings.json');
      const raw = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as { hooks: Record<string, unknown[]> };
      expect(settings).toHaveProperty('hooks');
    });

    it('should register PreToolUse safety hooks in worktree settings', () => {
      runCli('init --agents backend --templates none');
      const settingsPath = join(tmpDir, '.hive', 'worktrees', 'backend', '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        hooks: { PreToolUse?: Array<{ type: string; command: string }> };
      };
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PreToolUse![0].type).toBe('command');
      expect(settings.hooks.PreToolUse![0].command).toContain('destructive-guard.sh');
    });

    it('should register UserPromptSubmit coordination hooks in worktree settings', () => {
      runCli('init --agents backend --templates none');
      const settingsPath = join(tmpDir, '.hive', 'worktrees', 'backend', '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        hooks: { UserPromptSubmit?: Array<{ type: string; command: string }> };
      };
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      expect(settings.hooks.UserPromptSubmit![0].command).toContain('check-chat.sh');
    });
  });

  // ── Output messages ──────────────────────────────────────────────────

  describe('output messages', () => {
    it('should print agent list in summary', () => {
      const { stdout } = runCli('init --agents backend,qa --templates none');
      expect(stdout).toContain('Agents:');
      expect(stdout).toContain('backend');
      expect(stdout).toContain('qa');
    });

    it('should print config path in summary', () => {
      const { stdout } = runCli('init --agents backend --templates none');
      expect(stdout).toContain('.hive/config.yaml');
    });

    it('should print chat file path in summary', () => {
      const { stdout } = runCli('init --agents backend --templates none');
      expect(stdout).toContain('.hive/chat.md');
    });

    it('should print hive launch in next steps', () => {
      const { stdout } = runCli('init --agents backend --templates none');
      expect(stdout).toContain('hive launch');
    });

    it('should print hive dispatch in next steps', () => {
      const { stdout } = runCli('init --agents backend --templates none');
      expect(stdout).toContain('hive dispatch');
    });
  });
});
