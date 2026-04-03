import { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveAllAgents, resolveHivePath } from '../core/config.js';
import { loadPlan, savePlan } from '../core/plan.js';
import {
  validateEpicForDelivery,
  orchestrateEpicDelivery,
  type DeliveryOptions,
} from '../core/delivery.js';

export function registerDeliverCommand(program: Command): void {
  program
    .command('deliver <epic-id>')
    .description('Orchestrate full delivery of a completed epic: consolidate branches and apply delivery strategy')
    .option('--dry-run', 'Show what would be done without making any changes')
    .option('--force', 'Skip definition-of-done checks and deliver even if tasks are incomplete')
    .option(
      '--strategy <strategy>',
      'Override delivery strategy: auto-merge | pull-request | manual',
    )
    .action(async (epicId: string, opts: { dryRun?: boolean; force?: boolean; strategy?: string }) => {
      const cwd = program.opts().cwd ? resolve(program.opts().cwd) : process.cwd();

      let hiveRoot: string;
      let config: ReturnType<typeof loadConfig>;

      try {
        hiveRoot = resolveHiveRoot(cwd);
        config = loadConfig(cwd);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${msg}`));
        process.exit(1);
      }

      const hivePath = resolveHivePath(hiveRoot);
      const plan = loadPlan(hivePath);

      if (!plan) {
        console.error(chalk.red('No plan found. Run `hive plan` to create one.'));
        process.exit(1);
      }

      const allAgents = resolveAllAgents(config, hiveRoot);
      const allAgentNames = allAgents.map((a) => a.name);

      // Validate strategy option
      const validStrategies = ['auto-merge', 'pull-request', 'manual'];
      if (opts.strategy && !validStrategies.includes(opts.strategy)) {
        console.error(
          chalk.red(`Invalid strategy "${opts.strategy}". Must be one of: ${validStrategies.join(', ')}`),
        );
        process.exit(1);
      }

      const deliveryOpts: DeliveryOptions = {
        dryRun: opts.dryRun,
        force: opts.force,
        strategy: opts.strategy as DeliveryOptions['strategy'],
      };

      console.log(chalk.bold('\n🐝 AgentHive — Deliver\n'));

      // Show validation summary up front
      const dodSteps = config.delivery.definition_of_done ?? ['all_tasks_done'];
      const validation = validateEpicForDelivery(plan, epicId, dodSteps, opts.force);

      console.log(`  Epic:     ${chalk.cyan(epicId)}`);
      if (validation.epicTitle !== epicId) {
        console.log(`  Title:    ${validation.epicTitle}`);
      }
      console.log(
        `  Progress: ${validation.taskProgress.done}/${validation.taskProgress.total} tasks done`,
      );
      console.log(`  Strategy: ${chalk.cyan(opts.strategy ?? config.delivery.strategy)}`);
      if (opts.dryRun) console.log(`  Mode:     ${chalk.yellow('dry-run')}`);
      if (opts.force) console.log(`  Mode:     ${chalk.yellow('--force (skipping DoD checks)')}`);
      console.log('');

      if (!validation.valid && !opts.force) {
        console.error(chalk.red('Epic is not ready for delivery:'));
        for (const issue of validation.issues) {
          console.error(`  ${chalk.red('✗')} ${issue}`);
        }
        console.log('');
        console.log(`  Use ${chalk.cyan('--force')} to deliver anyway.`);
        console.log('');
        process.exit(1);
      }

      console.log(chalk.gray('Consolidating epic branch...'));

      const result = await orchestrateEpicDelivery(
        hiveRoot,
        plan,
        epicId,
        allAgentNames,
        config,
        deliveryOpts,
      );

      // ── Branch consolidation summary ────────────────────────────────

      if (result.branch) {
        console.log('');
        console.log(chalk.bold('Branch consolidation:'));
        for (const a of result.branch.agents) {
          if (a.status === 'squashed') {
            console.log(`  ${chalk.green('✓')} ${chalk.bold(a.agent)} — ${a.commits} commit(s) squashed`);
          } else if (a.status === 'skipped') {
            console.log(`  ${chalk.gray('⊘')} ${chalk.bold(a.agent)} — skipped: ${a.reason}`);
          } else {
            console.log(`  ${chalk.red('✗')} ${chalk.bold(a.agent)} — failed: ${a.error}`);
          }
        }
      }

      // ── Delivery outcome ────────────────────────────────────────────

      console.log('');
      console.log(chalk.bold('Delivery outcome:'));

      switch (result.outcome.status) {
        case 'dry-run':
          console.log(`  ${chalk.yellow('⊘')} Dry run — no changes made`);
          break;

        case 'delivered':
          console.log(
            `  ${chalk.green('✓')} Merged ${chalk.cyan(result.outcome.branch)} → ${chalk.cyan(result.outcome.baseBranch)} on origin`,
          );
          break;

        case 'pr-created':
          console.log(`  ${chalk.green('✓')} Pull request created: ${chalk.cyan(result.outcome.prUrl)}`);
          if (result.dodStepsRecorded.includes('pr_created')) {
            console.log(`  ${chalk.green('✓')} DoD step "pr_created" recorded`);
          }
          break;

        case 'manual': {
          const { epicBranch, baseBranch } = result.outcome;
          console.log(`  ${chalk.yellow('→')} Branch ${chalk.cyan(epicBranch)} is ready.`);
          console.log(`     Push manually with:`);
          console.log(`       ${chalk.cyan(`git push origin ${epicBranch}`)}`);
          console.log(`     Or merge into ${chalk.cyan(baseBranch)}:`);
          console.log(`       ${chalk.cyan(`git push origin ${epicBranch}:${baseBranch}`)}`);
          break;
        }

        case 'failed':
          console.error(`  ${chalk.red('✗')} Failed: ${result.outcome.error}`);
          console.log('');
          process.exit(1);
      }

      // ── Persist plan updates ────────────────────────────────────────

      if (result.dodStepsRecorded.length > 0) {
        savePlan(hivePath, plan);
        console.log('');
        console.log(chalk.gray(`Plan updated with DoD steps: ${result.dodStepsRecorded.join(', ')}`));
      }

      console.log('');
    });
}
