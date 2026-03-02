import { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../core/config.js';
import { appendMessage, resolveChatPath, readMessages } from '../core/chat.js';
import type { MessageType } from '../types/config.js';

const VALID_TYPES = new Set<string>([
  'REQUEST', 'STATUS', 'DONE', 'QUESTION', 'BLOCKER', 'ACK', 'WARN',
]);

export function registerDispatchCommand(program: Command): void {
  program
    .command('dispatch <target> <message>')
    .description('Send a message to an agent via the chat file')
    .option('--from <role>', 'Sender role tag', 'USER')
    .option(
      '--type <type>',
      'Message type: REQUEST, STATUS, QUESTION, WARN, etc.',
      'REQUEST',
    )
    .action(async (target: string, message: string, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runDispatch(cwd, target, message, opts);
    });
}

async function runDispatch(
  cwd: string,
  target: string,
  message: string,
  opts: { from: string; type: string },
): Promise<void> {
  let config;
  let hivePath: string;
  let hiveRoot: string;

  try {
    hiveRoot = resolveHiveRoot(cwd);
    hivePath = resolveHivePath(cwd);
    config = loadConfig(cwd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }

  const allAgents = resolveAllAgents(config, hiveRoot);

  // Validate message type
  const msgType = opts.type.toUpperCase();
  if (!VALID_TYPES.has(msgType)) {
    console.error(
      chalk.red(
        `Invalid message type: "${opts.type}". Valid: ${[...VALID_TYPES].join(', ')}`,
      ),
    );
    process.exit(1);
  }

  // Resolve target role
  const targetUpper = target.toUpperCase();
  const isAll = targetUpper === 'ALL';

  if (!isAll) {
    // Check if the target matches an agent name or a role tag
    const matchByName = allAgents.find(
      (a) => a.name.toUpperCase() === targetUpper,
    );
    const matchByRole = allAgents.find(
      (a) => a.chatRole === targetUpper,
    );

    if (!matchByName && !matchByRole) {
      const available = allAgents
        .map((a) => `${a.name} (${a.chatRole})`)
        .join(', ');
      console.error(
        chalk.red(
          `Unknown target: "${target}". Available agents: ${available}`,
        ),
      );
      process.exit(1);
    }
  }

  // Build the role tag for the target
  const targetRole = isAll
    ? 'ALL'
    : allAgents.find(
        (a) =>
          a.name.toUpperCase() === targetUpper ||
          a.chatRole === targetUpper,
      )!.chatRole;

  // Build the message body
  const body =
    msgType === 'REQUEST'
      ? `@${targetRole} ${message}`
      : message;

  const senderRole = opts.from.toUpperCase();
  const chatFilePath = resolveChatPath(hivePath, config.chat.file);

  // Append message
  appendMessage(chatFilePath, senderRole, msgType as MessageType, body);

  // Confirm
  const line = `[${senderRole}] ${msgType}: ${body}`;
  console.log(chalk.green('✓ ') + chalk.gray('Appended to chat:'));
  console.log(`  ${line}`);

  // Show last few messages for context
  const messages = readMessages(chatFilePath);
  const recent = messages.slice(-3);

  if (recent.length > 1) {
    console.log('');
    console.log(chalk.gray('  Recent messages:'));
    for (const msg of recent) {
      const isNew = msg === recent[recent.length - 1];
      const prefix = isNew ? chalk.green('  → ') : chalk.gray('    ');
      console.log(`${prefix}[${msg.role}] ${msg.type}: ${truncate(msg.body, 60)}`);
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
