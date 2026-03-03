import { getLockStatus, getCheckpoint } from './lock.js';

// ── Health states ────────────────────────────────────────────────────

export type AgentHealthState =
  | 'healthy'
  | 'unresponsive'
  | 'stuck'
  | 'dead'
  | 'stopped';

export interface AgentHealth {
  state: AgentHealthState;
  heartbeat?: string;
  pid?: number;
  checkpoint?: number;
}

// ── Health check ─────────────────────────────────────────────────────

/**
 * Check the health of an agent based on its lock file heartbeat,
 * checkpoint advancement, and PID liveness.
 *
 * Returns one of:
 *  - `healthy`:      PID alive, heartbeat recent
 *  - `unresponsive`: PID alive, heartbeat older than `pollSeconds × 3`
 *  - `stuck`:        PID alive, checkpoint not advancing while heartbeat is fresh
 *                    (detected via previous checkpoint comparison)
 *  - `dead`:         PID not alive, lock file still present (not cleaned)
 *  - `stopped`:      No lock file at all
 */
export function checkAgentHealth(
  hivePath: string,
  agentName: string,
  pollSeconds: number,
  previousCheckpoint?: number,
): AgentHealth {
  const lock = getLockStatus(hivePath, agentName);

  // No lock file — agent is stopped
  if (!lock.locked) {
    return { state: 'stopped' };
  }

  // Lock exists but PID is dead — stale lock
  if (lock.stale) {
    return {
      state: 'dead',
      pid: lock.pid,
      heartbeat: lock.heartbeat,
    };
  }

  // PID is alive — check heartbeat freshness
  const checkpoint = getCheckpoint(hivePath, agentName);
  const now = Date.now();
  const heartbeatAge = lock.heartbeat
    ? now - new Date(lock.heartbeat).getTime()
    : Infinity;
  const threshold = pollSeconds * 3 * 1000;

  // If heartbeat is too old, agent is unresponsive
  if (heartbeatAge > threshold) {
    return {
      state: 'unresponsive',
      pid: lock.pid,
      heartbeat: lock.heartbeat,
      checkpoint,
    };
  }

  // If checkpoint hasn't advanced and we have a previous value to compare,
  // and enough time has passed (threshold), the agent may be stuck
  if (
    previousCheckpoint !== undefined &&
    previousCheckpoint === checkpoint &&
    heartbeatAge > threshold
  ) {
    return {
      state: 'stuck',
      pid: lock.pid,
      heartbeat: lock.heartbeat,
      checkpoint,
    };
  }

  // All good
  return {
    state: 'healthy',
    pid: lock.pid,
    heartbeat: lock.heartbeat,
    checkpoint,
  };
}

/**
 * Human-readable label for a health state, suitable for display.
 */
export function healthLabel(state: AgentHealthState): string {
  switch (state) {
    case 'healthy':
      return 'healthy';
    case 'unresponsive':
      return 'unresponsive?';
    case 'stuck':
      return 'stuck?';
    case 'dead':
      return 'dead';
    case 'stopped':
      return 'stopped';
  }
}
