import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveAllAgents } from '../core/config.js';
import { getMainBranch } from '../core/worktree.js';
import type { ResolvedAgentConfig } from '../types/config.js';

const exec = promisify(execFile);

export function registerMergeCommand(program: Command): void {
  program
    .command('merge [agents...]')
    .description('Rebase agent branches onto main and push in order')
    .option('--dry-run', 'Show what would be merged without doing it')
    .option('--continue', 'Resume after a manually resolved conflict')
    .action(async (agents: string[], opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      if (opts.continue) {
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
