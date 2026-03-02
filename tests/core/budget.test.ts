import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkDailyBudget,
  recordSpending,
  getDailySpend,
  resetDailySpend,
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
});
