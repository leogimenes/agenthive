import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, releaseLock, setCheckpoint, updateHeartbeat } from '../../src/core/lock.js';
import { checkAgentHealth, healthLabel } from '../../src/core/watchdog.js';

describe('watchdog', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-test-watchdog-'));
  });

  afterEach(() => {
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── checkAgentHealth ──────────────────────────────────────────────

  describe('checkAgentHealth', () => {
    it('should return stopped when no lock file exists', () => {
      const health = checkAgentHealth(hivePath, 'sre', 60);
      expect(health.state).toBe('stopped');
    });

    it('should return healthy when lock is held with fresh heartbeat', () => {
      acquireLock(hivePath, 'sre');

      const health = checkAgentHealth(hivePath, 'sre', 60);
      expect(health.state).toBe('healthy');
      expect(health.pid).toBe(process.pid);
      expect(health.heartbeat).toBeDefined();
    });

    it('should return dead when lock PID is not alive', () => {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'sre.lock'),
        `999999999\n${new Date().toISOString()}`,
        'utf-8',
      );

      const health = checkAgentHealth(hivePath, 'sre', 60);
      expect(health.state).toBe('dead');
      expect(health.pid).toBe(999999999);
    });

    it('should return unresponsive when heartbeat is too old', () => {
      acquireLock(hivePath, 'sre');

      // Write an old heartbeat (10 minutes ago, with poll=60s threshold=180s)
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const lockFile = join(hivePath, 'state', 'sre.lock');
      writeFileSync(lockFile, `${process.pid}\n${oldTime}`, 'utf-8');

      const health = checkAgentHealth(hivePath, 'sre', 60);
      expect(health.state).toBe('unresponsive');
      expect(health.pid).toBe(process.pid);
    });

    it('should return healthy when heartbeat is within threshold', () => {
      acquireLock(hivePath, 'sre');

      // Write a recent heartbeat (30s ago, with poll=60s threshold=180s)
      const recentTime = new Date(Date.now() - 30 * 1000).toISOString();
      const lockFile = join(hivePath, 'state', 'sre.lock');
      writeFileSync(lockFile, `${process.pid}\n${recentTime}`, 'utf-8');

      const health = checkAgentHealth(hivePath, 'sre', 60);
      expect(health.state).toBe('healthy');
    });

    it('should handle old-format lock files without heartbeat', () => {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      // Old format: just PID, no timestamp
      writeFileSync(join(stateDir, 'sre.lock'), String(process.pid), 'utf-8');

      // No heartbeat → heartbeat age is Infinity → unresponsive
      const health = checkAgentHealth(hivePath, 'sre', 60);
      expect(health.state).toBe('unresponsive');
    });

    it('should include checkpoint in health result', () => {
      acquireLock(hivePath, 'sre');
      setCheckpoint(hivePath, 'sre', 42);

      const health = checkAgentHealth(hivePath, 'sre', 60);
      expect(health.checkpoint).toBe(42);
    });

    it('should return stuck when heartbeat is fresh but checkpoint has not advanced', () => {
      acquireLock(hivePath, 'sre');
      setCheckpoint(hivePath, 'sre', 10);

      // Fresh heartbeat (10s ago, well within threshold of 180s)
      const recentTime = new Date(Date.now() - 10 * 1000).toISOString();
      const lockFile = join(hivePath, 'state', 'sre.lock');
      writeFileSync(lockFile, `${process.pid}\n${recentTime}`, 'utf-8');

      // Previous checkpoint was also 10 — no progress
      const health = checkAgentHealth(hivePath, 'sre', 60, 10);
      expect(health.state).toBe('stuck');
      expect(health.checkpoint).toBe(10);
    });

    it('should return healthy when heartbeat is fresh and checkpoint has advanced', () => {
      acquireLock(hivePath, 'sre');
      setCheckpoint(hivePath, 'sre', 20);

      const recentTime = new Date(Date.now() - 10 * 1000).toISOString();
      const lockFile = join(hivePath, 'state', 'sre.lock');
      writeFileSync(lockFile, `${process.pid}\n${recentTime}`, 'utf-8');

      // Previous checkpoint was 10, now 20 — progress made
      const health = checkAgentHealth(hivePath, 'sre', 60, 10);
      expect(health.state).toBe('healthy');
    });
  });

  // ── updateHeartbeat ───────────────────────────────────────────────

  describe('updateHeartbeat', () => {
    it('should update the heartbeat timestamp in lock file', () => {
      acquireLock(hivePath, 'sre');

      // Wait a tiny bit then update
      const before = readFileSync(join(hivePath, 'state', 'sre.lock'), 'utf-8');
      updateHeartbeat(hivePath, 'sre');
      const after = readFileSync(join(hivePath, 'state', 'sre.lock'), 'utf-8');

      // PID should stay the same
      const pidBefore = before.split('\n')[0];
      const pidAfter = after.split('\n')[0];
      expect(pidBefore).toBe(pidAfter);

      // Heartbeat should exist
      const heartbeat = after.split('\n')[1];
      expect(heartbeat).toBeDefined();
      expect(new Date(heartbeat).getTime()).not.toBeNaN();
    });

    it('should be a no-op when lock file does not exist', () => {
      // Should not throw
      expect(() => updateHeartbeat(hivePath, 'sre')).not.toThrow();
    });
  });

  // ── Lock file format backward compatibility ────────────────────────

  describe('lock file format', () => {
    it('should write new lock files with PID and heartbeat', () => {
      acquireLock(hivePath, 'sre');

      const content = readFileSync(join(hivePath, 'state', 'sre.lock'), 'utf-8');
      const lines = content.split('\n');
      expect(lines.length).toBe(2);
      expect(parseInt(lines[0], 10)).toBe(process.pid);
      expect(new Date(lines[1]).getTime()).not.toBeNaN();
    });

    it('should still work with old PID-only lock format for acquireLock', () => {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      // Simulate old format lock from a dead process
      writeFileSync(join(stateDir, 'sre.lock'), '999999999', 'utf-8');

      // Should clean stale lock and acquire
      const acquired = acquireLock(hivePath, 'sre');
      expect(acquired).toBe(true);
    });
  });

  // ── healthLabel ───────────────────────────────────────────────────

  describe('healthLabel', () => {
    it('should return readable labels for all states', () => {
      expect(healthLabel('healthy')).toBe('healthy');
      expect(healthLabel('unresponsive')).toBe('unresponsive?');
      expect(healthLabel('stuck')).toBe('stuck?');
      expect(healthLabel('dead')).toBe('dead');
      expect(healthLabel('stopped')).toBe('stopped');
    });
  });
});
