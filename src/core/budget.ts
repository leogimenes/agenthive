import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

// ── Budget tracking ─────────────────────────────────────────────────

/**
 * Check if the agent's daily budget allows another task.
 * Resets the daily counter if the file is from a previous day.
 */
export function checkDailyBudget(
  hivePath: string,
  agentName: string,
  dailyMax: number,
): { allowed: boolean; spent: number } {
  const spendFile = getSpendFilePath(hivePath, agentName);
  const spent = readDailySpend(spendFile);

  return {
    allowed: spent < dailyMax,
    spent,
  };
}

/**
 * Record that an agent spent its per-task budget.
 * Returns the new daily total.
 */
export function recordSpending(
  hivePath: string,
  agentName: string,
  amount: number,
): number {
  const spendFile = getSpendFilePath(hivePath, agentName);
  const currentSpend = readDailySpend(spendFile);
  const newTotal = Math.round((currentSpend + amount) * 100) / 100;

  ensureStateDir(hivePath);
  writeFileSync(spendFile, String(newTotal), 'utf-8');

  return newTotal;
}

/**
 * Get the current daily spend for an agent.
 */
export function getDailySpend(
  hivePath: string,
  agentName: string,
): { spent: number; date: string } {
  const spendFile = getSpendFilePath(hivePath, agentName);
  const spent = readDailySpend(spendFile);
  const today = new Date().toISOString().slice(0, 10);

  return { spent, date: today };
}

/**
 * Reset daily spend for an agent.
 */
export function resetDailySpend(
  hivePath: string,
  agentName: string,
): void {
  const spendFile = getSpendFilePath(hivePath, agentName);
  ensureStateDir(hivePath);
  writeFileSync(spendFile, '0', 'utf-8');
}

// ── Cost log ────────────────────────────────────────────────────────

export interface CostLogEntry {
  timestamp: string;
  task: string;
  amount: number;
  success: boolean;
}

/**
 * Append a task cost entry to the agent's cost log.
 * Format: append-only TSV with timestamp, task summary, amount, success.
 */
export function logTaskCost(
  hivePath: string,
  agentName: string,
  task: string,
  amount: number,
  success: boolean,
): void {
  const logFile = getCostLogPath(hivePath, agentName);
  ensureStateDir(hivePath);
  // TSV line: timestamp\ttask\tamount\tsuccess
  const ts = new Date().toISOString();
  const sanitizedTask = task.replace(/[\t\n\r]/g, ' ').slice(0, 200);
  const line = `${ts}\t${sanitizedTask}\t${amount}\t${success}\n`;
  appendFileSync(logFile, line, 'utf-8');
}

/**
 * Read all cost log entries for an agent.
 */
export function readCostLog(
  hivePath: string,
  agentName: string,
): CostLogEntry[] {
  const logFile = getCostLogPath(hivePath, agentName);
  if (!existsSync(logFile)) return [];

  const content = readFileSync(logFile, 'utf-8').trim();
  if (!content) return [];

  return content.split('\n').map(parseCostLogLine).filter(Boolean) as CostLogEntry[];
}

/**
 * Read cost log entries filtered by date (YYYY-MM-DD).
 */
export function readCostLogSince(
  hivePath: string,
  agentName: string,
  sinceDate: string,
): CostLogEntry[] {
  return readCostLog(hivePath, agentName).filter(
    (e) => e.timestamp.slice(0, 10) >= sinceDate,
  );
}

function getCostLogPath(hivePath: string, agentName: string): string {
  return join(hivePath, 'state', `${agentName}.cost-log`);
}

function parseCostLogLine(line: string): CostLogEntry | null {
  const parts = line.split('\t');
  if (parts.length < 4) return null;
  const [timestamp, task, amountStr, successStr] = parts;
  const amount = parseFloat(amountStr);
  if (isNaN(amount)) return null;
  return {
    timestamp,
    task,
    amount,
    success: successStr === 'true',
  };
}

// ── Internal ────────────────────────────────────────────────────────

function getSpendFilePath(hivePath: string, agentName: string): string {
  return join(hivePath, 'state', `${agentName}.daily-spend`);
}

function readDailySpend(spendFile: string): number {
  if (!existsSync(spendFile)) return 0;

  // Check if file is from today — reset if not
  const fileStat = statSync(spendFile);
  const fileDate = fileStat.mtime.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  if (fileDate !== today) {
    // New day — reset
    writeFileSync(spendFile, '0', 'utf-8');
    return 0;
  }

  const value = parseFloat(readFileSync(spendFile, 'utf-8').trim());
  return isNaN(value) ? 0 : value;
}

function ensureStateDir(hivePath: string): void {
  const stateDir = join(hivePath, 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}
