import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Types ────────────────────────────────────────────────────────────

export interface TranscriptEvent {
  /** ISO 8601 timestamp. */
  timestamp: string;

  /** Event kind: tool_use, text, thinking. */
  kind: 'tool_use' | 'text' | 'thinking';

  /** Tool name (only for tool_use). */
  toolName?: string;

  /** Short summary of the event content. */
  summary: string;

  /** Agent name (set externally when merging timelines). */
  agent?: string;
}

export interface SessionInfo {
  /** Session UUID (file stem). */
  id: string;

  /** Path to the JSONL file. */
  path: string;

  /** First event timestamp. */
  startTime?: string;

  /** Duration in seconds (last - first event). */
  durationSecs?: number;

  /** Total number of parsed events. */
  eventCount: number;
}

// ── Tool icon mapping ────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  Bash: '$',
  Read: 'r',
  Write: 'w',
  Edit: 'e',
  Grep: '/',
  Glob: '*',
  Agent: '>>',
  WebFetch: '@',
  WebSearch: '?',
  TodoWrite: '#',
  NotebookEdit: 'n',
};

export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? toolName.charAt(0).toLowerCase();
}

// ── Transcript directory discovery ───────────────────────────────────

/**
 * Encode a filesystem path the way Claude Code does for its project dirs:
 * absolute path with `/` replaced by `-` (leading `-` from root `/`).
 */
function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

/**
 * Find the Claude Code transcript directory for a given worktree path.
 * Claude Code stores transcripts in ~/.claude/projects/<encoded-path>/.
 */
export function findTranscriptDir(worktreePath: string): string | undefined {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return undefined;

  const absPath = resolve(worktreePath);
  const encoded = encodeProjectPath(absPath);

  const candidatePath = join(claudeProjectsDir, encoded);
  if (existsSync(candidatePath)) return candidatePath;

  return undefined;
}

/**
 * List all session JSONL files in a transcript directory.
 * Returns metadata for each session, sorted by start time (newest first).
 */
export function listSessions(transcriptDir: string): SessionInfo[] {
  if (!existsSync(transcriptDir)) return [];

  const entries = readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'));
  const sessions: SessionInfo[] = [];

  for (const file of entries) {
    const filePath = join(transcriptDir, file);
    const id = basename(file, '.jsonl');

    // Quick scan: read first and last lines for time range
    let firstTimestamp: string | undefined;
    let lastTimestamp: string | undefined;
    let eventCount = 0;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          if (entry.type === 'assistant' || entry.type === 'user') {
            const ts = entry.timestamp;
            if (ts) {
              if (!firstTimestamp) firstTimestamp = ts;
              lastTimestamp = ts;
            }
            eventCount++;
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      continue;
    }

    let durationSecs: number | undefined;
    if (firstTimestamp && lastTimestamp) {
      const start = new Date(firstTimestamp).getTime();
      const end = new Date(lastTimestamp).getTime();
      durationSecs = Math.round((end - start) / 1000);
    }

    sessions.push({
      id,
      path: filePath,
      startTime: firstTimestamp,
      durationSecs,
      eventCount,
    });
  }

  // Sort newest first
  sessions.sort((a, b) => {
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return b.startTime.localeCompare(a.startTime);
  });

  return sessions;
}

// ── Transcript parsing ───────────────────────────────────────────────

interface TranscriptEntry {
  type: 'user' | 'assistant' | 'queue-operation';
  timestamp?: string;
  sessionId?: string;
  message?: {
    role: string;
    content: ContentBlock[] | string;
  };
}

type ContentBlock =
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; content?: string | ContentBlock[] }
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string };

/**
 * Parse a transcript JSONL file and return a list of events.
 * Extracts tool_use, text, and thinking events from assistant messages.
 */
export function parseTranscript(transcriptPath: string): TranscriptEvent[] {
  if (!existsSync(transcriptPath)) return [];

  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  const events: TranscriptEvent[] = [];

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    // Only process assistant messages (they contain the actions)
    if (entry.type !== 'assistant') continue;
    const ts = entry.timestamp;
    if (!ts) continue;

    const msg = entry.message;
    if (!msg) continue;

    const contentBlocks = msg.content;
    if (!Array.isArray(contentBlocks)) continue;

    for (const block of contentBlocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use') {
        events.push({
          timestamp: ts,
          kind: 'tool_use',
          toolName: block.name,
          summary: summarizeToolUse(block.name, block.input),
        });
      } else if (block.type === 'text' && block.text?.trim()) {
        events.push({
          timestamp: ts,
          kind: 'text',
          summary: truncate(block.text.trim(), 120),
        });
      } else if (block.type === 'thinking') {
        events.push({
          timestamp: ts,
          kind: 'thinking',
          summary: '(thinking)',
        });
      }
    }
  }

  return events;
}

// ── Helpers ──────────────────────────────────────────────────────────

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return truncate(String(input.command ?? ''), 100);
    case 'Read':
      return shortPath(String(input.file_path ?? ''));
    case 'Write':
      return shortPath(String(input.file_path ?? ''));
    case 'Edit':
      return shortPath(String(input.file_path ?? ''));
    case 'Grep':
      return `/${input.pattern ?? ''}/ ${input.path ? shortPath(String(input.path)) : ''}`.trim();
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Agent':
      return String(input.description ?? '');
    case 'TodoWrite':
      return 'update tasks';
    default:
      return name;
  }
}

function shortPath(p: string): string {
  // Show last two path components
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

function truncate(s: string, max: number): string {
  // Collapse whitespace
  const clean = s.replace(/\s+/g, ' ');
  return clean.length > max ? clean.slice(0, max - 3) + '...' : clean;
}

/**
 * Format a duration in seconds to a human-readable string.
 */
export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}
