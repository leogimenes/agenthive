import { useState, useEffect, useRef, useCallback } from 'react';
import { watchFile, unwatchFile } from 'node:fs';
import { readMessages, readMessagesSince, resolveChatPath, getChatLineCount } from '../../core/chat.js';
import { resolveHivePath } from '../../core/config.js';
import type { ChatMessage, MessageType } from '../../types/config.js';

export interface ChatState {
  messages: ChatMessage[];
  filteredMessages: ChatMessage[];
  filterRole: string | undefined;
  filterType: string | undefined;
  setFilterRole: (role: string | undefined) => void;
  setFilterType: (type: string | undefined) => void;
  newMessageIds: Set<number>;
}

function applyFilters(
  messages: ChatMessage[],
  filterRole?: string,
  filterType?: string,
): ChatMessage[] {
  let result = messages;
  if (filterRole) {
    result = result.filter((m) => m.role === filterRole);
  }
  if (filterType) {
    result = result.filter((m) => m.type === filterType);
  }
  return result;
}

export function useChatMessages(cwd: string): ChatState {
  const hivePath = resolveHivePath(cwd);
  const chatFilePath = resolveChatPath(hivePath);

  const [messages, setMessages] = useState<ChatMessage[]>(() => readMessages(chatFilePath));
  const [filterRole, setFilterRole] = useState<string | undefined>();
  const [filterType, setFilterType] = useState<string | undefined>();
  const [newMessageIds, setNewMessageIds] = useState<Set<number>>(new Set());
  const lastLineRef = useRef<number>(getChatLineCount(chatFilePath));

  useEffect(() => {
    const handler = () => {
      try {
        const currentLine = getChatLineCount(chatFilePath);
        if (currentLine <= lastLineRef.current) return;

        const newMsgs = readMessagesSince(chatFilePath, lastLineRef.current);
        lastLineRef.current = currentLine;

        if (newMsgs.length > 0) {
          setMessages((prev) => [...prev, ...newMsgs]);
          const newIds = new Set(newMsgs.map((m) => m.lineNumber));
          setNewMessageIds(newIds);

          // Clear highlight after 2 seconds
          setTimeout(() => {
            setNewMessageIds(new Set());
          }, 2000);
        }
      } catch {
        // File may be temporarily unavailable
      }
    };

    watchFile(chatFilePath, { interval: 1000 }, handler);
    return () => {
      unwatchFile(chatFilePath);
    };
  }, [chatFilePath]);

  const filteredMessages = applyFilters(messages, filterRole, filterType);

  return {
    messages,
    filteredMessages,
    filterRole,
    filterType,
    setFilterRole,
    setFilterType,
    newMessageIds,
  };
}
