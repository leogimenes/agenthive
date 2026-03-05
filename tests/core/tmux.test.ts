import { describe, it, expect } from 'vitest';
import { shellQuote } from '../../src/core/tmux.js';

describe('shellQuote', () => {
  // ── basic cases ────────────────────────────────────────────────────

  it('should wrap a plain string in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('should return empty single-quoted string for empty input', () => {
    expect(shellQuote('')).toBe("''");
  });

  // ── spaces ─────────────────────────────────────────────────────────

  it('should preserve spaces inside single quotes', () => {
    expect(shellQuote('hello world')).toBe("'hello world'");
  });

  it('should preserve leading and trailing spaces', () => {
    expect(shellQuote('  hello  ')).toBe("'  hello  '");
  });

  // ── embedded single quotes ─────────────────────────────────────────

  it("should escape an embedded single quote using the '\\'' technique", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('should escape multiple embedded single quotes', () => {
    expect(shellQuote("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
  });

  it('should escape a string that is only a single quote', () => {
    expect(shellQuote("'")).toBe("''\\'''");
  });

  it('should escape consecutive single quotes', () => {
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });

  // ── backslashes ────────────────────────────────────────────────────

  it('should preserve backslashes unchanged inside single quotes', () => {
    expect(shellQuote('back\\slash')).toBe("'back\\slash'");
  });

  it('should preserve a single trailing backslash', () => {
    expect(shellQuote('foo\\')).toBe("'foo\\'");
  });

  // ── double quotes ──────────────────────────────────────────────────

  it('should preserve double quotes inside single quotes without escaping', () => {
    expect(shellQuote('"hello"')).toBe('\'"hello"\'');
  });

  it('should preserve a string of only double quotes', () => {
    expect(shellQuote('""')).toBe("'\"\"'");
  });

  // ── newlines and control characters ───────────────────────────────

  it('should preserve a newline character inside single quotes', () => {
    expect(shellQuote('line1\nline2')).toBe("'line1\nline2'");
  });

  it('should preserve a tab character inside single quotes', () => {
    expect(shellQuote('col1\tcol2')).toBe("'col1\tcol2'");
  });

  // ── shell metacharacters ───────────────────────────────────────────

  it('should wrap a string with dollar signs in single quotes', () => {
    expect(shellQuote('$HOME')).toBe("'$HOME'");
  });

  it('should wrap a string with backticks in single quotes', () => {
    expect(shellQuote('`echo hello`')).toBe("'`echo hello`'");
  });

  it('should wrap a string with semicolons in single quotes', () => {
    expect(shellQuote('a; b')).toBe("'a; b'");
  });

  it('should wrap a string with pipes in single quotes', () => {
    expect(shellQuote('a | b')).toBe("'a | b'");
  });

  it('should wrap a string with ampersands in single quotes', () => {
    expect(shellQuote('a && b')).toBe("'a && b'");
  });

  // ── combined edge cases ────────────────────────────────────────────

  it("should handle a string with both single quotes and dollar signs", () => {
    expect(shellQuote("$HOME/it's here")).toBe("'$HOME/it'\\''s here'");
  });

  it('should handle a string with spaces and shell metacharacters', () => {
    expect(shellQuote('hello world $USER')).toBe("'hello world $USER'");
  });
});
