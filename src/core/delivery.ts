/**
 * Epic completion workflow orchestration.
 *
 * This module is the single source of truth for delivering an epic:
 *   1. Validate the epic is ready (DoD steps, task progress).
 *   2. Consolidate agent commits onto an epic/<id> branch.
 *   3. Apply the configured delivery strategy (auto-merge / pull-request / manual).
 *   4. Record completed DoD steps on the epic task and persist the plan.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { DeliveryConfig, DefinitionOfDoneStep } from '../types/config.js';
import type { Plan, PlanTask } from '../types/plan.js';
import {
  getChildren,
  computeParentStatus,
  evaluateDefinitionOfDone,
} from './plan.js';

const exec = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export interface EpicValidation {
  valid: boolean;
  epicId: string;
  epicTitle: string;
  issues: string[];
  pendingDodSteps: DefinitionOfDoneStep[];
  taskProgress: { done: number; total: number; failed: number };
}

export interface AgentConsolidation {
  agent: string;
  commits: number;
  status: 'squashed' | 'skipped' | 'failed';
  reason?: string;
  error?: string;
}

export interface EpicBranchResult {
  epicBranch: string;
  agents: AgentConsolidation[];
  branchReady: boolean;
}

export type DeliveryOutcome =
  | { status: 'delivered'; branch: string; baseBranch: string }
  | { status: 'pr-created'; prUrl: string; branch: string }
  | { status: 'manual'; epicBranch: string; baseBranch: string }
  | { status: 'failed'; error: string }
  | { status: 'dry-run' };

export interface DeliveryResult {
  epicId: string;
  validation: EpicValidation;
  branch: EpicBranchResult | null;
  outcome: DeliveryOutcome;
  dodStepsRecorded: DefinitionOfDoneStep[];
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate that an epic is ready for delivery.
 *
 * When `force` is true, DoD and task-completion checks are skipped and only
 * structural checks (epic exists, has the right type) are enforced.
 */
export function validateEpicForDelivery(
  plan: Plan,
  epicId: string,
  dodSteps: DefinitionOfDoneStep[] = ['all_tasks_done'],
  force = false,
): EpicValidation {
  const task = plan.tasks.find((t) => t.id === epicId);
  const issues: string[] = [];

  if (!task) {
    return {
      valid: false,
      epicId,
      epicTitle: epicId,
      issues: [`Epic "${epicId}" not found in plan`],
      pendingDodSteps: dodSteps,
      taskProgress: { done: 0, total: 0, failed: 0 },
    };
  }

  if (task.type !== 'epic') {
    issues.push(`Task "${epicId}" is not an epic (type: ${task.type ?? 'unset'})`);
  }

  const progress = computeParentStatus(plan, epicId);
  const taskProgress = {
    done: progress.done,
    total: progress.total,
    failed: progress.failed,
  };

  const { pending: pendingDodSteps } = evaluateDefinitionOfDone(task, plan, dodSteps);

  if (!force) {
    for (const step of pendingDodSteps) {
      if (step === 'all_tasks_done' && progress.total > 0) {
        const notDone = progress.total - progress.done;
        issues.push(`${notDone} task(s) not yet done (${progress.done}/${progress.total})`);
      } else if (step !== 'all_tasks_done') {
        issues.push(`Definition-of-done step "${step}" not satisfied`);
      }
    }
  }

  return {
    valid: issues.length === 0,
    epicId,
    epicTitle: task.title,
    issues,
    pendingDodSteps,
    taskProgress,
  };
}

// ── DoD step recording ────────────────────────────────────────────────

/**
 * Mark a definition-of-done step as satisfied on an epic task.
 * Returns true if the step was newly recorded, false if already present.
 * The caller is responsible for saving the plan afterward.
 */
export function recordDodStep(task: PlanTask, step: DefinitionOfDoneStep): boolean {
  if (!task.dod_steps_done) task.dod_steps_done = [];
  if (task.dod_steps_done.includes(step)) return false;
  task.dod_steps_done.push(step);
  task.updated_at = new Date().toISOString();
  return true;
}

// ── Epic task-ID collection ───────────────────────────────────────────

/**
 * Collect all task IDs belonging to an epic and all its descendants via BFS.
 */
export function collectEpicTaskIds(epicId: string, plan: Plan): Set<string> {
  const ids = new Set<string>();
  const queue = [epicId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    ids.add(current);
    for (const child of getChildren(plan, current)) {
      if (!ids.has(child.id)) queue.push(child.id);
    }
  }
  return ids;
}

// ── Git helpers ───────────────────────────────────────────────────────

/**
 * Return commits in `branchName` that are ahead of `origin/<mainBranch>` and
 * whose subject lines mention any of the given task IDs.
 * Results are returned in chronological order (oldest first).
 */
