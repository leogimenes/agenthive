import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';

// Path to the built CLI entry point
const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

describe('hive plan (CLI integration)', () => {
  let tmpDir: string;
  let hivePath: string;

  // Minimal valid config with agents for testing
  const testConfig = {
    session: 'test-session',
    defaults: {
      poll: 60,
      budget: 2,
      daily_max: 20,
      model: 'sonnet',
      skip_permissions: true,
    },
    agents: {
      backend: { description: 'Backend Engineer', agent: 'backend' },
      frontend: { description: 'Frontend Developer', agent: 'frontend' },
      qa: { description: 'Quality Analyst', agent: 'qa' },
    },
    chat: {
      file: 'chat.md',
      role_map: { backend: 'BACKEND', frontend: 'FRONTEND', qa: 'QA' },
    },
    hooks: { safety: [], coordination: [] },
    templates: {},
  };

  function initGitRepo(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
    // Need at least one commit for git to work
    writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
    execSync('git add .gitkeep && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  }

  function runCli(args: string, opts: { expectError?: boolean } = {}): { stdout: string; stderr: string; code: number } {
    const execOpts: ExecSyncOptionsWithStringEncoding = {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      timeout: 10000,
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
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-cli-plan-'));
    hivePath = join(tmpDir, '.hive');
    mkdirSync(hivePath, { recursive: true });
    writeFileSync(join(hivePath, 'config.yaml'), yamlStringify(testConfig), 'utf-8');
    writeFileSync(join(hivePath, 'chat.md'), '# HIVE chat\n', 'utf-8');
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Help text ───────────────────────────────────────────────────────

  describe('help text', () => {
    it('should show plan subcommands in help', () => {
      const { stdout } = runCli('plan --help');
      expect(stdout).toContain('add');
      expect(stdout).toContain('dispatch');
      expect(stdout).toContain('create');
      expect(stdout).toContain('ready');
      expect(stdout).toContain('stats');
    });

    it('should show quick-start guide in help', () => {
      const { stdout } = runCli('plan --help');
      expect(stdout).toContain('Quick start:');
      expect(stdout).toContain('hive plan add');
      expect(stdout).toContain('hive plan create');
      expect(stdout).toContain('hive plan dispatch');
    });

    it('should show optional args and -i flag in add help', () => {
      const { stdout } = runCli('plan add --help');
      expect(stdout).toContain('[target]');
      expect(stdout).toContain('[title]');
      expect(stdout).toContain('--interactive');
      expect(stdout).toContain('-i');
    });

    it('should show create subcommand options', () => {
      const { stdout } = runCli('plan create --help');
      expect(stdout).toContain('--budget');
      expect(stdout).toContain('--model');
      expect(stdout).toContain('--auto-import');
      expect(stdout).toContain('AI-assisted');
    });
  });

  // ── Board view (contextual guidance) ────────────────────────────────

  describe('board view', () => {
    it('should show empty plan guidance', () => {
      const { stdout } = runCli('plan');
      expect(stdout).toContain('Plan is empty');
      expect(stdout).toContain('hive plan add');
      expect(stdout).toContain('hive plan create');
    });

    it('should show ready tasks guidance', () => {
      runCli('plan add backend "task one" --priority p1');
      const { stdout } = runCli('plan');
      expect(stdout).toContain('ready to dispatch');
      expect(stdout).toContain('hive plan dispatch');
    });

    it('should show all-done guidance', () => {
      runCli('plan add backend "task one"');
      // Get the task ID from the plan
      const { stdout: jsonOut } = runCli('plan --json');
      const plan = JSON.parse(jsonOut);
      const taskId = plan.tasks[0].id;
      runCli(`plan update ${taskId} --status done`);
      const { stdout } = runCli('plan');
      expect(stdout).toContain('All tasks complete');
    });

    it('should show failed tasks guidance', () => {
      runCli('plan add backend "task one"');
      const { stdout: jsonOut } = runCli('plan --json');
      const plan = JSON.parse(jsonOut);
      const taskId = plan.tasks[0].id;
      runCli(`plan update ${taskId} --status failed`);
      const { stdout } = runCli('plan');
      expect(stdout).toContain('failed');
      expect(stdout).toContain('hive plan reset');
    });

    it('should support compact view', () => {
      runCli('plan add backend "Build API"');
      runCli('plan add frontend "Build UI"');
      const { stdout } = runCli('plan --compact');
      expect(stdout).toContain('Build API');
      expect(stdout).toContain('Build UI');
      expect(stdout).toContain('backend');
      expect(stdout).toContain('frontend');
    });

    it('should support filter by agent', () => {
      runCli('plan add backend "Build API"');
      runCli('plan add frontend "Build UI"');
      const { stdout } = runCli('plan --filter backend --compact');
      expect(stdout).toContain('Build API');
      expect(stdout).toContain('backend');
      expect(stdout).not.toContain('Build UI');
    });

    it('should support JSON output', () => {
      runCli('plan add backend "Build API"');
      const { stdout } = runCli('plan --json');
      const plan = JSON.parse(stdout);
      expect(plan.tasks).toHaveLength(1);
      expect(plan.tasks[0].title).toBe('Build API');
    });
  });

  // ── plan add (flag-based, backward compat) ──────────────────────────

  describe('plan add (flag-based)', () => {
    it('should add a task with required args', () => {
      const { stdout } = runCli('plan add backend "Implement auth"');
      expect(stdout).toContain('Added:');
      expect(stdout).toContain('backend');
      expect(stdout).toContain('Implement auth');
    });

    it('should add a task with all flags', () => {
      const { stdout } = runCli(
        'plan add backend "Build endpoint" --priority p0 --description "REST API for users" --id BE-99',
      );
      expect(stdout).toContain('BE-99');
      expect(stdout).toContain('p0');
    });

    it('should reject unknown agent target', () => {
      const { stderr, code } = runCli('plan add nonexistent "Task"', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('Unknown target');
    });

    it('should reject invalid priority', () => {
      const { stderr, code } = runCli('plan add backend "Task" --priority p9', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('Invalid priority');
    });

    it('should support dependencies', () => {
      runCli('plan add backend "Task A" --id A-01');
      const { stdout } = runCli('plan add frontend "Task B" --depends-on A-01');
      expect(stdout).toContain('Blocked by');
      expect(stdout).toContain('A-01');
    });

    it('should reject missing dependency', () => {
      const { stderr, code } = runCli('plan add backend "Task" --depends-on nonexistent', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('not found');
    });

    it('should reject duplicate task ID', () => {
      runCli('plan add backend "Task A" --id DUP-01');
      const { stderr, code } = runCli('plan add frontend "Task B" --id DUP-01', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('already exists');
    });

    it('should detect dependency cycles', () => {
      runCli('plan add backend "Task A" --id CYC-A');
      runCli('plan add frontend "Task B" --id CYC-B --depends-on CYC-A');
      const { stderr, code } = runCli('plan add qa "Task C" --id CYC-A --depends-on CYC-B', { expectError: true });
      // CYC-A already exists, so it would fail with duplicate ID
      expect(code).not.toBe(0);
    });

    it('should auto-promote tasks to ready when deps are met', () => {
      const { stdout } = runCli('plan add backend "No deps task"');
      expect(stdout).toContain('ready');
    });

    it('should persist task to plan.json', () => {
      runCli('plan add backend "Persistent task" --id PERS-01');
      const planJson = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      expect(planJson.tasks.some((t: { id: string }) => t.id === 'PERS-01')).toBe(true);
    });
  });

  // ── plan add (wizard TTY guard) ────────────────────────────────────

  describe('plan add (wizard / interactive mode)', () => {
    it('should error in non-TTY when no args provided', () => {
      const { stderr, code } = runCli('plan add', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('Interactive mode requires a terminal');
      expect(stderr).toContain('hive plan add <target> <title>');
    });

    it('should error in non-TTY when -i flag used', () => {
      const { stderr, code } = runCli('plan add backend "Test" -i', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('Interactive mode requires a terminal');
    });
  });

  // ── plan dispatch ──────────────────────────────────────────────────

  describe('plan dispatch', () => {
    it('should dispatch ready tasks', () => {
      runCli('plan add backend "Task A" --id DSP-A');
      const { stdout } = runCli('plan dispatch');
      expect(stdout).toContain('Dispatched');
      expect(stdout).toContain('DSP-A');
    });

    it('should append REQUEST message to chat file', () => {
      runCli('plan add backend "Task A" --id DSP-B');
      runCli('plan dispatch');
      const chatContent = readFileSync(join(hivePath, 'chat.md'), 'utf-8');
      expect(chatContent).toContain('[USER] REQUEST');
      expect(chatContent).toContain('@BACKEND');
      expect(chatContent).toContain('[DSP-B]');
    });

    it('should mark task as dispatched in plan', () => {
      runCli('plan add backend "Task A" --id DSP-C');
      runCli('plan dispatch');
      const planJson = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      const task = planJson.tasks.find((t: { id: string }) => t.id === 'DSP-C');
      expect(task.status).toBe('dispatched');
      expect(task.dispatched_at).toBeTruthy();
    });

    it('should support --dry-run', () => {
      runCli('plan add backend "Task A" --id DRY-A');
      const { stdout } = runCli('plan dispatch --dry-run');
      expect(stdout).toContain('Would dispatch');
      expect(stdout).toContain('DRY-A');
      // Task should NOT be dispatched
      const planJson = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      const task = planJson.tasks.find((t: { id: string }) => t.id === 'DRY-A');
      expect(task.status).toBe('ready');
    });

    it('should dispatch specific task by --id', () => {
      runCli('plan add backend "Task A" --id SP-A');
      runCli('plan add frontend "Task B" --id SP-B');
      const { stdout } = runCli('plan dispatch --id SP-B');
      expect(stdout).toContain('SP-B');
      // Only SP-B should be dispatched
      const planJson = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      expect(planJson.tasks.find((t: { id: string }) => t.id === 'SP-A').status).toBe('ready');
      expect(planJson.tasks.find((t: { id: string }) => t.id === 'SP-B').status).toBe('dispatched');
    });

    it('should dispatch by --agent', () => {
      runCli('plan add backend "Task A" --id AG-A');
      runCli('plan add frontend "Task B" --id AG-B');
      const { stdout } = runCli('plan dispatch --agent frontend');
      expect(stdout).toContain('AG-B');
    });

    it('should dispatch all with --all', () => {
      runCli('plan add backend "Task A" --id ALL-A');
      runCli('plan add frontend "Task B" --id ALL-B');
      const { stdout } = runCli('plan dispatch --all');
      expect(stdout).toContain('Dispatched 2');
    });

    it('should show message when no tasks to dispatch', () => {
      const { stdout } = runCli('plan dispatch');
      expect(stdout).toContain('No');
    });

    it('should not dispatch tasks with unmet deps', () => {
      runCli('plan add backend "Task A" --id NODSP-A');
      runCli('plan add frontend "Task B" --id NODSP-B --depends-on NODSP-A');
      // Dispatch A first
      runCli('plan dispatch --id NODSP-A');
      // B should not be dispatchable yet (A not done, just dispatched)
      const { stderr, code } = runCli('plan dispatch --id NODSP-B', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('not ready');
    });
  });

  // ── plan create (TTY guard) ────────────────────────────────────────

  describe('plan create', () => {
    it('should error in non-TTY', () => {
      const { stderr, code } = runCli('plan create', { expectError: true });
      expect(code).not.toBe(0);
      expect(stderr).toContain('Interactive mode requires a terminal');
    });
  });

  // ── plan import / export ───────────────────────────────────────────

  describe('plan import / export', () => {
    it('should import tasks from YAML file', () => {
      const yamlContent = yamlStringify({
        tasks: [
          { id: 'IMP-A', target: 'backend', title: 'Imported task A', priority: 'p1' },
          { id: 'IMP-B', target: 'frontend', title: 'Imported task B', priority: 'p2', depends_on: ['IMP-A'] },
        ],
      });
      const importFile = join(tmpDir, 'import.yaml');
      writeFileSync(importFile, yamlContent, 'utf-8');

      const { stdout } = runCli('plan import import.yaml');
      expect(stdout).toContain('Imported 2');

      const planJson = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      expect(planJson.tasks).toHaveLength(2);
    });

    it('should export plan to YAML file', () => {
      runCli('plan add backend "Export test" --id EXP-01');
      runCli('plan export export.yaml');

      const exportFile = join(tmpDir, 'export.yaml');
      expect(existsSync(exportFile)).toBe(true);
      const content = readFileSync(exportFile, 'utf-8');
      expect(content).toContain('EXP-01');
      expect(content).toContain('Export test');
    });

    it('should skip duplicate IDs on import', () => {
      runCli('plan add backend "Existing" --id DUP-IMP');
      const yamlContent = yamlStringify({
        tasks: [
          { id: 'DUP-IMP', target: 'backend', title: 'Duplicate', priority: 'p2' },
          { id: 'NEW-IMP', target: 'frontend', title: 'New task', priority: 'p2' },
        ],
      });
      const importFile = join(tmpDir, 'import2.yaml');
      writeFileSync(importFile, yamlContent, 'utf-8');

      const { stdout } = runCli('plan import import2.yaml');
      expect(stdout).toContain('1 skipped');
    });
  });

  // ── plan ready ─────────────────────────────────────────────────────

  describe('plan ready', () => {
    it('should show ready tasks', () => {
      runCli('plan add backend "Ready task" --id RDY-01');
      const { stdout } = runCli('plan ready');
      expect(stdout).toContain('RDY-01');
      expect(stdout).toContain('Ready task');
    });

    it('should filter by agent', () => {
      runCli('plan add backend "BE task" --id RDY-BE');
      runCli('plan add frontend "FE task" --id RDY-FE');
      const { stdout } = runCli('plan ready backend');
      expect(stdout).toContain('RDY-BE');
      expect(stdout).not.toContain('RDY-FE');
    });

    it('should list ready tasks with status indicators', () => {
      runCli('plan add backend "JSON ready" --id RDY-JSON');
      const { stdout } = runCli('plan ready');
      expect(stdout).toContain('RDY-JSON');
      // Verify via plan.json that the task is ready
      const plan = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      expect(plan.tasks.find((t: { id: string }) => t.id === 'RDY-JSON').status).toBe('ready');
    });
  });

  // ── plan update ────────────────────────────────────────────────────

  describe('plan update', () => {
    it('should update task status', () => {
      runCli('plan add backend "Update me" --id UPD-01');
      const { stdout } = runCli('plan update UPD-01 --status running');
      expect(stdout).toContain('Updated');
      expect(stdout).toContain('running');
    });

    it('should update task priority', () => {
      runCli('plan add backend "Reprioritize" --id UPD-02');
      const { stdout } = runCli('plan update UPD-02 --priority p0');
      expect(stdout).toContain('p0');
    });

    it('should update task title', () => {
      runCli('plan add backend "Old title" --id UPD-03');
      runCli('plan update UPD-03 --title "New title"');
      const { stdout: jsonOut } = runCli('plan --json');
      const plan = JSON.parse(jsonOut);
      expect(plan.tasks.find((t: { id: string }) => t.id === 'UPD-03').title).toBe('New title');
    });
  });

  // ── plan remove ────────────────────────────────────────────────────

  describe('plan remove', () => {
    it('should remove a task', () => {
      runCli('plan add backend "Remove me" --id REM-01');
      const { stdout } = runCli('plan remove REM-01 --force');
      expect(stdout).toContain('Removed');
      const plan = JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
      expect(plan.tasks.find((t: { id: string }) => t.id === 'REM-01')).toBeUndefined();
    });
  });

  // ── plan reset ─────────────────────────────────────────────────────

  describe('plan reset', () => {
    it('should reset a failed task', () => {
      runCli('plan add backend "Reset me" --id RST-01');
      runCli('plan update RST-01 --status failed');
      const { stdout } = runCli('plan reset RST-01');
      expect(stdout).toContain('Reset');
      const { stdout: jsonOut } = runCli('plan --json');
      const plan = JSON.parse(jsonOut);
      expect(plan.tasks.find((t: { id: string }) => t.id === 'RST-01').status).toBe('ready');
    });
  });

  // ── plan stats ─────────────────────────────────────────────────────

  describe('plan stats', () => {
    it('should show plan statistics', () => {
      runCli('plan add backend "Task A" --id ST-A');
      runCli('plan add frontend "Task B" --id ST-B');
      const { stdout } = runCli('plan stats');
      expect(stdout).toContain('2 tasks');
      expect(stdout).toContain('Status breakdown');
    });

    it('should show per-agent workload', () => {
      runCli('plan add backend "Task A" --id STJ-A');
      runCli('plan add backend "Task B" --id STJ-B');
      const { stdout } = runCli('plan stats');
      expect(stdout).toContain('2 tasks');
      expect(stdout).toContain('backend');
    });
  });

  // ── plan graph ─────────────────────────────────────────────────────

  describe('plan graph', () => {
    it('should show dependency graph', () => {
      runCli('plan add backend "Task A" --id GR-A');
      runCli('plan add frontend "Task B" --id GR-B --depends-on GR-A');
      const { stdout } = runCli('plan graph');
      expect(stdout).toContain('GR-A');
      expect(stdout).toContain('GR-B');
      expect(stdout).toContain('Legend');
    });
  });

  // ── plan tree ──────────────────────────────────────────────────────

  describe('plan tree', () => {
    it('should show tree view', () => {
      runCli('plan add backend "Task A" --id TR-A');
      runCli('plan add frontend "Task B" --id TR-B');
      const { stdout } = runCli('plan tree');
      expect(stdout).toContain('TR-A');
      expect(stdout).toContain('TR-B');
    });
  });

  // ── end-to-end workflow ────────────────────────────────────────────

  // Helper to read plan state from disk
  function readPlan(): { tasks: Array<{ id: string; status: string; title: string; target: string; priority: string; depends_on: string[] }> } {
    return JSON.parse(readFileSync(join(hivePath, 'plan.json'), 'utf-8'));
  }

  describe('end-to-end workflow', () => {
    it('should support full plan lifecycle: add → dispatch → done → cascade', () => {
      // Step 1: Add tasks with dependencies
      runCli('plan add backend "Build API" --id E2E-BE --priority p1');
      runCli('plan add frontend "Build UI" --id E2E-FE --priority p1 --depends-on E2E-BE');
      runCli('plan add qa "Write tests" --id E2E-QA --priority p2 --depends-on E2E-BE,E2E-FE');

      // Step 2: Verify only BE is ready (read state from disk)
      let plan = readPlan();
      const readyBefore = plan.tasks.filter((t) => t.status === 'ready');
      expect(readyBefore).toHaveLength(1);
      expect(readyBefore[0].id).toBe('E2E-BE');

      // Step 3: Dispatch
      const { stdout: dispatchOut } = runCli('plan dispatch --id E2E-BE');
      expect(dispatchOut).toContain('Dispatched');

      // Step 4: Complete BE task
      runCli('plan update E2E-BE --status done');

      // Step 5: FE should now be ready (deps met), QA still open
      plan = readPlan();
      const readyAfterBE = plan.tasks.filter((t) => t.status === 'ready');
      expect(readyAfterBE).toHaveLength(1);
      expect(readyAfterBE[0].id).toBe('E2E-FE');
      expect(plan.tasks.find((t) => t.id === 'E2E-QA')!.status).toBe('open');

      // Step 6: Complete FE → QA becomes ready
      runCli('plan update E2E-FE --status done');
      plan = readPlan();
      const readyAfterFE = plan.tasks.filter((t) => t.status === 'ready');
      expect(readyAfterFE).toHaveLength(1);
      expect(readyAfterFE[0].id).toBe('E2E-QA');

      // Step 7: Complete QA → all done
      runCli('plan update E2E-QA --status done');
      const { stdout: board } = runCli('plan');
      expect(board).toContain('All tasks complete');
    });

    it('should handle failure cascading', () => {
      runCli('plan add backend "Build API" --id FAIL-BE');
      runCli('plan add frontend "Build UI" --id FAIL-FE --depends-on FAIL-BE');

      // Fail the BE task
      runCli('plan update FAIL-BE --status failed');

      // FE should be blocked (read state from disk)
      let plan = readPlan();
      const feTask = plan.tasks.find((t) => t.id === 'FAIL-FE');
      expect(feTask!.status).toBe('blocked');

      // Board should show failed guidance
      const { stdout: board } = runCli('plan');
      expect(board).toContain('failed');
      expect(board).toContain('hive plan reset');

      // Reset and retry
      runCli('plan reset FAIL-BE');
      plan = readPlan();
      const beTask = plan.tasks.find((t) => t.id === 'FAIL-BE');
      expect(beTask!.status).toBe('ready');
    });
  });
});
