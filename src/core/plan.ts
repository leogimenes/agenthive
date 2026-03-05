import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  Plan,
  PlanTask,
  PlanUpdate,
  Priority,
  TaskStatus,
  DAGValidation,
} from '../types/plan.js';
import type { ChatMessage } from '../types/config.js';
import { appendMessage } from './chat.js';

// ── Constants ────────────────────────────────────────────────────────

const PLAN_FILE = 'plan.json';

const PRIORITY_ORDER: Record<Priority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

// ── Plan I/O ─────────────────────────────────────────────────────────

/**
 * Load the plan from .hive/plan.json.
 * Returns null if no plan file exists.
 */
export function loadPlan(hivePath: string): Plan | null {
  const planPath = join(hivePath, PLAN_FILE);
  if (!existsSync(planPath)) return null;

  const content = readFileSync(planPath, 'utf-8');
  return JSON.parse(content) as Plan;
}

/**
 * Save the plan to .hive/plan.json with atomic write.
 * Tasks are sorted by ID for clean diffs.
 */
export function savePlan(hivePath: string, plan: Plan): void {
  plan.updated_at = new Date().toISOString();
  plan.tasks.sort((a, b) => a.id.localeCompare(b.id));

  const planPath = join(hivePath, PLAN_FILE);
  const tmpPath = planPath + '.tmp';

  writeFileSync(tmpPath, JSON.stringify(plan, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, planPath);
}

/**
 * Create an empty plan with the given name.
 */
export function createPlan(name: string): Plan {
  const now = new Date().toISOString();
  return {
    name,
    created_at: now,
    updated_at: now,
    tasks: [],
  };
}

/**
 * Resolve the path to the plan file.
 */
export function resolvePlanPath(hivePath: string): string {
  return join(hivePath, PLAN_FILE);
}

// ── ID generation ────────────────────────────────────────────────────

/**
 * Generate a task ID: <prefix>-<4-hex>.
 * Hash is derived from title + target + timestamp to avoid collisions.
 */
export function generateId(title: string, target: string, prefix?: string): string {
  const pfx = prefix ?? target.slice(0, 4).toLowerCase();
  const hash = createHash('sha256')
    .update(title + target + Date.now().toString())
    .digest('hex')
    .slice(0, 4);
  return `${pfx}-${hash}`;
}

// ── Ready queue ──────────────────────────────────────────────────────

/**
 * Compute tasks that are ready to work on: status 'open' or 'ready'
 * where all depends_on tasks are 'done'.
 * Results sorted by priority (p0 first), then creation time (oldest first).
 */
export function computeReadyTasks(plan: Plan): PlanTask[] {
  const doneIds = new Set(
    plan.tasks.filter((t) => t.status === 'done').map((t) => t.id),
  );

  return plan.tasks
    .filter(
      (t) =>
        (t.status === 'open' || t.status === 'ready') &&
        t.depends_on.every((dep) => doneIds.has(dep)),
    )
    .sort((a, b) => {
      const priDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priDiff !== 0) return priDiff;
      return a.created_at.localeCompare(b.created_at);
    });
}

/**
 * Compute tasks that are blocked: have a dependency that is 'failed'
 * or transitively depends on a failed task.
 */
export function computeBlockedTasks(plan: Plan): PlanTask[] {
  const failedIds = new Set(
    plan.tasks.filter((t) => t.status === 'failed').map((t) => t.id),
  );

  if (failedIds.size === 0) return [];

  // Expand to include tasks transitively depending on failed tasks
  const blockedIds = new Set<string>();
  const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));

  function markBlocked(taskId: string): void {
    if (blockedIds.has(taskId)) return;
    blockedIds.add(taskId);
    // Find tasks that depend on this one
    for (const t of plan.tasks) {
      if (t.depends_on.includes(taskId) && t.status !== 'done') {
        markBlocked(t.id);
      }
    }
  }

  for (const failedId of failedIds) {
    // Mark tasks depending on failed tasks (not the failed task itself)
    for (const t of plan.tasks) {
      if (t.depends_on.includes(failedId) && t.status !== 'done') {
        markBlocked(t.id);
      }
    }
  }

  return plan.tasks.filter((t) => blockedIds.has(t.id));
}

/**
 * Get tasks assigned to a specific agent (by name or role, case-insensitive).
 */
export function getTasksByAgent(plan: Plan, agentRole: string): PlanTask[] {
  const lower = agentRole.toLowerCase();
  return plan.tasks.filter(
    (t) => t.target.toLowerCase() === lower,
  );
}

/**
 * Get the full dependency chain for a task (all ancestors up to roots).
 */
export function getDependencyChain(plan: Plan, taskId: string): PlanTask[] {
  const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));
  const chain: PlanTask[] = [];
  const visited = new Set<string>();

  function walk(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);

    const task = taskMap.get(id);
    if (!task) return;

    for (const depId of task.depends_on) {
      walk(depId);
    }
    chain.push(task);
  }

  walk(taskId);
  return chain;
}

