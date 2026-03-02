import { Command } from 'commander';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { stringify as stringifyYaml } from 'yaml';
import {
  loadConfig,
  resolveHiveRoot,
  resolveHivePath,
  resolveAllAgents,
} from '../core/config.js';
import {
  loadPlan,
  savePlan,
  createPlan,
  generateId,
  computeReadyTasks,
  computeBlockedTasks,
  getTasksByAgent,
  getDependencyChain,
  validateDAG,
  promoteReadyTasks,
  sortByPriority,
  findCriticalPath,
  getChildTasks,
  computeParentStatus,
  reconcilePlanWithChat,
  PRIORITY_ORDER,
} from '../core/plan.js';
import { appendMessage, resolveChatPath } from '../core/chat.js';
import type { Plan, PlanTask, Priority, TaskStatus } from '../types/plan.js';

// ── Status icons and colors ──────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  open: '○',
  ready: '◎',
  dispatched: '→',
  running: '●',
  done: '✓',
  failed: '✗',
  blocked: '◉',
};

const STATUS_COLOR: Record<string, (s: string) => string> = {
  open: chalk.white,
  ready: chalk.cyan,
  dispatched: chalk.blue,
  running: chalk.yellow,
  done: chalk.green,
  failed: chalk.red,
  blocked: chalk.yellow,
};

const PRIORITY_COLOR: Record<string, (s: string) => string> = {
  p0: chalk.bold.red,
  p1: chalk.yellow,
  p2: chalk.white,
  p3: chalk.gray,
};

// ── Command registration ─────────────────────────────────────────────

export function registerPlanCommand(program: Command): void {
  const plan = program
    .command('plan')
    .description('Plan-driven task tracking and dispatch');

  // Default action: board view
  plan
    .option('--json', 'Output plan as JSON')
    .option('--compact', 'Compact one-line-per-task view')
    .option('--filter <filter>', 'Filter by agent, status, or label')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runBoard(cwd, opts);
    });

  // plan add
  plan
    .command('add <target> <title>')
    .description('Add a task to the plan')
    .option('--id <id>', 'Custom task ID')
    .option('--priority <p>', 'Priority: p0, p1, p2, p3', 'p2')
    .option('--depends-on <ids>', 'Comma-separated dependency IDs')
    .option('--parent <id>', 'Parent task ID')
    .option('--labels <labels>', 'Comma-separated labels')
    .option('--description <text>', 'Task description')
    .action(async (target: string, title: string, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runAdd(cwd, target, title, opts);
    });

  // plan ready
  plan
    .command('ready [agent]')
    .description('Show tasks ready to be worked on')
    .option('--json', 'Output as JSON')
    .action(async (agent: string | undefined, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runReady(cwd, agent, opts);
    });

  // plan dispatch
  plan
    .command('dispatch')
    .description('Dispatch ready tasks to agents')
    .option('--agent <name>', 'Dispatch only to this agent')
    .option('--id <id>', 'Dispatch a specific task by ID')
    .option('--all', 'Dispatch all ready tasks (multiple per agent)')
    .option('--dry-run', 'Show what would be dispatched')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runDispatch(cwd, opts);
    });

  // plan import
  plan
    .command('import <file>')
    .description('Import tasks from a YAML or Markdown file')
    .action(async (file: string, _opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runImport(cwd, file);
    });

  // plan export
  plan
    .command('export <file>')
    .description('Export the plan to a YAML file')
    .action(async (file: string) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runExport(cwd, file);
    });

  // plan graph
  plan
    .command('graph')
    .description('Visualize the dependency graph')
    .option('--focus <id>', 'Focus on subgraph containing a task')
    .option('--critical-path', 'Highlight the critical path')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runGraph(cwd, opts);
    });

  // plan update
  plan
    .command('update <id>')
    .description('Update a task')
    .option('--status <status>', 'New status')
    .option('--priority <p>', 'New priority')
    .option('--target <agent>', 'New target agent')
    .option('--depends-on <ids>', 'Replace dependencies (comma-separated)')
    .option('--add-dep <id>', 'Add a dependency')
    .option('--remove-dep <id>', 'Remove a dependency')
    .option('--title <title>', 'New title')
    .option('--description <text>', 'New description')
    .option('--labels <labels>', 'Replace labels (comma-separated)')
    .action(async (id: string, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runUpdate(cwd, id, opts);
    });

  // plan remove
  plan
    .command('remove <id>')
    .description('Remove a task from the plan')
    .option('--force', 'Force removal even if depended on or in-progress')
    .action(async (id: string, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runRemove(cwd, id, opts);
    });

  // plan reset
  plan
    .command('reset <id>')
    .description('Reset a task to open status')
    .action(async (id: string) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runReset(cwd, id);
    });

  // plan tree
  plan
    .command('tree')
    .description('Show hierarchical tree view')
    .action(async () => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runTree(cwd);
    });

  // plan stats
  plan
    .command('stats')
    .description('Show plan analytics and critical path')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runStats(cwd, opts);
    });
}

