import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';

/**
 * Execute a tmux command safely using execFileSync (no shell interpretation).
 */
export function tmux(args: string[], options?: ExecFileSyncOptions): void {
  execFileSync('tmux', args, options);
}

/**
 * Check if a tmux session exists.
 */
export function tmuxSessionExists(name: string): boolean {
  try {
    tmux(['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shell-quote a string for safe inclusion in a shell command string.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
