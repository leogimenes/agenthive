import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireGitLock,
  releaseGitLock,
  getGitLockStatus,
} from '../../src/core/gitlock.js';

describe('gitlock', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-gitlock-'));
    mkdirSync(join(hivePath, 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── acquireGitLock ──────────────────────────────────────────────

  describe('acquireGitLock', () => {
    it('should acquire lock when no lock exists', async () => {
      const result = await acquireGitLock(hivePath, 'backend', 'sync');
      expect(result).toBe(true);

      // Lock file should exist
      expect(existsSync(join(hivePath, 'state', 'git.lock'))).toBe(true);
    });

    it('should write correct lock content', async () => {
      await acquireGitLock(hivePath, 'backend', 'push');

      const content = readFileSync(join(hivePath, 'state', 'git.lock'), 'utf-8');
      const lines = content.split('\n');
      expect(lines[0]).toBe(String(process.pid));
      expect(lines[1]).toBe('backend');
      expect(lines[2]).toBe('push');
      // Line 3 is ISO timestamp
      expect(new Date(lines[3]).getTime()).not.toBeNaN();
    });

    it('should fail non-blocking when lock is held by current process (different agent)', async () => {
      // Simulate another agent holding the lock by writing a lock with current PID but different agent
      const lockFile = join(hivePath, 'state', 'git.lock');
      writeFileSync(lockFile, `${process.pid}\nother-agent\nsync\n${new Date().toISOString()}`, 'utf-8');

      const result = await acquireGitLock(hivePath, 'backend', 'sync', 0);
      expect(result).toBe(false);
    });

    it('should acquire lock when existing lock has dead PID', async () => {
      // Write a lock with a PID that doesn't exist
      const lockFile = join(hivePath, 'state', 'git.lock');
      writeFileSync(lockFile, `999999\nold-agent\nsync\n${new Date().toISOString()}`, 'utf-8');

      const result = await acquireGitLock(hivePath, 'backend', 'sync');
      expect(result).toBe(true);
    });

    it('should acquire lock when existing lock is expired', async () => {
      // Write a lock with current PID but expired timestamp (2 minutes ago)
      const lockFile = join(hivePath, 'state', 'git.lock');
      const expired = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(lockFile, `${process.pid}\nold-agent\nsync\n${expired}`, 'utf-8');

      const result = await acquireGitLock(hivePath, 'backend', 'sync');
      expect(result).toBe(true);
    });

    it('should create state directory if it does not exist', async () => {
      const freshHivePath = mkdtempSync(join(tmpdir(), 'hive-gitlock-fresh-'));
      try {
        const result = await acquireGitLock(freshHivePath, 'backend', 'sync');
        expect(result).toBe(true);
        expect(existsSync(join(freshHivePath, 'state', 'git.lock'))).toBe(true);
      } finally {
        rmSync(freshHivePath, { recursive: true, force: true });
      }
    });
  });

  // ── releaseGitLock ──────────────────────────────────────────────

  describe('releaseGitLock', () => {
    it('should remove lock file when held by this agent', async () => {
      await acquireGitLock(hivePath, 'backend', 'sync');
      releaseGitLock(hivePath, 'backend');

      expect(existsSync(join(hivePath, 'state', 'git.lock'))).toBe(false);
    });

    it('should not remove lock file held by different agent', async () => {
      // Write lock for different agent
      const lockFile = join(hivePath, 'state', 'git.lock');
      writeFileSync(lockFile, `${process.pid}\nfrontend\nsync\n${new Date().toISOString()}`, 'utf-8');

      releaseGitLock(hivePath, 'backend');

      // Lock should still exist (owned by frontend)
      expect(existsSync(lockFile)).toBe(true);
    });

    it('should not throw when no lock exists', () => {
      expect(() => releaseGitLock(hivePath, 'backend')).not.toThrow();
    });
  });

  // ── getGitLockStatus ────────────────────────────────────────────

  describe('getGitLockStatus', () => {
    it('should return null when no lock exists', () => {
      expect(getGitLockStatus(hivePath)).toBeNull();
    });

    it('should return lock info when lock is held', async () => {
      await acquireGitLock(hivePath, 'backend', 'push');

      const status = getGitLockStatus(hivePath);
      expect(status).not.toBeNull();
      expect(status!.agent).toBe('backend');
      expect(status!.operation).toBe('push');
      expect(status!.pid).toBe(process.pid);
    });

    it('should return null for expired lock', () => {
      const lockFile = join(hivePath, 'state', 'git.lock');
      const expired = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(lockFile, `${process.pid}\nbackend\nsync\n${expired}`, 'utf-8');

      expect(getGitLockStatus(hivePath)).toBeNull();
    });

    it('should return null for dead PID lock', () => {
      const lockFile = join(hivePath, 'state', 'git.lock');
      writeFileSync(lockFile, `999999\nbackend\nsync\n${new Date().toISOString()}`, 'utf-8');

      expect(getGitLockStatus(hivePath)).toBeNull();
    });
  });

  // ── Lock acquire + release cycle ────────────────────────────────

  describe('acquire-release cycle', () => {
    it('should allow re-acquisition after release', async () => {
      const first = await acquireGitLock(hivePath, 'backend', 'sync');
      expect(first).toBe(true);

      releaseGitLock(hivePath, 'backend');

      const second = await acquireGitLock(hivePath, 'frontend', 'push');
      expect(second).toBe(true);

      const status = getGitLockStatus(hivePath);
      expect(status!.agent).toBe('frontend');
    });
  });
});
