import { Command } from 'commander';
import { resolve } from 'node:path';
import { watch } from 'chokidar';
import chalk from 'chalk';
import {
  loadConfig,
  resolveHiveRoot,
  resolveAllAgents,
} from '../core/config.js';
import { getRoleColor } from '../core/colors.js';
import {
  findTranscriptDir,
  listSessions,
  parseTranscript,
  getToolIcon,
  formatDuration,
} from '../core/transcripts.js';
import type { TranscriptEvent, SessionInfo } from '../core/transcripts.js';

// ── Command registration ─────────────────────────────────────────────

export function registerLogsCommand(program: Command): void {
  program
    .command('logs [agent]')
    .description(
      "Show Claude Code transcript events (tool calls, edits, thinking)",
    )
    .option('-n, --last <n>', 'Show last N events', '30')
    .option('-l, --list', 'List all sessions per agent')
    .option('-s, --session <id>', 'Show a specific session by ID')
    .option('-f, --follow', 'Live-tail the active transcript file')
    .option('--json', 'Output as JSON')
    .action(async (agent: string | undefined, opts) => {
      const cwd = program.opts().cwd
        ? resolve(program.opts().cwd)
        : process.cwd();

      await runLogs(cwd, agent, opts);
    });
}

// ── Main logic ───────────────────────────────────────────────────────

async function runLogs(
  cwd: string,
  agentFilter: string | undefined,
  opts: {
    last: string;
    list?: boolean;
    session?: string;
    follow?: boolean;
    json?: boolean;
  },
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

  const allAgents = resolveAllAgents(config, hiveRoot);

  // Resolve which agents to show
  const agents = agentFilter
    ? allAgents.filter(
        (a) =>
          a.name === agentFilter ||
          a.chatRole === agentFilter.toUpperCase(),
      )
    : allAgents;

  if (agents.length === 0) {
    console.error(
      chalk.red(
        `Unknown agent: "${agentFilter}". Available: ${allAgents.map((a) => a.name).join(', ')}`,
      ),
    );
    process.exit(1);
  }

  // Build agent → transcript dir mapping
  const agentDirs = new Map<string, string>();
  for (const agent of agents) {
    const dir = findTranscriptDir(agent.worktreePath);
    if (dir) {
      agentDirs.set(agent.name, dir);
    }
  }

  // Also check the main repo path
  const mainDir = findTranscriptDir(hiveRoot);
  if (mainDir && !agentFilter) {
    // Include main repo transcripts if not filtering by agent
    agentDirs.set('(main)', mainDir);
  }

  if (agentDirs.size === 0) {
    console.error(
      chalk.yellow(
        'No Claude Code transcripts found. Transcripts appear after agents run Claude Code.',
      ),
    );
    process.exit(0);
  }

  // ── List mode ──────────────────────────────────────────────────────

  if (opts.list) {
    return listMode(agentDirs, opts.json);
  }

  // ── Session mode ───────────────────────────────────────────────────

  if (opts.session) {
    return sessionMode(agentDirs, opts.session, opts.json);
  }

  // ── Follow mode ────────────────────────────────────────────────────

  if (opts.follow) {
    return followMode(agentDirs);
  }

  // ── Default: recent events ─────────────────────────────────────────

  return recentMode(agentDirs, parseInt(opts.last, 10) || 30, opts.json);
}

// ── Modes ────────────────────────────────────────────────────────────

function listMode(
  agentDirs: Map<string, string>,
  json?: boolean,
): void {
  const result: Record<string, SessionInfo[]> = {};

  for (const [agentName, dir] of agentDirs) {
    const sessions = listSessions(dir);
    result[agentName] = sessions;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const [agentName, sessions] of Object.entries(result)) {
    const roleColor = getRoleColor(agentName.toUpperCase());
    console.log(roleColor(`\n── ${agentName} ──`));

    if (sessions.length === 0) {
      console.log(chalk.gray('  No sessions found'));
      continue;
    }

    for (const session of sessions) {
      const start = session.startTime
        ? new Date(session.startTime).toLocaleString()
        : 'unknown';
      const dur = session.durationSecs !== undefined
        ? formatDuration(session.durationSecs)
        : '?';
      const count = session.eventCount;
      const idShort = session.id.slice(0, 8);

      console.log(
        `  ${chalk.bold(idShort)}  ${start}  ${chalk.gray(`${dur}`)}  ${chalk.gray(`${count} events`)}`,
      );
    }
  }

  console.log('');
}

