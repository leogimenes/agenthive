import { Command } from 'commander';
import { resolve } from 'node:path';
import { watchFile, unwatchFile } from 'node:fs';
import chalk from 'chalk';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../core/config.js';
import {
  readMessages,
  readMessagesSince,
  resolveChatPath,
  getChatLineCount,
} from '../core/chat.js';
import { formatMessage } from '../core/colors.js';
import type { ChatMessage } from '../types/config.js';

// ── Command registration ─────────────────────────────────────────────

export function registerTailCommand(program: Command): void {
  program
    .command('tail [agent]')
    .description('Show agent coordination messages from the chat file')
    .option('-n, --last <n>', 'Show last N messages', '40')
    .option('-f, --follow', 'Live follow mode (watch for new messages)')
    .option('--type <types>', 'Filter by message type (comma-separated)')
    .option('--raw', 'Show raw lines without color formatting')
    .action(async (agent: string | undefined, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runTail(cwd, agent, opts);
    });
}

// ── Tail logic ───────────────────────────────────────────────────────

async function runTail(
  cwd: string,
  agentFilter: string | undefined,
  opts: { last: string; follow?: boolean; type?: string; raw?: boolean },
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
  const chatFilePath = resolveChatPath(hivePath, config.chat.file);

  // ── Resolve filters ────────────────────────────────────────────────

  let filterRoles: Set<string> | undefined;
  if (agentFilter) {
    // Match by name or role tag
    const agent = allAgents.find(
      (a) =>
        a.name === agentFilter ||
        a.chatRole === agentFilter.toUpperCase(),
    );
    if (!agent) {
      console.error(
        chalk.red(
          `Unknown agent: "${agentFilter}". Available: ${allAgents.map((a) => a.name).join(', ')}`,
        ),
      );
      process.exit(1);
    }
    filterRoles = new Set([agent.chatRole]);
  }

  let filterTypes: Set<string> | undefined;
  if (opts.type) {
    filterTypes = new Set(
      opts.type.split(',').map((t) => t.trim().toUpperCase()),
    );
  }

  const lastN = parseInt(opts.last, 10) || 40;

  // ── Initial read ───────────────────────────────────────────────────

  let messages = readMessages(chatFilePath);
  messages = applyFilters(messages, filterRoles, filterTypes);

  const display = messages.slice(-lastN);

  // Header
  const filterDesc = agentFilter
    ? `agent: ${agentFilter}`
    : 'all agents';
  console.log(
    chalk.gray(
      `── ${config.session} · ${filterDesc} · last ${display.length} message(s) ──`,
    ),
  );
  console.log('');

  // Print messages
  for (const msg of display) {
    printMessage(msg, opts.raw);
  }

  // ── Follow mode ────────────────────────────────────────────────────

  if (!opts.follow) return;

  console.log('');
  console.log(chalk.gray('── following (Ctrl+C to stop) ──'));

  let lastLine = getChatLineCount(chatFilePath);

  watchFile(chatFilePath, { interval: 1000 }, () => {
    const currentLine = getChatLineCount(chatFilePath);
    if (currentLine <= lastLine) return;

    let newMessages = readMessagesSince(chatFilePath, lastLine);
    lastLine = currentLine;

    newMessages = applyFilters(newMessages, filterRoles, filterTypes);

    for (const msg of newMessages) {
      printMessage(msg, opts.raw);
    }
  });

  // Handle clean shutdown
  const cleanup = () => {
    unwatchFile(chatFilePath);
    console.log(chalk.gray('\n── stopped ──'));
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Block forever — waits for signal
  await new Promise(() => {});
}

// ── Helpers ─────────────────────────────────────────────────────────

function applyFilters(
  messages: ChatMessage[],
  filterRoles?: Set<string>,
  filterTypes?: Set<string>,
): ChatMessage[] {
  let result = messages;
  if (filterRoles) {
    result = result.filter((m) => filterRoles.has(m.role));
  }
  if (filterTypes) {
    result = result.filter((m) => filterTypes.has(m.type));
  }
  return result;
}

function printMessage(msg: ChatMessage, raw?: boolean): void {
  if (raw) {
    console.log(`[${msg.role}] ${msg.type}: ${msg.body}`);
  } else {
    console.log(formatMessage(msg));
  }
}