// ── DAG validation ───────────────────────────────────────────────────

/**
 * Validate that the task dependency graph has no cycles.
 * Returns { valid: true } or { valid: false, cycles: [...] }.
 */
export function validateDAG(plan: Plan): DAGValidation {
  const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));
  const cycles: string[][] = [];

  // Standard DFS cycle detection
  const WHITE = 0; // unvisited
  const GRAY = 1;  // in current path
  const BLACK = 2; // fully processed

  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const t of plan.tasks) {
    color.set(t.id, WHITE);
  }

  function dfs(nodeId: string): void {
    color.set(nodeId, GRAY);
    const task = taskMap.get(nodeId);
    if (!task) return;

    for (const depId of task.depends_on) {
      if (!taskMap.has(depId)) continue; // skip unknown deps

      const depColor = color.get(depId) ?? WHITE;
      if (depColor === GRAY) {
        // Found a cycle — trace back
        const cycle: string[] = [depId, nodeId];
        let cur = nodeId;
        while (cur !== depId) {
          const p = parent.get(cur);
          if (!p || p === depId) break;
          cycle.push(p);
          cur = p;
        }
        cycles.push(cycle.reverse());
      } else if (depColor === WHITE) {
        parent.set(depId, nodeId);
        dfs(depId);
      }
    }

    color.set(nodeId, BLACK);
  }

  for (const t of plan.tasks) {
    if (color.get(t.id) === WHITE) {
      dfs(t.id);
    }
  }

  return cycles.length === 0
    ? { valid: true }
    : { valid: false, cycles };
}

// ── Status promotion ─────────────────────────────────────────────────

/**
 * Promote open tasks to 'ready' if all dependencies are done.
 * Block tasks whose dependencies have failed.
 * Returns the number of tasks promoted.
 */
export function promoteReadyTasks(plan: Plan): number {
  const doneIds = new Set(
    plan.tasks.filter((t) => t.status === 'done').map((t) => t.id),
  );
  const now = new Date().toISOString();
  let promoted = 0;

  for (const task of plan.tasks) {
    if (
      task.status === 'open' &&
      task.depends_on.length > 0 &&
      task.depends_on.every((dep) => doneIds.has(dep))
    ) {
      task.status = 'ready';
      task.updated_at = now;
      promoted++;
    }
    // Also promote open tasks with no dependencies
    if (
      task.status === 'open' &&
      task.depends_on.length === 0
    ) {
      task.status = 'ready';
      task.updated_at = now;
      promoted++;
    }
  }

  // Cascade blocks from failed tasks
  const blocked = computeBlockedTasks(plan);
  for (const task of blocked) {
    if (task.status !== 'blocked' && task.status !== 'done' && task.status !== 'failed') {
      task.status = 'blocked';
      task.updated_at = now;
    }
  }

  return promoted;
}

// ── Chat-driven state transitions ────────────────────────────────────

/**
 * Extract a known task ID from a chat message body.
 * Looks for bracketed IDs like [BE-06] first, then scans for any known ID.
 */
export function extractTaskId(body: string, plan: Plan): string | null {
  const knownIds = plan.tasks.map((t) => t.id);

  // 1. Check for bracketed ID: [TASK-ID]
  const bracketMatch = body.match(/\[([A-Za-z0-9_-]+)\]/);
  if (bracketMatch) {
    const candidate = bracketMatch[1];
    if (knownIds.some((id) => id.toLowerCase() === candidate.toLowerCase())) {
      return knownIds.find(
        (id) => id.toLowerCase() === candidate.toLowerCase(),
      )!;
    }
  }

  // 2. Scan for any known ID in the message body (case-insensitive)
  for (const id of knownIds) {
    if (body.toLowerCase().includes(id.toLowerCase())) {
      return id;
    }
  }

  return null;
}

/**
 * Reconcile plan state with new chat messages.
 * DONE messages → mark task done; BLOCKER messages → mark task failed.
 * Returns the list of updates applied.
 */
export function reconcilePlanWithChat(
  plan: Plan,
  messages: ChatMessage[],
): PlanUpdate[] {
  const updates: PlanUpdate[] = [];
  const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));

  for (const msg of messages) {
    if (msg.type === 'DONE' || msg.type === 'BLOCKER') {
      let taskId = extractTaskId(msg.body, plan);

      // If no ID found, try to infer from the agent's active tasks
      if (!taskId) {
        const role = msg.role.toLowerCase();
        const activeTasks = plan.tasks.filter(
          (t) =>
            t.target.toLowerCase() === role &&
            (t.status === 'dispatched' || t.status === 'running'),
        );
        if (activeTasks.length === 1) {
          taskId = activeTasks[0].id;
        }
      }

      if (taskId) {
        const task = taskMap.get(taskId);
        if (task && task.status !== 'done' && task.status !== 'failed') {
          const newStatus: TaskStatus = msg.type === 'DONE' ? 'done' : 'failed';
          const now = new Date().toISOString();

          updates.push({
            taskId,
            newStatus,
            resolution: msg.body,
            timestamp: now,
          });

          // Apply the update
          task.status = newStatus;
          task.resolution = msg.body;
          task.updated_at = now;
          if (newStatus === 'done') {
            task.completed_at = now;
          }
        }
      }
    }
  }

  // Cascade: promote newly ready tasks and block dependents of failed tasks
  if (updates.length > 0) {
    promoteReadyTasks(plan);
  }

  return updates;
}