function sessionMode(
  agentDirs: Map<string, string>,
  sessionId: string,
  json?: boolean,
): void {
  // Search all agent dirs for the session
  let events: TranscriptEvent[] = [];
  let agentName: string | undefined;

  for (const [name, dir] of agentDirs) {
    const sessions = listSessions(dir);
    const match = sessions.find(
      (s) => s.id === sessionId || s.id.startsWith(sessionId),
    );
    if (match) {
      events = parseTranscript(match.path);
      agentName = name;
      break;
    }
  }

  if (events.length === 0) {
    console.error(chalk.red(`Session not found: ${sessionId}`));
    process.exit(1);
  }

  // Tag events with agent name
  for (const event of events) {
    event.agent = agentName;
  }

  if (json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  console.log(
    chalk.gray(
      `── session ${sessionId.slice(0, 8)} · ${agentName} · ${events.length} events ──\n`,
    ),
  );

  for (const event of events) {
    printEvent(event);
  }
}

function recentMode(
  agentDirs: Map<string, string>,
  lastN: number,
  json?: boolean,
): void {
  // Gather events from the most recent session of each agent
  const allEvents: TranscriptEvent[] = [];

  for (const [agentName, dir] of agentDirs) {
    const sessions = listSessions(dir);
    if (sessions.length === 0) continue;

    // Most recent session (already sorted newest first)
    const latest = sessions[0];
    const events = parseTranscript(latest.path);
    for (const event of events) {
      event.agent = agentName;
    }
    allEvents.push(...events);
  }

  // Sort by timestamp
  allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const display = allEvents.slice(-lastN);

  if (json) {
    console.log(JSON.stringify(display, null, 2));
    return;
  }

  const agentDesc =
    agentDirs.size === 1
      ? `agent: ${[...agentDirs.keys()][0]}`
      : `${agentDirs.size} agents`;

  console.log(
    chalk.gray(
      `── transcript · ${agentDesc} · last ${display.length} events ──\n`,
    ),
  );

  for (const event of display) {
    printEvent(event);
  }
}

async function followMode(
  agentDirs: Map<string, string>,
): Promise<void> {
  // Find the most recent session file for each agent
  const watchPaths: { path: string; agent: string }[] = [];

  for (const [agentName, dir] of agentDirs) {
    const sessions = listSessions(dir);
    if (sessions.length > 0) {
      watchPaths.push({ path: sessions[0].path, agent: agentName });
    }
  }

  if (watchPaths.length === 0) {
    console.error(chalk.yellow('No active sessions to follow.'));
    process.exit(0);
  }

  console.log(chalk.gray('── following transcripts (Ctrl+C to stop) ──\n'));

  // Track file positions to only show new events
  const filePositions = new Map<string, number>();
  for (const wp of watchPaths) {
    const events = parseTranscript(wp.path);
    filePositions.set(wp.path, events.length);
  }

  const watcher = watch(
    watchPaths.map((wp) => wp.path),
    { persistent: true, ignoreInitial: true },
  );

  watcher.on('change', (changedPath) => {
    const wp = watchPaths.find((w) => w.path === changedPath);
    if (!wp) return;

    const allEvents = parseTranscript(wp.path);
    const prevCount = filePositions.get(wp.path) ?? 0;
    const newEvents = allEvents.slice(prevCount);
    filePositions.set(wp.path, allEvents.length);

    for (const event of newEvents) {
      event.agent = wp.agent;
      printEvent(event);
    }
  });

  // Handle clean shutdown
  const cleanup = () => {
    watcher.close();
    console.log(chalk.gray('\n── stopped ──'));
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await new Promise(() => {});
}

// ── Display helpers ──────────────────────────────────────────────────

function printEvent(event: TranscriptEvent): void {
  const ts = formatTime(event.timestamp);
  const agentLabel = event.agent
    ? getRoleColor(event.agent.toUpperCase())(`[${event.agent}]`)
    : '';

  if (event.kind === 'tool_use' && event.toolName) {
    const icon = getToolIcon(event.toolName);
    const iconStyled = chalk.bold.cyan(icon);
    const nameStyled = chalk.bold(event.toolName);
    console.log(
      `${chalk.gray(ts)} ${agentLabel} ${iconStyled} ${nameStyled} ${event.summary}`,
    );
  } else if (event.kind === 'text') {
    console.log(
      `${chalk.gray(ts)} ${agentLabel} ${chalk.white(event.summary)}`,
    );
  } else if (event.kind === 'thinking') {
    console.log(
      `${chalk.gray(ts)} ${agentLabel} ${chalk.dim('(thinking)')}`,
    );
  }
}

function formatTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
