import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findTranscriptDir,
  listSessions,
  parseTranscript,
  getToolIcon,
  formatDuration,
  rotateTranscriptDir,
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

  // ── rotateTranscriptDir ────────────────────────────────────────────

  describe('rotateTranscriptDir', () => {
    /**
     * Helper: create a fake session JSONL file with a given ISO timestamp
     * so listSessions() can sort by startTime.
     */
    function createSession(dir: string, id: string, timestamp: string): string {
      const filePath = join(dir, `${id}.jsonl`);
      writeFileSync(
        filePath,
        makeEntry('user', timestamp, [{ type: 'text', text: 'hello' }]),
      );
      return filePath;
    }

    it('should return 0 deleted when directory does not exist', () => {
      const result = rotateTranscriptDir('/nonexistent/dir', 20);
      expect(result.deleted).toBe(0);
    });

    it('should return 0 deleted when sessions count is at or below retention limit', () => {
      // Create 3 sessions, retention = 5
      createSession(tmpDir, 'session-1', '2026-01-01T10:00:00Z');
      createSession(tmpDir, 'session-2', '2026-01-02T10:00:00Z');
      createSession(tmpDir, 'session-3', '2026-01-03T10:00:00Z');

      const result = rotateTranscriptDir(tmpDir, 5);
      expect(result.deleted).toBe(0);

      // All files should still exist
      expect(existsSync(join(tmpDir, 'session-1.jsonl'))).toBe(true);
      expect(existsSync(join(tmpDir, 'session-2.jsonl'))).toBe(true);
      expect(existsSync(join(tmpDir, 'session-3.jsonl'))).toBe(true);
    });

    it('should return 0 deleted when sessions count exactly equals retention limit', () => {
      createSession(tmpDir, 'session-a', '2026-01-01T10:00:00Z');
      createSession(tmpDir, 'session-b', '2026-01-02T10:00:00Z');

      const result = rotateTranscriptDir(tmpDir, 2);
      expect(result.deleted).toBe(0);
    });

    it('should delete oldest sessions beyond the retention limit', () => {
      // Create 5 sessions with different timestamps (oldest to newest)
      createSession(tmpDir, 'oldest-1', '2026-01-01T10:00:00Z');
      createSession(tmpDir, 'older-2',  '2026-01-02T10:00:00Z');
      createSession(tmpDir, 'middle-3', '2026-01-03T10:00:00Z');
      createSession(tmpDir, 'newer-4',  '2026-01-04T10:00:00Z');
      createSession(tmpDir, 'newest-5', '2026-01-05T10:00:00Z');

      // Keep only 3 newest
      const result = rotateTranscriptDir(tmpDir, 3);
      expect(result.deleted).toBe(2);

      // Newest 3 should survive
      expect(existsSync(join(tmpDir, 'newest-5.jsonl'))).toBe(true);
      expect(existsSync(join(tmpDir, 'newer-4.jsonl'))).toBe(true);
      expect(existsSync(join(tmpDir, 'middle-3.jsonl'))).toBe(true);

      // Oldest 2 should be gone
      expect(existsSync(join(tmpDir, 'older-2.jsonl'))).toBe(false);
      expect(existsSync(join(tmpDir, 'oldest-1.jsonl'))).toBe(false);
    });

    it('should also delete tool-results subdirectory for rotated sessions', () => {
      createSession(tmpDir, 'old-session', '2026-01-01T10:00:00Z');
      createSession(tmpDir, 'new-session', '2026-01-02T10:00:00Z');

      // Create matching tool-results dirs
      const toolResultsDir = join(tmpDir, 'tool-results');
      mkdirSync(join(toolResultsDir, 'old-session'), { recursive: true });
      mkdirSync(join(toolResultsDir, 'new-session'), { recursive: true });

      // Keep only 1 newest
      const result = rotateTranscriptDir(tmpDir, 1);
      expect(result.deleted).toBe(1);

      // old-session jsonl and tool-results dir should be gone
      expect(existsSync(join(tmpDir, 'old-session.jsonl'))).toBe(false);
      expect(existsSync(join(toolResultsDir, 'old-session'))).toBe(false);

      // new-session should be intact
      expect(existsSync(join(tmpDir, 'new-session.jsonl'))).toBe(true);
      expect(existsSync(join(toolResultsDir, 'new-session'))).toBe(true);
    });

    it('should not fail when tool-results dir does not exist for a session', () => {
      createSession(tmpDir, 'session-no-tools', '2026-01-01T10:00:00Z');
      createSession(tmpDir, 'session-with-tools', '2026-01-02T10:00:00Z');

      // No tool-results directory created
      const result = rotateTranscriptDir(tmpDir, 1);
      expect(result.deleted).toBe(1);
      expect(existsSync(join(tmpDir, 'session-no-tools.jsonl'))).toBe(false);
    });

    it('should keep exactly retention count of sessions', () => {
      for (let i = 1; i <= 25; i++) {
        const ts = `2026-01-${String(i).padStart(2, '0')}T10:00:00Z`;
        createSession(tmpDir, `session-${i}`, ts);
      }

      const result = rotateTranscriptDir(tmpDir, 20);
      expect(result.deleted).toBe(5);

      // Sessions 6-25 (newest 20) survive, sessions 1-5 deleted
      for (let i = 6; i <= 25; i++) {
        expect(existsSync(join(tmpDir, `session-${i}.jsonl`))).toBe(true);
      }
      for (let i = 1; i <= 5; i++) {
        expect(existsSync(join(tmpDir, `session-${i}.jsonl`))).toBe(false);
      }
    });
  });
});