export async function getMatchingCommits(
  hiveRoot: string,
  branchName: string,
  mainBranch: string,
  taskIds: Set<string>,
): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const { stdout } = await exec(
      'git',
      ['log', '--format=%H %s', `origin/${mainBranch}..${branchName}`],
      { cwd: hiveRoot },
    );
    const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
    const matching: Array<{ sha: string; subject: string }> = [];
    for (const line of lines) {
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      const sha = line.slice(0, sp);
      const subject = line.slice(sp + 1);
      for (const id of taskIds) {
        if (subject.includes(id)) {
          matching.push({ sha, subject });
          break;
        }
      }
    }
    return matching.reverse();
  } catch {
    return [];
  }
}

/** Collect all commits between origin/mainBranch and branchName. */
async function getCommitList(
  hiveRoot: string,
  branchName: string,
  mainBranch: string,
): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const { stdout } = await exec(
      'git',
      ['log', '--format=%H %s', `origin/${mainBranch}..${branchName}`],
      { cwd: hiveRoot },
    );
    const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line) => {
      const idx = line.indexOf(' ');
      return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
    }).reverse();
  } catch {
    return [];
  }
}

/** Extract task IDs from commit subject lines. */
function extractTaskIds(subjects: string[]): string[] {
  const seen = new Set<string>();
  const pat1 = /\b([A-Z]{1,10}-\d+)\b/g;
  const pat2 = /\(([A-Z]{1,10}-\d+)\)/g;
  for (const s of subjects) {
    for (const m of s.matchAll(pat1)) seen.add(m[1]);
    for (const m of s.matchAll(pat2)) seen.add(m[1]);
  }
  return [...seen].sort();
}

// ── Branch consolidation ──────────────────────────────────────────────

interface AgentConsolidationInput {
  agentName: string;
  commits: Array<{ sha: string; subject: string }>;
}

/**
 * Squash-merge matching commits from each agent branch onto the epic branch.
 *
 * Creates `epic/<epicId>` from `origin/<mainBranch>` (or resets it if it
 * already exists) then cherry-picks + squashes each agent's matching commits.
 */
