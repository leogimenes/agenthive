import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkDailyBudget,
  recordSpending,
  getDailySpend,
  resetDailySpend,
  logTaskCost,
  readCostLog,
  readCostLogSince,
} from '../../src/core/budget.js';

describe('budget', () => {
  let hivePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-test-budget-'));
  });

  afterEach(() => {
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── checkDailyBudget ──────────────────────────────────────────────

  describe('checkDailyBudget', () => {
    it('should allow spending when no spend file exists', () => {
      const result = checkDailyBudget(hivePath, 'sre', 20);
      expect(result.allowed).toBe(true);
      expect(result.spent).toBe(0);
    });

    it('should allow spending when under budget', () => {
      recordSpending(hivePath, 'sre', 5);
      const result = checkDailyBudget(hivePath, 'sre', 20);
      expect(result.allowed).toBe(true);
      expect(result.spent).toBe(5);
    });

    it('should deny spending when at or over budget', () => {
      recordSpending(hivePath, 'sre', 20);
      const result = checkDailyBudget(hivePath, 'sre', 20);
      expect(result.allowed).toBe(false);
      expect(result.spent).toBe(20);
    });
  });

  // ── recordSpending ────────────────────────────────────────────────

  describe('recordSpending', () => {
    it('should record initial spending', () => {
      const total = recordSpending(hivePath, 'sre', 2);
      expect(total).toBe(2);
    });

    it('should accumulate spending', () => {
      recordSpending(hivePath, 'sre', 2);
      recordSpending(hivePath, 'sre', 3);
      const total = recordSpending(hivePath, 'sre', 1.5);
      expect(total).toBe(6.5);
    });

    it('should avoid floating point drift', () => {
      // 0.1 + 0.2 should be 0.3, not 0.30000000000000004
      recordSpending(hivePath, 'sre', 0.1);
      const total = recordSpending(hivePath, 'sre', 0.2);
      expect(total).toBe(0.3);
    });

    it('should track agents independently', () => {
      recordSpending(hivePath, 'sre', 5);
      recordSpending(hivePath, 'frontend', 3);
      expect(getDailySpend(hivePath, 'sre').spent).toBe(5);
      expect(getDailySpend(hivePath, 'frontend').spent).toBe(3);
    });
  });

  // ── getDailySpend ─────────────────────────────────────────────────

  describe('getDailySpend', () => {
    it('should return 0 when no spend exists', () => {
      const result = getDailySpend(hivePath, 'sre');
      expect(result.spent).toBe(0);
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should return current spend', () => {
      recordSpending(hivePath, 'sre', 7.5);
      const result = getDailySpend(hivePath, 'sre');
      expect(result.spent).toBe(7.5);
    });
  });

  // ── resetDailySpend ───────────────────────────────────────────────

  describe('resetDailySpend', () => {
    it('should reset spend to 0', () => {
      recordSpending(hivePath, 'sre', 15);
      resetDailySpend(hivePath, 'sre');
      expect(getDailySpend(hivePath, 'sre').spent).toBe(0);
    });

    it('should not affect other agents', () => {
      recordSpending(hivePath, 'sre', 10);
      recordSpending(hivePath, 'frontend', 5);
      resetDailySpend(hivePath, 'sre');
      expect(getDailySpend(hivePath, 'sre').spent).toBe(0);
      expect(getDailySpend(hivePath, 'frontend').spent).toBe(5);
    });
  });

  // ── logTaskCost ────────────────────────────────────────────────────

  describe('logTaskCost', () => {
    it('should create a cost log entry', () => {
      logTaskCost(hivePath, 'sre', 'implement pagination', 2.0, true);
      const entries = readCostLog(hivePath, 'sre');
      expect(entries).toHaveLength(1);
      expect(entries[0].task).toBe('implement pagination');
      expect(entries[0].amount).toBe(2.0);
      expect(entries[0].success).toBe(true);
      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should append multiple entries', () => {
      logTaskCost(hivePath, 'sre', 'task 1', 2.0, true);
      logTaskCost(hivePath, 'sre', 'task 2', 1.5, false);
      logTaskCost(hivePath, 'sre', 'task 3', 2.0, true);
      const entries = readCostLog(hivePath, 'sre');
      expect(entries).toHaveLength(3);
      expect(entries[0].task).toBe('task 1');
      expect(entries[1].task).toBe('task 2');
      expect(entries[1].success).toBe(false);
      expect(entries[2].task).toBe('task 3');
    });

    it('should sanitize tabs and newlines in task descriptions', () => {
      logTaskCost(hivePath, 'sre', 'task\twith\ttabs\nand\nnewlines', 2.0, true);
      const entries = readCostLog(hivePath, 'sre');
      expect(entries).toHaveLength(1);
      expect(entries[0].task).not.toContain('\t');
      expect(entries[0].task).not.toContain('\n');
    });

    it('should track agents independently', () => {
      logTaskCost(hivePath, 'sre', 'sre task', 2.0, true);
      logTaskCost(hivePath, 'frontend', 'frontend task', 1.5, true);
      expect(readCostLog(hivePath, 'sre')).toHaveLength(1);
      expect(readCostLog(hivePath, 'frontend')).toHaveLength(1);
    });
  });

  // ── readCostLog ────────────────────────────────────────────────────

  describe('readCostLog', () => {
    it('should return empty array when no log exists', () => {
      const entries = readCostLog(hivePath, 'sre');
      expect(entries).toEqual([]);
    });
  });

  // ── date-rollover reset ───────────────────────────────────────────

  describe('date-rollover reset', () => {
    /**
     * Helper: write a spend file with an mtime from N days ago.
     */
    function writeStaleSpendFile(agentName: string, amount: number, daysAgo: number): void {
      const stateDir = join(hivePath, 'state');
      mkdirSync(stateDir, { recursive: true });
      const spendFile = join(stateDir, `${agentName}.daily-spend`);
      writeFileSync(spendFile, String(amount), 'utf-8');
      const staleTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      utimesSync(spendFile, staleTime, staleTime);
    }

    it('should reset spend to 0 when file is from yesterday (checkDailyBudget)', () => {
      writeStaleSpendFile('sre', 18, 1);
      const result = checkDailyBudget(hivePath, 'sre', 20);
      expect(result.spent).toBe(0);
      expect(result.allowed).toBe(true);
    });

    it('should return 0 spend when file is from yesterday (getDailySpend)', () => {
      writeStaleSpendFile('sre', 15, 1);
      const result = getDailySpend(hivePath, 'sre');
      expect(result.spent).toBe(0);
    });

    it('should reset and accumulate fresh spend after rollover (recordSpending)', () => {
      writeStaleSpendFile('sre', 19, 1);
      // First recordSpending call reads stale file → resets to 0, then adds 3
      const total = recordSpending(hivePath, 'sre', 3);
      expect(total).toBe(3);
    });

    it('should reset spend to 0 when file is from multiple days ago', () => {
      writeStaleSpendFile('sre', 20, 5);
      const result = checkDailyBudget(hivePath, 'sre', 20);
      expect(result.spent).toBe(0);
      expect(result.allowed).toBe(true);
    });

    it('should not reset spend when file is from today', () => {
      // recordSpending writes the file with today's mtime automatically
      recordSpending(hivePath, 'sre', 12);
      const result = getDailySpend(hivePath, 'sre');
      expect(result.spent).toBe(12);
    });

    it('should report the correct date after rollover', () => {
      writeStaleSpendFile('sre', 10, 1);
      const result = getDailySpend(hivePath, 'sre');
      const today = new Date().toISOString().slice(0, 10);
      expect(result.date).toBe(today);
    });

    it('should deny budget when daily max was already hit today (no rollover)', () => {
      // Spend exactly the daily max today (fresh file)
      recordSpending(hivePath, 'sre', 20);
      const result = checkDailyBudget(hivePath, 'sre', 20);
      expect(result.allowed).toBe(false);
      expect(result.spent).toBe(20);
    });

    it('should allow budget after rollover even when previous day was maxed', () => {
      writeStaleSpendFile('sre', 20, 1);
      const result = checkDailyBudget(hivePath, 'sre', 20);
      expect(result.allowed).toBe(true);
      expect(result.spent).toBe(0);
    });
  });

  // ── readCostLogSince ──────────────────────────────────────────────

  describe('readCostLogSince', () => {
    it('should filter entries by date', () => {
      logTaskCost(hivePath, 'sre', 'today task', 2.0, true);
      const today = new Date().toISOString().slice(0, 10);
      const entries = readCostLogSince(hivePath, 'sre', today);
      expect(entries).toHaveLength(1);
    });

    it('should exclude entries before since date', () => {
      logTaskCost(hivePath, 'sre', 'task', 2.0, true);
      // Use a future date to ensure it filters out
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const entries = readCostLogSince(hivePath, 'sre', tomorrow);
      expect(entries).toHaveLength(0);
    });
  });
});