// ── Helpers ──────────────────────────────────────────────────────────

function loadContext(cwd: string) {
  try {
    const hiveRoot = resolveHiveRoot(cwd);
    const hivePath = resolveHivePath(cwd);
    const config = loadConfig(cwd);
    return { hiveRoot, hivePath, config };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}

function loadOrCreatePlan(hivePath: string, name: string): Plan {
  const plan = loadPlan(hivePath);
  if (plan) {
    promoteReadyTasks(plan);
    return plan;
  }
  return createPlan(name);
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function taskLine(task: PlanTask, compact = false): string {
  const icon = STATUS_ICON[task.status] ?? '?';
  const color = STATUS_COLOR[task.status] ?? chalk.white;
  const priColor = PRIORITY_COLOR[task.priority] ?? chalk.white;
  const id = pad(task.id, 10);

  if (compact) {
    return `${color(icon)} ${id} ${priColor(pad(task.priority, 4))} ${pad(task.target, 10)} ${task.title}`;
  }

  return `${color(icon)} ${id} ${priColor(task.priority)}\n    ${chalk.gray(task.target)}`;
}

// ── Board view (US-002) ──────────────────────────────────────────────

async function runBoard(
  cwd: string,
  opts: { json?: boolean; compact?: boolean; filter?: string },
): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  if (plan.tasks.length === 0) {
    console.log(chalk.gray('\nNo plan found. Run `hive plan add` to create tasks.\n'));
    return;
  }

  // JSON output
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // Apply filter
  let tasks = plan.tasks;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        t.target.toLowerCase() === f ||
        t.status === f ||
        (t.labels ?? []).some((l) => l.toLowerCase() === f),
    );
  }

  // Compact view
  if (opts.compact) {
    console.log(chalk.bold(`\n🐝 AgentHive — Plan: ${plan.name} (${tasks.length} tasks)\n`));
    for (const task of sortByPriority(tasks)) {
      console.log(taskLine(task, true));
    }
    const ready = computeReadyTasks(plan);
    if (ready.length > 0) {
      console.log(`\n${chalk.cyan(`Ready: ${ready.length} tasks. Run \`hive plan dispatch\` to send them.`)}\n`);
    }
    return;
  }

  // Kanban board view
  const columns: TaskStatus[] = ['open', 'ready', 'dispatched', 'running', 'done', 'failed', 'blocked'];
  const grouped: Record<string, PlanTask[]> = {};
  for (const col of columns) {
    grouped[col] = sortByPriority(tasks.filter((t) => t.status === col));
  }

  // Remove empty trailing columns
  const activeColumns = columns.filter((c) => grouped[c].length > 0);

  console.log(chalk.bold(`\n🐝 AgentHive — Plan: ${plan.name} (${tasks.length} tasks)\n`));

  // Column headers
  const COL_WIDTH = 18;
  const headers = activeColumns
    .map((c) => {
      const label = `${c.toUpperCase()} (${grouped[c].length})`;
      return pad(label, COL_WIDTH);
    })
    .join('');
  console.log(chalk.gray(headers));
  console.log(
    chalk.gray(activeColumns.map(() => '─'.repeat(COL_WIDTH - 2) + '  ').join('')),
  );

  // Find max column height
  const maxHeight = Math.max(...activeColumns.map((c) => grouped[c].length));

  for (let row = 0; row < maxHeight; row++) {
    const line = activeColumns
      .map((col) => {
        const task = grouped[col][row];
        if (!task) return pad('', COL_WIDTH);

        const icon = STATUS_ICON[task.status] ?? '?';
        const color = STATUS_COLOR[task.status] ?? chalk.white;
        const priColor = PRIORITY_COLOR[task.priority] ?? chalk.white;
        const cell = `${icon} ${task.id} ${task.priority}`;
        return pad('', 0) + color(icon) + ' ' + task.id + ' ' + priColor(task.priority) + ' '.repeat(Math.max(0, COL_WIDTH - cell.length - 1));
      })
      .join('');
    console.log(line);

    // Target line
    const targetLine = activeColumns
      .map((col) => {
        const task = grouped[col][row];
        if (!task) return pad('', COL_WIDTH);
        return '  ' + chalk.gray(pad(task.target, COL_WIDTH - 2));
      })
      .join('');
    console.log(targetLine);
  }

  // Summary
  const ready = computeReadyTasks(plan);
  if (ready.length > 0) {
    console.log(
      `\n${chalk.cyan(`Ready: ${ready.length} tasks can be dispatched now. Run \`hive plan dispatch\` to send them.`)}`,
    );
  }
  console.log('');
}

// ── Add task (US-003) ────────────────────────────────────────────────

async function runAdd(
  cwd: string,
  target: string,
  title: string,
  opts: {
    id?: string;
    priority?: string;
    dependsOn?: string;
    parent?: string;
    labels?: string;
    description?: string;
  },
): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  // Validate priority
  const priority = (opts.priority ?? 'p2') as Priority;
  if (!['p0', 'p1', 'p2', 'p3'].includes(priority)) {
    console.error(chalk.red(`Invalid priority: "${opts.priority}". Must be p0, p1, p2, or p3.`));
    process.exit(1);
  }

  // Validate target against config agents
  const allAgents = resolveAllAgents(config, resolveHiveRoot(cwd));
  const validTarget = allAgents.find(
    (a) =>
      a.name.toLowerCase() === target.toLowerCase() ||
      a.chatRole.toLowerCase() === target.toLowerCase(),
  );
  if (!validTarget) {
    const available = allAgents.map((a) => a.name).join(', ');
    console.error(
      chalk.red(`Unknown target: "${target}". Available agents: ${available}`),
    );
    process.exit(1);
  }

  // Resolve target to agent name
  const resolvedTarget = validTarget.name;

  // Generate or validate ID
  const taskId = opts.id ?? generateId(title, resolvedTarget);
  if (plan.tasks.some((t) => t.id === taskId)) {
    console.error(chalk.red(`Task ID "${taskId}" already exists in the plan.`));
    process.exit(1);
  }

  // Parse dependencies
  const dependsOn = opts.dependsOn
    ? opts.dependsOn.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // Validate dependencies exist
  for (const depId of dependsOn) {
    if (!plan.tasks.some((t) => t.id === depId)) {
      console.error(chalk.red(`Dependency "${depId}" not found in the plan.`));
      process.exit(1);
    }
  }

  // Validate parent exists
  if (opts.parent && !plan.tasks.some((t) => t.id === opts.parent)) {
    console.error(chalk.red(`Parent "${opts.parent}" not found in the plan.`));
    process.exit(1);
  }

  // Parse labels
  const labels = opts.labels
    ? opts.labels.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const now = new Date().toISOString();
  const newTask: PlanTask = {
    id: taskId,
    title,
    target: resolvedTarget,
    priority,
    status: 'open',
    depends_on: dependsOn,
    created_at: now,
    updated_at: now,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(labels ? { labels } : {}),
  };

  plan.tasks.push(newTask);

  // Validate DAG
  const dag = validateDAG(plan);
  if (!dag.valid) {
    plan.tasks.pop(); // remove the task we just added
    console.error(chalk.red('Adding this task would create a dependency cycle.'));
    if (dag.cycles) {
      for (const cycle of dag.cycles) {
        console.error(chalk.red(`  Cycle: ${cycle.join(' → ')}`));
      }
    }
    process.exit(1);
  }

  // Promote ready tasks
  promoteReadyTasks(plan);
  // Re-fetch the task after promotion
  const savedTask = plan.tasks.find((t) => t.id === taskId)!;

  savePlan(hivePath, plan);

  // Print result
  console.log(chalk.green('✓ ') + `Added: ${taskId} (${resolvedTarget}, ${priority})`);
  console.log(`  "${title}"`);

  if (dependsOn.length > 0) {
    const depStatuses = dependsOn.map((id) => {
      const dep = plan.tasks.find((t) => t.id === id);
      return dep ? `${id} (${dep.status}) ${dep.status === 'done' ? '✓' : ''}` : id;
    });
    console.log(`  Blocked by: ${depStatuses.join(', ')}`);
  }

  console.log(
    `  Status: ${savedTask.status}${savedTask.status === 'ready' ? ' (all dependencies met)' : ''}`,
  );
}

// ── Ready queue (US-004) ─────────────────────────────────────────────

async function runReady(
  cwd: string,
  agent: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  if (plan.tasks.length === 0) {
    console.log(chalk.gray('\nNo plan found.\n'));
    return;
  }

  let ready = computeReadyTasks(plan);

  if (agent) {
    const lower = agent.toLowerCase();
    ready = ready.filter((t) => t.target.toLowerCase() === lower);
  }

  if (opts.json) {
    console.log(JSON.stringify(ready, null, 2));
    return;
  }

  if (ready.length === 0) {
    console.log(chalk.gray(`\nNo ready tasks${agent ? ` for ${agent}` : ''}.\n`));
    return;
  }

  console.log(chalk.bold(`\n🐝 Ready tasks (${ready.length}):\n`));

  for (const task of ready) {
    const icon = STATUS_ICON[task.status];
    const color = STATUS_COLOR[task.status] ?? chalk.white;
    const priColor = PRIORITY_COLOR[task.priority] ?? chalk.white;

    console.log(
      `${color(icon)} ${pad(task.id, 10)} ${priColor(pad(task.priority, 4))} ${pad(task.target, 10)} ${task.title}`,
    );
    if (task.depends_on.length > 0) {
      const deps = task.depends_on.map((id) => {
        const dep = plan.tasks.find((t) => t.id === id);
        return dep?.status === 'done' ? `${id} ✓` : id;
      });
      console.log(chalk.gray(`    Deps: ${deps.join(', ')}`));
    }
  }
  console.log('');
}

// ── Dispatch (US-008) ────────────────────────────────────────────────

async function runDispatch(
  cwd: string,
  opts: {
    agent?: string;
    id?: string;
    all?: boolean;
    dryRun?: boolean;
  },
): Promise<void> {
  const { hivePath, config, hiveRoot } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  if (plan.tasks.length === 0) {
    console.log(chalk.gray('\nNo plan found.\n'));
    return;
  }

  const allAgents = resolveAllAgents(config, hiveRoot);
  const chatFilePath = resolveChatPath(hivePath, config.chat.file);
  const ready = computeReadyTasks(plan);

  let toDispatch: PlanTask[] = [];

  if (opts.id) {
    // Dispatch specific task
    const task = ready.find((t) => t.id === opts.id);
    if (!task) {
      const exists = plan.tasks.find((t) => t.id === opts.id);
      if (exists) {
        console.error(chalk.red(`Task "${opts.id}" exists but is not ready (status: ${exists.status}).`));
      } else {
        console.error(chalk.red(`Task "${opts.id}" not found.`));
      }
      process.exit(1);
    }
    toDispatch = [task];
  } else if (opts.agent) {
    // Dispatch to specific agent
    const lower = opts.agent.toLowerCase();
    const agentReady = ready.filter((t) => t.target.toLowerCase() === lower);
    if (agentReady.length === 0) {
      console.log(chalk.gray(`\nNo ready tasks for ${opts.agent}.\n`));
      return;
    }
    toDispatch = [agentReady[0]]; // highest priority
  } else if (opts.all) {
    toDispatch = ready;
  } else {
    // One per agent (highest priority)
    const seen = new Set<string>();
    for (const task of ready) {
      if (!seen.has(task.target)) {
        seen.add(task.target);
        toDispatch.push(task);
      }
    }
  }

  if (toDispatch.length === 0) {
    console.log(chalk.gray('\nNo tasks to dispatch.\n'));
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.bold(`\n🐝 Would dispatch ${toDispatch.length} task(s):\n`));
    for (const task of toDispatch) {
      console.log(`  → ${pad(task.id, 10)} ${pad(task.priority, 4)} ${pad(task.target, 10)} ${task.title}`);
    }
    console.log('');
    return;
  }

  // Actually dispatch
  const now = new Date().toISOString();
  for (const task of toDispatch) {
    task.status = 'dispatched';
    task.dispatched_at = now;
    task.updated_at = now;

    // Resolve the agent's chat role
    const agent = allAgents.find((a) => a.name === task.target);
    const role = agent?.chatRole ?? task.target.toUpperCase();

    // Build the message body
    const descLine = task.description
      ? `. ${task.description.split('\n')[0]}`
      : '';
    const body = `@${role}: [${task.id}] ${task.title}${descLine}`;
    appendMessage(chatFilePath, 'USER', 'REQUEST', body);
  }

  savePlan(hivePath, plan);

  console.log(chalk.bold(`\n🐝 Dispatched ${toDispatch.length} task(s):\n`));
  for (const task of toDispatch) {
    console.log(`  → ${pad(task.id, 10)} ${pad(task.priority, 4)} ${pad(task.target, 10)} ${task.title}`);
  }

  const remaining = plan.tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'dispatched' && t.status !== 'running',
  );
  const stillWaiting = remaining.filter(
    (t) => t.status === 'open' || t.status === 'blocked',
  );
  if (stillWaiting.length > 0) {
    console.log(`\n${chalk.gray(`${stillWaiting.length} task(s) still waiting on dependencies.`)}`);
  }
  console.log('');
}

// ── Import (US-006) ──────────────────────────────────────────────────

async function runImport(cwd: string, file: string): Promise<void> {
  const { hivePath, config, hiveRoot } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);
  const allAgents = resolveAllAgents(config, hiveRoot);

  const filePath = resolve(cwd, file);
  if (!existsSync(filePath)) {
    console.error(chalk.red(`File not found: ${filePath}`));
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  let importedTasks: Partial<PlanTask>[];

  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    importedTasks = parseYamlImport(content);
  } else if (file.endsWith('.md') || file.endsWith('.markdown')) {
    importedTasks = parseMarkdownImport(content);
  } else {
    // Try YAML first, then markdown
    try {
      importedTasks = parseYamlImport(content);
    } catch {
      importedTasks = parseMarkdownImport(content);
    }
  }

  const now = new Date().toISOString();
  let added = 0;
  let skipped = 0;
  const warnings: string[] = [];

  for (const imported of importedTasks) {
    if (!imported.target || !imported.title) {
      warnings.push(`Skipped task with missing target or title`);
      continue;
    }

    const taskId = imported.id ?? generateId(imported.title, imported.target);

    // Skip if already exists
    if (plan.tasks.some((t) => t.id === taskId)) {
      warnings.push(`Skipped "${taskId}" — already exists`);
      skipped++;
      continue;
    }

    // Validate target
    const validTarget = allAgents.find(
      (a) =>
        a.name.toLowerCase() === imported.target!.toLowerCase() ||
        a.chatRole.toLowerCase() === imported.target!.toLowerCase(),
    );
    if (!validTarget) {
      warnings.push(`Skipped "${taskId}" — unknown target "${imported.target}"`);
      skipped++;
      continue;
    }

    const task: PlanTask = {
      id: taskId,
      title: imported.title,
      target: validTarget.name,
      priority: (imported.priority as Priority) ?? 'p2',
      status: 'open',
      depends_on: imported.depends_on ?? [],
      created_at: now,
      updated_at: now,
      ...(imported.description ? { description: imported.description } : {}),
      ...(imported.parent ? { parent: imported.parent } : {}),
      ...(imported.labels ? { labels: imported.labels } : {}),
    };

    plan.tasks.push(task);
    added++;
  }

  // Validate dependencies
  const taskIds = new Set(plan.tasks.map((t) => t.id));
  for (const task of plan.tasks) {
    task.depends_on = task.depends_on.filter((dep) => {
      if (!taskIds.has(dep)) {
        warnings.push(`${task.id}: removed unknown dependency "${dep}"`);
        return false;
      }
      return true;
    });
  }

  // Validate DAG
  const dag = validateDAG(plan);
  if (!dag.valid) {
    console.error(chalk.red('Import would create dependency cycles:'));
    for (const cycle of dag.cycles ?? []) {
      console.error(chalk.red(`  Cycle: ${cycle.join(' → ')}`));
    }
    process.exit(1);
  }

  promoteReadyTasks(plan);
  savePlan(hivePath, plan);

  const ready = computeReadyTasks(plan).length;
  const pending = plan.tasks.filter((t) => t.status === 'open').length;

  console.log(chalk.green(`✓ Imported ${added} tasks (${ready} ready, ${pending} pending).`));
  if (skipped > 0) {
    console.log(chalk.yellow(`  ${skipped} skipped.`));
  }
  for (const w of warnings) {
    console.log(chalk.yellow(`  ${w}`));
  }
  console.log(chalk.gray(`Run \`hive plan\` to see the board.`));
}

