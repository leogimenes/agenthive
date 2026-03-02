import { execFile } from 'node:child_process';
import { platform } from 'node:os';

export type NotifyUrgency = 'low' | 'normal' | 'critical';

/**
 * Send a platform-aware desktop notification.
 *
 * Linux: uses `notify-send`.
 * macOS: uses `osascript`.
 * Fallback: terminal bell + stderr message.
 *
 * Non-blocking — fire and forget. Errors are silently ignored.
 */
export function notify(
  title: string,
  body: string,
  urgency: NotifyUrgency = 'normal',
): void {
  const os = platform();

  if (os === 'linux') {
    execFile(
      'notify-send',
      ['--urgency', urgency, '--app-name', 'AgentHive', title, body],
      { timeout: 5000 },
      () => {}, // ignore errors
    );
  } else if (os === 'darwin') {
    const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${escaped}" with title "${title.replace(/"/g, '\\"')}"`;
    execFile(
      'osascript',
      ['-e', script],
      { timeout: 5000 },
      () => {},
    );
  } else {
    // Fallback: terminal bell + stderr
    process.stderr.write(`\x07[AgentHive] ${title}: ${body}\n`);
  }
}

/** Default message types that trigger notifications. */
export const DEFAULT_NOTIFY_ON: readonly string[] = [
  'DONE',
  'BLOCKER',
];
