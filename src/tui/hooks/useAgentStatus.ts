import { useState, useEffect, useRef } from 'react';
import { loadConfig, resolveHiveRoot, resolveHivePath, resolveAllAgents } from '../../core/config.js';
import { getLockStatus } from '../../core/lock.js';
import { getDailySpend } from '../../core/budget.js';
import { readMessages, resolveChatPath } from '../../core/chat.js';
import type { ResolvedAgentConfig, ChatMessage } from '../../types/config.js';

export interface AgentStatusInfo {
  name: string;
  role: string;
  description: string;
  status: 'RUNNING' | 'STOPPED' | 'STALE_LOCK';
  pid?: number;
  dailySpend: number;
  dailyMax: number;
  lastActivity?: string;
  worktreePath: string;
}

export interface StatusData {
  agents: AgentStatusInfo[];
  session: string;
  running: number;
  total: number;
  stale: number;
  totalSpend: number;
  totalDailyMax: number;
}

function fetchStatus(cwd: string): StatusData {
  const hiveRoot = resolveHiveRoot(cwd);
  const hivePath = resolveHivePath(cwd);
  const config = loadConfig(cwd);
  const allAgents = resolveAllAgents(config, hiveRoot);
  const chatFilePath = resolveChatPath(hivePath, config.chat.file);
  const allMessages = readMessages(chatFilePath);

  const agents = allAgents.map((agent) => {
    const lock = getLockStatus(hivePath, agent.name);
    const { spent } = getDailySpend(hivePath, agent.name);
    const agentMessages = allMessages.filter((m) => m.role === agent.chatRole);
    const lastMsg = agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : undefined;

    let status: 'RUNNING' | 'STOPPED' | 'STALE_LOCK';
    if (lock.locked && !lock.stale) {
      status = 'RUNNING';
    } else if (lock.locked && lock.stale) {
      status = 'STALE_LOCK';
    } else {
      status = 'STOPPED';
    }

    return {
      name: agent.name,
      role: agent.chatRole,
      description: agent.description,
      status,
      pid: lock.pid,
      dailySpend: spent,
      dailyMax: agent.daily_max,
      lastActivity: lastMsg ? `${lastMsg.type}: ${truncate(lastMsg.body, 50)}` : undefined,
      worktreePath: agent.worktreePath,
    };
  });

  const running = agents.filter((a) => a.status === 'RUNNING').length;
  const stale = agents.filter((a) => a.status === 'STALE_LOCK').length;
  const totalSpend = agents.reduce((sum, a) => sum + a.dailySpend, 0);
  const totalDailyMax = agents.reduce((sum, a) => sum + a.dailyMax, 0);

  return {
    agents,
    session: config.session,
    running,
    total: agents.length,
    stale,
    totalSpend,
    totalDailyMax,
  };
}

export function useAgentStatus(cwd: string, pollInterval = 3000): StatusData {
  const [data, setData] = useState<StatusData>(() => fetchStatus(cwd));

  useEffect(() => {
    const timer = setInterval(() => {
      try {
        setData(fetchStatus(cwd));
      } catch {
        // Config may temporarily be unavailable
      }
    }, pollInterval);

    return () => clearInterval(timer);
  }, [cwd, pollInterval]);

  return data;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