function parseYamlImport(content: string): Partial<PlanTask>[] {
  const parsed = parseYaml(content) as { tasks?: Record<string, unknown>[] };
  if (!parsed?.tasks || !Array.isArray(parsed.tasks)) {
    throw new Error('YAML must contain a "tasks" array.');
  }

  return parsed.tasks.map((t: Record<string, unknown>) => ({
    id: t.id as string | undefined,
    title: t.title as string,
    target: t.target as string,
    priority: t.priority as Priority | undefined,
    depends_on: Array.isArray(t.depends_on) ? (t.depends_on as string[]) : undefined,
    description: t.description as string | undefined,
    parent: t.parent as string | undefined,
    labels: Array.isArray(t.labels) ? (t.labels as string[]) : undefined,
  }));
}

function parseMarkdownImport(content: string): Partial<PlanTask>[] {
  const tasks: Partial<PlanTask>[] = [];
  // ## ID: title (priority) @target [depends: IDs]
  const regex = /^##\s+([A-Za-z0-9_-]+):\s+(.+?)(?:\s+\((p[0-3])\))?(?:\s+@(\S+))?(?:\s+\[depends:\s*([^\]]+)\])?$/gm;

  let match;
  while ((match = regex.exec(content)) !== null) {
    tasks.push({
      id: match[1],
      title: match[2].trim(),
      priority: (match[3] as Priority) ?? 'p2',
      target: match[4],
      depends_on: match[5]
        ? match[5].split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    });
  }

  return tasks;
}

