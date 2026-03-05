/**
 * AgentHive planning and task tracking schema.
 * Plan file lives at .hive/plan.json.
 */

/** Priority levels: p0 = critical, p1 = high, p2 = normal, p3 = low. */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

/** Hierarchy level of a plan task. */
export type TaskType = 'epic' | 'story' | 'task';

/** Lifecycle status of a plan task. */
export type TaskStatus =
  | 'open'
  | 'ready'
  | 'dispatched'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked';

/**
 * Status transitions:
 *   open → ready       (when all depends_on are done)
 *   ready → dispatched  (when auto-dispatch or manual dispatch sends REQUEST)
 *   dispatched → running (when agent picks up the task)
 *   running → done | failed (when agent posts DONE or BLOCKER)
 *   failed → open       (when user resets for retry)
 *   any → blocked       (when a dependency fails — cascading block)
 */

export interface PlanTask {
  /** Short unique ID. User-provided (e.g., "BE-06") or auto-generated hash. */
  id: string;

  /** Imperative title — what needs to happen. */
  title: string;

  /** Detailed description, acceptance criteria, code references. */
  description?: string;

  /** Target agent name or role tag (e.g., "backend" or "SRE"). */
  target: string;

  /** Priority: p0 = critical, p1 = high, p2 = normal, p3 = low. */
  priority: Priority;

  /** Lifecycle status. */
  status: TaskStatus;

  /** IDs of tasks that must be 'done' before this task becomes 'ready'. */
  depends_on: string[];

  /** Hierarchy level: epic > story > task. When omitted the task is untyped. */
  type?: TaskType;

  /** Parent task ID for hierarchical grouping (epic → task → subtask). */
  parent?: string;

  /** Free-form labels for filtering (e.g., ["api", "breaking"]). */
  labels?: string[];

  /** ISO 8601 timestamps. */
  created_at: string;
  updated_at: string;
  dispatched_at?: string;
  completed_at?: string;

  /** The chat message that completed or blocked this task. */
  resolution?: string;

  /** Estimated cost (per-task budget cap × estimated invocations). */
  estimated_cost?: number;

  /** Actual cost recorded after completion. */
  actual_cost?: number;

  /**
   * Number of times this task has been retried after a transient failure.
   * Incremented by resetTaskForRetry() each time the task is reset for retry.
   */
  retry_count?: number;

  /**
   * Maximum number of retry attempts allowed for transient failures.
   * Defaults to DEFAULT_MAX_RETRIES (3) when not set.
   * Set to 0 to disable retries (task fails permanently on first failure).
   */
  max_retries?: number;

  /** Last error message recorded when a transient failure occurred. */
  last_error?: string;
}

export interface Plan {
  /** Plan name. */
  name: string;

  /** ISO 8601 timestamps. */
  created_at: string;
  updated_at: string;

  /** All tasks in the plan. */
  tasks: PlanTask[];
}

/** Result of applying chat messages to the plan. */
export interface PlanUpdate {
  taskId: string;
  newStatus: TaskStatus;
  resolution?: string;
  timestamp: string;
}

/** Result of DAG validation. */
export interface DAGValidation {
  valid: boolean;
  cycles?: string[][];
}
