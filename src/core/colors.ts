import chalk from 'chalk';
import type { ChatMessage, MessageType } from '../types/config.js';

// ── Role color palette ──────────────────────────────────────────────

const ROLE_COLORS: Record<string, (s: string) => string> = {};

export const PALETTE = [
  chalk.cyan,
  chalk.magenta,
  chalk.yellow,
  chalk.green,
  chalk.blue,
  chalk.redBright,
  chalk.whiteBright,
  chalk.cyanBright,
];

export function getRoleColor(role: string): (s: string) => string {
  if (!ROLE_COLORS[role]) {
    const idx = Object.keys(ROLE_COLORS).length % PALETTE.length;
    ROLE_COLORS[role] = PALETTE[idx];
  }
  return ROLE_COLORS[role];
}

// ── Message type styles ─────────────────────────────────────────────

export const TYPE_STYLES: Record<string, (s: string) => string> = {
  REQUEST: chalk.bold.yellow,
  DONE: chalk.bold.green,
  BLOCKER: chalk.bold.red,
  WARN: chalk.yellow,
  STATUS: chalk.gray,
  QUESTION: chalk.cyan,
  ACK: chalk.dim,
};

// ── Ink-compatible color names (no chalk dependency for TUI) ────────

export const ROLE_COLOR_NAMES = [
  'cyan',
  'magenta',
  'yellow',
  'green',
  'blue',
  'redBright',
  'white',
  'cyanBright',
] as const;

const roleColorIndex: Record<string, number> = {};

export function getRoleColorName(role: string): string {
  if (!(role in roleColorIndex)) {
    roleColorIndex[role] = Object.keys(roleColorIndex).length % ROLE_COLOR_NAMES.length;
  }
  return ROLE_COLOR_NAMES[roleColorIndex[role]];
}

export type TypeStyleInfo = { bold?: boolean; dim?: boolean; color: string };

export const TYPE_STYLE_MAP: Record<MessageType, TypeStyleInfo> = {
  REQUEST: { bold: true, color: 'yellow' },
  DONE: { bold: true, color: 'green' },
  BLOCKER: { bold: true, color: 'red' },
  WARN: { color: 'yellow' },
  STATUS: { color: 'gray' },
  QUESTION: { color: 'cyan' },
  ACK: { dim: true, color: 'white' },
};

// ── Time helpers ────────────────────────────────────────────────────

export function timeAgo(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatTimestamp(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Format helpers ──────────────────────────────────────────────────

export function formatMessage(msg: ChatMessage): string {
  const roleColor = getRoleColor(msg.role);
  const typeStyle = TYPE_STYLES[msg.type] ?? chalk.white;
  const ts = msg.timestamp ? chalk.gray(` ${formatTimestamp(msg.timestamp)}`) : '';
  return `${roleColor(`[${msg.role}]`)} ${typeStyle(msg.type)}${ts}: ${msg.body}`;
}

// ── Spend color helpers ─────────────────────────────────────────────

export function getSpendColor(pct: number): string {
  if (pct > 0.8) return 'red';
  if (pct > 0.5) return 'yellow';
  return 'green';
}
