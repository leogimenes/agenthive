import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initChatFile,
  appendMessage,
  readMessages,
  readMessagesSince,
  findRequests,
  getChatLineCount,
  resolveChatPath,
} from '../../src/core/chat.js';

describe('chat', () => {
  let hivePath: string;
  let chatFilePath: string;

  beforeEach(() => {
    hivePath = mkdtempSync(join(tmpdir(), 'hive-test-chat-'));
    chatFilePath = initChatFile(hivePath);
  });

  afterEach(() => {
    rmSync(hivePath, { recursive: true, force: true });
  });

  // ── initChatFile ──────────────────────────────────────────────────

  describe('initChatFile', () => {
    it('should create a chat file with protocol header', () => {
      const content = readFileSync(chatFilePath, 'utf-8');
      expect(content).toContain('# HIVE — Inter-Agent Coordination Log');
      expect(content).toContain('[ROLE] TYPE <ISO8601>: message body');
    });

    it('should return the absolute path', () => {
      expect(chatFilePath).toBe(join(hivePath, 'chat.md'));
    });

    it('should accept a custom file name', () => {
      const custom = initChatFile(hivePath, 'custom-chat.md');
      expect(custom).toBe(join(hivePath, 'custom-chat.md'));
    });
  });

  // ── appendMessage ─────────────────────────────────────────────────

  describe('appendMessage', () => {
    it('should append a correctly formatted message with timestamp', () => {
      appendMessage(chatFilePath, 'SRE', 'DONE', 'fixed the thing');
      const content = readFileSync(chatFilePath, 'utf-8');
      expect(content).toMatch(/\[SRE\] DONE <\d{4}-\d{2}-\d{2}T[^>]+>: fixed the thing/);
    });

    it('should uppercase the role', () => {
      appendMessage(chatFilePath, 'sre', 'STATUS', 'working on it');
      const content = readFileSync(chatFilePath, 'utf-8');
      expect(content).toMatch(/\[SRE\] STATUS <[^>]+>: working on it/);
    });

    it('should trim whitespace from body', () => {
      appendMessage(chatFilePath, 'PM', 'REQUEST', '  do something  ');
      const content = readFileSync(chatFilePath, 'utf-8');
      expect(content).toMatch(/\[PM\] REQUEST <[^>]+>: do something/);
    });

    it('should reject invalid message types', () => {
      expect(() =>
        appendMessage(chatFilePath, 'PM', 'INVALID' as any, 'body'),
      ).toThrow('Invalid message type: INVALID');
    });

    it('should append multiple messages in order', () => {
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@SRE do first');
      appendMessage(chatFilePath, 'SRE', 'ACK', 'on it');
      appendMessage(chatFilePath, 'SRE', 'DONE', 'finished');
      const messages = readMessages(chatFilePath);
      expect(messages).toHaveLength(3);
      expect(messages[0].type).toBe('REQUEST');
      expect(messages[1].type).toBe('ACK');
      expect(messages[2].type).toBe('DONE');
    });
  });

  // ── readMessages ──────────────────────────────────────────────────

  describe('readMessages', () => {
    it('should return empty array for fresh file (header only)', () => {
      const messages = readMessages(chatFilePath);
      expect(messages).toEqual([]);
    });

    it('should return empty array for non-existent file', () => {
      const messages = readMessages('/nonexistent/path.md');
      expect(messages).toEqual([]);
    });

    it('should parse messages correctly with timestamp', () => {
      appendMessage(chatFilePath, 'SRE', 'DONE', 'implemented BE-08 (3cb91c9)');
      const messages = readMessages(chatFilePath);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'SRE',
        type: 'DONE',
        body: 'implemented BE-08 (3cb91c9)',
      });
      expect(messages[0].lineNumber).toBeGreaterThan(0);
      expect(messages[0].timestamp).toBeDefined();
      expect(new Date(messages[0].timestamp!).toISOString()).toBe(messages[0].timestamp);
    });

    it('should parse legacy messages without timestamps', () => {
      // Manually write a legacy-format message (no timestamp)
      appendFileSync(chatFilePath, '[SRE] DONE: legacy message\n', 'utf-8');
      const messages = readMessages(chatFilePath);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'SRE',
        type: 'DONE',
        body: 'legacy message',
      });
      expect(messages[0].timestamp).toBeUndefined();
    });

    it('should skip comment lines and blank lines', () => {
      // The header has many comment lines — they should all be skipped
      appendMessage(chatFilePath, 'PM', 'STATUS', 'test');
      const messages = readMessages(chatFilePath);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('PM');
    });

    it('should parse all valid message types', () => {
      const types = ['STATUS', 'DONE', 'REQUEST', 'QUESTION', 'BLOCKER', 'ACK', 'WARN'] as const;
      for (const type of types) {
        appendMessage(chatFilePath, 'TEST', type, `test ${type}`);
      }
      const messages = readMessages(chatFilePath);
      expect(messages).toHaveLength(types.length);
      for (let i = 0; i < types.length; i++) {
        expect(messages[i].type).toBe(types[i]);
      }
    });
  });

  // ── readMessagesSince ─────────────────────────────────────────────

  describe('readMessagesSince', () => {
    it('should return only messages after the given line', () => {
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@SRE do first');
      const checkpoint = getChatLineCount(chatFilePath);

      appendMessage(chatFilePath, 'SRE', 'ACK', 'on it');
      appendMessage(chatFilePath, 'SRE', 'DONE', 'finished');

      const newMessages = readMessagesSince(chatFilePath, checkpoint);
      expect(newMessages).toHaveLength(2);
      expect(newMessages[0].type).toBe('ACK');
      expect(newMessages[1].type).toBe('DONE');
    });

    it('should return empty for non-existent file', () => {
      const messages = readMessagesSince('/nonexistent/path.md', 0);
      expect(messages).toEqual([]);
    });
  });

  // ── findRequests ──────────────────────────────────────────────────

  describe('findRequests', () => {
    it('should find REQUEST messages targeting a specific role', () => {
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@SRE implement connection pooling');
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@FRONTEND fix the CSS');
      appendMessage(chatFilePath, 'SRE', 'DONE', 'finished');

      const sreRequests = findRequests(chatFilePath, 'SRE');
      expect(sreRequests).toHaveLength(1);
      expect(sreRequests[0].body).toContain('@SRE');
    });

    it('should be case-insensitive on role matching', () => {
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@sre do something');
      const requests = findRequests(chatFilePath, 'SRE');
      expect(requests).toHaveLength(1);
    });

    it('should respect the sinceLine parameter', () => {
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@SRE task 1');
      const checkpoint = getChatLineCount(chatFilePath);
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@SRE task 2');

      const allRequests = findRequests(chatFilePath, 'SRE');
      const newRequests = findRequests(chatFilePath, 'SRE', checkpoint);

      expect(allRequests).toHaveLength(2);
      expect(newRequests).toHaveLength(1);
      expect(newRequests[0].body).toContain('task 2');
    });

    it('should return empty when no matching requests exist', () => {
      appendMessage(chatFilePath, 'PM', 'REQUEST', '@FRONTEND fix it');
      const requests = findRequests(chatFilePath, 'SRE');
      expect(requests).toEqual([]);
    });
  });

  // ── getChatLineCount ──────────────────────────────────────────────

  describe('getChatLineCount', () => {
    it('should return 0 for non-existent file', () => {
      expect(getChatLineCount('/nonexistent/path.md')).toBe(0);
    });

    it('should count lines including header', () => {
      const count = getChatLineCount(chatFilePath);
      expect(count).toBeGreaterThan(10); // Header has ~35 lines
    });

    it('should increase after appending messages', () => {
      const before = getChatLineCount(chatFilePath);
      appendMessage(chatFilePath, 'PM', 'STATUS', 'test');
      const after = getChatLineCount(chatFilePath);
      expect(after).toBe(before + 1);
    });
  });

  // ── resolveChatPath ───────────────────────────────────────────────

  describe('resolveChatPath', () => {
    it('should return the default chat file path', () => {
      expect(resolveChatPath('/some/path')).toBe('/some/path/chat.md');
    });

    it('should accept a custom file name', () => {
      expect(resolveChatPath('/some/path', 'custom.md')).toBe(
        '/some/path/custom.md',
      );
    });
  });
});
