import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock node:os so we can control the platform
vi.mock('node:os', () => ({
  platform: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { notify, DEFAULT_NOTIFY_ON } from '../../src/core/notify.js';

const mockExecFile = vi.mocked(execFile);
const mockPlatform = vi.mocked(platform);

describe('notify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── DEFAULT_NOTIFY_ON ─────────────────────────────────────────────

  describe('DEFAULT_NOTIFY_ON', () => {
    it('should include DONE', () => {
      expect(DEFAULT_NOTIFY_ON).toContain('DONE');
    });

    it('should include BLOCKER', () => {
      expect(DEFAULT_NOTIFY_ON).toContain('BLOCKER');
    });

    it('should be a readonly array with exactly two entries', () => {
      expect(DEFAULT_NOTIFY_ON).toHaveLength(2);
    });
  });

  // ── Linux (notify-send) ───────────────────────────────────────────

  describe('on linux', () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue('linux');
    });

    it('should call execFile with notify-send', () => {
      notify('Title', 'Body');
      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile.mock.calls[0][0]).toBe('notify-send');
    });

    it('should pass urgency flag with default value normal', () => {
      notify('Title', 'Body');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain('--urgency');
      expect(args[args.indexOf('--urgency') + 1]).toBe('normal');
    });

    it('should pass urgency flag with provided value', () => {
      notify('Title', 'Body', 'critical');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[args.indexOf('--urgency') + 1]).toBe('critical');
    });

    it('should pass low urgency when specified', () => {
      notify('Title', 'Body', 'low');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[args.indexOf('--urgency') + 1]).toBe('low');
    });

    it('should pass --app-name AgentHive', () => {
      notify('Title', 'Body');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain('--app-name');
      expect(args[args.indexOf('--app-name') + 1]).toBe('AgentHive');
    });

    it('should pass title and body as positional arguments', () => {
      notify('My Title', 'My Body');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain('My Title');
      expect(args).toContain('My Body');
    });

    it('should set a 5000ms timeout', () => {
      notify('Title', 'Body');
      const opts = mockExecFile.mock.calls[0][2] as { timeout: number };
      expect(opts.timeout).toBe(5000);
    });

    it('should not throw when execFile callback is invoked with an error', () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as (err: Error | null) => void)(new Error('notify-send not found'));
        return {} as ReturnType<typeof execFile>;
      });
      expect(() => notify('Title', 'Body')).not.toThrow();
    });
  });

  // ── macOS (osascript) ─────────────────────────────────────────────

  describe('on darwin', () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue('darwin');
    });

    it('should call execFile with osascript', () => {
      notify('Title', 'Body');
      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile.mock.calls[0][0]).toBe('osascript');
    });

    it('should pass -e flag with an AppleScript display notification command', () => {
      notify('Title', 'Body');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[0]).toBe('-e');
      expect(args[1]).toContain('display notification');
    });

    it('should include the title in the script', () => {
      notify('My Title', 'Body');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[1]).toContain('My Title');
    });

    it('should include the body in the script', () => {
      notify('Title', 'My Body');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[1]).toContain('My Body');
    });

    it('should escape double quotes in the body', () => {
      notify('Title', 'say "hello"');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[1]).toContain('\\"hello\\"');
    });

    it('should escape backslashes in the body', () => {
      notify('Title', 'back\\slash');
      const args = mockExecFile.mock.calls[0][1] as string[];
      // Backslash must be doubled before embedding in AppleScript string
      expect(args[1]).toContain('back\\\\slash');
    });

    it('should escape double quotes in the title', () => {
      notify('Say "Hi"', 'Body');
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[1]).toContain('\\"Hi\\"');
    });

    it('should set a 5000ms timeout', () => {
      notify('Title', 'Body');
      const opts = mockExecFile.mock.calls[0][2] as { timeout: number };
      expect(opts.timeout).toBe(5000);
    });

    it('should not throw when execFile callback is invoked with an error', () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
        (cb as (err: Error | null) => void)(new Error('osascript failed'));
        return {} as ReturnType<typeof execFile>;
      });
      expect(() => notify('Title', 'Body')).not.toThrow();
    });
  });

  // ── Fallback (other platforms) ────────────────────────────────────

  describe('on other platforms (fallback)', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockPlatform.mockReturnValue('win32');
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    it('should not call execFile on unsupported platform', () => {
      notify('Title', 'Body');
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should write to stderr', () => {
      notify('Title', 'Body');
      expect(stderrSpy).toHaveBeenCalledOnce();
    });

    it('should include the title in the stderr message', () => {
      notify('My Title', 'Body');
      const written = stderrSpy.mock.calls[0][0] as string;
      expect(written).toContain('My Title');
    });

    it('should include the body in the stderr message', () => {
      notify('Title', 'My Body');
      const written = stderrSpy.mock.calls[0][0] as string;
      expect(written).toContain('My Body');
    });

    it('should include AgentHive branding in the stderr message', () => {
      notify('Title', 'Body');
      const written = stderrSpy.mock.calls[0][0] as string;
      expect(written).toContain('AgentHive');
    });

    it('should include a terminal bell character in the stderr message', () => {
      notify('Title', 'Body');
      const written = stderrSpy.mock.calls[0][0] as string;
      expect(written).toContain('\x07');
    });

    it('should end the stderr message with a newline', () => {
      notify('Title', 'Body');
      const written = stderrSpy.mock.calls[0][0] as string;
      expect(written.endsWith('\n')).toBe(true);
    });
  });
});
