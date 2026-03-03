import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findTranscriptDir,
  listSessions,
  parseTranscript,
  getToolIcon,
  formatDuration,
} from '../../src/core/transcripts.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeEntry(
  type: 'user' | 'assistant',
  timestamp: string,
  content: unknown[],
): string {
  return JSON.stringify({
    type,
    timestamp,
    sessionId: 'test-session',
    message: { role: type, content },
  });
}

function makeToolUse(
  name: string,
  input: Record<string, unknown>,
): { type: string; name: string; input: Record<string, unknown> } {
  return { type: 'tool_use', name, input };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('transcripts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-test-transcripts-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── getToolIcon ────────────────────────────────────────────────────

  describe('getToolIcon', () => {
    it('should return known tool icons', () => {
      expect(getToolIcon('Bash')).toBe('$');
      expect(getToolIcon('Read')).toBe('r');
      expect(getToolIcon('Write')).toBe('w');
      expect(getToolIcon('Edit')).toBe('e');
      expect(getToolIcon('Grep')).toBe('/');
      expect(getToolIcon('Glob')).toBe('*');
      expect(getToolIcon('Agent')).toBe('>>');
    });

    it('should return first char lowercase for unknown tools', () => {
      expect(getToolIcon('CustomTool')).toBe('c');
      expect(getToolIcon('Xyz')).toBe('x');
    });
  });

  // ── formatDuration ─────────────────────────────────────────────────

  describe('formatDuration', () => {
    it('should format seconds', () => {
      expect(formatDuration(30)).toBe('30s');
    });

    it('should format minutes', () => {
      expect(formatDuration(120)).toBe('2m');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(90)).toBe('1m30s');
    });

    it('should format hours', () => {
      expect(formatDuration(3600)).toBe('1h');
    });

    it('should format hours and minutes', () => {
      expect(formatDuration(3720)).toBe('1h2m');
    });
  });

  // ── findTranscriptDir ──────────────────────────────────────────────

  describe('findTranscriptDir', () => {
    it('should return undefined for non-existent path', () => {
      const result = findTranscriptDir('/nonexistent/path/project');
      expect(result).toBeUndefined();
    });
  });

  // ── listSessions ──────────────────────────────────────────────────

  describe('listSessions', () => {
    it('should return empty array for non-existent directory', () => {
      const result = listSessions('/nonexistent/dir');
      expect(result).toEqual([]);
    });

    it('should return empty array for empty directory', () => {
      const result = listSessions(tmpDir);
      expect(result).toEqual([]);
    });

    it('should list sessions sorted by start time (newest first)', () => {
      // Create two session files
      const session1 = join(tmpDir, 'aaaa-1111.jsonl');
      const session2 = join(tmpDir, 'bbbb-2222.jsonl');

      writeFileSync(
        session1,
        [
          makeEntry('user', '2026-01-01T10:00:00Z', [
            { type: 'text', text: 'hello' },
          ]),
          makeEntry('assistant', '2026-01-01T10:05:00Z', [
            { type: 'text', text: 'response' },
          ]),
        ].join('\n'),
      );

      writeFileSync(
        session2,
        [
          makeEntry('user', '2026-01-02T10:00:00Z', [
            { type: 'text', text: 'hello again' },
          ]),
          makeEntry('assistant', '2026-01-02T10:10:00Z', [
            { type: 'text', text: 'response 2' },
          ]),
        ].join('\n'),
      );

      const sessions = listSessions(tmpDir);
      expect(sessions).toHaveLength(2);
      // Newest first
      expect(sessions[0].id).toBe('bbbb-2222');
      expect(sessions[1].id).toBe('aaaa-1111');
    });

    it('should compute duration and event count', () => {
      const session = join(tmpDir, 'session-1.jsonl');

      writeFileSync(
        session,
        [
          makeEntry('user', '2026-01-01T10:00:00Z', [
            { type: 'text', text: 'start' },
          ]),
          makeEntry('assistant', '2026-01-01T10:01:00Z', [
            { type: 'text', text: 'mid' },
          ]),
          makeEntry('assistant', '2026-01-01T10:02:00Z', [
            { type: 'text', text: 'end' },
          ]),
        ].join('\n'),
      );

      const sessions = listSessions(tmpDir);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].eventCount).toBe(3);
      expect(sessions[0].durationSecs).toBe(120); // 2 minutes
    });

    it('should skip non-jsonl files', () => {
      writeFileSync(join(tmpDir, 'notes.txt'), 'not a transcript');
      writeFileSync(
        join(tmpDir, 'session.jsonl'),
        makeEntry('user', '2026-01-01T10:00:00Z', [
          { type: 'text', text: 'hi' },
        ]),
      );

      const sessions = listSessions(tmpDir);
      expect(sessions).toHaveLength(1);
    });
  });

  // ── parseTranscript ────────────────────────────────────────────────

  describe('parseTranscript', () => {
    it('should return empty array for non-existent file', () => {
      const result = parseTranscript('/nonexistent/file.jsonl');
      expect(result).toEqual([]);
    });

    it('should parse tool_use events from assistant messages', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        [
          makeEntry('assistant', '2026-01-01T10:00:00Z', [
            makeToolUse('Bash', { command: 'npm test' }),
          ]),
          makeEntry('assistant', '2026-01-01T10:00:05Z', [
            makeToolUse('Read', { file_path: '/home/user/project/src/index.ts' }),
          ]),
          makeEntry('assistant', '2026-01-01T10:00:10Z', [
            makeToolUse('Edit', {
              file_path: '/home/user/project/src/main.ts',
            }),
          ]),
        ].join('\n'),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(3);

      expect(events[0].kind).toBe('tool_use');
      expect(events[0].toolName).toBe('Bash');
      expect(events[0].summary).toBe('npm test');

      expect(events[1].kind).toBe('tool_use');
      expect(events[1].toolName).toBe('Read');
      expect(events[1].summary).toContain('index.ts');

      expect(events[2].kind).toBe('tool_use');
      expect(events[2].toolName).toBe('Edit');
      expect(events[2].summary).toContain('main.ts');
    });

    it('should parse text events', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        makeEntry('assistant', '2026-01-01T10:00:00Z', [
          { type: 'text', text: 'I will fix the bug now.' },
        ]),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('text');
      expect(events[0].summary).toBe('I will fix the bug now.');
    });

    it('should parse thinking events', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        makeEntry('assistant', '2026-01-01T10:00:00Z', [
          { type: 'thinking', thinking: 'Let me think about this...' },
        ]),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('thinking');
      expect(events[0].summary).toBe('(thinking)');
    });

    it('should skip user messages', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        [
          makeEntry('user', '2026-01-01T10:00:00Z', [
            { type: 'text', text: 'Do something' },
          ]),
          makeEntry('assistant', '2026-01-01T10:00:05Z', [
            makeToolUse('Bash', { command: 'echo hello' }),
          ]),
        ].join('\n'),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Bash');
    });

    it('should skip queue-operation entries', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: '2026-01-01T10:00:00Z',
          }),
          makeEntry('assistant', '2026-01-01T10:00:05Z', [
            makeToolUse('Read', { file_path: '/tmp/test.ts' }),
          ]),
        ].join('\n'),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
    });

    it('should handle multiple content blocks in one entry', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        makeEntry('assistant', '2026-01-01T10:00:00Z', [
          { type: 'text', text: 'I will read the file.' },
          makeToolUse('Read', { file_path: '/tmp/test.ts' }),
          makeToolUse('Grep', { pattern: 'TODO', path: '/tmp' }),
        ]),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(3);
      expect(events[0].kind).toBe('text');
      expect(events[1].kind).toBe('tool_use');
      expect(events[1].toolName).toBe('Read');
      expect(events[2].kind).toBe('tool_use');
      expect(events[2].toolName).toBe('Grep');
      expect(events[2].summary).toContain('/TODO/');
    });

    it('should skip malformed lines gracefully', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        [
          'this is not json',
          makeEntry('assistant', '2026-01-01T10:00:00Z', [
            makeToolUse('Bash', { command: 'ls' }),
          ]),
          '{"broken": true',
        ].join('\n'),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Bash');
    });

    it('should summarize Grep tool with pattern and path', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        makeEntry('assistant', '2026-01-01T10:00:00Z', [
          makeToolUse('Grep', { pattern: 'function\\s+main', path: '/project/src' }),
        ]),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
      expect(events[0].summary).toContain('function\\s+main');
    });

    it('should summarize Glob tool with pattern', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        makeEntry('assistant', '2026-01-01T10:00:00Z', [
          makeToolUse('Glob', { pattern: '**/*.ts' }),
        ]),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
      expect(events[0].summary).toBe('**/*.ts');
    });

    it('should truncate long summaries', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      const longCmd = 'x'.repeat(200);
      writeFileSync(
        file,
        makeEntry('assistant', '2026-01-01T10:00:00Z', [
          makeToolUse('Bash', { command: longCmd }),
        ]),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(1);
      expect(events[0].summary.length).toBeLessThanOrEqual(103); // 100 + "..."
    });

    it('should handle empty text blocks', () => {
      const file = join(tmpDir, 'transcript.jsonl');
      writeFileSync(
        file,
        makeEntry('assistant', '2026-01-01T10:00:00Z', [
          { type: 'text', text: '' },
          { type: 'text', text: '   ' },
        ]),
      );

      const events = parseTranscript(file);
      expect(events).toHaveLength(0);
    });
  });
});
