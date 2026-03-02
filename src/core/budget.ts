import {
  readFileSync,
  writeFileSync,
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
