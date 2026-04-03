import { Command } from 'commander';
import { resolve } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { input, select, checkbox, confirm } from '@inquirer/prompts';
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
  dispatchTask,
  PRIORITY_ORDER,
} from '../core/plan.js';
import { resolveChatPath } from '../core/chat.js';
import type { Plan, PlanTask, Priority, TaskStatus, TaskType } from '../types/plan.js';

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

  plan.addHelpText('after', `
Quick start:
  hive plan add                 Add a task (interactive wizard)
  hive plan create              AI-assisted plan creation
  hive plan                     View the board
  hive plan dispatch            Dispatch ready tasks
  hive ui                       TUI with plan view (press p)
`);

  // Default action: board view
  plan
    .option('--json', 'Output plan as JSON')
    .option('--compact', 'Compact one-line-per-task view')
    .option('--flat', 'Flat list — no grouping under epic headers')
    .option('--filter <filter>', 'Filter by agent, status, or label')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runBoard(cwd, opts);
    });

  // plan add
  plan
    .command('add [target] [title]')
    .description('Add a task to the plan')
    .option('--id <id>', 'Custom task ID')
    .option('--priority <p>', 'Priority: p0, p1, p2, p3', 'p2')
    .option('--type <type>', 'Hierarchy type: epic, story, task')
    .option('--depends-on <ids>', 'Comma-separated dependency IDs')
    .option('--parent <id>', 'Parent task ID')
    .option('--labels <labels>', 'Comma-separated labels')
    .option('--description <text>', 'Task description')
    .option('-i, --interactive', 'Force interactive wizard mode')
    .action(async (target: string | undefined, title: string | undefined, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      if ((!target || !title) || opts.interactive) {
        await runAddWizard(cwd, target, title, opts);
      } else {
        await runAdd(cwd, target, title, opts);
      }
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

  // plan create
  plan
    .command('create')
    .description('AI-assisted plan creation from a feature description')
    .option('--budget <usd>', 'Max budget in USD for the PM agent', '1.00')
    .option('--model <model>', 'Model for the PM agent', 'sonnet')
    .option('--auto-import', 'Auto-import without confirmation')
    .action(async (opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();
      await runCreate(cwd, opts);
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
  opts: { json?: boolean; compact?: boolean; flat?: boolean; filter?: string },
): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  if (plan.tasks.length === 0) {
    console.log(chalk.gray('\nPlan is empty. Run `hive plan add` to add your first task, or `hive plan create` for AI-assisted planning.\n'));
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

  // Epic-grouped view (default when epics exist, suppressed by --flat)
  const epics = tasks.filter((t) => t.type === 'epic');
  if (!opts.flat && epics.length > 0) {
    console.log(chalk.bold(`\n🐝 AgentHive — Plan: ${plan.name} (${tasks.length} tasks)\n`));
    for (const epic of sortByPriority(epics)) {
      const ps = computeParentStatus(plan, epic.id);
      const progressStr = ps.total > 0
        ? ` ${chalk.gray(`(${ps.done}/${ps.total})`)}`
        : '';
      const epicColor = STATUS_COLOR[epic.status] ?? chalk.white;
      console.log(`${chalk.bold.cyan('◈')} ${chalk.bold(epic.id)}${progressStr} ${chalk.bold(epic.title)}`);
      // Children of this epic
      const children = tasks.filter((t) => t.parent === epic.id);
      for (const child of sortByPriority(children)) {
        const icon = STATUS_ICON[child.status] ?? '?';
        const color = STATUS_COLOR[child.status] ?? chalk.white;
        const priColor = PRIORITY_COLOR[child.priority] ?? chalk.white;
        const typeTag = child.type ? chalk.gray(`[${child.type}] `) : '';
        console.log(`  ${color(icon)} ${pad(child.id, 10)} ${priColor(pad(child.priority, 4))} ${typeTag}${chalk.gray(pad(child.target, 10))} ${child.title}`);
      }
      console.log('');
    }
    // Tasks not under any epic
    const orphans = tasks.filter((t) => t.type !== 'epic' && (!t.parent || !tasks.some((e) => e.id === t.parent && e.type === 'epic')));
    if (orphans.length > 0) {
      console.log(chalk.gray('── Unassigned ──────────────'));
      for (const task of sortByPriority(orphans)) {
        const icon = STATUS_ICON[task.status] ?? '?';
        const color = STATUS_COLOR[task.status] ?? chalk.white;
        const priColor = PRIORITY_COLOR[task.priority] ?? chalk.white;
        const typeTag = task.type ? chalk.gray(`[${task.type}] `) : '';
        console.log(`${color(icon)} ${pad(task.id, 10)} ${priColor(pad(task.priority, 4))} ${typeTag}${chalk.gray(pad(task.target, 10))} ${task.title}`);
      }
      console.log('');
    }
    const ready = computeReadyTasks(plan);
    const failed = plan.tasks.filter((t) => t.status === 'failed');
    const allDone = plan.tasks.every((t) => t.status === 'done');
    if (allDone) {
      console.log(`\n${chalk.green('✓ All tasks complete!')}`);
    } else if (failed.length > 0) {
      console.log(`\n${chalk.red(`✗ ${failed.length} task(s) failed. Run \`hive plan reset <id>\` to retry.`)}`);
      if (ready.length > 0) {
        console.log(chalk.cyan(`  ${ready.length} task(s) ready to dispatch. Run \`hive plan dispatch\`.`));
      }
    } else if (ready.length > 0) {
      console.log(`\n${chalk.cyan(`${ready.length} task(s) ready to dispatch. Run \`hive plan dispatch\` or press \`p\` in the TUI.`)}`);
    } else {
      console.log('');
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

  // Build set of parent IDs for progress fraction display
  const parentIds = new Set(
    tasks.filter((t) => t.parent).map((t) => t.parent!),
  );

  for (let row = 0; row < maxHeight; row++) {
    const line = activeColumns
      .map((col) => {
        const task = grouped[col][row];
        if (!task) return pad('', COL_WIDTH);

        const icon = STATUS_ICON[task.status] ?? '?';
        const color = STATUS_COLOR[task.status] ?? chalk.white;
        const priColor = PRIORITY_COLOR[task.priority] ?? chalk.white;

        // Show progress fraction for parent tasks (those with children)
        if (parentIds.has(task.id)) {
          const ps = computeParentStatus(plan, task.id);
          const fraction = `(${ps.done}/${ps.total})`;
          const cell = `${icon} ${task.id} ${fraction}`;
          return color(icon) + ' ' + task.id + ' ' + chalk.gray(fraction) + ' '.repeat(Math.max(0, COL_WIDTH - cell.length - 1));
        }

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

  // Contextual guidance footer
  const ready = computeReadyTasks(plan);
  const failed = plan.tasks.filter((t) => t.status === 'failed');
  const allDone = plan.tasks.every((t) => t.status === 'done');

  if (allDone) {
    console.log(`\n${chalk.green('✓ All tasks complete!')}`);
  } else if (failed.length > 0) {
    console.log(`\n${chalk.red(`✗ ${failed.length} task(s) failed. Run \`hive plan reset <id>\` to retry.`)}`);
    if (ready.length > 0) {
      console.log(chalk.cyan(`  ${ready.length} task(s) ready to dispatch. Run \`hive plan dispatch\`.`));
    }
  } else if (ready.length > 0) {
    console.log(`\n${chalk.cyan(`${ready.length} task(s) ready to dispatch. Run \`hive plan dispatch\` or press \`p\` in the TUI.`)}`);
  } else {
    console.log('');
  }
}

// ── Add wizard (Epic 1) ──────────────────────────────────────────────

async function runAddWizard(
  cwd: string,
  preTarget?: string,
  preTitle?: string,
  opts: {
    id?: string;
    type?: string;
    priority?: string;
    dependsOn?: string;
    parent?: string;
    labels?: string;
    description?: string;
    interactive?: boolean;
  } = {},
): Promise<void> {
  // TTY guard
  if (!process.stdout.isTTY) {
    console.error(
      chalk.red(
        'Interactive mode requires a terminal. Use flags: hive plan add <target> <title> [--priority p1] [--depends-on X]',
      ),
    );
    process.exit(1);
  }

  const { hivePath, config, hiveRoot } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);
  const allAgents = resolveAllAgents(config, hiveRoot);

  // Step 1: Title
  const title = preTitle ?? await input({
    message: 'Task title — what needs to be done?',
    validate: (v) => (v.trim() ? true : 'Title is required'),
  });

  // Step 2: Target agent
  const agentChoices = allAgents.map((a) => ({
    name: `${a.name} — ${a.description}`,
    value: a.name,
  }));

  let target: string;
  if (preTarget) {
    const valid = allAgents.find(
      (a) => a.name.toLowerCase() === preTarget.toLowerCase() ||
        a.chatRole.toLowerCase() === preTarget.toLowerCase(),
    );
    target = valid?.name ?? await select({
      message: 'Which agent should handle this?',
      choices: agentChoices,
    });
  } else {
    target = await select({
      message: 'Which agent should handle this?',
      choices: agentChoices,
    });
  }

  // Step 3: Priority
  const priority = (opts.priority as string) ?? await select({
    message: 'Priority level?',
    choices: [
      { name: 'p0 — Critical', value: 'p0' },
      { name: 'p1 — High', value: 'p1' },
      { name: 'p2 — Normal', value: 'p2' },
      { name: 'p3 — Low', value: 'p3' },
    ],
    default: 'p2',
  });

  // Step 4: Description
  const description = opts.description ?? await input({
    message: 'Description (optional, Enter to skip):',
  });

  // Step 5: Dependencies
  let dependsOn: string[] = [];
  if (opts.dependsOn) {
    dependsOn = opts.dependsOn.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (plan.tasks.length > 0) {
    const depChoices = plan.tasks.map((t) => ({
      name: `${t.id} — ${t.title} (${t.status})`,
      value: t.id,
    }));
    dependsOn = await checkbox({
      message: 'Dependencies — select tasks this depends on:',
      choices: depChoices,
    });
  }

  // Step 6: Parent
  let parent: string | undefined = opts.parent;
  if (!parent && plan.tasks.length > 0) {
    const parentChoices = [
      { name: 'None', value: '__none__' },
      ...plan.tasks.map((t) => ({
        name: `${t.id} — ${t.title}`,
        value: t.id,
      })),
    ];
    const selected = await select({
      message: 'Parent task (for grouping)?',
      choices: parentChoices,
    });
    parent = selected === '__none__' ? undefined : selected;
  }

  // Step 7: Summary & confirmation
  console.log('');
  console.log(chalk.bold('Task summary:'));
  console.log(`  Title:    ${title}`);
  console.log(`  Agent:    ${target}`);
  console.log(`  Priority: ${priority}`);
  if (description) console.log(`  Desc:     ${description}`);
  if (dependsOn.length > 0) console.log(`  Deps:     ${dependsOn.join(', ')}`);
  if (parent) console.log(`  Parent:   ${parent}`);
  console.log('');

  const ok = await confirm({ message: 'Create this task?', default: true });
  if (!ok) {
    console.log(chalk.gray('Cancelled.'));
    return;
  }

  // Delegate to runAdd with resolved values
  await runAdd(cwd, target, title, {
    id: opts.id,
    type: opts.type,
    priority,
    dependsOn: dependsOn.length > 0 ? dependsOn.join(',') : undefined,
    parent,
    labels: opts.labels,
    description: description || undefined,
  });
}

// ── Add task (US-003) ────────────────────────────────────────────────

async function runAdd(
  cwd: string,
  target: string,
  title: string,
  opts: {
    id?: string;
    type?: string;
    priority?: string;
    dependsOn?: string;
    parent?: string;
    labels?: string;
    description?: string;
  },
): Promise<void> {
  const { hivePath, config } = loadContext(cwd);
  const plan = loadOrCreatePlan(hivePath, config.session);

  // Validate type
  const validTypes: TaskType[] = ['epic', 'story', 'task'];
  if (opts.type && !validTypes.includes(opts.type as TaskType)) {
    console.error(chalk.red(`Invalid type: "${opts.type}". Must be epic, story, or task.`));
    process.exit(1);
  }
  const taskType = opts.type as TaskType | undefined;

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
    ...(taskType ? { type: taskType } : {}),
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
  } else if (process.stdout.isTTY && ready.length > 0) {
    // Interactive mode: let user select tasks
    const dispatchChoices = ready.map((t) => ({
      name: `${pad(t.id, 10)} ${pad(t.priority, 4)} ${pad(t.target, 10)} — ${t.title}`,
      value: t.id,
      checked: true,
    }));

    const selectedIds = await checkbox({
      message: 'Select tasks to dispatch:',
      choices: dispatchChoices,
    });

    toDispatch = ready.filter((t) => selectedIds.includes(t.id));
  } else {
    // Non-TTY fallback: one per agent (highest priority)
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
  for (const task of toDispatch) {
    const agent = allAgents.find((a) => a.name === task.target);
    const role = agent?.chatRole ?? task.target.toUpperCase();
    dispatchTask(chatFilePath, task, role);
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
      ...(imported.type ? { type: imported.type } : {}),
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
  type RawTask = Record<string, unknown>;
  const parsed = parseYaml(content) as {
    tasks?: RawTask[];
    epics?: RawTask[];
  };

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('YAML must contain a "tasks" array or an "epics" hierarchy.');
  }

  // Flat format: { tasks: [...] }
  if (parsed.tasks && Array.isArray(parsed.tasks)) {
    return parsed.tasks.map((t: RawTask) => ({
      id: t.id as string | undefined,
      type: t.type as TaskType | undefined,
      title: t.title as string,
      target: t.target as string,
      priority: t.priority as Priority | undefined,
      depends_on: Array.isArray(t.depends_on) ? (t.depends_on as string[]) : undefined,
      description: t.description as string | undefined,
      parent: t.parent as string | undefined,
      labels: Array.isArray(t.labels) ? (t.labels as string[]) : undefined,
    }));
  }

  // Nested format: { epics: [{ stories: [{ tasks: [...] }] }] }
  if (parsed.epics && Array.isArray(parsed.epics)) {
    const result: Partial<PlanTask>[] = [];

    for (const epic of parsed.epics) {
      const epicId = epic.id as string | undefined;
      const epicTarget = epic.target as string;
      result.push({
        id: epicId,
        type: 'epic',
        title: epic.title as string,
        target: epicTarget,
        priority: epic.priority as Priority | undefined,
        depends_on: Array.isArray(epic.depends_on) ? (epic.depends_on as string[]) : undefined,
        description: epic.description as string | undefined,
        labels: Array.isArray(epic.labels) ? (epic.labels as string[]) : undefined,
      });

      const stories = epic.stories as RawTask[] | undefined;
      if (!stories || !Array.isArray(stories)) continue;

      for (const story of stories) {
        const storyId = story.id as string | undefined;
        const storyTarget = (story.target as string | undefined) ?? epicTarget;
        result.push({
          id: storyId,
          type: 'story',
          title: story.title as string,
          target: storyTarget,
          priority: story.priority as Priority | undefined,
          depends_on: Array.isArray(story.depends_on) ? (story.depends_on as string[]) : undefined,
          description: story.description as string | undefined,
          parent: epicId,
          labels: Array.isArray(story.labels) ? (story.labels as string[]) : undefined,
        });

        const tasks = story.tasks as RawTask[] | undefined;
        if (!tasks || !Array.isArray(tasks)) continue;

        for (const task of tasks) {
          result.push({
            id: task.id as string | undefined,
            type: 'task',
            title: task.title as string,
            target: (task.target as string | undefined) ?? storyTarget,
            priority: task.priority as Priority | undefined,
            depends_on: Array.isArray(task.depends_on) ? (task.depends_on as string[]) : undefined,
            description: task.description as string | undefined,
            parent: storyId,
            labels: Array.isArray(task.labels) ? (task.labels as string[]) : undefined,
          });
        }
      }
    }

    return result;
  }

  throw new Error('YAML must contain a "tasks" array or an "epics" hierarchy.');
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

  const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));

  // Recursively print a task and its children with indentation
  function printTask(task: PlanTask, indent: string, isLast: boolean): void {
    const icon = STATUS_ICON[task.status] ?? '?';
    const color = STATUS_COLOR[task.status] ?? chalk.white;
    const priColor = PRIORITY_COLOR[task.priority] ?? chalk.white;
    const children = sortByPriority(getChildTasks(plan, task.id));
    const hasChildren = children.length > 0;

    const connector = indent === '' ? '' : (isLast ? '└── ' : '├── ');
    const typeTag = task.type ? chalk.cyan(`[${task.type}] `) : '';

    if (hasChildren) {
      const ps = computeParentStatus(plan, task.id);
      const progressStr = ps.status === 'done'
        ? chalk.green('✓ done')
        : chalk.gray(`${ps.done}/${ps.total} done`);
      console.log(
        `${indent}${connector}${color(icon)} ${chalk.bold(task.id)} ${typeTag}${progressStr}`,
      );
      console.log(
        `${indent}${indent === '' ? '' : (isLast ? '    ' : '│   ')}  ${chalk.gray(task.title)} ${priColor(task.priority)} ${chalk.gray(task.target)}`,
      );
    } else {
      console.log(
        `${indent}${connector}${color(icon)} ${task.id} ${typeTag}${priColor(task.priority)} ${chalk.gray(task.target)} — ${task.title}`,
      );
    }

    if (hasChildren) {
      const childIndent = indent + (indent === '' ? '' : (isLast ? '    ' : '│   '));
      for (let i = 0; i < children.length; i++) {
        printTask(children[i], childIndent, i === children.length - 1);
      }
    }
  }

  // Find top-level tasks (no parent)
  const topLevel = sortByPriority(plan.tasks.filter((t) => !t.parent));
  for (let i = 0; i < topLevel.length; i++) {
    printTask(topLevel[i], '', i === topLevel.length - 1);
    // Add blank line between top-level items that have children
    if (getChildTasks(plan, topLevel[i].id).length > 0) {
      console.log('');
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

  // Per-epic progress data
  const epics = plan.tasks.filter((t) => t.type === 'epic');
  const epicStats = epics.map((epic) => {
    const ps = computeParentStatus(plan, epic.id);
    const children = getChildTasks(plan, epic.id);
    const actualCost = children.reduce((s, c) => s + (c.actual_cost ?? 0), 0);
    const estimatedCostEpic = children.reduce((s, c) => s + (c.estimated_cost ?? 0), 0);
    return { epic, ps, actualCost, estimatedCostEpic };
  });

  // Total actual cost across all tasks
  const totalActualCost = plan.tasks.reduce((s, t) => s + (t.actual_cost ?? 0), 0);
  const totalEstimatedCost = plan.tasks.reduce((s, t) => s + (t.estimated_cost ?? 0), 0);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          total,
          statusCounts,
          agentWorkload,
          criticalPath: criticalPath.map((t) => t.id),
          estimatedRemainingCost: estimatedCost,
          epics: epicStats.map(({ epic, ps, actualCost, estimatedCostEpic }) => ({
            id: epic.id,
            title: epic.title,
            status: epic.status,
            done: ps.done,
            total: ps.total,
            running: ps.running,
            failed: ps.failed,
            blocked: ps.blocked,
            actualCost,
            estimatedCost: estimatedCostEpic,
          })),
          totalActualCost,
          totalEstimatedCost,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(chalk.bold(`\nPlan: ${plan.name} — ${total} tasks\n`));

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

  // Per-epic progress bars
  if (epicStats.length > 0) {
    console.log(chalk.bold('\nEpic progress:'));
    for (const { epic, ps, actualCost, estimatedCostEpic } of epicStats) {
      if (ps.total === 0) continue;

      const pct = Math.round((ps.done / ps.total) * 100);
      const barLen = Math.round((ps.done / ps.total) * 20);
      const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
      const epicColor = STATUS_COLOR[epic.status] ?? chalk.white;

      const costParts: string[] = [];
      if (actualCost > 0) costParts.push(`$${actualCost.toFixed(2)} actual`);
      else if (estimatedCostEpic > 0) costParts.push(`$${estimatedCostEpic.toFixed(2)} est.`);
      const costStr = costParts.length > 0 ? `  ${chalk.gray(costParts.join(', '))}` : '';

      const statusIcon = ps.failed > 0 ? chalk.red('✗') : ps.done === ps.total ? chalk.green('✓') : chalk.yellow('●');
      console.log(
        `  ${statusIcon} ${chalk.bold(pad(epic.id, 10))} ${epicColor(pad(pct + '%', 5))} ${epicColor(bar)}  ${ps.done}/${ps.total}${costStr}  ${chalk.gray(epic.title)}`,
      );
    }
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

  // Cost summary
  if (totalActualCost > 0) {
    console.log(
      chalk.bold(`\nActual cost: `) + `$${totalActualCost.toFixed(2)}` +
      (totalEstimatedCost > 0 ? ` / $${totalEstimatedCost.toFixed(2)} estimated` : ''),
    );
  } else {
    console.log(
      chalk.bold(`\nEstimated remaining cost: `) +
        `$${estimatedCost.toFixed(2)} (${remainingTasks} tasks × $${avgBudget.toFixed(2)} avg)`,
    );
  }
  console.log('');
}

// ── AI-assisted plan creation (Epic 3) ──────────────────────────────

async function runCreate(
  cwd: string,
  opts: {
    budget?: string;
    model?: string;
    autoImport?: boolean;
  },
): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error(chalk.red('Interactive mode requires a terminal.'));
    process.exit(1);
  }

  const { hivePath, config, hiveRoot } = loadContext(cwd);
  const allAgents = resolveAllAgents(config, hiveRoot);

  // Phase A: Gather input
  const featureDesc = await input({
    message: 'Describe the feature you want to build:',
    validate: (v) => (v.trim() ? true : 'Description is required'),
  });

  const agentChoices = allAgents.map((a) => ({
    name: `${a.name} — ${a.description}`,
    value: a.name,
    checked: true,
  }));

  const selectedAgents = await checkbox({
    message: 'Which agents are available?',
    choices: agentChoices,
  });

  if (selectedAgents.length === 0) {
    console.error(chalk.red('At least one agent must be selected.'));
    process.exit(1);
  }

  const budget = opts.budget ?? '1.00';
  const agentList = selectedAgents.join(', ');
  const prefixMap: Record<string, string> = {
    backend: 'BE', frontend: 'FE', qa: 'QA', sre: 'SRE', security: 'SEC', appsec: 'SEC', pm: 'PM',
  };

  const agentDescriptions = selectedAgents
    .map((name) => {
      const agent = allAgents.find((a) => a.name === name);
      const prefix = prefixMap[name] ?? name.toUpperCase().slice(0, 3);
      return `- ${name} (ID prefix: ${prefix}-): ${agent?.description ?? 'agent'}`;
    })
    .join('\n');

  const prompt = `You are a PM agent analyzing a codebase and creating a structured implementation plan.

