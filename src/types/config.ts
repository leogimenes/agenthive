/**
 * AgentHive configuration schema.
 * Loaded from .hive/config.yaml in the project root.
 */

export interface HiveConfig {
  /** tmux session name. Defaults to directory name. */
  session: string;

  /** Default values applied to all agents unless overridden. */
  defaults: DefaultsConfig;

  /** Agent definitions keyed by name. */
  agents: Record<string, AgentConfig>;

  /** Chat file coordination settings. */
  chat: ChatConfig;

  /** Hook configuration. */
  hooks: HooksConfig;

  /** Templates configuration. */
  templates: TemplatesConfig;

  /** Delivery configuration. */
  delivery: DeliveryConfig;
}

export interface DefaultsConfig {
  /** Seconds between chat file polls. Default: 60. */
  poll: number;

  /** Max USD per task invocation. Default: 2.00. */
  budget: number;

  /** Max USD per agent per day. Default: 20.00. */
  daily_max: number;

  /** Claude model to use. Default: "sonnet". */
  model?: string;

  /** Pass --dangerously-skip-permissions to claude. Default: true. */
  skip_permissions: boolean;

  /** Enable desktop notifications. Default: false. */
  notifications: boolean;

  /** Message types that trigger notifications. Default: ["DONE", "BLOCKER"]. */
  notify_on: string[];

  /** Number of transcript sessions to keep per agent. Older sessions are deleted. Default: 20. */
  transcript_retention: number;
}

export interface AgentConfig {
  /** Human-readable description of this agent's role. */
  description: string;

  /** Agent definition file name (maps to .claude/agents/<agent>.md). */
  agent: string;

  /** Override: seconds between chat file polls. */
  poll?: number;

  /** Override: max USD per task invocation. */
  budget?: number;

  /** Override: max USD per agent per day. */
  daily_max?: number;

  /** Override: Claude model. */
  model?: string;
}

/** Resolved agent config with all defaults merged in. */
export interface ResolvedAgentConfig extends Required<AgentConfig> {
  /** The key name from the config (e.g., "sre", "frontend"). */
  name: string;

  /** The role tag used in chat messages (e.g., "SRE", "FRONTEND"). */
  chatRole: string;

  /** Absolute path to the agent's worktree. */
  worktreePath: string;

  /** Whether to skip permissions. */
  skip_permissions: boolean;
}

export interface ChatConfig {
  /** Chat file path relative to .hive/. Default: "chat.md". */
  file: string;

  /** Agent name → chat role tag mapping. */
  role_map: Record<string, string>;
}

export interface HooksConfig {
  /** Safety hooks shipped with AgentHive. */
  safety?: string[];

  /** Coordination hooks shipped with AgentHive. */
  coordination?: string[];

  /** User-defined custom hooks. */
  custom?: string[];
}

export interface TemplatesConfig {
  /** Override the project-local template directory path (relative to hive root). */
  dir?: string;
}

/**
 * Ordered steps that must all be satisfied before an epic is considered done.
 *
 * - all_tasks_done  All child tasks are in 'done' status.
 * - tests_pass      Test suite passes (must be recorded externally on the epic).
 * - pr_created      A pull request has been opened for the epic branch.
 * - pr_merged       The pull request has been merged into the base branch.
 * - released        A release/tag has been published.
 */
export type DefinitionOfDoneStep =
  | 'all_tasks_done'
  | 'tests_pass'
  | 'pr_created'
  | 'pr_merged'
  | 'released';

export interface DeliveryConfig {
  /** Delivery strategy. Default: 'manual'. */
  strategy: 'auto-merge' | 'pull-request' | 'manual';

  /** Require CI to pass before delivery. Default: true. */
  require_ci: boolean;

  /** Base branch for delivery. Default: 'main'. */
  base_branch: string;

  /** Automatically create a release after delivery. Default: false. */
  auto_release: boolean;

  /**
   * Ordered steps that must all be satisfied before an epic is considered
   * complete. Steps are evaluated in order; all must pass. Default: ['all_tasks_done'].
   */
  definition_of_done: DefinitionOfDoneStep[];
}


/** Message types in the chat protocol. */
export type MessageType =
  | 'STATUS'
  | 'DONE'
  | 'REQUEST'
  | 'QUESTION'
  | 'BLOCKER'
  | 'ACK'
  | 'WARN';

/** A parsed message from the chat file. */
export interface ChatMessage {
  /** The role that sent the message (e.g., "PM", "SRE"). */
  role: string;

  /** Message type. */
  type: MessageType;

  /** Message body after the type prefix. */
  body: string;

  /** Line number in the chat file (1-indexed). */
  lineNumber: number;

  /** ISO 8601 timestamp when the message was written. */
  timestamp?: string;
}

/** Result of a git worktree operation. */
export interface WorktreeInfo {
  /** Worktree directory path. */
  path: string;

  /** Branch name. */
  branch: string;

  /** HEAD commit hash. */
  head: string;

  /** Whether this is the main worktree. */
  isMain: boolean;
}

/** Result of a rebase + push operation. */
export interface RebaseResult {
  success: boolean;

  /** Conflict details if rebase failed. */
  conflictFiles?: string[];

  /** Error message if push failed. */
  error?: string;
}

// ── Sync diagnostics ─────────────────────────────────────────────────

/** Diagnosis of why a git sync (rebase) failed. */
export type SyncDiagnosis =
  | { type: 'cherry_pick_duplicates'; duplicateCount: number; uniqueCount: number }
  | { type: 'branch_diverged'; aheadCount: number; behindCount: number }
  | { type: 'merge_conflict'; conflictFiles: string[] }
  | { type: 'clean' }
  | { type: 'unknown'; error: string };

/** Result of a worktree sync operation with strategy details. */
export interface SyncResult {
  success: boolean;
  error?: string;
  /** Which sync strategy succeeded (if any). */
  strategy?: 'rebase' | 'rebase-reapply' | 'cherry-pick-unique' | 'reset-to-target';
  /** Diagnosis details when sync fails. */
  diagnosis?: SyncDiagnosis;
}

/** Agent runtime state for status display. */
export interface AgentStatus {
  name: string;
  status: 'RUNNING' | 'STOPPED' | 'STALE_LOCK';
  pid?: number;
  dailySpend: number;
  dailyMax: number;
  lastActivity?: string;
  lastActivityTime?: Date;
}