// ── Hierarchical helpers ─────────────────────────────────────────────

/**
 * Get children of a parent task.
 */
export function getChildTasks(plan: Plan, parentId: string): PlanTask[] {
  return plan.tasks.filter((t) => t.parent === parentId);
}

/**
 * Compute the rollup status for a parent task based on its children.
 */
export function computeParentStatus(
  plan: Plan,
  parentId: string,
): { status: string; done: number; total: number } {
  const children = getChildTasks(plan, parentId);
  if (children.length === 0) return { status: 'open', done: 0, total: 0 };

  const done = children.filter((c) => c.status === 'done').length;
  const failed = children.filter((c) => c.status === 'failed').length;
  const running = children.filter((c) =>
    c.status === 'running' || c.status === 'dispatched',
  ).length;

  if (done === children.length) return { status: 'done', done, total: children.length };
  if (failed > 0) return { status: 'warning', done, total: children.length };
  if (running > 0) return { status: 'running', done, total: children.length };
  return { status: 'progress', done, total: children.length };
}

// ── Critical path ────────────────────────────────────────────────────

/**
 * Find the critical path: the longest dependency chain among non-done tasks.
 */
export function findCriticalPath(plan: Plan): PlanTask[] {
  const taskMap = new Map(plan.tasks.map((t) => [t.id, t]));
  const nonDone = plan.tasks.filter((t) => t.status !== 'done');

  if (nonDone.length === 0) return [];

  const nonDoneIds = new Set(nonDone.map((t) => t.id));

  // Build adjacency list (task → tasks that depend on it)
  const dependents = new Map<string, string[]>();
  for (const t of nonDone) {
    for (const dep of t.depends_on) {
      if (nonDoneIds.has(dep)) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep)!.push(t.id);
      }
    }
  }

  // Find roots (non-done tasks with no non-done dependencies)
  const roots = nonDone.filter(
    (t) => t.depends_on.every((d) => !nonDoneIds.has(d)),
  );

  // DFS to find longest path
  let longestPath: string[] = [];

  function dfs(nodeId: string, path: string[]): void {
    path.push(nodeId);
    if (path.length > longestPath.length) {
      longestPath = [...path];
    }
    const deps = dependents.get(nodeId) ?? [];
    for (const depId of deps) {
      dfs(depId, path);
    }
    path.pop();
  }

  for (const root of roots) {
    dfs(root.id, []);
  }

  // If no roots found (all remaining tasks have deps), pick shortest chain
  if (longestPath.length === 0 && nonDone.length > 0) {
    longestPath = [nonDone[0].id];
  }

  return longestPath.map((id) => taskMap.get(id)!).filter(Boolean);
}

// ── Sorting helpers ──────────────────────────────────────────────────

export function sortByPriority(tasks: PlanTask[]): PlanTask[] {
  return [...tasks].sort((a, b) => {
    const priDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priDiff !== 0) return priDiff;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function dispatchTask(
  chatFilePath: string,
  task: PlanTask,
  chatRole: string,
): void {
  const now = new Date().toISOString();
  task.status = 'dispatched';
  task.dispatched_at = now;
  task.updated_at = now;

  const descLine = task.description
    ? `. ${task.description.split('\n')[0]}`
    : '';
  const body = `@${chatRole}: [${task.id}] ${task.title}${descLine}`;
  appendMessage(chatFilePath, 'USER', 'REQUEST', body);
}

export { PRIORITY_ORDER };

// ── Retry policy ─────────────────────────────────────────────────────

/**
 * Default number of retry attempts allowed for transient task failures.
 * A task must fail this many times before it is permanently marked 'failed'.
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Attempt to reset a failed/dispatched plan task for retry after a transient error.
 *
 * Increments `task.retry_count` then:
 * - Returns `'retry'`  and resets `task.status` to `'open'`  when retries remain.
 * - Returns `'failed'` and sets   `task.status` to `'failed'` when retries are exhausted.
 *
 * The caller is responsible for saving the plan after calling this function.
 */
export function resetTaskForRetry(
  task: PlanTask,
  error?: string,
): 'retry' | 'failed' {
  const maxRetries = task.max_retries ?? DEFAULT_MAX_RETRIES;
  const currentRetries = task.retry_count ?? 0;
  const now = new Date().toISOString();

  task.retry_count = currentRetries + 1;
  task.updated_at = now;

  if (error !== undefined) {
    task.last_error = error;
  }

  if (currentRetries < maxRetries) {
    task.status = 'open';
    return 'retry';
  }

  task.status = 'failed';
  return 'failed';
}