Feature request: ${featureDesc}

Available agents:
${agentDescriptions}

Instructions:
1. Explore the codebase to understand the architecture and relevant files
2. Break the feature into discrete, well-scoped tasks
3. Assign each task to the most appropriate agent
4. Define dependencies between tasks (a task can only start after its dependencies are done)
5. Set priorities: p0 (critical), p1 (high), p2 (normal), p3 (low)
6. Use imperative titles (e.g., "Add pagination to list endpoint")

Output a YAML block at the end of your analysis with this exact format:

\`\`\`yaml
tasks:
  - id: BE-01
    target: backend
    title: "imperative title here"
    priority: p1
    description: "acceptance criteria and implementation notes"
    depends_on: []
  - id: FE-01
    target: frontend
    title: "another task"
    priority: p2
    description: "details"
    depends_on: [BE-01]
\`\`\`

ID prefix convention: ${Object.entries(prefixMap).map(([k, v]) => `${v}- for ${k}`).join(', ')}.
Number IDs sequentially per agent (e.g., BE-01, BE-02, FE-01, FE-02).`;

  // Phase B: Spawn PM agent
  console.log(chalk.bold('\n🐝 Spawning PM agent to analyze codebase...\n'));

  const output = await new Promise<string>((resolvePromise, reject) => {
    let stdout = '';
    const child = spawn('claude', ['-p', '--max-turns', '20', prompt], {
      cwd: hiveRoot,
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`PM agent exited with code ${code}`));
      } else {
        resolvePromise(stdout);
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn PM agent: ${err.message}. Is 'claude' CLI installed?`));
    });
  });

  // Phase C: Extract, review, import
  console.log(chalk.bold('\n\n🐝 Extracting plan from PM output...\n'));

  let yamlContent: string | null = null;
  const yamlMatch = output.match(/```yaml\n([\s\S]+?)```/);
  if (yamlMatch) {
    yamlContent = yamlMatch[1];
  } else {
    // Try parsing entire output as YAML
    try {
      const parsed = parseYaml(output);
      if (parsed?.tasks) {
        yamlContent = output;
      }
    } catch {
      // Not valid YAML
    }
  }

  if (!yamlContent) {
    const draftPath = resolve(hivePath, 'plan-draft.txt');
    writeFileSync(draftPath, output, 'utf-8');
    console.error(chalk.yellow(`No YAML plan found in PM output. Raw output saved to: ${draftPath}`));
    console.error(chalk.gray('Edit the file and run `hive plan import <file>` to import manually.'));
    process.exit(1);
  }

  let importedTasks: Partial<PlanTask>[];
  try {
    importedTasks = parseYamlImport(yamlContent);
  } catch (err) {
    const draftPath = resolve(hivePath, 'plan-draft.txt');
    writeFileSync(draftPath, output, 'utf-8');
    console.error(chalk.yellow(`Failed to parse YAML: ${err instanceof Error ? err.message : err}`));
    console.error(chalk.gray(`Raw output saved to: ${draftPath}`));
    process.exit(1);
  }

  // Display parsed tasks
  console.log(chalk.bold(`Found ${importedTasks.length} tasks:\n`));
  for (const t of importedTasks) {
    const priColor = PRIORITY_COLOR[t.priority ?? 'p2'] ?? chalk.white;
    console.log(`  ${pad(t.id ?? '???', 10)} ${priColor(pad(t.priority ?? 'p2', 4))} ${pad(t.target ?? '???', 10)} ${t.title ?? '(no title)'}`);
    if (t.depends_on && t.depends_on.length > 0) {
      console.log(chalk.gray(`    Deps: ${t.depends_on.join(', ')}`));
    }
  }
  console.log('');

  // Import or save
  let doImport = opts.autoImport ?? false;
  if (!doImport) {
    doImport = await confirm({ message: 'Import this plan?', default: true });
  }

  if (!doImport) {
    const savePath = resolve(hivePath, 'plan-draft.yaml');
    writeFileSync(savePath, yamlContent, 'utf-8');
    console.log(chalk.gray(`Plan saved to: ${savePath}`));
    console.log(chalk.gray('Edit and run `hive plan import plan-draft.yaml` to import.'));
    return;
  }

  // Run import logic
  const plan = loadOrCreatePlan(hivePath, config.session);
  const now = new Date().toISOString();
  let added = 0;
  const warnings: string[] = [];

  for (const imported of importedTasks) {
    if (!imported.target || !imported.title) {
      warnings.push('Skipped task with missing target or title');
      continue;
    }

    const taskId = imported.id ?? generateId(imported.title, imported.target);
    if (plan.tasks.some((t) => t.id === taskId)) {
      warnings.push(`Skipped "${taskId}" — already exists`);
      continue;
    }

    const validTarget = allAgents.find(
      (a) =>
        a.name.toLowerCase() === imported.target!.toLowerCase() ||
        a.chatRole.toLowerCase() === imported.target!.toLowerCase(),
    );
    if (!validTarget) {
      warnings.push(`Skipped "${taskId}" — unknown target "${imported.target}"`);
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

  const readyCount = computeReadyTasks(plan).length;
  console.log(chalk.green(`✓ Imported ${added} tasks (${readyCount} ready).`));
  for (const w of warnings) {
    console.log(chalk.yellow(`  ${w}`));
  }
  console.log(chalk.gray('Run `hive plan` to see the board, or `hive plan dispatch` to start.'));
}