// ── Export (US-006) ──────────────────────────────────────────────────

async function runExport(cwd: string, file: string): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadPlan(hivePath);

  if (!plan || plan.tasks.length === 0) {
    console.log(chalk.gray('\nNo plan to export.\n'));
    return;
  }

  const exportData = {
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      target: t.target,
      title: t.title,
      priority: t.priority,
      status: t.status,
      ...(t.depends_on.length > 0 ? { depends_on: t.depends_on } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(t.parent ? { parent: t.parent } : {}),
      ...(t.labels?.length ? { labels: t.labels } : {}),
    })),
  };

  const filePath = resolve(cwd, file);
  const yamlContent = stringifyYaml(exportData, { lineWidth: 120 });
  const { writeFileSync: wfs } = await import('node:fs');
  wfs(filePath, yamlContent, 'utf-8');

  console.log(chalk.green(`✓ Exported ${plan.tasks.length} tasks to ${file}`));
}

// ── Graph (US-007) ──────────────────────────────────────────────────

async function runGraph(
  cwd: string,
  opts: { focus?: string; criticalPath?: boolean },
): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  if (plan.tasks.length === 0) {
    console.log(chalk.gray('\nNo plan found.\n'));
    return;
  }

  let tasks = plan.tasks;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Focus mode: show only ancestors + descendants of the focused task
  if (opts.focus) {
    const focusTask = taskMap.get(opts.focus);
    if (!focusTask) {
      console.error(chalk.red(`Task "${opts.focus}" not found.`));
      process.exit(1);
    }

    const subgraph = new Set<string>();

    // Add ancestors
    function addAncestors(id: string): void {
      if (subgraph.has(id)) return;
      subgraph.add(id);
      const t = taskMap.get(id);
      if (t) {
        for (const dep of t.depends_on) addAncestors(dep);
      }
    }

    // Add descendants
    function addDescendants(id: string): void {
      if (subgraph.has(id)) return;
      subgraph.add(id);
      for (const t of tasks) {
        if (t.depends_on.includes(id)) addDescendants(t.id);
      }
    }

    addAncestors(opts.focus);
    addDescendants(opts.focus);
    tasks = tasks.filter((t) => subgraph.has(t.id));
  }

  // Critical path highlighting
  const criticalIds = new Set<string>();
  if (opts.criticalPath) {
    const cp = findCriticalPath(plan);
    for (const t of cp) criticalIds.add(t.id);
  }

  console.log(chalk.bold('\n🐝 AgentHive — Dependency Graph\n'));

  // Build adjacency: task → dependents
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(t.id);
    }
  }

  // Find root tasks (no deps in scope)
  const scopeIds = new Set(tasks.map((t) => t.id));
  const roots = tasks.filter(
    (t) => t.depends_on.every((d) => !scopeIds.has(d)),
  );

  // Standalone tasks (no deps, no dependents)
  const standalone = roots.filter(
    (t) => !(dependents.get(t.id)?.some((d) => scopeIds.has(d))),
  );
  const chainRoots = roots.filter((t) => !standalone.includes(t));

  // Render chains
  const rendered = new Set<string>();

  function renderNode(id: string): string {
    const t = taskMap.get(id);
    if (!t) return id;
    const icon = STATUS_ICON[t.status] ?? '?';
    const color = STATUS_COLOR[t.status] ?? chalk.white;
    const isCritical = criticalIds.has(id);
    const label = `${id} ${icon}`;
    return isCritical ? chalk.bold.red(label) : color(label);
  }

  function renderChain(rootId: string, indent: string): void {
    if (rendered.has(rootId)) return;
    rendered.add(rootId);

    const deps = (dependents.get(rootId) ?? []).filter((d) => scopeIds.has(d));

    if (deps.length === 0) {
      process.stdout.write(renderNode(rootId) + '\n');
      return;
    }

    if (deps.length === 1) {
      process.stdout.write(renderNode(rootId) + chalk.gray(' ──→ '));
      renderChain(deps[0], indent + '         ');
    } else {
      process.stdout.write(renderNode(rootId) + chalk.gray(' ──┬──→ '));
      renderChain(deps[0], indent + '         ');
      for (let i = 1; i < deps.length; i++) {
        const connector = i === deps.length - 1 ? '└' : '├';
        process.stdout.write(indent + chalk.gray(`   ${connector}──→ `));
        renderChain(deps[i], indent + '         ');
      }
    }
  }

  // Sort chain roots by priority
  const sortedRoots = sortByPriority(chainRoots);
  for (const root of sortedRoots) {
    renderChain(root.id, '');
    console.log('');
  }

  // Standalone tasks
  if (standalone.length > 0) {
    for (const t of standalone) {
      if (rendered.has(t.id)) continue;
      console.log(`${renderNode(t.id)}    ${chalk.gray('(no dependents)')}`);
    }
    console.log('');
  }

  // Legend
  console.log(
    chalk.gray(
      `Legend: ○ open  ◎ ready  → dispatched  ● running  ✓ done  ✗ failed  ◉ blocked`,
    ),
  );
  console.log('');
}

