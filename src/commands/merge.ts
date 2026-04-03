import { Command } from 'commander';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveAllAgents } from '../core/config.js';
import { getMainBranch } from '../core/worktree.js';
import { loadPlan, getChildren } from '../core/plan.js';
import { resolveHivePath } from '../core/config.js';
import type { ResolvedAgentConfig, DeliveryConfig } from '../types/config.js';

const exec = promisify(execFile);

export function registerMergeCommand(program: Command): void {
  program
    .command('merge [agents...]')
    .description('Rebase agent branches onto main and push in order')
    .option('--dry-run', 'Show what would be merged without doing it')
    .option('--continue', 'Resume after a manually resolved conflict')
    .option('--epic <epicId>', 'Consolidate epic tasks into an epic/<epicId> branch via squash-merge')
    .option('--pr', 'Create a GitHub PR via gh pr create instead of pushing directly to main')
    .action(async (agents: string[], opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      if (opts.epic) {
        await runEpicMerge(cwd, opts.epic, opts);
      } else if (opts.continue) {
        await runContinue(cwd);
      } else {
        await runMerge(cwd, agents, opts);
      }
    });
}

// ── Types ──────────────────────────────────────────────────────────

interface AgentMergeInfo {
  agent: ResolvedAgentConfig;
  commitsAhead: number;
}

type MergeResult =
  | { status: 'merged'; commits: number }
  | { status: 'skipped'; reason: string }
  | { status: 'conflict'; files: string[] }
  | { status: 'failed'; error: string };

interface MergeSummary {
  name: string;
  result: MergeResult;
}

// ── State file for --continue ──────────────────────────────────────

const MERGE_STATE_FILE = 'merge-state.json';

interface MergeState {
  mainBranch: string;
  currentAgent: string;
  remainingAgents: string[];
  completedResults: MergeSummary[];
}

function mergeStatePath(hiveRoot: string): string {
  return join(hiveRoot, '.hive', 'state', MERGE_STATE_FILE);
}

