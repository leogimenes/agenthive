#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerInitCommand } from './commands/init.js';
import { registerLaunchCommand, registerLoopCommand } from './commands/launch.js';
import { registerKillCommand } from './commands/kill.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDispatchCommand } from './commands/dispatch.js';
import { registerTailCommand } from './commands/tail.js';
import { registerConfigCommand } from './commands/config.js';
import { registerUiCommand } from './commands/ui.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerTemplatesCommand } from './commands/templates.js';
import { registerMergeCommand } from './commands/merge.js';

// Read version from package.json at dev/install time, fall back for
// standalone binaries where the filesystem layout doesn't exist.
function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
    );
    return pkg.version;
  } catch {
    return '0.1.0';
  }
}

const program = new Command();

program
  .name('hive')
  .description(
    'AgentHive — Multi-agent orchestrator for Claude Code',
  )
  .version(getVersion())
  .option('--cwd <path>', 'Override working directory');

registerInitCommand(program);
registerLaunchCommand(program);
registerLoopCommand(program);
registerKillCommand(program);
registerStatusCommand(program);
registerDispatchCommand(program);
registerTailCommand(program);
registerConfigCommand(program);
registerUiCommand(program);
registerPlanCommand(program);
registerTemplatesCommand(program);
registerMergeCommand(program);

program.parse();
