import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { AgentStatusInfo } from '../hooks/useAgentStatus.js';
import {
  useTranscriptEvents,
  formatEventLine,
  formatDuration,
  clampScrollOffset,
} from '../hooks/useTranscriptEvents.js';

interface TranscriptPanelProps {
  /** Currently selected agent to show transcripts for. */
  agent: AgentStatusInfo | undefined;
  /** All available agents for switching. */
  agents: AgentStatusInfo[];
  /** Index of the selected agent. */
  selectedAgentIndex: number;
  /** Whether this panel is focused. */
  focused: boolean;
  /** Current scroll offset (lines from the bottom). */
  scrollOffset: number;
  /** Max number of event lines to display. */
  maxVisible: number;
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'tool_use': return 'cyan';
    case 'thinking': return 'magenta';
    case 'text': return 'white';
    default: return 'gray';
  }
}

export function TranscriptPanel({
  agent,
  agents,
  selectedAgentIndex,
  focused,
  scrollOffset,
  maxVisible,
}: TranscriptPanelProps): React.ReactElement {
  const worktreePath = agent?.worktreePath;
  const transcript = useTranscriptEvents(worktreePath);

  const clampedOffset = useMemo(
    () => clampScrollOffset(scrollOffset, transcript.events.length, maxVisible),
    [scrollOffset, transcript.events.length, maxVisible],
  );

  const visibleEvents = useMemo(() => {
    const total = transcript.events.length;
    const start = Math.max(0, total - maxVisible - clampedOffset);
    const end = Math.max(0, total - clampedOffset);
    return transcript.events.slice(start, end);
  }, [transcript.events, clampedOffset, maxVisible]);

  const borderColor = focused ? 'cyan' : 'gray';
  const titleColor = focused ? 'cyan' : 'white';

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={borderColor}
      flexGrow={2}
      paddingX={1}
    >
      {/* Header */}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={titleColor}>
          {' '}Transcript{agent ? `: ${agent.name}` : ''}{' '}
        </Text>
        {transcript.session && (
          <Text dimColor>
            {transcript.session.eventCount} events
            {transcript.session.durationSecs != null
              ? ` · ${formatDuration(transcript.session.durationSecs)}`
              : ''}
          </Text>
        )}
      </Box>

      {/* Agent selector strip */}
      {agents.length > 1 && (
        <Box marginBottom={1} gap={1}>
          {agents.map((a, i) => (
            <Text
              key={a.name}
              bold={i === selectedAgentIndex}
              inverse={i === selectedAgentIndex && focused}
              color={i === selectedAgentIndex ? 'cyan' : 'gray'}
            >
              {a.name}
            </Text>
          ))}
        </Box>
      )}

      {/* Events */}
      {transcript.error ? (
        <Box>
          <Text dimColor>{transcript.error}</Text>
        </Box>
      ) : visibleEvents.length === 0 ? (
        <Box>
          <Text dimColor>
            {agent ? 'No transcript events found.' : 'Select an agent to view transcripts.'}
          </Text>
        </Box>
      ) : (
        visibleEvents.map((event, i) => {
          const line = formatEventLine(event);
          return (
            <Box key={`${event.timestamp}-${i}`}>
              <Text color={kindColor(event.kind)}>{line}</Text>
            </Box>
          );
        })
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {transcript.events.length} events
          {clampedOffset > 0 && ` · ↑${clampedOffset}`}
          {' · '}
          j/k scroll · h/l agent · t close
        </Text>
      </Box>
    </Box>
  );
}
