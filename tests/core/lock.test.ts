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
      expect(status).toEqual({
        locked: true,
        pid: process.pid,
        stale: false,
      });
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
  });
});