export async function consolidateEpicBranch(
  hiveRoot: string,
  epicId: string,
  mainBranch: string,
  agentInputs: AgentConsolidationInput[],
): Promise<EpicBranchResult> {
  const epicBranch = `epic/${epicId}`;
  const agents: AgentConsolidation[] = [];

  // Create or reset the epic branch from origin/main
  const epicExists = await exec('git', ['rev-parse', '--verify', epicBranch], { cwd: hiveRoot })
    .then(() => true)
    .catch(() => false);

  try {
    if (epicExists) {
      await exec('git', ['branch', '-f', epicBranch, `origin/${mainBranch}`], { cwd: hiveRoot });
    } else {
      await exec('git', ['branch', epicBranch, `origin/${mainBranch}`], { cwd: hiveRoot });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      epicBranch,
      agents: agentInputs.map((a) => ({
        agent: a.agentName,
        commits: a.commits.length,
        status: 'failed',
        error: `failed to create epic branch: ${msg}`,
      })),
      branchReady: false,
    };
  }

  // Process each agent
  for (const { agentName, commits } of agentInputs) {
    if (commits.length === 0) {
      agents.push({ agent: agentName, commits: 0, status: 'skipped', reason: 'no matching commits' });
      continue;
    }

    const tmpBranch = `epic/${epicId}-tmp-${agentName}`;
    const agentWorktree = join(hiveRoot, '.hive', 'worktrees', agentName);
    const workDir = existsSync(agentWorktree) ? agentWorktree : null;

    try {
      await exec('git', ['branch', '-f', tmpBranch, epicBranch], { cwd: hiveRoot });

      if (!workDir) {
        // No worktree: create a temporary one
        const tmpWorktree = join(hiveRoot, '.hive', 'state', `epic-tmp-${agentName}`);
        if (!existsSync(join(hiveRoot, '.hive', 'state'))) {
          mkdirSync(join(hiveRoot, '.hive', 'state'), { recursive: true });
        }
        try {
          await exec('git', ['worktree', 'add', '--force', tmpWorktree, tmpBranch], { cwd: hiveRoot });
          const shas = commits.map((c) => c.sha);
          await exec('git', ['cherry-pick', '--allow-empty', ...shas], { cwd: tmpWorktree });
          await exec('git', ['reset', '--soft', `HEAD~${commits.length}`], { cwd: tmpWorktree });
          await exec(
            'git',
            ['commit', '-m', `squash(${epicId}): ${agentName} — ${commits.length} task(s) merged`],
            { cwd: tmpWorktree },
          );
          await exec('git', ['branch', '-f', epicBranch, tmpBranch], { cwd: hiveRoot });
          agents.push({ agent: agentName, commits: commits.length, status: 'squashed' });
        } finally {
          try { await exec('git', ['worktree', 'remove', '--force', tmpWorktree], { cwd: hiveRoot }); } catch { /* best-effort */ }
          try { await exec('git', ['branch', '-D', tmpBranch], { cwd: hiveRoot }); } catch { /* best-effort */ }
        }
      } else {
        // Use the agent's existing worktree
        await exec('git', ['checkout', tmpBranch], { cwd: workDir });
        const shas = commits.map((c) => c.sha);
        await exec('git', ['cherry-pick', '--allow-empty', ...shas], { cwd: workDir });
        await exec('git', ['reset', '--soft', `HEAD~${commits.length}`], { cwd: workDir });
        await exec(
          'git',
          ['commit', '-m', `squash(${epicId}): ${agentName} — ${commits.length} task(s) merged`],
          { cwd: workDir },
        );
        await exec('git', ['branch', '-f', epicBranch, tmpBranch], { cwd: hiveRoot });
        await exec('git', ['checkout', `agent/${agentName}`], { cwd: workDir });
        try { await exec('git', ['branch', '-D', tmpBranch], { cwd: hiveRoot }); } catch { /* best-effort */ }
        agents.push({ agent: agentName, commits: commits.length, status: 'squashed' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      agents.push({ agent: agentName, commits: commits.length, status: 'failed', error: msg });
      // Attempt cleanup
      try { await exec('git', ['cherry-pick', '--abort'], { cwd: workDir ?? hiveRoot }); } catch { /* ignore */ }
      try { await exec('git', ['branch', '-D', tmpBranch], { cwd: hiveRoot }); } catch { /* ignore */ }
    }
  }

  const branchReady = agents.some((a) => a.status === 'squashed');
  return { epicBranch, agents, branchReady };
}

// ── Delivery strategy ─────────────────────────────────────────────────

/**
 * Run tests synchronously and return a trimmed excerpt of the output.
 */
function runTests(hiveRoot: string): { passed: boolean; output: string } {
  try {
    const raw = execFileSync('npm', ['test'], {
      cwd: hiveRoot,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, output: raw.split('\n').slice(-40).join('\n').trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const combined = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
    return { passed: false, output: combined.split('\n').slice(-40).join('\n').trim() };
  }
}

/**
 * Apply the configured delivery strategy after the epic branch is ready.
 *
 * - `auto-merge`:   Push epic branch directly onto base_branch (fast-forward).
 * - `pull-request`: Create a GitHub PR via `gh pr create`.
 * - `manual`:       Print the push command for the user.
 */
export async function applyDeliveryStrategy(
  hiveRoot: string,
  epicId: string,
  epicBranch: string,
  mainBranch: string,
  delivery: DeliveryConfig,
  dryRun = false,
): Promise<DeliveryOutcome> {
  if (dryRun) return { status: 'dry-run' };

  const baseBranch = delivery.base_branch ?? mainBranch;

  switch (delivery.strategy) {
    case 'auto-merge': {
      try {
        await exec('git', ['push', 'origin', `${epicBranch}:${baseBranch}`], { cwd: hiveRoot });
        return { status: 'delivered', branch: epicBranch, baseBranch };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', error: `auto-merge push failed: ${msg}` };
      }
    }

    case 'pull-request': {
      // Push the epic branch to origin
      try {
        await exec(
          'git', ['push', '--force-with-lease', 'origin', `${epicBranch}:${epicBranch}`],
          { cwd: hiveRoot },
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', error: `push before PR failed: ${msg}` };
      }

      // Build PR body
      const commits = await getCommitList(hiveRoot, epicBranch, baseBranch);
      const taskIds = extractTaskIds(commits.map((c) => c.subject));
      const tasksSection = taskIds.length > 0
        ? taskIds.map((id) => `- ${id}`).join('\n')
        : '_No task IDs found in commit messages._';
      const commitsSection = commits.length > 0
        ? commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`).join('\n')
        : '_No commits._';

      let testSection = '';
      if (delivery.require_ci) {
        const testResult = runTests(hiveRoot);
        const testStatus = testResult.passed ? '**PASSED**' : '**FAILED**';
        testSection = [
          '',
          '## Test Results',
          '',
          `Status: ${testStatus}`,
          '',
          '```',
          testResult.output || '_No test output captured._',
          '```',
        ].join('\n');
      }

      const prBody = [
        '## Tasks Completed',
        '',
        tasksSection,
        '',
        '## Commit Summary',
        '',
        commitsSection,
        testSection,
        '',
        '---',
        `_Created by AgentHive \`hive deliver\` for epic \`${epicId}\`_`,
      ].join('\n');

      const prTitle = `epic(${epicId}): deliver epic branch`;

      try {
        const { stdout: prUrl } = await exec(
          'gh',
          ['pr', 'create', '--base', baseBranch, '--head', epicBranch, '--title', prTitle, '--body', prBody],
          { cwd: hiveRoot },
        );
        return { status: 'pr-created', prUrl: prUrl.trim(), branch: epicBranch };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', error: `gh pr create failed: ${msg}` };
      }
    }

    case 'manual':
    default:
      return { status: 'manual', epicBranch, baseBranch };
  }
}

// ── Main orchestration ────────────────────────────────────────────────

export interface DeliveryOptions {
  dryRun?: boolean;
  /** Skip DoD and task-completion checks. */
  force?: boolean;
  /** Override the strategy from config. */
  strategy?: 'auto-merge' | 'pull-request' | 'manual';
}

/**
 * Orchestrate full epic delivery:
 *   1. Validate the epic against the plan.
 *   2. Consolidate agent commits onto the epic branch.
 *   3. Apply the delivery strategy.
 *   4. Record completed DoD steps on the epic task.
 *
 * The caller is responsible for loading and saving the plan around this call
 * (pass the loaded plan in; after the call, check `result.dodStepsRecorded`
 * and persist if non-empty).
 */
export async function orchestrateEpicDelivery(
  hiveRoot: string,
  plan: Plan,
  epicId: string,
  allAgentNames: string[],
  config: { delivery: DeliveryConfig },
  opts: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const delivery: DeliveryConfig = opts.strategy
    ? { ...config.delivery, strategy: opts.strategy }
    : config.delivery;

  const dodSteps = delivery.definition_of_done ?? ['all_tasks_done'];

  // 1. Validate
  const validation = validateEpicForDelivery(plan, epicId, dodSteps, opts.force);

  if (!validation.valid && !opts.force) {
    return {
      epicId,
      validation,
      branch: null,
      outcome: { status: 'failed', error: `Epic not ready: ${validation.issues.join('; ')}` },
      dodStepsRecorded: [],
    };
  }

  const mainBranch = await getMainBranch(hiveRoot);
  const taskIds = collectEpicTaskIds(epicId, plan);

  // Fetch latest
  try {
    await exec('git', ['fetch', 'origin'], { cwd: hiveRoot });
  } catch {
    // Continue with local state
  }

  if (opts.dryRun) {
    return {
      epicId,
      validation,
      branch: null,
      outcome: { status: 'dry-run' },
      dodStepsRecorded: [],
    };
  }

  // 2. Gather matching commits per agent
  const agentInputs: AgentConsolidationInput[] = [];
  for (const agentName of allAgentNames) {
    const branchName = `agent/${agentName}`;
    const branchExists = await exec('git', ['rev-parse', '--verify', branchName], { cwd: hiveRoot })
      .then(() => true)
      .catch(() => false);
    if (!branchExists) continue;
    const commits = await getMatchingCommits(hiveRoot, branchName, mainBranch, taskIds);
    agentInputs.push({ agentName, commits });
  }

  // 3. Consolidate epic branch
  const branch = await consolidateEpicBranch(hiveRoot, epicId, mainBranch, agentInputs);

  if (!branch.branchReady) {
    return {
      epicId,
      validation,
      branch,
      outcome: { status: 'failed', error: 'No commits were squashed onto the epic branch' },
      dodStepsRecorded: [],
    };
  }

  // 4. Apply delivery strategy
  const outcome = await applyDeliveryStrategy(
    hiveRoot, epicId, branch.epicBranch, mainBranch, delivery, opts.dryRun,
  );

  // 5. Record DoD steps on the epic task
  const epicTask = plan.tasks.find((t) => t.id === epicId);
  const dodStepsRecorded: DefinitionOfDoneStep[] = [];

  if (epicTask) {
    if (branch.branchReady) {
      // all_tasks_done is auto-computed; record other steps based on outcome
    }
    if (outcome.status === 'pr-created') {
      if (recordDodStep(epicTask, 'pr_created')) {
        dodStepsRecorded.push('pr_created');
      }
      epicTask.pr_url = (outcome as { prUrl: string }).prUrl;
      epicTask.updated_at = new Date().toISOString();
    }
    if (outcome.status === 'delivered') {
      if (recordDodStep(epicTask, 'pr_merged')) {
        dodStepsRecorded.push('pr_merged');
      }
    }
  }

  return { epicId, validation, branch, outcome, dodStepsRecorded };
}

// ── Utility ────────────────────────────────────────────────────────────

/** Determine the main branch of the repository. */
export async function getMainBranch(hiveRoot: string): Promise<string> {
  try {
    const { stdout } = await exec(
      'git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
      { cwd: hiveRoot },
    );
    return stdout.trim().replace('origin/', '');
  } catch {
    return 'main';
  }
}
