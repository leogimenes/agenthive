import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage, MessageType } from '../../types/config.js';
import { getRoleColorName, TYPE_STYLE_MAP } from '../../core/colors.js';
import type { TypeStyleInfo } from '../../core/colors.js';

interface ChatPanelProps {
  messages: ChatMessage[];
  scrollOffset: number;
  maxVisible: number;
  focused: boolean;
  newMessageIds: Set<number>;
  filterRole?: string;
  filterType?: string;
}

function MessageLine({ msg, isNew }: { msg: ChatMessage; isNew: boolean }): React.ReactElement {
  const roleColor = getRoleColorName(msg.role);
  const typeInfo: TypeStyleInfo = TYPE_STYLE_MAP[msg.type] ?? { color: 'white' };

  return (
    <Box>
      <Text bold={isNew}>
        <Text color={roleColor}>[{msg.role}]</Text>
        {' '}
        <Text color={typeInfo.color} bold={typeInfo.bold} dimColor={typeInfo.dim}>
          {msg.type}
        </Text>
        <Text>: {msg.body}</Text>
      </Text>
    </Box>
  );
}

export function ChatPanel({
  messages,
  scrollOffset,
  maxVisible,
  focused,
  newMessageIds,
  filterRole,
  filterType,
}: ChatPanelProps): React.ReactElement {
  const visibleMessages = useMemo(() => {
    const start = Math.max(0, messages.length - maxVisible - scrollOffset);
    const end = messages.length - scrollOffset;
    return messages.slice(Math.max(0, start), Math.max(0, end));
  }, [messages, scrollOffset, maxVisible]);

  const filterDesc: string[] = [];
  if (filterRole) filterDesc.push(`agent: ${filterRole}`);
  if (filterType) filterDesc.push(`type: ${filterType}`);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} flexGrow={2} paddingX={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={focused ? 'cyan' : 'white'}> Chat </Text>
        {filterDesc.length > 0 && (
          <Text dimColor> [{filterDesc.join(' · ')}]</Text>
        )}
      </Box>

      {visibleMessages.length === 0 ? (
        <Box>
          <Text dimColor>No messages yet.</Text>
        </Box>
      ) : (
        visibleMessages.map((msg) => (
          <MessageLine
            key={msg.lineNumber}
            msg={msg}
            isNew={newMessageIds.has(msg.lineNumber)}
          />
        ))
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {messages.length} msg{messages.length !== 1 ? 's' : ''}
          {scrollOffset > 0 && ` · ↑${scrollOffset}`}
          {' · '}
          f filter · t type · G bottom
        </Text>
      </Box>
    </Box>
  );
}