// ── Update (US-009) ──────────────────────────────────────────────────

async function runUpdate(
  cwd: string,
  id: string,
  opts: {
    status?: string;
    priority?: string;
    target?: string;
    dependsOn?: string;
    addDep?: string;
    removeDep?: string;
    title?: string;
    description?: string;
    labels?: string;
  },
): Promise<void> {
  const { hivePath, config, hiveRoot } = loadContext(cwd);
  const plan = loadPlan(hivePath);

  if (!plan) {
    console.error(chalk.red('No plan found.'));
    process.exit(1);
  }

  const task = plan.tasks.find((t) => t.id === id);
  if (!task) {
    console.error(chalk.red(`Task "${id}" not found.`));
    process.exit(1);
  }

  const now = new Date().toISOString();
  const changes: string[] = [];

  if (opts.status) {
    const valid: TaskStatus[] = ['open', 'ready', 'dispatched', 'running', 'done', 'failed', 'blocked'];
    if (!valid.includes(opts.status as TaskStatus)) {
      console.error(chalk.red(`Invalid status: "${opts.status}". Valid: ${valid.join(', ')}`));
      process.exit(1);
    }
    task.status = opts.status as TaskStatus;
    changes.push(`status → ${opts.status}`);
  }

  if (opts.priority) {
    if (!['p0', 'p1', 'p2', 'p3'].includes(opts.priority)) {
      console.error(chalk.red(`Invalid priority: "${opts.priority}".`));
      process.exit(1);
    }
    task.priority = opts.priority as Priority;
    changes.push(`priority → ${opts.priority}`);
  }

  if (opts.target) {
    const allAgents = resolveAllAgents(config, hiveRoot);
    const validTarget = allAgents.find(
      (a) => a.name.toLowerCase() === opts.target!.toLowerCase(),
    );
    if (!validTarget) {
      console.error(chalk.red(`Unknown target: "${opts.target}".`));
      process.exit(1);
    }
    task.target = validTarget.name;
    changes.push(`target → ${validTarget.name}`);
  }

  if (opts.dependsOn !== undefined) {
    task.depends_on = opts.dependsOn
      .split(',').map((s) => s.trim()).filter(Boolean);
    changes.push(`depends_on → [${task.depends_on.join(', ')}]`);
  }

  if (opts.addDep) {
    if (!plan.tasks.some((t) => t.id === opts.addDep)) {
      console.error(chalk.red(`Dependency "${opts.addDep}" not found.`));
      process.exit(1);
    }
    if (!task.depends_on.includes(opts.addDep)) {
      task.depends_on.push(opts.addDep);
      changes.push(`added dep: ${opts.addDep}`);
    }
  }

  if (opts.removeDep) {
    task.depends_on = task.depends_on.filter((d) => d !== opts.removeDep);
    changes.push(`removed dep: ${opts.removeDep}`);
  }

  if (opts.title) {
    task.title = opts.title;
    changes.push('title updated');
  }

  if (opts.description) {
    task.description = opts.description;
    changes.push('description updated');
  }

  if (opts.labels !== undefined) {
    task.labels = opts.labels.split(',').map((s) => s.trim()).filter(Boolean);
    changes.push(`labels → [${task.labels.join(', ')}]`);
  }

  task.updated_at = now;

  // Validate DAG
  const dag = validateDAG(plan);
  if (!dag.valid) {
    console.error(chalk.red('Update would create a dependency cycle.'));
    process.exit(1);
  }

  promoteReadyTasks(plan);
  savePlan(hivePath, plan);

  console.log(chalk.green(`✓ Updated ${id}:`));
  for (const c of changes) {
    console.log(`  ${c}`);
  }
}

