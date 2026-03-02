import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

// ── State directory ─────────────────────────────────────────────────

function ensureStateDir(hivePath: string): string {
  const stateDir = join(hivePath, 'state');
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  return stateDir;
}

// ── Lock management ─────────────────────────────────────────────────

/**
 * Acquire a PID-based lock for an agent.
 * Returns true if lock was acquired, false if another process holds it.
 * Automatically cleans stale locks (PID no longer alive).
 */
export function acquireLock(hivePath: string, agentName: string): boolean {
  const stateDir = ensureStateDir(hivePath);
  const lockFile = join(stateDir, `${agentName}.lock`);

  if (existsSync(lockFile)) {
    const existingPid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);

    if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
      return false; // Another process holds the lock
    }

    // Stale lock — clean it up
    unlinkSync(lockFile);
  }

  writeFileSync(lockFile, String(process.pid), 'utf-8');
  return true;
}

/**
 * Release a lock for an agent.
 */
export function releaseLock(hivePath: string, agentName: string): void {
  const stateDir = join(hivePath, 'state');
  const lockFile = join(stateDir, `${agentName}.lock`);

  if (existsSync(lockFile)) {
    unlinkSync(lockFile);
  }
}

/**
 * Check if a lock is held and by which PID.
 */
export function getLockStatus(
  hivePath: string,
  agentName: string,
): { locked: boolean; pid?: number; stale: boolean } {
  const lockFile = join(hivePath, 'state', `${agentName}.lock`);

  if (!existsSync(lockFile)) {
    return { locked: false, stale: false };
  }

  const pid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);

  if (isNaN(pid)) {
    return { locked: true, stale: true };
  }

  if (isProcessAlive(pid)) {
    return { locked: true, pid, stale: false };
  }

  return { locked: true, pid, stale: true };
}

/**
 * Register signal handlers to release all locks on exit.
 */
export function registerCleanupHandlers(
  hivePath: string,
  agentNames: string[],
): void {
  const cleanup = () => {
    for (const name of agentNames) {
      try {
        releaseLock(hivePath, name);
      } catch {
        // Best-effort cleanup on exit
      }
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);
}

// ── Checkpoint management ───────────────────────────────────────────

/**
 * Get the last-read line number for an agent.
 */
export function getCheckpoint(hivePath: string, agentName: string): number {
  const checkpointFile = join(hivePath, 'state', `${agentName}.checkpoint`);

  if (!existsSync(checkpointFile)) return 0;

  const value = parseInt(readFileSync(checkpointFile, 'utf-8').trim(), 10);
  return isNaN(value) ? 0 : value;
}

/**
 * Set the last-read line number for an agent.
 */
export function setCheckpoint(
  hivePath: string,
  agentName: string,
  line: number,
): void {
  const stateDir = ensureStateDir(hivePath);
  writeFileSync(join(stateDir, `${agentName}.checkpoint`), String(line), 'utf-8');
}

// ── Helpers ─────────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
