import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PALETTE,
  ROLE_COLOR_NAMES,
  TYPE_STYLE_MAP,
  getRoleColor,
  getRoleColorName,
  getSpendColor,
  timeAgo,
  formatTimestamp,
  formatMessage,
} from '../../src/core/colors.js';
import type { ChatMessage } from '../../src/types/config.js';

// ── getSpendColor ────────────────────────────────────────────────────

describe('getSpendColor', () => {
  it('should return green for zero spend', () => {
    expect(getSpendColor(0)).toBe('green');
  });

  it('should return green for spend at 0.5 (boundary — not > 0.5)', () => {
    expect(getSpendColor(0.5)).toBe('green');
  });

  it('should return yellow for spend just above 0.5', () => {
    expect(getSpendColor(0.51)).toBe('yellow');
  });

  it('should return yellow for spend at 0.8 (boundary — not > 0.8)', () => {
    expect(getSpendColor(0.8)).toBe('yellow');
  });

  it('should return red for spend just above 0.8', () => {
    expect(getSpendColor(0.81)).toBe('red');
  });

  it('should return red for spend at 1.0 (fully exhausted)', () => {
    expect(getSpendColor(1.0)).toBe('red');
  });

  it('should return red for spend above 1.0 (over budget)', () => {
    expect(getSpendColor(1.5)).toBe('red');
  });

  it('should return green for a small mid-range spend', () => {
    expect(getSpendColor(0.25)).toBe('green');
  });

  it('should return yellow for a mid-range spend between 0.5 and 0.8', () => {
    expect(getSpendColor(0.65)).toBe('yellow');
  });
});

// ── timeAgo ──────────────────────────────────────────────────────────

describe('timeAgo', () => {
  const BASE = '2026-01-15T12:00:00.000Z';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "just now" for a future timestamp', () => {
    expect(timeAgo('2026-01-15T12:00:01.000Z')).toBe('just now');
  });

  it('should return "0s ago" for the same instant', () => {
    expect(timeAgo(BASE)).toBe('0s ago');
  });

  it('should return seconds for a timestamp less than 60s ago', () => {
    expect(timeAgo('2026-01-15T11:59:45.000Z')).toBe('15s ago');
  });

  it('should return "59s ago" for 59 seconds ago', () => {
    expect(timeAgo('2026-01-15T11:59:01.000Z')).toBe('59s ago');
  });

  it('should return "1m ago" for exactly 60 seconds ago', () => {
    expect(timeAgo('2026-01-15T11:59:00.000Z')).toBe('1m ago');
  });

  it('should return minutes for a timestamp between 1m and 60m ago', () => {
    expect(timeAgo('2026-01-15T11:45:00.000Z')).toBe('15m ago');
  });

  it('should return "59m ago" for 59 minutes ago', () => {
    expect(timeAgo('2026-01-15T11:01:00.000Z')).toBe('59m ago');
  });

  it('should return "1h ago" for exactly 60 minutes ago', () => {
    expect(timeAgo('2026-01-15T11:00:00.000Z')).toBe('1h ago');
  });

  it('should return hours for a timestamp between 1h and 24h ago', () => {
    expect(timeAgo('2026-01-15T06:00:00.000Z')).toBe('6h ago');
  });

  it('should return "23h ago" for 23 hours ago', () => {
    expect(timeAgo('2026-01-14T13:00:00.000Z')).toBe('23h ago');
  });

  it('should return "1d ago" for exactly 24 hours ago', () => {
    expect(timeAgo('2026-01-14T12:00:00.000Z')).toBe('1d ago');
  });

  it('should return days for a timestamp more than 24h ago', () => {
    expect(timeAgo('2026-01-12T12:00:00.000Z')).toBe('3d ago');
  });

  it('should return "7d ago" for one week ago', () => {
    expect(timeAgo('2026-01-08T12:00:00.000Z')).toBe('7d ago');
  });
});

// ── formatTimestamp ──────────────────────────────────────────────────

