import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findTranscriptDir,
  listSessions,
  parseTranscript,
  getToolIcon,
  formatDuration,
  rotateTranscriptDir,
  rotateTranscripts,
} from '../../src/core/transcripts.js';

// ── Mocks ────────────────────────────────────────────────────────────

// Mock node:os so we can control homedir() in findTranscriptDir tests.
// vi.mock is hoisted, so it runs before imports are evaluated.
vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>();
  return { ...mod, homedir: vi.fn(() => mod.homedir()) };
});

// Grab the mocked module so tests can call mockReturnValue on homedir.
const { homedir: homedirMock } = await import('node:os');

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
    afterEach(() => {
      vi.mocked(homedirMock).mockReset();
    });

    it('should return undefined for non-existent path', () => {
      const result = findTranscriptDir('/nonexistent/path/project');
      expect(result).toBeUndefined();
    });

    it('should return undefined when ~/.claude/projects does not exist', () => {
      // Point homedir at tmpDir — no .claude/projects inside it
      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      const result = findTranscriptDir('/some/project');
      expect(result).toBeUndefined();
    });

    it('should return undefined when projects dir exists but encoded path does not', () => {
      // Create ~/.claude/projects but NOT the encoded project directory
      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      mkdirSync(claudeProjectsDir, { recursive: true });
      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      const result = findTranscriptDir('/project/that/does/not/exist');
      expect(result).toBeUndefined();
    });

    it('should return the encoded path when the transcript directory exists', () => {
      // Encode the worktree path the same way the implementation does:
      // absolute path with every '/' replaced by '-'
      const worktreePath = join(tmpDir, 'my-project');
      const absPath = resolve(worktreePath);
      const encoded = absPath.replace(/\//g, '-');

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      const expectedDir = join(claudeProjectsDir, encoded);
      mkdirSync(expectedDir, { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      const result = findTranscriptDir(worktreePath);
      expect(result).toBe(expectedDir);
    });

    it('should resolve absolute paths correctly before encoding', () => {
      // Provide an absolute worktree path and verify the expected encoded dir is returned
      const absWorktreePath = join(tmpDir, 'agent', 'backend');
      const encoded = absWorktreePath.replace(/\//g, '-');

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      const expectedDir = join(claudeProjectsDir, encoded);
      mkdirSync(expectedDir, { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      const result = findTranscriptDir(absWorktreePath);
      expect(result).toBe(expectedDir);
    });

    it('should encode path by replacing all slashes with dashes', () => {
      // Verify encoding: /home/user/project -> -home-user-project
      const worktreePath = '/home/user/project';
      const expectedEncoded = '-home-user-project';

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      const expectedDir = join(claudeProjectsDir, expectedEncoded);
      mkdirSync(expectedDir, { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      const result = findTranscriptDir(worktreePath);
      expect(result).toBe(expectedDir);
    });

    it('should return undefined when a sibling encoded path exists but not the target', () => {
      // Create a different project's encoded directory
      const otherPath = '/home/user/other-project';
      const otherEncoded = otherPath.replace(/\//g, '-');

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      mkdirSync(join(claudeProjectsDir, otherEncoded), { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      // Look up a completely different project
      const result = findTranscriptDir('/home/user/my-project');
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

    it('should handle retention=1 by keeping only the single newest session', () => {
      function createSession2(dir: string, id: string, timestamp: string): void {
        writeFileSync(
          join(dir, `${id}.jsonl`),
          makeEntry('user', timestamp, [{ type: 'text', text: 'x' }]),
        );
      }
      createSession2(tmpDir, 'alpha', '2026-02-01T08:00:00Z');
      createSession2(tmpDir, 'beta', '2026-02-02T08:00:00Z');
      createSession2(tmpDir, 'gamma', '2026-02-03T08:00:00Z');

      const result = rotateTranscriptDir(tmpDir, 1);
      expect(result.deleted).toBe(2);

      expect(existsSync(join(tmpDir, 'gamma.jsonl'))).toBe(true);
      expect(existsSync(join(tmpDir, 'beta.jsonl'))).toBe(false);
      expect(existsSync(join(tmpDir, 'alpha.jsonl'))).toBe(false);
    });

    it('should handle empty transcript directory gracefully', () => {
      // tmpDir is empty for this test (no sessions created)
      const result = rotateTranscriptDir(tmpDir, 5);
      expect(result.deleted).toBe(0);
    });
  });

  // ── rotateTranscripts ──────────────────────────────────────────────

  describe('rotateTranscripts', () => {
    afterEach(() => {
      vi.mocked(homedirMock).mockReset();
    });

    it('should return 0 deleted when transcript dir does not exist for worktree', () => {
      // Point homedir at tmpDir — no .claude/projects inside it
      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      const result = rotateTranscripts('/some/worktree/path', 20);
      expect(result.deleted).toBe(0);
    });

    it('should return 0 deleted when worktree is not registered in claude projects', () => {
      // Create .claude/projects but no matching encoded path
      mkdirSync(join(tmpDir, '.claude', 'projects'), { recursive: true });
      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      const result = rotateTranscripts('/nonexistent/worktree', 20);
      expect(result.deleted).toBe(0);
    });

    it('should rotate sessions in the found transcript dir', () => {
      // Set up a fake worktree path and its encoded transcript directory
      const worktreePath = '/fake/agent/backend';
      const encoded = worktreePath.replace(/\//g, '-'); // '-fake-agent-backend'

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      const transcriptDir = join(claudeProjectsDir, encoded);
      mkdirSync(transcriptDir, { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      // Create 3 sessions in the transcript dir (old first, new last)
      for (let i = 1; i <= 3; i++) {
        const ts = `2026-03-0${i}T10:00:00Z`;
        writeFileSync(
          join(transcriptDir, `session-${i}.jsonl`),
          makeEntry('user', ts, [{ type: 'text', text: 'hi' }]),
        );
      }

      // Keep only 2 newest
      const result = rotateTranscripts(worktreePath, 2);
      expect(result.deleted).toBe(1);

      expect(existsSync(join(transcriptDir, 'session-3.jsonl'))).toBe(true);
      expect(existsSync(join(transcriptDir, 'session-2.jsonl'))).toBe(true);
      expect(existsSync(join(transcriptDir, 'session-1.jsonl'))).toBe(false);
    });

    it('should use default retention of 20 when not specified', () => {
      const worktreePath = '/fake/agent/qa';
      const encoded = worktreePath.replace(/\//g, '-');

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      const transcriptDir = join(claudeProjectsDir, encoded);
      mkdirSync(transcriptDir, { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      // Create exactly 20 sessions — none should be deleted with default retention
      for (let i = 1; i <= 20; i++) {
        const ts = `2026-03-${String(i).padStart(2, '0')}T10:00:00Z`;
        writeFileSync(
          join(transcriptDir, `session-${i}.jsonl`),
          makeEntry('user', ts, [{ type: 'text', text: 'hi' }]),
        );
      }

      // Default retention = 20, exactly at limit — nothing deleted
      const result = rotateTranscripts(worktreePath);
      expect(result.deleted).toBe(0);
    });

    it('should delete sessions beyond default retention of 20', () => {
      const worktreePath = '/fake/agent/frontend';
      const encoded = worktreePath.replace(/\//g, '-');

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      const transcriptDir = join(claudeProjectsDir, encoded);
      mkdirSync(transcriptDir, { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      // Create 23 sessions — 3 should be deleted with default retention (20)
      for (let i = 1; i <= 23; i++) {
        const ts = `2026-03-${String(i).padStart(2, '0')}T10:00:00Z`;
        writeFileSync(
          join(transcriptDir, `session-${i}.jsonl`),
          makeEntry('user', ts, [{ type: 'text', text: 'hi' }]),
        );
      }

      const result = rotateTranscripts(worktreePath);
      expect(result.deleted).toBe(3);
    });

    it('should also clean up tool-results dirs for rotated sessions', () => {
      const worktreePath = '/fake/agent/pm';
      const encoded = worktreePath.replace(/\//g, '-');

      const claudeProjectsDir = join(tmpDir, '.claude', 'projects');
      const transcriptDir = join(claudeProjectsDir, encoded);
      mkdirSync(transcriptDir, { recursive: true });

      vi.mocked(homedirMock).mockReturnValue(tmpDir);

      // Create 2 sessions with matching tool-results dirs
      writeFileSync(
        join(transcriptDir, 'old-session.jsonl'),
        makeEntry('user', '2026-01-01T10:00:00Z', [{ type: 'text', text: 'old' }]),
      );
      writeFileSync(
        join(transcriptDir, 'new-session.jsonl'),
        makeEntry('user', '2026-01-02T10:00:00Z', [{ type: 'text', text: 'new' }]),
      );

      const toolResultsDir = join(transcriptDir, 'tool-results');
      mkdirSync(join(toolResultsDir, 'old-session'), { recursive: true });
      mkdirSync(join(toolResultsDir, 'new-session'), { recursive: true });

      // Keep only 1 newest — old-session should be cleaned up
      const result = rotateTranscripts(worktreePath, 1);
      expect(result.deleted).toBe(1);

      expect(existsSync(join(transcriptDir, 'old-session.jsonl'))).toBe(false);
      expect(existsSync(join(toolResultsDir, 'old-session'))).toBe(false);
      expect(existsSync(join(transcriptDir, 'new-session.jsonl'))).toBe(true);
      expect(existsSync(join(toolResultsDir, 'new-session'))).toBe(true);
    });
  });
});
