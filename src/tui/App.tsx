import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Panel } from './keybindings.js';
import { HELP_TABS } from './keybindings.js';
import { useAgentStatus } from './hooks/useAgentStatus.js';
import { useChatMessages } from './hooks/useChatMessages.js';
import { usePlanData } from './hooks/usePlanData.js';
import { Header } from './components/Header.js';
import { CostBar } from './components/CostBar.js';
import { StatusPanel } from './components/StatusPanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { PlanPanel } from './components/PlanPanel.js';
import { PlanTaskDetail } from './components/PlanTaskDetail.js';
import { InputBar } from './components/InputBar.js';
import { AgentDetail } from './components/AgentDetail.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { TranscriptPanel } from './components/TranscriptPanel.js';
import { EpicTreePanel } from './components/EpicTreePanel.js';
import { EpicDispatchPanel } from './components/EpicDispatchPanel.js';
import type { EpicAction } from './components/EpicDispatchPanel.js';
import { flattenTree, buildEpicTree, getEpicReadyTasks } from './utils/epicTree.js';
import { appendMessage, resolveChatPath } from '../core/chat.js';
import { resolveHivePath, resolveAllAgents, loadConfig, resolveHiveRoot } from '../core/config.js';
import { dispatchTask, loadPlan, savePlan } from '../core/plan.js';
import type { MessageType } from '../types/config.js';

