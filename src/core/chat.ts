import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, MessageType } from '../types/config.js';

// ── Chat file header ────────────────────────────────────────────────

const CHAT_HEADER = `# HIVE — Inter-Agent Coordination Log
#
# This file is the shared communication channel for all AgentHive agents.
# Each agent reads this file before starting work and writes to it after.
#
# ## Message Format
#
#   [ROLE] TYPE: message body
#
#   TYPE is one of:
#     STATUS   — Progress update on current work
#     DONE     — Task completed (include commit hash if applicable)
#     REQUEST  — Asking another role to do something (tag target with @ROLE)
#     QUESTION — Asking for information or clarification (tag with @ROLE or @ALL)
#     BLOCKER  — Something is blocking progress (explain what and who can unblock)
#     ACK      — Acknowledge a request or message
#     WARN     — Heads-up about a risk, conflict, or side effect
#
# ## Rules
#   1. Append-only — NEVER edit or delete previous messages
#   2. Read before writing — always read the full chat before posting
#   3. Keep messages concise — one or two lines max
#   4. Reference commits when relevant — e.g. (abc1234)
#   5. Reference files when relevant — e.g. \`src/auth/auth.guard.ts\`
#
# ─────────────────────────────────────────────────────────────────────

`;

// ── Message format regex ────────────────────────────────────────────

const MESSAGE_REGEX = /^\[([A-Z_]+)\]\s+(STATUS|DONE|REQUEST|QUESTION|BLOCKER|ACK|WARN):\s*(.+)$/;

const VALID_TYPES = new Set<string>([
  'STATUS', 'DONE', 'REQUEST', 'QUESTION', 'BLOCKER', 'ACK', 'WARN',
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize a chat file with the protocol header.
 */
export function initChatFile(hivePath: string, fileName = 'chat.md'): string {
  const chatPath = join(hivePath, fileName);
  writeFileSync(chatPath, CHAT_HEADER, 'utf-8');
  return chatPath;
}

/**
 * Append a message to the chat file.
 * Format: [ROLE] TYPE: body
 */
export function appendMessage(
  chatFilePath: string,
  role: string,
  type: MessageType,
  body: string,
): void {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid message type: ${type}`);
  }

  const line = `[${role.toUpperCase()}] ${type}: ${body.trim()}\n`;
  appendFileSync(chatFilePath, line, 'utf-8');
}

/**
 * Read all messages from the chat file.
 * Skips comment lines (starting with #) and blank lines.
 */
export function readMessages(chatFilePath: string): ChatMessage[] {
  if (!existsSync(chatFilePath)) return [];

  const content = readFileSync(chatFilePath, 'utf-8');
  return parseMessages(content);
}

/**
 * Read messages from the chat file starting at a given line number.
 * Used with checkpoints to avoid re-scanning old messages.
 */
export function readMessagesSince(
  chatFilePath: string,
  sinceLine: number,
): ChatMessage[] {
  if (!existsSync(chatFilePath)) return [];

  const content = readFileSync(chatFilePath, 'utf-8');
  const lines = content.split('\n');

  // Build content from only new lines
  const newLines = lines.slice(sinceLine);
  return parseMessages(newLines.join('\n'), sinceLine);
}

/**
 * Find REQUEST messages targeting a specific role since a given line.
 * Case-insensitive on the role tag.
 */
export function findRequests(
  chatFilePath: string,
  role: string,
  sinceLine = 0,
): ChatMessage[] {
  const messages = readMessagesSince(chatFilePath, sinceLine);
  const roleUpper = role.toUpperCase();

  return messages.filter(
    (msg) =>
      msg.type === 'REQUEST' &&
      msg.body.toUpperCase().includes(`@${roleUpper}`),
  );
}

/**
 * Get the total line count of the chat file.
 */
export function getChatLineCount(chatFilePath: string): number {
  if (!existsSync(chatFilePath)) return 0;
  const content = readFileSync(chatFilePath, 'utf-8');
  const lines = content.split('\n');
  // Files ending with \n produce a trailing empty string in the split —
  // don't count it, or checkpoints will overshoot by 1 when used with slice().
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * Resolve the absolute path to the chat file.
 */
export function resolveChatPath(hivePath: string, chatFile = 'chat.md'): string {
  return join(hivePath, chatFile);
}

// ── Internal ────────────────────────────────────────────────────────

function parseMessages(content: string, lineOffset = 0): ChatMessage[] {
  const lines = content.split('\n');
  const messages: ChatMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) continue;

    const match = line.match(MESSAGE_REGEX);
    if (match) {
      messages.push({
        role: match[1],
        type: match[2] as MessageType,
        body: match[3],
        lineNumber: lineOffset + i + 1,
      });
    }
  }

  return messages;
}
