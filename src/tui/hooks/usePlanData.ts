import { useState, useEffect } from 'react';
import { loadPlan, computeReadyTasks } from '../../core/plan.js';
import { resolveHivePath } from '../../core/config.js';
import type { Plan, PlanTask } from '../../types/plan.js';

export interface PlanStats {
  total: number;
  done: number;
  running: number;
  ready: number;
  open: number;
  failed: number;
  blocked: number;
  dispatched: number;
}

export interface PlanData {
  plan: Plan | null;
  tasks: PlanTask[];
  readyTasks: PlanTask[];
  stats: PlanStats;
}

function fetchPlanData(cwd: string): PlanData {
  try {
    const hivePath = resolveHivePath(cwd);
    const plan = loadPlan(hivePath);
    if (!plan) {
      return {
        plan: null,
        tasks: [],
        readyTasks: [],
        stats: { total: 0, done: 0, running: 0, ready: 0, open: 0, failed: 0, blocked: 0, dispatched: 0 },
      };
    }

    const tasks = plan.tasks;
    const readyTasks = computeReadyTasks(plan);
    const stats: PlanStats = {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      running: tasks.filter((t) => t.status === 'running').length,
      ready: tasks.filter((t) => t.status === 'ready').length,
      open: tasks.filter((t) => t.status === 'open').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      dispatched: tasks.filter((t) => t.status === 'dispatched').length,
    };

    return { plan, tasks, readyTasks, stats };
  } catch {
    return {
      plan: null,
      tasks: [],
      readyTasks: [],
      stats: { total: 0, done: 0, running: 0, ready: 0, open: 0, failed: 0, blocked: 0, dispatched: 0 },
    };
  }
}

export function usePlanData(cwd: string, pollInterval = 3000): PlanData {
  const [data, setData] = useState<PlanData>(() => fetchPlanData(cwd));

  useEffect(() => {
    const timer = setInterval(() => {
      try {
        setData(fetchPlanData(cwd));
      } catch {
        // Silently ignore transient errors
      }
    }, pollInterval);
    return () => clearInterval(timer);
  }, [cwd, pollInterval]);

  return data;
}