// ── Remove (US-009) ──────────────────────────────────────────────────

async function runRemove(
  cwd: string,
  id: string,
  opts: { force?: boolean },
): Promise<void> {
  const { hivePath } = loadContext(cwd);
  const plan = loadPlan(hivePath);

  if (!plan) {
    console.error(chalk.red('No plan found.'));
    process.exit(1);
  }

  const taskIndex = plan.tasks.findIndex((t) => t.id === id);
  if (taskIndex === -1) {
    console.error(chalk.red(`Task "${id}" not found.`));
    process.exit(1);
  }

  const task = plan.tasks[taskIndex];

  // Check if in-progress
  if (
    (task.status === 'dispatched' || task.status === 'running') &&
    !opts.force
  ) {
    console.error(
      chalk.red(
        `Task "${id}" is ${task.status}. Use --force to remove it.`,
      ),
    );
    process.exit(1);
  }

  // Check if other tasks depend on it
  const dependents = plan.tasks.filter(
    (t) => t.depends_on.includes(id) && t.id !== id,
  );
  if (dependents.length > 0 && !opts.force) {
    console.error(
      chalk.red(
        `Task "${id}" is depended on by: ${dependents.map((t) => t.id).join(', ')}. Use --force to remove.`,
      ),
    );
    process.exit(1);
  }

  // Remove
  plan.tasks.splice(taskIndex, 1);

  // Clean dependency edges if forced
  if (opts.force) {
    for (const t of plan.tasks) {
      t.depends_on = t.depends_on.filter((d) => d !== id);
    }
  }

  savePlan(hivePath, plan);
  console.log(chalk.green(`✓ Removed ${id}: "${task.title}"`));
}