const PANELS: Panel[] = ['status', 'chat', 'plan', 'input', 'transcript', 'tree'];
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
  const [helpTab, setHelpTab] = useState(0);
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

  // Transcript panel state
  const [transcriptScroll, setTranscriptScroll] = useState(0);
  const [transcriptAgent, setTranscriptAgent] = useState(0);

  // Plan panel state
  const planData = usePlanData(cwd);
  const [selectedTask, setSelectedTask] = useState(0);
  const [showTaskDetail, setShowTaskDetail] = useState(false);
  const [planStatusFilter, setPlanStatusFilter] = useState<string | undefined>();
  const [planAgentFilter, setPlanAgentFilter] = useState<string | undefined>();
  const [planScroll, setPlanScroll] = useState(0);
  const planMaxVisible = Math.max(5, termHeight - 14);

  // Epic tree panel state
  const [treeSelectedIndex, setTreeSelectedIndex] = useState(0);
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
  const [treeScroll, setTreeScroll] = useState(0);
  const [epicDetailMode, setEpicDetailMode] = useState(false);
  const [epicConfirmAction, setEpicConfirmAction] = useState<EpicAction | null>(null);
  const [pausedEpics, setPausedEpics] = useState<Set<string>>(new Set());

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

  const getFilteredPlanTasks = useCallback(() => {
    let filtered = planData.tasks;
    if (planStatusFilter) {
      filtered = filtered.filter((t) => t.status === planStatusFilter);
    }
    if (planAgentFilter) {
      filtered = filtered.filter((t) => t.target === planAgentFilter);
    }
    return filtered;
  }, [planData.tasks, planStatusFilter, planAgentFilter]);

  // Keyboard handling
  useInput((input, key) => {
    // Help toggle always works
    if (input === '?' && activePanel !== 'input') {
      setShowHelp((prev) => !prev);
      return;
    }

    // Help overlay navigation
    if (showHelp) {
      if (input === '?' || key.escape) {
        setShowHelp(false);
        return;
      }
      if (input === 'h' || input === '[') {
        setHelpTab((prev) => Math.max(0, prev - 1));
        return;
      }
      if (input === 'l' || input === ']') {
        setHelpTab((prev) => Math.min(prev + 1, HELP_TABS.length - 1));
        return;
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
    if (input === '3') { setActivePanel('plan'); return; }
    if (input === '4') { setActivePanel('input'); return; }
    if (input === 'c') { setActivePanel('chat'); return; }
    if (input === 'p') { setActivePanel('plan'); return; }
    if (input === 't' && activePanel !== 'chat') {
      setActivePanel((prev) => prev === 'transcript' ? 'status' : 'transcript');
      setTranscriptScroll(0);
      return;
    }
    if (input === 'd' && activePanel !== 'plan') {
      setActivePanel('input');
      return;
    }
    if (input === 'e') {
      setActivePanel((prev) => prev === 'tree' ? 'status' : 'tree');
      setTreeScroll(0);
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

    // Plan panel keys
    if (activePanel === 'plan') {
      if (key.escape && showTaskDetail) {
        setShowTaskDetail(false);
        return;
      }
      if ((input === 'j' || key.downArrow) && !showTaskDetail) {
        const filteredTasks = getFilteredPlanTasks();
        setSelectedTask((prev) => Math.min(prev + 1, filteredTasks.length - 1));
        // Auto-scroll
        if (selectedTask + 1 >= planScroll + planMaxVisible) {
          setPlanScroll((prev) => prev + 1);
        }
        return;
      }
      if ((input === 'k' || key.upArrow) && !showTaskDetail) {
        setSelectedTask((prev) => Math.max(prev - 1, 0));
        if (selectedTask - 1 < planScroll) {
          setPlanScroll((prev) => Math.max(0, prev - 1));
        }
        return;
      }
      if (key.return && !showTaskDetail) {
        setShowTaskDetail(true);
        return;
      }
      if (input === 'f' && !showTaskDetail) {
        const statuses: Array<string | undefined> = [undefined, 'open', 'ready', 'dispatched', 'running', 'done', 'failed', 'blocked'];
        const idx = statuses.indexOf(planStatusFilter);
        setPlanStatusFilter(statuses[(idx + 1) % statuses.length]);
        setSelectedTask(0);
        setPlanScroll(0);
        return;
      }
      if (input === 'a' && !showTaskDetail) {
        const agents: Array<string | undefined> = [undefined, ...new Set(planData.tasks.map((t) => t.target))];
        const idx = agents.indexOf(planAgentFilter);
        setPlanAgentFilter(agents[(idx + 1) % agents.length]);
        setSelectedTask(0);
        setPlanScroll(0);
        return;
      }
      if (input === 'd') {
        const filteredTasks = getFilteredPlanTasks();
        const selected = filteredTasks[selectedTask];
        if (selected && selected.status === 'ready') {
          try {
            const hivePath = resolveHivePath(cwd);
            const config = loadConfig(cwd);
            const hiveRoot = resolveHiveRoot(cwd);
            const plan = loadPlan(hivePath);
            if (plan) {
              const task = plan.tasks.find((t) => t.id === selected.id);
              if (task && task.status === 'ready') {
                const chatFilePath = resolveChatPath(hivePath);
                const allAgents = resolveAllAgents(config, hiveRoot);
                const agent = allAgents.find((a) => a.name === task.target);
                const role = agent?.chatRole ?? task.target.toUpperCase();
                dispatchTask(chatFilePath, task, role);
                savePlan(hivePath, plan);
              }
            }
          } catch {
            // Silently ignore
          }
        }
        return;
      }
      return;
    }

    // Epic tree panel keys
    if (activePanel === 'tree') {
      // Compute rows for navigation
      const treeNodes = buildEpicTree(planData.tasks);
      const treeRows = flattenTree(treeNodes, treeExpanded);
      const selectedRow = treeRows[treeSelectedIndex];
      const selectedEpicId = selectedRow?.node.task.id;

      // Epic detail / dispatch mode
      if (epicDetailMode) {
        // Handle confirmation prompt
        if (epicConfirmAction) {
          if (input === 'y' || input === 'Y') {
            // Execute the confirmed action
            if (epicConfirmAction === 'start' && selectedEpicId) {
              const readyTasks = getEpicReadyTasks(planData.tasks, selectedEpicId);
              if (readyTasks.length > 0) {
                try {
                  const hivePath = resolveHivePath(cwd);
                  const config = loadConfig(cwd);
                  const hiveRoot = resolveHiveRoot(cwd);
                  const plan = loadPlan(hivePath);
                  if (plan) {
                    const chatFilePath = resolveChatPath(hivePath);
                    const allAgents = resolveAllAgents(config, hiveRoot);
                    for (const t of readyTasks) {
                      const planTask = plan.tasks.find((pt) => pt.id === t.id);
                      if (planTask && planTask.status === 'ready') {
                        const agent = allAgents.find((a) => a.name === planTask.target);
                        const role = agent?.chatRole ?? planTask.target.toUpperCase();
                        dispatchTask(chatFilePath, planTask, role);
                      }
                    }
                    savePlan(hivePath, plan);
                  }
                } catch {
                  // Silently ignore
                }
              }
            } else if (epicConfirmAction === 'pause' && selectedEpicId) {
              setPausedEpics((prev) => {
                const next = new Set(prev);
                if (next.has(selectedEpicId)) {
                  next.delete(selectedEpicId);
                } else {
                  next.add(selectedEpicId);
                }
                return next;
              });
            } else if (epicConfirmAction === 'deliver' && selectedEpicId) {
              try {
                const hivePath = resolveHivePath(cwd);
                const chatFilePath = resolveChatPath(hivePath);
                appendMessage(
                  chatFilePath,
                  'USER',
                  'REQUEST',
                  `@ALL deliver epic ${selectedEpicId}: trigger completion workflow`,
                );
              } catch {
                // Silently ignore
              }
            }
            setEpicConfirmAction(null);
            return;
          }
          if (input === 'n' || input === 'N' || key.escape) {
            setEpicConfirmAction(null);
            return;
          }
          return;
        }

        // Actions in detail mode
        if (key.escape) {
          setEpicDetailMode(false);
          return;
        }
        if (input === 's') {
          setEpicConfirmAction('start');
          return;
        }
        if (input === 'p') {
          setEpicConfirmAction('pause');
          return;
        }
        if (input === 'd') {
          setEpicConfirmAction('deliver');
          return;
        }
        return;
      }

      // Tree navigation mode
      if (key.escape || input === 'e') {
        setActivePanel('status');
        setEpicDetailMode(false);
        return;
      }
      if (input === 'j' || key.downArrow) {
        const next = Math.min(treeSelectedIndex + 1, treeRows.length - 1);
        setTreeSelectedIndex(next);
        if (next >= treeScroll + planMaxVisible) {
          setTreeScroll((prev) => prev + 1);
        }
        return;
      }
      if (input === 'k' || key.upArrow) {
        const prev = Math.max(treeSelectedIndex - 1, 0);
        setTreeSelectedIndex(prev);
        if (prev < treeScroll) {
          setTreeScroll((p) => Math.max(0, p - 1));
        }
        return;
      }
      if (input === ' ') {
        // Space: expand/collapse
        if (selectedRow && selectedRow.node.children.length > 0) {
          const taskId = selectedRow.node.task.id;
          setTreeExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(taskId)) {
              next.delete(taskId);
            } else {
              next.add(taskId);
            }
            return next;
          });
        }
        return;
      }
      if (key.return) {
        // Enter: open epic detail/dispatch panel
        if (selectedRow) {
          setEpicDetailMode(true);
          setEpicConfirmAction(null);
        }
        return;
      }
      if (input === 'G') {
        setTreeScroll(0);
        setTreeSelectedIndex(Math.max(0, treeRows.length - 1));
        return;
      }
      return;
    }

    // Transcript panel keys
    if (activePanel === 'transcript') {
      if (key.escape) {
        setActivePanel('status');
        return;
      }
      if (input === 'j' || key.downArrow) {
        setTranscriptScroll((prev) => Math.max(0, prev - 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setTranscriptScroll((prev) => prev + 1);
        return;
      }
      if (input === 'G') {
        setTranscriptScroll(0);
        return;
      }
      if (input === 'h') {
        setTranscriptAgent((prev) => Math.max(0, prev - 1));
        setTranscriptScroll(0);
        return;
      }
      if (input === 'l') {
        setTranscriptAgent((prev) => Math.min(prev + 1, status.agents.length - 1));
        setTranscriptScroll(0);
        return;
      }
      return;
    }
  });

  if (showHelp) {
    return (
      <Box flexDirection="column" height={termHeight}>
        <Header status={status} planStats={planData.stats.total > 0 ? { ready: planData.stats.ready, total: planData.stats.total } : undefined} />
        <HelpOverlay activeTab={helpTab} />
      </Box>
    );
  }

  const selectedAgentData = status.agents[selectedAgent];

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header status={status} planStats={planData.stats.total > 0 ? { ready: planData.stats.ready, total: planData.stats.total } : undefined} />
      <CostBar status={status} />

      <Box flexDirection="row" flexGrow={1}>
        <StatusPanel
          agents={status.agents}
          selectedIndex={selectedAgent}
          focused={activePanel === 'status'}
        />

        {activePanel === 'tree' ? (
          epicDetailMode ? (
            <EpicDispatchPanel
              tasks={planData.tasks}
              selectedEpicId={
                flattenTree(buildEpicTree(planData.tasks), treeExpanded)[treeSelectedIndex]
                  ?.node.task.id ?? ''
              }
              focused={true}
              confirmAction={epicConfirmAction}
              pausedEpics={pausedEpics}
            />
          ) : (
            <EpicTreePanel
              tasks={planData.tasks}
              selectedIndex={treeSelectedIndex}
              focused={true}
              scrollOffset={treeScroll}
              maxVisible={planMaxVisible}
              expanded={treeExpanded}
            />
          )
        ) : activePanel === 'transcript' ? (
          <TranscriptPanel
            agent={status.agents[transcriptAgent]}
            agents={status.agents}
            selectedAgentIndex={transcriptAgent}
            focused={true}
            scrollOffset={transcriptScroll}
            maxVisible={Math.max(5, termHeight - 14)}
          />
        ) : activePanel === 'plan' ? (
          showTaskDetail && getFilteredPlanTasks()[selectedTask] ? (
            <PlanTaskDetail
              task={getFilteredPlanTasks()[selectedTask]}
              plan={planData.plan!}
              focused={true}
            />
          ) : (
            <PlanPanel
              tasks={planData.tasks}
              selectedIndex={selectedTask}
              focused={activePanel === 'plan'}
              scrollOffset={planScroll}
              maxVisible={planMaxVisible}
              statusFilter={planStatusFilter}
              agentFilter={planAgentFilter}
            />
          )
        ) : showDetail && selectedAgentData ? (
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
