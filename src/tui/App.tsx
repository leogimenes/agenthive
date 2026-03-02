import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Panel } from './keybindings.js';
import { useAgentStatus } from './hooks/useAgentStatus.js';
import { useChatMessages } from './hooks/useChatMessages.js';
import { Header } from './components/Header.js';
import { CostBar } from './components/CostBar.js';
import { StatusPanel } from './components/StatusPanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { AgentDetail } from './components/AgentDetail.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { appendMessage, resolveChatPath } from '../core/chat.js';
import { resolveHivePath } from '../core/config.js';
import type { MessageType } from '../types/config.js';

const PANELS: Panel[] = ['status', 'chat', 'input'];
const VALID_TYPES = new Set(['REQUEST', 'STATUS', 'DONE', 'QUESTION', 'BLOCKER', 'ACK', 'WARN']);

interface AppProps {
  cwd: string;
}

export function App({ cwd }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;

  // Panel state
  const [activePanel, setActivePanel] = useState<Panel>('status');
  const [showHelp, setShowHelp] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  // Status panel state
  const [selectedAgent, setSelectedAgent] = useState(0);
  const status = useAgentStatus(cwd);

  // Chat panel state
  const chat = useChatMessages(cwd);
  const [chatScroll, setChatScroll] = useState(0);

  // Input state
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string | undefined>();
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Computed
  const agentNames = status.agents.map((a) => a.name);
  const chatMaxVisible = Math.max(5, termHeight - 14);

  const cyclePanel = useCallback(() => {
    setActivePanel((prev) => {
      const idx = PANELS.indexOf(prev);
      return PANELS[(idx + 1) % PANELS.length];
    });
  }, []);

  const sendDispatch = useCallback(() => {
    if (!inputValue.trim()) return;

    const hivePath = resolveHivePath(cwd);
    const chatFilePath = resolveChatPath(hivePath);

    let text = inputValue.trim();
    let senderRole = 'USER';
    let msgType: MessageType = 'REQUEST';

    // Parse prefix commands
    const fromMatch = text.match(/^\/from\s+(\S+)\s+(.+)$/i);
    if (fromMatch) {
      senderRole = fromMatch[1].toUpperCase();
      text = fromMatch[2];
    }

    const typeMatch = text.match(/^\/(warn|status|question|blocker|ack|done)\s+(.+)$/i);
    if (typeMatch) {
      const parsedType = typeMatch[1].toUpperCase();
      if (VALID_TYPES.has(parsedType)) {
        msgType = parsedType as MessageType;
        text = typeMatch[2];
      }
    }

    // Parse target from text
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      setInputError('Format: <target> <message>');
      return;
    }

    const target = parts[0];
    const body = parts.slice(1).join(' ');

    // Validate target
    const targetUpper = target.toUpperCase();
    const isAll = targetUpper === 'ALL';
    const matchAgent = status.agents.find(
      (a) => a.name.toUpperCase() === targetUpper || a.role === targetUpper,
    );

    if (!isAll && !matchAgent) {
      setInputError(`Unknown target: "${target}". Available: ${agentNames.join(', ')}, ALL`);
      return;
    }

    const targetRole = isAll ? 'ALL' : matchAgent!.role;
    const finalBody = msgType === 'REQUEST' ? `@${targetRole} ${body}` : body;

    try {
      appendMessage(chatFilePath, senderRole, msgType, finalBody);
      setInputHistory((prev) => [...prev.slice(-19), inputValue]);
      setInputValue('');
      setInputError(undefined);
      setHistoryIndex(-1);
      setChatScroll(0); // Auto-scroll to bottom
    } catch (err) {
      setInputError(err instanceof Error ? err.message : 'Failed to send');
    }
  }, [inputValue, cwd, status.agents, agentNames]);

  const handleTabComplete = useCallback(() => {
    if (!inputValue) return;
    const parts = inputValue.split(/\s+/);
    const partial = parts[0].toLowerCase();
    const matches = agentNames.filter((n) => n.toLowerCase().startsWith(partial));
    if (matches.length === 1) {
      parts[0] = matches[0];
      setInputValue(parts.join(' '));
    } else if (matches.length > 1) {
      // Find common prefix
      const common = matches.reduce((a, b) => {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return a.slice(0, i);
      });
      if (common.length > partial.length) {
        parts[0] = common;
        setInputValue(parts.join(' '));
      }
    }
  }, [inputValue, agentNames]);

  // Keyboard handling
  useInput((input, key) => {
    // Help toggle always works
    if (input === '?' && activePanel !== 'input') {
      setShowHelp((prev) => !prev);
      return;
    }

    // Close help
    if (showHelp) {
      if (input === '?' || key.escape) {
        setShowHelp(false);
      }
      return;
    }

    // Quit
    if ((input === 'q' && activePanel !== 'input') || (key.ctrl && input === 'c')) {
      exit();
      return;
    }

    // Input mode
    if (activePanel === 'input') {
      if (key.escape) {
        setActivePanel('status');
        return;
      }
      if (key.return) {
        sendDispatch();
        return;
      }
      if (key.tab) {
        handleTabComplete();
        return;
      }
      if (key.upArrow) {
        if (inputHistory.length > 0) {
          const newIdx = historyIndex < 0 ? inputHistory.length - 1 : Math.max(0, historyIndex - 1);
          setHistoryIndex(newIdx);
          setInputValue(inputHistory[newIdx]);
        }
        return;
      }
      if (key.downArrow) {
        if (historyIndex >= 0) {
          const newIdx = historyIndex + 1;
          if (newIdx >= inputHistory.length) {
            setHistoryIndex(-1);
            setInputValue('');
          } else {
            setHistoryIndex(newIdx);
            setInputValue(inputHistory[newIdx]);
          }
        }
        return;
      }
      if (key.backspace || key.delete) {
        setInputValue((prev) => prev.slice(0, -1));
        setInputError(undefined);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setInputValue((prev) => prev + input);
        setInputError(undefined);
        return;
      }
      return;
    }

    // Global navigation
    if (key.tab) {
      cyclePanel();
      return;
    }
    if (input === '1') { setActivePanel('status'); return; }
    if (input === '2') { setActivePanel('chat'); return; }
    if (input === '3') { setActivePanel('input'); return; }
    if (input === 'd') {
      setActivePanel('input');
      return;
    }

    // Status panel keys
    if (activePanel === 'status') {
      if (key.escape && showDetail) {
        setShowDetail(false);
        return;
      }
      if ((input === 'j' || key.downArrow) && !showDetail) {
        setSelectedAgent((prev) => Math.min(prev + 1, status.agents.length - 1));
        return;
      }
      if ((input === 'k' || key.upArrow) && !showDetail) {
        setSelectedAgent((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (key.return && !showDetail) {
        setShowDetail(true);
        return;
      }
      if (key.escape && showDetail) {
        setShowDetail(false);
        return;
      }
      return;
    }

    // Chat panel keys
    if (activePanel === 'chat') {
      if (input === 'j' || key.downArrow) {
        setChatScroll((prev) => Math.max(0, prev - 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setChatScroll((prev) => Math.min(prev + 1, Math.max(0, chat.filteredMessages.length - chatMaxVisible)));
        return;
      }
      if (input === 'G') {
        setChatScroll(0);
        return;
      }
      if (input === 'g') {
        setChatScroll(Math.max(0, chat.filteredMessages.length - chatMaxVisible));
        return;
      }
      if (input === 'f') {
        // Cycle through agent filter
        const roles = [undefined, ...status.agents.map((a) => a.role)];
        const currentIdx = roles.indexOf(chat.filterRole);
        chat.setFilterRole(roles[(currentIdx + 1) % roles.length]);
        setChatScroll(0);
        return;
      }
      if (input === 't') {
        // Cycle through type filter
        const types: Array<string | undefined> = [undefined, 'REQUEST', 'DONE', 'STATUS', 'BLOCKER', 'WARN', 'QUESTION', 'ACK'];
        const currentIdx = types.indexOf(chat.filterType);
        chat.setFilterType(types[(currentIdx + 1) % types.length]);
        setChatScroll(0);
        return;
      }
      return;
    }
  });

  if (showHelp) {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Header status={status} />
        <HelpOverlay />
      </Box>
    );
  }

  const selectedAgentData = status.agents[selectedAgent];

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header status={status} />
      <CostBar status={status} />

      <Box flexDirection="row" flexGrow={1}>
        <StatusPanel
          agents={status.agents}
          selectedIndex={selectedAgent}
          focused={activePanel === 'status'}
        />

        {showDetail && selectedAgentData ? (
          <AgentDetail
            agent={selectedAgentData}
            messages={chat.messages}
            focused={activePanel === 'status'}
          />
        ) : (
          <ChatPanel
            messages={chat.filteredMessages}
            scrollOffset={chatScroll}
            maxVisible={chatMaxVisible}
            focused={activePanel === 'chat'}
            newMessageIds={chat.newMessageIds}
            filterRole={chat.filterRole}
            filterType={chat.filterType}
          />
        )}
      </Box>

      <InputBar
        value={inputValue}
        focused={activePanel === 'input'}
        error={inputError}
        agentNames={agentNames}
      />
    </Box>
  );
}