// ── Reset (US-009) ──────────────────────────────────────────────────

async function runReset(cwd: string, id: string): Promise<void> {
  const { hivePath } = loadContext(cwd);
  const plan = loadPlan(hivePath);

  if (!plan) {
    console.error(chalk.red('No plan found.'));
    process.exit(1);
  }

  const task = plan.tasks.find((t) => t.id === id);
  if (!task) {
    console.error(chalk.red(`Task "${id}" not found.`));
    process.exit(1);
  }

  task.status = 'open';
  task.dispatched_at = undefined;
  task.completed_at = undefined;
  task.resolution = undefined;
  task.updated_at = new Date().toISOString();

  promoteReadyTasks(plan);
  savePlan(hivePath, plan);

  const updated = plan.tasks.find((t) => t.id === id)!;
  console.log(chalk.green(`✓ Reset ${id} to ${updated.status}.`));
}

// ── Tree (US-010) ───────────────────────────────────────────────────

async function runTree(cwd: string): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  if (plan.tasks.length === 0) {
    console.log(chalk.gray('\nNo plan found.\n'));
    return;
  }

  console.log(chalk.bold(`\n🐝 AgentHive — Plan Tree: ${plan.name}\n`));

  // Find top-level tasks (no parent)
  const topLevel = plan.tasks.filter((t) => !t.parent);
  // Find parents (tasks that have children)
  const parentIds = new Set(
    plan.tasks.filter((t) => t.parent).map((t) => t.parent!),
  );

  for (const task of sortByPriority(topLevel)) {
    const icon = STATUS_ICON[task.status] ?? '?';
    const color = STATUS_COLOR[task.status] ?? chalk.white;

    if (parentIds.has(task.id)) {
      // This is a parent — show with children
      const ps = computeParentStatus(plan, task.id);
      const progressStr = ps.status === 'done'
        ? chalk.green('✓ done')
        : `${ps.done}/${ps.total} done`;

      console.log(`${chalk.bold(task.id)} ${chalk.gray(`(${progressStr})`)}`);
      console.log(chalk.gray(`  ${task.title}`));

      const children = sortByPriority(getChildTasks(plan, task.id));
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const isLast = i === children.length - 1;
        const prefix = isLast ? '└── ' : '├── ';
        const cIcon = STATUS_ICON[child.status] ?? '?';
        const cColor = STATUS_COLOR[child.status] ?? chalk.white;
        const priColor = PRIORITY_COLOR[child.priority] ?? chalk.white;

        console.log(
          `${chalk.gray(prefix)}${cColor(cIcon)} ${child.id} ${priColor(child.priority)} ${chalk.gray(child.target)} — ${child.title}`,
        );
      }
      console.log('');
    } else if (!task.parent) {
      // Standalone task
      const priColor = PRIORITY_COLOR[task.priority] ?? chalk.white;
      console.log(
        `${color(icon)} ${task.id} ${priColor(task.priority)} ${chalk.gray(task.target)} — ${task.title}`,
      );
    }
  }
  console.log('');
}

