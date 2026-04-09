import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive } from './lock.js';

// ── Types ──────────────────────────────────────────────────────────

export type GitOperation = 'sync' | 'push' | 'merge';

export interface GitLock {
  pid: number;
  agent: string;
  operation: GitOperation;
  timestamp: string;
}

// ── Constants ──────────────────────────────────────────────────────

/** Lock auto-expires after this duration (ms) to handle crashes. */
const GIT_LOCK_TTL_MS = 60_000; // 60 seconds

const LOCK_FILENAME = 'git.lock';
const LOCK_TMP_FILENAME = 'git.lock.tmp';

// ── Public API ─────────────────────────────────────────────────────

/**
 * Attempt to acquire the global git operation lock.
 *
 * @param hivePath - Path to the .hive directory
 * @param agentName - Name of the agent acquiring the lock
 * @param operation - Type of git operation being performed
 * @param timeoutMs - Max time to wait for lock (0 = non-blocking). Default: 0.
 * @returns true if lock acquired, false if timed out
 */
export async function acquireGitLock(
  hivePath: string,
  agentName: string,
  operation: GitOperation,
  timeoutMs = 0,
): Promise<boolean> {
  const stateDir = ensureStateDir(hivePath);
  const lockFile = join(stateDir, LOCK_FILENAME);

  const deadline = Date.now() + timeoutMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Try to clean stale/expired locks
    cleanStaleLock(lockFile);

    if (!existsSync(lockFile)) {
      // Write atomically: tmp file + rename
      const tmpFile = join(stateDir, LOCK_TMP_FILENAME);
      const content = [
        String(process.pid),
        agentName,
        operation,
        new Date().toISOString(),
      ].join('\n');

      writeFileSync(tmpFile, content, 'utf-8');
      try {
        renameSync(tmpFile, lockFile);
        return true;
      } catch {
        // Another process beat us — remove tmp and retry/fail
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }

    // Lock is held — check if we should wait
    if (Date.now() >= deadline) {
      return false;
    }

    // Poll every 200ms
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Release the git lock if held by this process.
 */
export function releaseGitLock(hivePath: string, agentName: string): void {
  const lockFile = join(hivePath, 'state', LOCK_FILENAME);

  if (!existsSync(lockFile)) return;

  const lock = parseLock(lockFile);
  if (lock && lock.pid === process.pid && lock.agent === agentName) {
    try {
      unlinkSync(lockFile);
    } catch {
      // Best-effort
    }
  }
}

/**
 * Get current git lock status (for observability / status commands).
 */
export function getGitLockStatus(hivePath: string): GitLock | null {
  const lockFile = join(hivePath, 'state', LOCK_FILENAME);

  if (!existsSync(lockFile)) return null;

  const lock = parseLock(lockFile);
  if (!lock) return null;

  // Check if stale
  if (!isProcessAlive(lock.pid) || isExpired(lock.timestamp)) {
    return null;
  }

  return lock;
}

// ── Helpers ────────────────────────────────────────────────────────

function ensureStateDir(hivePath: string): string {
  const stateDir = join(hivePath, 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  return stateDir;
}

function parseLock(lockFile: string): GitLock | null {
  try {
    const content = readFileSync(lockFile, 'utf-8');
    const lines = content.split('\n');
    if (lines.length < 4) return null;

    const pid = parseInt(lines[0].trim(), 10);
    if (isNaN(pid)) return null;

    return {
      pid,
      agent: lines[1].trim(),
      operation: lines[2].trim() as GitOperation,
      timestamp: lines[3].trim(),
    };
  } catch {
    return null;
  }
}

function isExpired(timestamp: string): boolean {
  const lockTime = new Date(timestamp).getTime();
  return Date.now() - lockTime > GIT_LOCK_TTL_MS;
}

function cleanStaleLock(lockFile: string): void {
  if (!existsSync(lockFile)) return;

  const lock = parseLock(lockFile);
  if (!lock) {
    // Corrupt lock file — remove it
    try { unlinkSync(lockFile); } catch { /* ignore */ }
    return;
  }

  if (!isProcessAlive(lock.pid) || isExpired(lock.timestamp)) {
    try { unlinkSync(lockFile); } catch { /* ignore */ }
  }
}