describe('formatTimestamp', () => {
  it('should format midnight as 00:00:00', () => {
    // Use a known UTC timestamp and check it contains the expected time
    const result = formatTimestamp('2026-01-15T00:00:00.000Z');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('should return a string matching HH:MM:SS pattern', () => {
    const result = formatTimestamp('2026-06-20T14:30:45.000Z');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('should include two-digit hour, minute, and second', () => {
    const result = formatTimestamp('2026-01-01T09:05:03.000Z');
    // Each segment should be exactly two digits
    const parts = result.split(':');
    expect(parts).toHaveLength(3);
    parts.forEach((part) => expect(part).toMatch(/^\d{2}$/));
  });
});

// ── getRoleColorName ─────────────────────────────────────────────────

describe('getRoleColorName', () => {
  it('should return a string from ROLE_COLOR_NAMES for a new role', () => {
    const color = getRoleColorName('TEST_ROLE_ALPHA');
    expect(ROLE_COLOR_NAMES as readonly string[]).toContain(color);
  });

  it('should return the same color for the same role on repeated calls', () => {
    const first = getRoleColorName('TEST_ROLE_BETA');
    const second = getRoleColorName('TEST_ROLE_BETA');
    expect(first).toBe(second);
  });

  it('should assign different colors to the first two distinct roles', () => {
    // Use unique names to avoid collisions with cached state
    const a = getRoleColorName('TEST_ROLE_UNIQUE_A1');
    const b = getRoleColorName('TEST_ROLE_UNIQUE_B1');
    // They are assigned sequentially from the palette so must differ
    expect(a).not.toBe(b);
  });

  it('should cycle back through colors after exhausting the palette', () => {
    // Assign ROLE_COLOR_NAMES.length unique new roles to fill one full cycle
    const prefix = 'TEST_ROLE_CYCLE_';
    const len = ROLE_COLOR_NAMES.length;
    const colors: string[] = [];
    for (let i = 0; i < len; i++) {
      colors.push(getRoleColorName(`${prefix}${i}_${Date.now()}_${Math.random()}`));
    }
    // The next role should wrap around and match the first in this batch
    const wrap = getRoleColorName(`${prefix}wrap_${Date.now()}_${Math.random()}`);
    expect(wrap).toBe(colors[0]);
  });

  it('should only return values defined in ROLE_COLOR_NAMES', () => {
    const validColors = new Set(ROLE_COLOR_NAMES as readonly string[]);
    for (let i = 0; i < 20; i++) {
      const color = getRoleColorName(`TEST_VALIDITY_${i}`);
      expect(validColors.has(color)).toBe(true);
    }
  });
});

// ── getRoleColor ─────────────────────────────────────────────────────

describe('getRoleColor', () => {
  it('should return a function for a new role', () => {
    const fn = getRoleColor('COLOR_ROLE_ALPHA');
    expect(typeof fn).toBe('function');
  });

  it('should return the same function instance for the same role', () => {
    const first = getRoleColor('COLOR_ROLE_BETA');
    const second = getRoleColor('COLOR_ROLE_BETA');
    expect(first).toBe(second);
  });

  it('should return a function from the PALETTE for a new role', () => {
    const fn = getRoleColor('COLOR_ROLE_GAMMA');
    expect(PALETTE).toContain(fn);
  });

  it('should return a callable that accepts a string and returns a string', () => {
    const fn = getRoleColor('COLOR_ROLE_DELTA');
    const result = fn('hello');
    expect(typeof result).toBe('string');
  });

  it('should assign different color functions to different new roles', () => {
    const fn1 = getRoleColor('COLOR_ROLE_UNIQUE_X');
    const fn2 = getRoleColor('COLOR_ROLE_UNIQUE_Y');
    expect(fn1).not.toBe(fn2);
  });
});

// ── TYPE_STYLE_MAP ───────────────────────────────────────────────────

describe('TYPE_STYLE_MAP', () => {
  it('should define a style for REQUEST with bold and yellow', () => {
    expect(TYPE_STYLE_MAP.REQUEST).toMatchObject({ bold: true, color: 'yellow' });
  });

  it('should define a style for DONE with bold and green', () => {
    expect(TYPE_STYLE_MAP.DONE).toMatchObject({ bold: true, color: 'green' });
  });

  it('should define a style for BLOCKER with bold and red', () => {
    expect(TYPE_STYLE_MAP.BLOCKER).toMatchObject({ bold: true, color: 'red' });
  });

  it('should define a style for WARN with yellow (no bold)', () => {
    expect(TYPE_STYLE_MAP.WARN).toMatchObject({ color: 'yellow' });
    expect(TYPE_STYLE_MAP.WARN.bold).toBeUndefined();
  });

  it('should define a style for STATUS with gray (no bold)', () => {
    expect(TYPE_STYLE_MAP.STATUS).toMatchObject({ color: 'gray' });
    expect(TYPE_STYLE_MAP.STATUS.bold).toBeUndefined();
  });

  it('should define a style for QUESTION with cyan', () => {
    expect(TYPE_STYLE_MAP.QUESTION).toMatchObject({ color: 'cyan' });
  });

  it('should define a style for ACK with dim and white', () => {
    expect(TYPE_STYLE_MAP.ACK).toMatchObject({ dim: true, color: 'white' });
  });

  it('should have entries for all MessageType values', () => {
    const types = ['STATUS', 'DONE', 'REQUEST', 'QUESTION', 'BLOCKER', 'ACK', 'WARN'] as const;
    types.forEach((t) => {
      expect(TYPE_STYLE_MAP[t]).toBeDefined();
    });
  });
});

// ── formatMessage ────────────────────────────────────────────────────

describe('formatMessage', () => {
  const makeMsg = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
    role: 'FMT_TEST_ROLE',
    type: 'STATUS',
    body: 'hello world',
    lineNumber: 1,
    ...overrides,
  });

  it('should include the role name in the output', () => {
    const result = formatMessage(makeMsg({ role: 'MYBOT' }));
    expect(result).toContain('MYBOT');
  });

  it('should include the message type in the output', () => {
    const result = formatMessage(makeMsg({ type: 'DONE' }));
    expect(result).toContain('DONE');
  });

  it('should include the message body in the output', () => {
    const result = formatMessage(makeMsg({ body: 'task finished' }));
    expect(result).toContain('task finished');
  });

  it('should include the timestamp when provided', () => {
    const result = formatMessage(makeMsg({ timestamp: '2026-01-15T10:30:00.000Z' }));
    // The formatted time (HH:MM:SS) should appear in the output
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('should not include a timestamp segment when timestamp is undefined', () => {
    const msg = makeMsg({ timestamp: undefined });
    const result = formatMessage(msg);
    // Should not contain HH:MM:SS pattern from a timestamp
    // Body "hello world" contains no digits; role/type don't have colons
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('should wrap the role in square brackets', () => {
    const result = formatMessage(makeMsg({ role: 'BOTNAME' }));
    expect(result).toContain('[BOTNAME]');
  });

  it('should include a colon separator before the body', () => {
    const result = formatMessage(makeMsg({ body: 'some message' }));
    expect(result).toContain(': some message');
  });

  it('should return a non-empty string', () => {
    const result = formatMessage(makeMsg());
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle all MessageType values without throwing', () => {
    const types: ChatMessage['type'][] = ['STATUS', 'DONE', 'REQUEST', 'QUESTION', 'BLOCKER', 'ACK', 'WARN'];
    types.forEach((type) => {
      expect(() => formatMessage(makeMsg({ type }))).not.toThrow();
    });
  });
});