// ── Stats (US-011) ──────────────────────────────────────────────────

async function runStats(
  cwd: string,
  opts: { json?: boolean },
): Promise<void> {
  const { hivePath, config, hiveRoot } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  if (plan.tasks.length === 0) {
    console.log(chalk.gray('\nNo plan found.\n'));
    return;
  }

  const allAgents = resolveAllAgents(config, hiveRoot);
  const criticalPath = findCriticalPath(plan);
  const total = plan.tasks.length;

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const t of plan.tasks) {
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
  }

  // Per-agent workload
  const agentWorkload: Record<string, { remaining: number; breakdown: Record<string, number> }> = {};
  for (const agent of allAgents) {
    const tasks = getTasksByAgent(plan, agent.name);
    const remaining = tasks.filter((t) => t.status !== 'done');
    const breakdown: Record<string, number> = {};
    for (const t of remaining) {
      breakdown[t.status] = (breakdown[t.status] ?? 0) + 1;
    }
    agentWorkload[agent.name] = { remaining: remaining.length, breakdown };
  }

  // Estimated remaining cost
  const avgBudget =
    allAgents.reduce((sum, a) => sum + a.budget, 0) / allAgents.length;
  const remainingTasks = plan.tasks.filter((t) => t.status !== 'done').length;
  const estimatedCost = remainingTasks * avgBudget;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          total,
          statusCounts,
          agentWorkload,
          criticalPath: criticalPath.map((t) => t.id),
          estimatedRemainingCost: estimatedCost,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(chalk.bold(`\n🐝 Plan: ${plan.name} — ${total} tasks\n`));

  // Status breakdown with progress bars
  console.log(chalk.bold('Status breakdown:'));
  const statuses: TaskStatus[] = ['done', 'running', 'dispatched', 'ready', 'open', 'failed', 'blocked'];
  for (const status of statuses) {
    const count = statusCounts[status] ?? 0;
    if (count === 0) continue;

    const pct = Math.round((count / total) * 100);
    const barLen = Math.round((count / total) * 20);
    const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
    const color = STATUS_COLOR[status] ?? chalk.white;

    console.log(
      `  ${color(pad(status + ':', 14))} ${pad(String(count), 4)} (${pad(pct + '%', 4)}) ${color(bar)}`,
    );
  }

  // Per-agent workload
  console.log(chalk.bold('\nPer-agent workload:'));
  for (const [name, wl] of Object.entries(agentWorkload)) {
    if (wl.remaining === 0) {
      console.log(`  ${pad(name + ':', 14)} 0 remaining ${chalk.green('✓')}`);
    } else {
      const parts = Object.entries(wl.breakdown)
        .map(([s, n]) => `${n} ${s}`)
        .join(', ');
      console.log(`  ${pad(name + ':', 14)} ${wl.remaining} remaining (${parts})`);
    }
  }

  // Critical path
  if (criticalPath.length > 0) {
    const pathStr = criticalPath.map((t) => t.id).join(' → ');
    console.log(
      chalk.bold(`\nCritical path: `) +
        `${pathStr} (longest chain: ${criticalPath.length} tasks)`,
    );
  }

  // Cost estimate
  console.log(
    chalk.bold(`\nEstimated remaining cost: `) +
      `$${estimatedCost.toFixed(2)} (${remainingTasks} tasks × $${avgBudget.toFixed(2)} avg)`,
  );
  console.log('');
}