function saveMergeState(hiveRoot: string, state: MergeState): void {
  const statePath = mergeStatePath(hiveRoot);
  const stateDir = join(hiveRoot, '.hive', 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadMergeState(hiveRoot: string): MergeState | null {
  const statePath = mergeStatePath(hiveRoot);
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearMergeState(hiveRoot: string): void {
  const statePath = mergeStatePath(hiveRoot);
  try {
    unlinkSync(statePath);
  } catch {
    // File may not exist
  }
}

// ── Main merge flow ────────────────────────────────────────────────

async function runMerge(
  cwd: string,
  agentFilter: string[],
  opts: { dryRun?: boolean; pr?: boolean },
): Promise<void> {
  let config;
  let hiveRoot: string;

  try {
    hiveRoot = resolveHiveRoot(cwd);
    config = loadConfig(cwd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }

  // Check for in-progress merge
  if (loadMergeState(hiveRoot)) {
    console.error(
      chalk.red('A merge is already in progress. Use `hive merge --continue` to resume or resolve the conflict and retry.'),
    );
    process.exit(1);
  }

  const mainBranch = await getMainBranch(hiveRoot);
  const allAgents = resolveAllAgents(config, hiveRoot);

  // Filter agents
  let selected: ResolvedAgentConfig[];
  if (agentFilter.length > 0) {
    selected = [];
    for (const name of agentFilter) {
      const agent = allAgents.find((a) => a.name === name);
      if (!agent) {
        console.error(
          chalk.red(`Unknown agent: "${name}". Available: ${allAgents.map((a) => a.name).join(', ')}`),
        );
        process.exit(1);
      }
      selected.push(agent);
    }
  } else {
    // No filter — all agents alphabetically
    selected = [...allAgents].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Fetch latest
  console.log(chalk.gray('Fetching from origin...'));
  try {
    await exec('git', ['fetch', 'origin'], { cwd: hiveRoot });
  } catch {
    console.error(chalk.red('Failed to fetch from origin. Continuing with local state.'));
  }

  // Determine which agents have commits ahead of main
  const mergeable: AgentMergeInfo[] = [];
  const skipped: MergeSummary[] = [];

  for (const agent of selected) {
    const branchName = `agent/${agent.name}`;

    // Check if branch exists
    try {
      await exec('git', ['rev-parse', '--verify', branchName], { cwd: hiveRoot });
    } catch {
      skipped.push({ name: agent.name, result: { status: 'skipped', reason: 'branch does not exist' } });
      continue;
    }

    // Check worktree is clean
    const worktreePath = agent.worktreePath;
    if (existsSync(worktreePath)) {
      try {
        const { stdout: statusOut } = await exec(
          'git', ['status', '--porcelain'], { cwd: worktreePath },
        );
        if (statusOut.trim().length > 0) {
          skipped.push({ name: agent.name, result: { status: 'skipped', reason: 'worktree has uncommitted changes' } });
          continue;
        }
      } catch {
        // Can't check status — worktree might not exist as a directory
      }
    }

    // Count commits ahead
    try {
      const { stdout: logOut } = await exec(
        'git', ['log', '--oneline', `origin/${mainBranch}..${branchName}`],
        { cwd: hiveRoot },
      );
      const commits = logOut.trim().split('\n').filter((l) => l.length > 0);
      if (commits.length === 0) {
        skipped.push({ name: agent.name, result: { status: 'skipped', reason: 'no new commits' } });
        continue;
      }
      mergeable.push({ agent, commitsAhead: commits.length });
    } catch {
      skipped.push({ name: agent.name, result: { status: 'skipped', reason: 'could not compare with main' } });
      continue;
    }
  }

  if (mergeable.length === 0) {
    console.log(chalk.bold('\n🐝 AgentHive — Merge\n'));
    console.log(chalk.gray('No agents have commits to merge.\n'));
    for (const s of skipped) {
      if (s.result.status === 'skipped') {
        console.log(`  ${chalk.gray('⊘')} ${chalk.bold(s.name)} — ${s.result.reason}`);
      }
    }
    console.log('');
    return;
  }

  // ── Dry run ──────────────────────────────────────────────────────

  console.log(chalk.bold('\n🐝 AgentHive — Merge\n'));

  if (opts.dryRun) {
    console.log(chalk.gray('Dry run — no changes will be made.\n'));
    for (const { agent, commitsAhead } of mergeable) {
      console.log(
        `  ${chalk.green('→')} ${chalk.bold(agent.name)} — ${commitsAhead} commit(s) ahead of ${mainBranch}`,
      );
    }
    for (const s of skipped) {
      if (s.result.status === 'skipped') {
        console.log(`  ${chalk.gray('⊘')} ${chalk.bold(s.name)} — ${s.result.reason}`);
      }
    }
    console.log('');
    return;
  }

  // ── PR mode ──────────────────────────────────────────────────────

  if (opts.pr) {
    console.log(`Creating PRs for ${mergeable.length} agent(s) against ${chalk.cyan(mainBranch)}:\n`);

    for (const { agent, commitsAhead } of mergeable) {
      const branchName = `agent/${agent.name}`;
      console.log(`  ${chalk.bold(agent.name)} (${commitsAhead} commit(s))...`);

      const commits = await getCommitList(hiveRoot, branchName, mainBranch);
      const prInfo: PRAgentInfo = { agentName: agent.name, branchName, commits, commitsAhead };
      const result = await mergeAgentAsPR(hiveRoot, prInfo, mainBranch);

      if (result.status === 'pr-created') {
        console.log(`    ${chalk.green('✓')} PR created: ${chalk.cyan(result.prUrl)}`);
      } else {
        console.log(`    ${chalk.red('✗')} Failed: ${result.error}`);
      }
    }

    console.log('');
    console.log(chalk.bold('Summary:'));
    for (const { name, result } of skipped) {
      if (result.status === 'skipped') {
        console.log(`  ${chalk.gray('⊘')} ${chalk.bold(name)} — skipped: ${result.reason}`);
      }
    }
    console.log('');
    return;
  }

  // ── Execute merges ───────────────────────────────────────────────

  console.log(`Merging ${mergeable.length} agent(s) onto ${chalk.cyan(mainBranch)}:\n`);

  const results: MergeSummary[] = [...skipped];

  for (let i = 0; i < mergeable.length; i++) {
    const { agent, commitsAhead } = mergeable[i];
    const branchName = `agent/${agent.name}`;
    const remaining = mergeable.slice(i + 1).map((m) => m.agent.name);

    console.log(`  ${chalk.bold(agent.name)} (${commitsAhead} commit(s))...`);

    const result = await mergeAgent(hiveRoot, branchName, mainBranch, commitsAhead);

    if (result.status === 'conflict') {
      // Save state for --continue
      saveMergeState(hiveRoot, {
        mainBranch,
        currentAgent: agent.name,
        remainingAgents: remaining,
        completedResults: results,
      });

      console.log(`    ${chalk.red('✗')} Rebase conflict`);
      console.log(chalk.yellow('\n  Conflict files:'));
      for (const f of result.files) {
        console.log(`    ${chalk.yellow(f)}`);
      }
      console.log('');
      console.log(`  The rebase is paused in the agent worktree.`);
      console.log(`  To resolve:`);
      console.log(`    1. cd ${chalk.cyan(agent.worktreePath)}`);
      console.log(`    2. Fix the conflicts and run ${chalk.cyan('git add <files>')}`);
      console.log(`    3. Run ${chalk.cyan('git rebase --continue')}`);
      console.log(`    4. Run ${chalk.cyan('hive merge --continue')} to resume the sequence`);
      console.log('');
      console.log(`  Or abort with: ${chalk.cyan(`cd ${agent.worktreePath} && git rebase --abort`)}`);
      console.log('');

      results.push({ name: agent.name, result });
      printSummary(results);
      process.exit(1);
    }

    results.push({ name: agent.name, result });

    if (result.status === 'merged') {
      console.log(`    ${chalk.green('✓')} Merged ${result.commits} commit(s)`);
    } else if (result.status === 'failed') {
      console.log(`    ${chalk.red('✗')} Failed: ${result.error}`);
    }
  }

  console.log('');
  printSummary(results);
}

// ── Continue after conflict resolution ─────────────────────────────

async function runContinue(cwd: string): Promise<void> {
  let config;
  let hiveRoot: string;

  try {
    hiveRoot = resolveHiveRoot(cwd);
    config = loadConfig(cwd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }

  const state = loadMergeState(hiveRoot);
  if (!state) {
    console.error(chalk.red('No merge in progress. Nothing to continue.'));
    process.exit(1);
  }

  const allAgents = resolveAllAgents(config, hiveRoot);
  const currentAgent = allAgents.find((a) => a.name === state.currentAgent);

  if (!currentAgent) {
    console.error(chalk.red(`Agent "${state.currentAgent}" no longer exists in config.`));
    clearMergeState(hiveRoot);
    process.exit(1);
  }

  console.log(chalk.bold('\n🐝 AgentHive — Merge (continue)\n'));

  const branchName = `agent/${currentAgent.name}`;
  const results: MergeSummary[] = [...state.completedResults];

  // Check if the rebase is still in progress
  const worktreePath = currentAgent.worktreePath;
  const rebaseInProgress = existsSync(join(worktreePath, '.git', 'rebase-merge'))
    || existsSync(join(worktreePath, '.git', 'rebase-apply'));

  // For worktrees, .git is a file pointing to the main repo, so check the main repo too
  let rebaseDirInProgress = rebaseInProgress;
  if (!rebaseDirInProgress) {
    try {
      const { stdout: gitDir } = await exec(
        'git', ['rev-parse', '--git-dir'], { cwd: worktreePath },
      );
      const dir = gitDir.trim();
      rebaseDirInProgress = existsSync(join(dir, 'rebase-merge'))
        || existsSync(join(dir, 'rebase-apply'));
    } catch {
      // Couldn't determine git dir
    }
  }

  if (rebaseDirInProgress) {
    console.error(
      chalk.red(`Rebase still in progress in ${worktreePath}.`),
    );
    console.log(`  Resolve conflicts and run ${chalk.cyan('git rebase --continue')} first.`);
    console.log('');
    process.exit(1);
  }

  // Push the resolved rebase to main
  console.log(`  ${chalk.bold(currentAgent.name)} (continuing after conflict resolution)...`);

  try {
    await exec(
      'git', ['push', 'origin', `${branchName}:${state.mainBranch}`],
      { cwd: worktreePath },
    );
    results.push({ name: currentAgent.name, result: { status: 'merged', commits: 0 } });
    console.log(`    ${chalk.green('✓')} Pushed to ${state.mainBranch}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: currentAgent.name, result: { status: 'failed', error: msg } });
    console.log(`    ${chalk.red('✗')} Push failed: ${msg}`);
    clearMergeState(hiveRoot);
    console.log('');
    printSummary(results);
    process.exit(1);
  }

  // Continue with remaining agents
  clearMergeState(hiveRoot);

  if (state.remainingAgents.length > 0) {
    // Fetch latest after the push
    try {
      await exec('git', ['fetch', 'origin'], { cwd: hiveRoot });
    } catch {
      // Continue anyway
    }

    for (const name of state.remainingAgents) {
      const agent = allAgents.find((a) => a.name === name);
      if (!agent) {
        results.push({ name, result: { status: 'skipped', reason: 'agent no longer in config' } });
        continue;
      }

      const agentBranch = `agent/${name}`;

      // Count commits ahead
      let commitsAhead = 0;
      try {
        const { stdout: logOut } = await exec(
          'git', ['log', '--oneline', `origin/${state.mainBranch}..${agentBranch}`],
          { cwd: hiveRoot },
        );
        const commits = logOut.trim().split('\n').filter((l) => l.length > 0);
        commitsAhead = commits.length;
      } catch {
        results.push({ name, result: { status: 'skipped', reason: 'could not compare with main' } });
        continue;
      }

      if (commitsAhead === 0) {
        results.push({ name, result: { status: 'skipped', reason: 'no new commits' } });
        console.log(`  ${chalk.gray('⊘')} ${chalk.bold(name)} — no new commits (already merged?)`);
        continue;
      }

      console.log(`  ${chalk.bold(name)} (${commitsAhead} commit(s))...`);

      const result = await mergeAgent(hiveRoot, agentBranch, state.mainBranch, commitsAhead);

      if (result.status === 'conflict') {
        saveMergeState(hiveRoot, {
          mainBranch: state.mainBranch,
          currentAgent: name,
          remainingAgents: state.remainingAgents.slice(state.remainingAgents.indexOf(name) + 1),
          completedResults: results,
        });

        console.log(`    ${chalk.red('✗')} Rebase conflict`);
        console.log(chalk.yellow('\n  Conflict files:'));
        for (const f of result.files) {
          console.log(`    ${chalk.yellow(f)}`);
        }
        console.log('');
        console.log(`  Resolve and run ${chalk.cyan('hive merge --continue')} again.`);
        console.log('');

        results.push({ name, result });
        printSummary(results);
        process.exit(1);
      }

      results.push({ name, result });

      if (result.status === 'merged') {
        console.log(`    ${chalk.green('✓')} Merged ${result.commits} commit(s)`);
      } else if (result.status === 'failed') {
        console.log(`    ${chalk.red('✗')} Failed: ${result.error}`);
      }
    }
  }

  console.log('');
  printSummary(results);
}

// ── Single agent merge ─────────────────────────────────────────────

async function mergeAgent(
  hiveRoot: string,
  branchName: string,
  mainBranch: string,
  commitsAhead: number,
): Promise<MergeResult> {
  // Determine worktree path from branch name
  const agentName = branchName.replace('agent/', '');
  const worktreePath = join(hiveRoot, '.hive', 'worktrees', agentName);

  // Use the worktree if it exists, otherwise use the main repo
  const workDir = existsSync(worktreePath) ? worktreePath : hiveRoot;

  try {
    // Rebase onto main
    if (workDir === worktreePath) {
      await exec('git', ['fetch', 'origin'], { cwd: workDir });
      await exec('git', ['rebase', `origin/${mainBranch}`], { cwd: workDir });
    } else {
      // Working from main repo — checkout the branch temporarily is risky
      // Use worktree approach: the branch should have a worktree
      return { status: 'failed', error: `No worktree found at ${worktreePath}` };
    }

    // Push to main (fast-forward)
    await exec(
      'git', ['push', 'origin', `${branchName}:${mainBranch}`],
      { cwd: workDir },
    );

    return { status: 'merged', commits: commitsAhead };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Check if this is a rebase conflict
    if (message.includes('CONFLICT') || message.includes('could not apply')) {
      let conflictFiles: string[] = [];
      try {
        const { stdout } = await exec(
          'git', ['diff', '--name-only', '--diff-filter=U'],
          { cwd: workDir },
        );
        conflictFiles = stdout.split('\n').filter((f) => f.trim().length > 0);
      } catch {
        // Can't get conflict files
      }

      // Don't abort — leave the rebase paused for the user
      return { status: 'conflict', files: conflictFiles };
    }

    // Non-conflict failure — abort rebase if in progress
    try {
      await exec('git', ['rebase', '--abort'], { cwd: workDir });
    } catch {
      // Not in rebase state
    }

    return { status: 'failed', error: message };
  }
}

// ── Epic branch consolidation ──────────────────────────────────────

/**
 * Collect all task IDs that belong to an epic (including descendants).
 */
function collectEpicTaskIds(epicId: string, hivePath: string): Set<string> {
  const plan = loadPlan(hivePath);
  const ids = new Set<string>();
  if (!plan) return ids;

  const epicTask = plan.tasks.find((t) => t.id === epicId);
  if (!epicTask) return ids;

  // BFS: collect epic + all descendants
  const queue = [epicId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    ids.add(current);
    const children = getChildren(plan, current);
    for (const child of children) {
      if (!ids.has(child.id)) {
        queue.push(child.id);
      }
    }
  }

  return ids;
}

/**
 * Get commits in an agent branch that reference any of the given task IDs.
 * Returns array of { sha, subject } for matching commits.
 */
async function getMatchingCommits(
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
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      const sha = line.slice(0, spaceIdx);
      const subject = line.slice(spaceIdx + 1);

      for (const id of taskIds) {
        if (subject.includes(id)) {
          matching.push({ sha, subject });
          break;
        }
      }
    }

    // Return in chronological order (log gives newest first)
    return matching.reverse();
  } catch {
    return [];
  }
}

interface EpicAgentResult {
  agent: string;
  commits: Array<{ sha: string; subject: string }>;
  status: 'squashed' | 'skipped' | 'failed' | 'dry-run';
  reason?: string;
  error?: string;
}

async function runEpicMerge(
  cwd: string,
  epicId: string,
  opts: { dryRun?: boolean },
): Promise<void> {
  let config;
  let hiveRoot: string;

  try {
    hiveRoot = resolveHiveRoot(cwd);
    config = loadConfig(cwd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }

  const hivePath = resolveHivePath(hiveRoot);
  const taskIds = collectEpicTaskIds(epicId, hivePath);

  if (taskIds.size === 0) {
    console.error(chalk.red(`Epic "${epicId}" not found in plan.`));
    process.exit(1);
  }

  const epicBranch = `epic/${epicId}`;
  const mainBranch = await getMainBranch(hiveRoot);

  console.log(chalk.bold(`\n🐝 AgentHive — Epic Merge\n`));
  console.log(`  Epic:       ${chalk.cyan(epicId)}`);
  console.log(`  Branch:     ${chalk.cyan(epicBranch)}`);
  console.log(`  Tasks:      ${[...taskIds].join(', ')}`);
  console.log(`  Base:       ${chalk.cyan(mainBranch)}\n`);

  // Fetch latest
  console.log(chalk.gray('Fetching from origin...'));
  try {
    await exec('git', ['fetch', 'origin'], { cwd: hiveRoot });
  } catch {
    console.error(chalk.yellow('Warning: failed to fetch from origin.'));
  }

  const allAgents = resolveAllAgents(config, hiveRoot);
  const results: EpicAgentResult[] = [];

  // Scan all agent branches for matching commits
  for (const agent of allAgents) {
    const branchName = `agent/${agent.name}`;

    // Verify branch exists
    try {
      await exec('git', ['rev-parse', '--verify', branchName], { cwd: hiveRoot });
    } catch {
      results.push({ agent: agent.name, commits: [], status: 'skipped', reason: 'branch does not exist' });
      continue;
    }

    const matching = await getMatchingCommits(hiveRoot, branchName, mainBranch, taskIds);

    if (matching.length === 0) {
      results.push({ agent: agent.name, commits: [], status: 'skipped', reason: 'no matching commits' });
      continue;
    }

    results.push({ agent: agent.name, commits: matching, status: opts.dryRun ? 'dry-run' : 'squashed' });
  }

  const toMerge = results.filter((r) => r.status === 'squashed' || r.status === 'dry-run');

  if (toMerge.length === 0) {
    console.log(chalk.gray('No commits found matching epic task IDs.\n'));
    for (const r of results) {
      console.log(`  ${chalk.gray('⊘')} ${chalk.bold(r.agent)} — ${r.reason}`);
    }
    console.log('');
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.gray('Dry run — no changes will be made.\n'));
    for (const r of results) {
      if (r.status === 'dry-run') {
        console.log(`  ${chalk.green('→')} ${chalk.bold(r.agent)} — ${r.commits.length} commit(s):`);
        for (const c of r.commits) {
          console.log(`      ${chalk.gray(c.sha.slice(0, 7))} ${c.subject}`);
        }
      } else {
        console.log(`  ${chalk.gray('⊘')} ${chalk.bold(r.agent)} — ${r.reason}`);
      }
    }
    console.log('');
    return;
  }

  // Create or reset the epic branch from origin/main
  const epicExists = await exec('git', ['rev-parse', '--verify', epicBranch], { cwd: hiveRoot }).then(() => true).catch(() => false);

  try {
    if (epicExists) {
      // Reset the epic branch to origin/main
      await exec('git', ['branch', '-f', epicBranch, `origin/${mainBranch}`], { cwd: hiveRoot });
      console.log(`  ${chalk.gray('↺')} Reset ${epicBranch} to origin/${mainBranch}`);
    } else {
      await exec('git', ['branch', epicBranch, `origin/${mainBranch}`], { cwd: hiveRoot });
      console.log(`  ${chalk.green('+')} Created ${epicBranch} from origin/${mainBranch}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to create/reset epic branch: ${msg}`));
    process.exit(1);
  }

  // For each agent, cherry-pick matching commits then squash into one commit
  for (const r of results) {
    if (r.status !== 'squashed') continue;

    console.log(`\n  ${chalk.bold(r.agent)} — squash-merging ${r.commits.length} commit(s)...`);

    // Create a temporary branch for this agent's cherry-picks
    const tmpBranch = `epic/${epicId}-tmp-${r.agent}`;

    try {
      // Create tmp branch from current epic branch tip
      await exec('git', ['branch', '-f', tmpBranch, epicBranch], { cwd: hiveRoot });

      // We need a worktree or temp checkout to cherry-pick
      // Use the agent's worktree if it exists, otherwise create a temp worktree
      const agentWorktree = join(hiveRoot, '.hive', 'worktrees', r.agent);
      const workDir = existsSync(agentWorktree) ? agentWorktree : null;

      if (!workDir) {
        // Create a temp worktree
        const tmpWorktree = join(hiveRoot, '.hive', 'state', `epic-tmp-${r.agent}`);
        try {
          await exec('git', ['worktree', 'add', '--force', tmpWorktree, tmpBranch], { cwd: hiveRoot });

          // Cherry-pick matching commits in order
          const shas = r.commits.map((c) => c.sha);
          await exec('git', ['cherry-pick', '--allow-empty', ...shas], { cwd: tmpWorktree });

          // Squash all cherry-picked commits into one
          const commitCount = r.commits.length;
          await exec(
            'git',
            ['reset', '--soft', `HEAD~${commitCount}`],
            { cwd: tmpWorktree },
          );
          await exec(
            'git',
            ['commit', '-m', `squash(${epicId}): ${r.agent} — ${commitCount} task(s) merged`],
            { cwd: tmpWorktree },
          );

          // Fast-forward epic branch to tmp branch
          await exec('git', ['branch', '-f', epicBranch, tmpBranch], { cwd: hiveRoot });

          results[results.indexOf(r)].status = 'squashed';
          console.log(`    ${chalk.green('✓')} Squashed ${commitCount} commit(s)`);
        } finally {
          // Clean up temp worktree
          try {
            await exec('git', ['worktree', 'remove', '--force', tmpWorktree], { cwd: hiveRoot });
          } catch {
            // Best effort
          }
          try {
            await exec('git', ['branch', '-D', tmpBranch], { cwd: hiveRoot });
          } catch {
            // Best effort
          }
        }
      } else {
        // Use the existing agent worktree: checkout the tmp branch there
        await exec('git', ['checkout', tmpBranch], { cwd: workDir });

        const shas = r.commits.map((c) => c.sha);
        await exec('git', ['cherry-pick', '--allow-empty', ...shas], { cwd: workDir });

        const commitCount = r.commits.length;
        await exec('git', ['reset', '--soft', `HEAD~${commitCount}`], { cwd: workDir });
        await exec(
          'git',
          ['commit', '-m', `squash(${epicId}): ${r.agent} — ${commitCount} task(s) merged`],
          { cwd: workDir },
        );

        // Fast-forward epic branch
        await exec('git', ['branch', '-f', epicBranch, tmpBranch], { cwd: hiveRoot });

        // Restore agent worktree to its own branch
        const agentBranch = `agent/${r.agent}`;
        await exec('git', ['checkout', agentBranch], { cwd: workDir });

        console.log(`    ${chalk.green('✓')} Squashed ${commitCount} commit(s)`);

        // Clean up tmp branch
        try {
          await exec('git', ['branch', '-D', tmpBranch], { cwd: hiveRoot });
        } catch {
          // Best effort
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results[results.indexOf(r)].status = 'failed';
      results[results.indexOf(r)].error = msg;
      console.log(`    ${chalk.red('✗')} Failed: ${msg}`);

      // Attempt cleanup
      try {
        await exec('git', ['cherry-pick', '--abort'], { cwd: hiveRoot });
      } catch { /* ignore */ }
      try {
        await exec('git', ['branch', '-D', `epic/${epicId}-tmp-${r.agent}`], { cwd: hiveRoot });
      } catch { /* ignore */ }
    }
  }

  console.log('');
  console.log(chalk.bold('Summary:'));

  for (const r of results) {
    if (r.status === 'squashed') {
      console.log(`  ${chalk.green('✓')} ${chalk.bold(r.agent)} — ${r.commits.length} commit(s) squashed`);
    } else if (r.status === 'skipped') {
      console.log(`  ${chalk.gray('⊘')} ${chalk.bold(r.agent)} — skipped: ${r.reason}`);
    } else if (r.status === 'failed') {
      console.log(`  ${chalk.red('✗')} ${chalk.bold(r.agent)} — failed: ${r.error}`);
    }
  }

  const successCount = results.filter((r) => r.status === 'squashed').length;
  if (successCount > 0) {
    console.log('');
    await applyDeliveryStrategy(hiveRoot, epicBranch, mainBranch, config.delivery);
  }
  console.log('');
}

// ── Delivery strategy ──────────────────────────────────────────────

/**
 * Apply the configured delivery strategy after an epic branch is ready.
 *
 * - auto-merge:   Push the epic branch directly onto base_branch (fast-forward).
 * - pull-request: Create a GitHub PR via `gh pr create`.
 * - manual:       Print instructions for the user to push manually.
 */
async function applyDeliveryStrategy(
  hiveRoot: string,
  epicBranch: string,
  mainBranch: string,
  delivery: DeliveryConfig,
): Promise<void> {
  const baseBranch = delivery.base_branch ?? mainBranch;

  switch (delivery.strategy) {
    case 'auto-merge': {
      console.log(chalk.bold(`  Delivery strategy: ${chalk.cyan('auto-merge')}`));
      console.log(`  Pushing ${chalk.cyan(epicBranch)} → ${chalk.cyan(baseBranch)}...`);
      try {
        await exec('git', ['push', 'origin', `${epicBranch}:${baseBranch}`], { cwd: hiveRoot });
        console.log(`  ${chalk.green('✓')} Merged into ${chalk.cyan(baseBranch)} on origin`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${chalk.red('✗')} Auto-merge failed: ${msg}`);
        console.log(`  Push manually: ${chalk.cyan(`git push origin ${epicBranch}:${baseBranch}`)}`);
      }
      break;
    }

    case 'pull-request': {
      console.log(chalk.bold(`  Delivery strategy: ${chalk.cyan('pull-request')}`));
      console.log(`  Pushing ${chalk.cyan(epicBranch)} to origin and creating PR...`);

      // Push the epic branch to origin
      try {
        await exec('git', ['push', '--force-with-lease', 'origin', `${epicBranch}:${epicBranch}`], { cwd: hiveRoot });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${chalk.red('✗')} Push failed: ${msg}`);
        break;
      }

      // Build commit summary for PR body
      let commits: Array<{ sha: string; subject: string }> = [];
      try {
        commits = await getCommitList(hiveRoot, epicBranch, baseBranch);
      } catch {
        // Best-effort
      }

      const taskIds = extractTaskIds(commits.map((c) => c.subject));
      const tasksSection = taskIds.length > 0
        ? taskIds.map((id) => `- ${id}`).join('\n')
        : '_No task IDs found in commit messages._';
      const commitsSection = commits.length > 0
        ? commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`).join('\n')
        : '_No commits._';

      const prBody = [
        '## Tasks Completed',
        '',
        tasksSection,
        '',
        '## Commit Summary',
        '',
        commitsSection,
        '',
        '---',
        `_Created by AgentHive \`hive merge --epic\` with strategy \`pull-request\`_`,
      ].join('\n');

      const prTitle = `epic(${epicBranch.replace('epic/', '')}): deliver epic branch`;

      try {
        const { stdout: prUrl } = await exec(
          'gh',
          ['pr', 'create', '--base', baseBranch, '--head', epicBranch, '--title', prTitle, '--body', prBody],
          { cwd: hiveRoot },
        );
        console.log(`  ${chalk.green('✓')} PR created: ${chalk.cyan(prUrl.trim())}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${chalk.red('✗')} PR creation failed: ${msg}`);
        console.log(`  Create PR manually: ${chalk.cyan(`gh pr create --base ${baseBranch} --head ${epicBranch}`)}`);
      }
      break;
    }

    case 'manual':
    default: {
      console.log(`  Branch ${chalk.cyan(epicBranch)} is ready. Push with:`);
      console.log(`    ${chalk.cyan(`git push origin ${epicBranch}`)}`);
      if (delivery.strategy !== 'manual') {
        console.log(chalk.gray(`  (delivery.strategy is "${delivery.strategy}" — treated as manual)`));
      }
      break;
    }
  }
}

// ── PR creation helpers ────────────────────────────────────────────

/** Extract task IDs from commit subjects (e.g. BE-25, US-003, feat(BE-24): ...) */
function extractTaskIds(subjects: string[]): string[] {
  const seen = new Set<string>();
  const taskPattern = /\b([A-Z]{1,10}-\d+)\b/g;
  const scopePattern = /\(([A-Z]{1,10}-\d+)\)/g;
  for (const s of subjects) {
    for (const m of s.matchAll(taskPattern)) seen.add(m[1]);
    for (const m of s.matchAll(scopePattern)) seen.add(m[1]);
  }
  return [...seen].sort();
}

/** Run tests and return a trimmed excerpt of the output. */
function runTestsForPR(hiveRoot: string): { passed: boolean; output: string } {
  try {
    const raw = execFileSync('npm', ['test'], {
      cwd: hiveRoot,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = raw.split('\n').slice(-40).join('\n').trim();
    return { passed: true, output: lines };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    const combined = ((e.stdout ?? '') + '\n' + (e.stderr ?? '')).trim();
    const lines = combined.split('\n').slice(-40).join('\n').trim();
    return { passed: false, output: lines };
  }
}

interface PRAgentInfo {
  agentName: string;
  branchName: string;
  commits: Array<{ sha: string; subject: string }>;
  commitsAhead: number;
}

/** Collect commit list for a branch relative to mainBranch. */
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

/** Build the PR body markdown. */
function buildPRBody(
  agentName: string,
  mainBranch: string,
  commits: Array<{ sha: string; subject: string }>,
  testResult: { passed: boolean; output: string },
): string {
  const taskIds = extractTaskIds(commits.map((c) => c.subject));

  const tasksSection = taskIds.length > 0
    ? taskIds.map((id) => `- ${id}`).join('\n')
    : '_No task IDs found in commit messages._';

  const commitsSection = commits.length > 0
    ? commits.map((c) => `- \`${c.sha.slice(0, 7)}\` ${c.subject}`).join('\n')
    : '_No commits._';

  const testStatus = testResult.passed ? 'PASSED' : 'FAILED';
  const testBlock = testResult.output
    ? `\`\`\`\n${testResult.output}\n\`\`\``
    : '_No test output captured._';

  return [
    `## Tasks Completed`,
    '',
    tasksSection,
    '',
    `## Commit Summary`,
    '',
    `Agent \`${agentName}\` — ${commits.length} commit(s) onto \`${mainBranch}\`:`,
    '',
    commitsSection,
    '',
    `## Test Results`,
    '',
    `**Status:** ${testStatus}`,
    '',
    testBlock,
    '',
    '---',
    '_Created by AgentHive `hive merge --pr`_',
  ].join('\n');
}

/** Rebase branch onto main, push the agent branch (not to main), then create a PR. */
async function mergeAgentAsPR(
  hiveRoot: string,
  info: PRAgentInfo,
  mainBranch: string,
): Promise<{ status: 'pr-created'; prUrl: string } | { status: 'failed'; error: string }> {
  const worktreePath = join(hiveRoot, '.hive', 'worktrees', info.agentName);
  const workDir = existsSync(worktreePath) ? worktreePath : null;

  if (!workDir) {
    return { status: 'failed', error: `No worktree found at ${worktreePath}` };
  }

  try {
    // Rebase onto main
    await exec('git', ['fetch', 'origin'], { cwd: workDir });
    await exec('git', ['rebase', `origin/${mainBranch}`], { cwd: workDir });

    // Push the rebased agent branch to origin (not to main)
    await exec('git', ['push', '--force-with-lease', 'origin', `${info.branchName}:${info.branchName}`], { cwd: workDir });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await exec('git', ['rebase', '--abort'], { cwd: workDir });
    } catch { /* not in rebase */ }
    return { status: 'failed', error: message };
  }

  // Run tests
  console.log(chalk.gray('    Running tests...'));
  const testResult = runTestsForPR(hiveRoot);

  // Get updated commit list (post-rebase)
  const commits = await getCommitList(hiveRoot, info.branchName, mainBranch);

  // Build PR body
  const body = buildPRBody(info.agentName, mainBranch, commits, testResult);
  const title = `feat(${info.agentName}): ${commits.length} task(s) merged [agent/${info.agentName}]`;

  try {
    const { stdout: prUrl } = await exec(
      'gh',
      [
        'pr', 'create',
        '--base', mainBranch,
        '--head', info.branchName,
        '--title', title,
        '--body', body,
      ],
      { cwd: hiveRoot },
    );
    return { status: 'pr-created', prUrl: prUrl.trim() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: `gh pr create failed: ${message}` };
  }
}

// ── Summary ────────────────────────────────────────────────────────

function printSummary(results: MergeSummary[]): void {
  console.log(chalk.bold('Summary:'));

  for (const { name, result } of results) {
    switch (result.status) {
      case 'merged':
        console.log(`  ${chalk.green('✓')} ${chalk.bold(name)} — ${result.commits} commit(s) merged`);
        break;
      case 'skipped':
        console.log(`  ${chalk.gray('⊘')} ${chalk.bold(name)} — skipped: ${result.reason}`);
        break;
      case 'conflict':
        console.log(`  ${chalk.red('✗')} ${chalk.bold(name)} — conflict (${result.files.length} file(s))`);
        break;
      case 'failed':
        console.log(`  ${chalk.red('✗')} ${chalk.bold(name)} — failed: ${result.error}`);
        break;
    }
  }

  console.log('');
}
