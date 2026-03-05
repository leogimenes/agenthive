import { useState, useEffect, useRef } from 'react';
import {
  findTranscriptDir,
  listSessions,
  parseTranscript,
  getToolIcon,
  formatDuration,
} from '../../core/transcripts.js';
import type { TranscriptEvent, SessionInfo } from '../../core/transcripts.js';

// ── Pure utility exports (also used by tests) ─────────────────────────

/**
 * Select the latest (newest) session from a sorted-newest-first list.
 */
export function selectLatestSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions[0];
}

/**
 * Clamp a scroll offset to a valid range given the number of events and max visible.
 */
export function clampScrollOffset(offset: number, totalEvents: number, maxVisible: number): number {
  const maxOffset = Math.max(0, totalEvents - maxVisible);
  return Math.max(0, Math.min(offset, maxOffset));
}

/**
 * Format a single TranscriptEvent into a display string for the panel.
 */
export function formatEventLine(event: TranscriptEvent): string {
  if (event.kind === 'tool_use' && event.toolName) {
    const icon = getToolIcon(event.toolName);
    return `[${icon}] ${event.toolName}: ${event.summary}`;
  }
  if (event.kind === 'thinking') {
    return `~ (thinking)`;
  }
  // text
  return event.summary;
}

// ── Hook ───────────────────────────────────────────────────────────────

export interface TranscriptData {
  events: TranscriptEvent[];
  session: SessionInfo | undefined;
  sessions: SessionInfo[];
  error: string | undefined;
}

/**
 * Hook to load and live-tail transcript events for a given agent worktree path.
 */
export function useTranscriptEvents(worktreePath: string | undefined, pollInterval = 3000): TranscriptData {
  const [data, setData] = useState<TranscriptData>({
    events: [],
    session: undefined,
    sessions: [],
    error: undefined,
  });

  // Track path across renders to avoid stale closures
  const pathRef = useRef(worktreePath);
  pathRef.current = worktreePath;

  useEffect(() => {
    if (!worktreePath) {
      setData({ events: [], session: undefined, sessions: [], error: undefined });
      return;
    }

    function fetchData(): void {
      const transcriptDir = findTranscriptDir(worktreePath!);
      if (!transcriptDir) {
        setData({
          events: [],
          session: undefined,
          sessions: [],
          error: 'No transcript directory found',
        });
        return;
      }

      const sessions = listSessions(transcriptDir);
      const latest = selectLatestSession(sessions);
      const events = latest ? parseTranscript(latest.path) : [];

      setData({
        events,
        session: latest,
        sessions,
        error: undefined,
      });
    }

    // Initial load
    try {
      fetchData();
    } catch {
      setData({ events: [], session: undefined, sessions: [], error: 'Failed to load transcript' });
    }

    // Poll for live updates
    const timer = setInterval(() => {
      try {
        fetchData();
      } catch {
        // silently ignore polling errors
      }
    }, pollInterval);

    return () => clearInterval(timer);
  }, [worktreePath, pollInterval]);

  return data;
}

// Re-export helpers needed by the panel component
export { formatDuration, getToolIcon };
