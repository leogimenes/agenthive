import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireLock,
  releaseLock,
  getLockStatus,
  getCheckpoint,
  setCheckpoint,
  updateHeartbeat,
  isProcessAlive,
} from '../../src/core/lock.js';

describe('lock', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-test-lock-'));
  });

  afterEach(() => {
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── acquireLock ───────────────────────────────────────────────────

  describe('acquireLock', () => {
    it('should acquire a lock and write PID', () => {
      const acquired = acquireLock(hivePath, 'sre');
      expect(acquired).toBe(true);

      const lockFile = join(hivePath, 'state', 'sre.lock');
      expect(existsSync(lockFile)).toBe(true);

      const pid = parseInt(readFileSync(lockFile, 'utf-8').trim(), 10);
      expect(pid).toBe(process.pid);
    });

    it('should fail if the same process already holds the lock', () => {
      acquireLock(hivePath, 'sre');
      const second = acquireLock(hivePath, 'sre');
      expect(second).toBe(false);
    });

    it('should create the state directory if it does not exist', () => {
      const stateDir = join(hivePath, 'state');
      expect(existsSync(stateDir)).toBe(false);

      acquireLock(hivePath, 'sre');
      expect(existsSync(stateDir)).toBe(true);
    });

    it('should clean up stale locks (PID not running)', () => {
      // Write a lock with a PID that doesn't exist
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'sre.lock'), '999999999', 'utf-8');

      // Should clean up the stale lock and acquire
      const acquired = acquireLock(hivePath, 'sre');
      expect(acquired).toBe(true);
    });

    it('should handle independent agent locks', () => {
      const a = acquireLock(hivePath, 'sre');
      const b = acquireLock(hivePath, 'frontend');
      expect(a).toBe(true);
      expect(b).toBe(true);
    });
  });

  // ── releaseLock ───────────────────────────────────────────────────

  describe('releaseLock', () => {
    it('should remove the lock file', () => {
      acquireLock(hivePath, 'sre');
      releaseLock(hivePath, 'sre');

      const lockFile = join(hivePath, 'state', 'sre.lock');
      expect(existsSync(lockFile)).toBe(false);
    });

    it('should not throw if lock file does not exist', () => {
      expect(() => releaseLock(hivePath, 'sre')).not.toThrow();
    });
  });

  // ── getLockStatus ─────────────────────────────────────────────────

  describe('getLockStatus', () => {
    it('should return unlocked when no lock file exists', () => {
      const status = getLockStatus(hivePath, 'sre');
      expect(status).toEqual({ locked: false, stale: false });
    });

    it('should return running when current process holds lock', () => {
      acquireLock(hivePath, 'sre');
      const status = getLockStatus(hivePath, 'sre');
      expect(status.locked).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.stale).toBe(false);
      expect(status.heartbeat).toBeDefined();
    });

    it('should detect stale locks', () => {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'sre.lock'), '999999999', 'utf-8');

      const status = getLockStatus(hivePath, 'sre');
      expect(status.locked).toBe(true);
      expect(status.pid).toBe(999999999);
      expect(status.stale).toBe(true);
    });

    it('should handle corrupt lock files', () => {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'sre.lock'), 'not-a-number', 'utf-8');

      const status = getLockStatus(hivePath, 'sre');
      expect(status.locked).toBe(true);
      expect(status.stale).toBe(true);
    });
  });

  // ── Checkpoint ────────────────────────────────────────────────────

  describe('checkpoint', () => {
    it('should return 0 when no checkpoint exists', () => {
      expect(getCheckpoint(hivePath, 'sre')).toBe(0);
    });

    it('should set and get a checkpoint', () => {
      setCheckpoint(hivePath, 'sre', 42);
      expect(getCheckpoint(hivePath, 'sre')).toBe(42);
    });

    it('should update an existing checkpoint', () => {
      setCheckpoint(hivePath, 'sre', 10);
      setCheckpoint(hivePath, 'sre', 50);
      expect(getCheckpoint(hivePath, 'sre')).toBe(50);
    });

    it('should maintain independent checkpoints per agent', () => {
      setCheckpoint(hivePath, 'sre', 10);
      setCheckpoint(hivePath, 'frontend', 20);
      expect(getCheckpoint(hivePath, 'sre')).toBe(10);
      expect(getCheckpoint(hivePath, 'frontend')).toBe(20);
    });

    it('should return 0 for a corrupt checkpoint file', () => {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'sre.checkpoint'), 'not-a-number', 'utf-8');

      expect(getCheckpoint(hivePath, 'sre')).toBe(0);
    });
  });

  // ── isProcessAlive ────────────────────────────────────────────────

  describe('isProcessAlive', () => {
    it('should return true for the current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('should return false for a non-existent PID', () => {
      // PID 999999999 is virtually guaranteed not to exist
      expect(isProcessAlive(999999999)).toBe(false);
    });

  });

  // ── updateHeartbeat ───────────────────────────────────────────────

  describe('updateHeartbeat', () => {
    it('should not throw when no lock file exists', () => {
      expect(() => updateHeartbeat(hivePath, 'sre')).not.toThrow();
    });

    it('should preserve the PID while updating the heartbeat timestamp', () => {
      acquireLock(hivePath, 'sre');
      const lockFile = join(hivePath, 'state', 'sre.lock');
      const originalContent = readFileSync(lockFile, 'utf-8');
      const originalPid = parseInt(originalContent.split('\n')[0].trim(), 10);

      updateHeartbeat(hivePath, 'sre');

      const updatedContent = readFileSync(lockFile, 'utf-8');
      const updatedPid = parseInt(updatedContent.split('\n')[0].trim(), 10);
      const updatedHeartbeat = updatedContent.split('\n')[1]?.trim();

      expect(updatedPid).toBe(originalPid);
      expect(updatedHeartbeat).toBeDefined();
      expect(updatedHeartbeat).not.toBe('');
    });

    it('should only update the specified agent lock and leave others untouched', () => {
      acquireLock(hivePath, 'sre');
      acquireLock(hivePath, 'frontend');

      const frontendLockBefore = readFileSync(
        join(hivePath, 'state', 'frontend.lock'),
        'utf-8',
      );

      updateHeartbeat(hivePath, 'sre');

      const frontendLockAfter = readFileSync(
        join(hivePath, 'state', 'frontend.lock'),
        'utf-8',
      );

      expect(frontendLockAfter).toBe(frontendLockBefore);
    });

    it('should write a valid ISO 8601 heartbeat timestamp', () => {
      acquireLock(hivePath, 'sre');
      updateHeartbeat(hivePath, 'sre');

      const content = readFileSync(join(hivePath, 'state', 'sre.lock'), 'utf-8');
      const heartbeat = content.split('\n')[1]?.trim();

      expect(heartbeat).toBeDefined();
      expect(new Date(heartbeat!).toISOString()).toBe(heartbeat);
    });
  });

  // ── acquireLock — additional edge cases ───────────────────────────

  describe('acquireLock — additional edge cases', () => {
    it('should clean up a stale old-format lock (PID only, no heartbeat line)', () => {
      // Old format: just a PID with no trailing timestamp line
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'sre.lock'), '999999999', 'utf-8');

      // The stale lock (dead PID) should be cleaned and re-acquired
      const acquired = acquireLock(hivePath, 'sre');
      expect(acquired).toBe(true);

      const content = readFileSync(join(stateDir, 'sre.lock'), 'utf-8');
      const pid = parseInt(content.split('\n')[0].trim(), 10);
      expect(pid).toBe(process.pid);
    });

    it('should write a heartbeat timestamp when acquiring a new lock', () => {
      acquireLock(hivePath, 'sre');
      const content = readFileSync(join(hivePath, 'state', 'sre.lock'), 'utf-8');
      const lines = content.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(new Date(lines[1].trim()).toISOString()).toBe(lines[1].trim());
    });
  });

  // ── getLockStatus — additional edge cases ─────────────────────────

  describe('getLockStatus — additional edge cases', () => {
    it('should return undefined heartbeat for old-format lock files', () => {
      // Old format: PID only, no heartbeat line
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      // Use current process PID so the process is alive (not stale)
      writeFileSync(join(stateDir, 'sre.lock'), String(process.pid), 'utf-8');

      const status = getLockStatus(hivePath, 'sre');
      expect(status.locked).toBe(true);
      expect(status.stale).toBe(false);
      expect(status.heartbeat).toBeUndefined();
    });

    it('should report stale with heartbeat when dead PID has timestamp', () => {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      const ts = new Date().toISOString();
      writeFileSync(join(stateDir, 'sre.lock'), `999999999\n${ts}`, 'utf-8');

      const status = getLockStatus(hivePath, 'sre');
      expect(status.locked).toBe(true);
      expect(status.stale).toBe(true);
      expect(status.pid).toBe(999999999);
      expect(status.heartbeat).toBe(ts);
    });
  });
});
