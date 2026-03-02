import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AgentStatusInfo } from '../hooks/useAgentStatus.js';
import type { ChatMessage } from '../../types/config.js';
import { getRoleColorName, TYPE_STYLE_MAP } from '../../core/colors.js';
import { getSpendColor } from '../../core/colors.js';

interface AgentDetailProps {
  agent: AgentStatusInfo;
  messages: ChatMessage[];
  focused: boolean;
}

function getGitInfo(worktreePath: string): { branch: string; commits: string } {
  try {
    if (!existsSync(worktreePath)) {
      return { branch: 'N/A', commits: 'worktree not found' };
    }
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
    const log = execSync('git log --oneline -5', {
      cwd: worktreePath,
      encoding: 'utf-8',
    }).trim();
    return { branch, commits: log || '(no commits)' };
  } catch {
    return { branch: 'unknown', commits: '(error reading git info)' };
  }
}

export function AgentDetail({ agent, messages, focused }: AgentDetailProps): React.ReactElement {
  const [gitInfo, setGitInfo] = useState({ branch: '...', commits: '...' });

  useEffect(() => {
    setGitInfo(getGitInfo(agent.worktreePath));
    const timer = setInterval(() => {
      setGitInfo(getGitInfo(agent.worktreePath));
    }, 10000);
    return () => clearInterval(timer);
  }, [agent.worktreePath]);

  const agentMessages = messages
    .filter((m) => m.role === agent.role)
    .slice(-10);
  const spendPct = agent.dailyMax > 0 ? agent.dailySpend / agent.dailyMax : 0;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} flexGrow={2} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={focused ? 'cyan' : 'white'}>
          {' '}Agent: {agent.name} ({agent.role}){' '}
        </Text>
      </Box>

      {/* Info section */}
      <Box flexDirection="column" gap={0}>
        <Box gap={1}>
          <Text dimColor>Status:</Text>
          <Text color={agent.status === 'RUNNING' ? 'green' : agent.status === 'STALE_LOCK' ? 'yellow' : 'gray'}>
            {agent.status}
          </Text>
          {agent.pid && <Text dimColor>(PID {agent.pid})</Text>}
        </Box>
        <Box gap={1}>
          <Text dimColor>Description:</Text>
          <Text>{agent.description}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Branch:</Text>
          <Text>{gitInfo.branch}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>Spend:</Text>
          <Text color={getSpendColor(spendPct)}>
            ${agent.dailySpend.toFixed(2)} / ${agent.dailyMax.toFixed(2)} ({(spendPct * 100).toFixed(0)}%)
          </Text>
        </Box>
      </Box>

      {/* Recent commits */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>Recent commits:</Text>
        {gitInfo.commits.split('\n').map((line, i) => (
          <Text key={i} dimColor>{line}</Text>
        ))}
      </Box>

      {/* Recent messages */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>Recent messages:</Text>
        {agentMessages.length === 0 ? (
          <Text dimColor>(no messages)</Text>
        ) : (
          agentMessages.map((msg) => {
            const typeInfo = TYPE_STYLE_MAP[msg.type] ?? { color: 'white' };
            return (
              <Box key={msg.lineNumber}>
                <Text color={typeInfo.color} bold={typeInfo.bold} dimColor={typeInfo.dim}>
                  {msg.type}
                </Text>
                <Text>: {msg.body}</Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>k kill · r relaunch · m merge · Esc back</Text>
      </Box>
    </Box>
  );
}
