import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '../../src/types/config.js';
import { applyFilters } from '../../src/tui/hooks/useChatMessages.js';
import { timeAgo } from '../../src/core/colors.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeMsg(
  lineNumber: number,
  role: string,
  type: ChatMessage['type'],
  body: string,
  timestamp?: string,
): ChatMessage {
  return { lineNumber, role, type, body, timestamp };
}

const SAMPLE_MESSAGES: ChatMessage[] = [
  makeMsg(1, 'BACKEND', 'STATUS', 'working on feature', '2026-01-01T10:00:00Z'),
  makeMsg(2, 'FRONTEND', 'DONE', 'UI complete', '2026-01-01T10:01:00Z'),
  makeMsg(3, 'BACKEND', 'BLOCKER', 'need API key', '2026-01-01T10:02:00Z'),
  makeMsg(4, 'USER', 'REQUEST', 'backend please do x', '2026-01-01T10:03:00Z'),
  makeMsg(5, 'FRONTEND', 'STATUS', 'still building', '2026-01-01T10:04:00Z'),
];

// ── applyFilters ─────────────────────────────────────────────────────

describe('applyFilters', () => {
  it('should return all messages when no filters are set', () => {
    const result = applyFilters(SAMPLE_MESSAGES);
    expect(result).toHaveLength(5);
    expect(result).toEqual(SAMPLE_MESSAGES);
  });

  it('should filter by role when filterRole is provided', () => {
    const result = applyFilters(SAMPLE_MESSAGES, 'BACKEND');
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.role === 'BACKEND')).toBe(true);
    expect(result[0].lineNumber).toBe(1);
    expect(result[1].lineNumber).toBe(3);
  });

  it('should filter by type when filterType is provided', () => {
    const result = applyFilters(SAMPLE_MESSAGES, undefined, 'STATUS');
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.type === 'STATUS')).toBe(true);
    expect(result[0].lineNumber).toBe(1);
    expect(result[1].lineNumber).toBe(5);
  });

  it('should apply both role and type filters together', () => {
    const result = applyFilters(SAMPLE_MESSAGES, 'FRONTEND', 'STATUS');
    expect(result).toHaveLength(1);
    expect(result[0].lineNumber).toBe(5);
    expect(result[0].role).toBe('FRONTEND');
    expect(result[0].type).toBe('STATUS');
  });

  it('should return empty array when no messages match', () => {
    const result = applyFilters(SAMPLE_MESSAGES, 'DEVOPS', 'DONE');
    expect(result).toHaveLength(0);
  });

  it('should return empty array for empty input', () => {
    const result = applyFilters([], 'BACKEND', 'STATUS');
    expect(result).toHaveLength(0);
  });

  it('should return all messages when filters are undefined', () => {
    const result = applyFilters(SAMPLE_MESSAGES, undefined, undefined);
    expect(result).toHaveLength(5);
  });

  it('should handle FRONTEND role filter correctly', () => {
    const result = applyFilters(SAMPLE_MESSAGES, 'FRONTEND');
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.lineNumber)).toEqual([2, 5]);
  });
});

// ── timeAgo (relative timestamps) ────────────────────────────────────

describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return seconds ago for timestamps less than 60 seconds old', () => {
    const now = new Date('2026-03-05T12:00:30Z');
    vi.setSystemTime(now);
    const ts = new Date('2026-03-05T12:00:00Z').toISOString();
    expect(timeAgo(ts)).toBe('30s ago');
  });

  it('should return minutes ago for timestamps 1-59 minutes old', () => {
    const now = new Date('2026-03-05T12:05:00Z');
    vi.setSystemTime(now);
    const ts = new Date('2026-03-05T12:00:00Z').toISOString();
    expect(timeAgo(ts)).toBe('5m ago');
  });

  it('should return hours ago for timestamps 1-23 hours old', () => {
    const now = new Date('2026-03-05T15:00:00Z');
    vi.setSystemTime(now);
    const ts = new Date('2026-03-05T12:00:00Z').toISOString();
    expect(timeAgo(ts)).toBe('3h ago');
  });

  it('should return days ago for timestamps more than 24 hours old', () => {
    const now = new Date('2026-03-07T12:00:00Z');
    vi.setSystemTime(now);
    const ts = new Date('2026-03-05T12:00:00Z').toISOString();
    expect(timeAgo(ts)).toBe('2d ago');
  });

  it('should return "just now" for future timestamps', () => {
    const now = new Date('2026-03-05T12:00:00Z');
    vi.setSystemTime(now);
    const ts = new Date('2026-03-05T12:00:01Z').toISOString();
    expect(timeAgo(ts)).toBe('just now');
  });

  it('should return "0s ago" for timestamp equal to now', () => {
    const now = new Date('2026-03-05T12:00:00Z');
    vi.setSystemTime(now);
    const ts = now.toISOString();
    expect(timeAgo(ts)).toBe('0s ago');
  });
});
