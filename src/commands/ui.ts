import { Command } from 'commander';
import { resolve } from 'node:path';
import React from 'react';
import { render } from 'ink';
import { resolveHiveRoot } from '../core/config.js';
import { App } from '../tui/App.js';

export function registerUiCommand(program: Command): void {
  program
    .command('ui')
    .alias('tui')
    .description('Launch the interactive terminal dashboard')
    .action(async () => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      // Validate that we're in a hive project
      try {
        resolveHiveRoot(cwd);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      const { waitUntilExit } = render(React.createElement(App, { cwd }));
      await waitUntilExit();
    });
}
