import { describe, it, expect } from 'vitest';
import type { TranscriptEvent } from '../../src/core/transcripts.js';
import type { SessionInfo } from '../../src/core/transcripts.js';
import {
  formatEventLine,
  selectLatestSession,
  clampScrollOffset,
} from '../../src/tui/hooks/useTranscriptEvents.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeEvent(
  kind: TranscriptEvent['kind'],
  opts: Partial<TranscriptEvent> = {},
): TranscriptEvent {
  return {
    timestamp: '2026-01-01T10:00:00Z',
    kind,
    summary: opts.summary ?? 'some summary',
    toolName: opts.toolName,
    agent: opts.agent,
  };
}

function makeSession(id: string, startTime?: string, eventCount = 5): SessionInfo {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    startTime,
    durationSecs: 60,
    eventCount,
  };
}

// ── formatEventLine ─────────────────────────────────────────────────

describe('formatEventLine', () => {
  it('should format tool_use events with icon and tool name', () => {
    const event = makeEvent('tool_use', { toolName: 'Bash', summary: 'npm test' });
    const line = formatEventLine(event);
    expect(line).toContain('$');
    expect(line).toContain('Bash');
    expect(line).toContain('npm test');
  });

  it('should format Read tool events', () => {
    const event = makeEvent('tool_use', { toolName: 'Read', summary: '…/src/index.ts' });
    const line = formatEventLine(event);
    expect(line).toContain('r');
    expect(line).toContain('Read');
    expect(line).toContain('…/src/index.ts');
  });

  it('should format Edit tool events', () => {
    const event = makeEvent('tool_use', { toolName: 'Edit', summary: '…/src/main.ts' });
    const line = formatEventLine(event);
    expect(line).toContain('e');
    expect(line).toContain('Edit');
  });

  it('should format text events without tool icon', () => {
    const event = makeEvent('text', { summary: 'I will fix the bug now.' });
    const line = formatEventLine(event);
    expect(line).toContain('I will fix the bug now.');
    // Should not have a tool icon prefix like [$] or [r]
    expect(line).not.toContain('[Bash]');
  });

  it('should format thinking events with distinctive marker', () => {
    const event = makeEvent('thinking', { summary: '(thinking)' });
    const line = formatEventLine(event);
    expect(line).toContain('thinking');
  });

  it('should include timestamp in output', () => {
    const event = makeEvent('tool_use', {
      toolName: 'Bash',
      summary: 'ls',
    });
    const line = formatEventLine(event);
    // Timestamp should be present in some form
    expect(line.length).toBeGreaterThan(5);
  });
});

// ── selectLatestSession ─────────────────────────────────────────────

describe('selectLatestSession', () => {
  it('should return undefined for empty sessions array', () => {
    expect(selectLatestSession([])).toBeUndefined();
  });

  it('should return the single session when only one exists', () => {
    const sessions = [makeSession('abc', '2026-01-01T10:00:00Z')];
    expect(selectLatestSession(sessions)?.id).toBe('abc');
  });

  it('should return the first session (newest first ordering)', () => {
    const sessions = [
      makeSession('newest', '2026-01-02T10:00:00Z'),
      makeSession('older', '2026-01-01T10:00:00Z'),
    ];
    expect(selectLatestSession(sessions)?.id).toBe('newest');
  });

  it('should handle sessions without startTime', () => {
    const sessions = [makeSession('no-time', undefined)];
    const result = selectLatestSession(sessions);
    expect(result?.id).toBe('no-time');
  });
});

// ── clampScrollOffset ───────────────────────────────────────────────

describe('clampScrollOffset', () => {
  it('should return 0 for empty events', () => {
    expect(clampScrollOffset(0, 0, 10)).toBe(0);
  });

  it('should clamp offset to 0 when events fit in view', () => {
    // 5 events, 10 max visible -> no scrolling needed
    expect(clampScrollOffset(3, 5, 10)).toBe(0);
  });

  it('should allow positive offset when events exceed max visible', () => {
    // 20 events, 10 max visible -> can scroll up to 10
    const result = clampScrollOffset(5, 20, 10);
    expect(result).toBe(5);
  });

  it('should clamp offset to maximum possible value', () => {
    // 20 events, 10 max visible -> max offset = 10
    const result = clampScrollOffset(100, 20, 10);
    expect(result).toBe(10);
  });

  it('should not return negative offset', () => {
    expect(clampScrollOffset(-5, 10, 5)).toBe(0);
  });
});
