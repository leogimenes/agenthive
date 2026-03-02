# Planning and Task Tracking

## Overview

A Beads-inspired planning and tracking system built into AgentHive. Provides a structured way to author task graphs with explicit dependencies, a queryable "ready queue" of actionable work, and live state tracking driven by the chat protocol. Replaces manual `hive dispatch` orchestration with a persistent, dependency-aware plan that auto-dispatches when predecessors complete. Storage starts as a JSON file with a clean abstraction layer; can migrate to Dolt for distributed conflict-free sync in a future version. Supersedes the basic task queue concept from the features backlog.

## User Stories

### US-001: Plan data model and storage

**As a** developer orchestrating complex multi-task workflows
**I want** a structured plan file that represents tasks as a dependency DAG with statuses
**So that** the system can compute what's ready, what's blocked, and what's done without me tracking dependencies in my head

#### Acceptance Criteria
- [ ] `PlanTask` interface in `src/types/plan.ts` includes: `id`, `title`, `description?`, `target` (agent), `priority` (p0-p3), `status` (open/ready/dispatched/running/done/failed/blocked), `depends_on` (string array), `parent?`, `labels?`, timestamps (`created_at`, `updated_at`, `dispatched_at?`, `completed_at?`), `resolution?`, `estimated_cost?`, `actual_cost?`
- [ ] `Plan` interface wraps tasks with metadata: `name`, `created_at`, `updated_at`, `tasks[]`
- [ ] Storage is `.hive/plan.json` — a single JSON file with atomic writes (write to `.tmp`, then `rename`)
- [ ] Tasks are sorted by `id` before writing so diffs are clean
- [ ] `src/core/plan.ts` exports: `loadPlan()`, `savePlan()`, `generateId()`, `computeReadyTasks()`, `computeBlockedTasks()`, `getTasksByAgent()`, `getDependencyChain()`, `validateDAG()`
- [ ] `generateId()` produces `<target-prefix>-<4-hex>` (e.g., `back-a3f8`) from a hash of title + target + timestamp to avoid collisions
- [ ] `validateDAG()` detects circular dependencies and returns the cycle path
- [ ] Plan file is optional — AgentHive works without it (pure chat-driven mode)

### US-002: Board view

**As a** developer managing a plan with 15+ tasks
**I want** `hive plan` to show a kanban-style board grouped by status
**So that** I can see at a glance what's done, running, ready, and blocked

#### Acceptance Criteria
- [ ] `hive plan` (no subcommand) renders kanban columns: OPEN, READY, DISPATCHED, RUNNING, DONE, FAILED
- [ ] Each task shows: status icon, ID, priority, target agent name
- [ ] Status icons: `○` open, `◎` ready, `→` dispatched, `●` running, `✓` done, `✗` failed, `◉` blocked
- [ ] Color coding: p0 = bold red, p1 = yellow, p2 = white, p3 = gray; done = green, failed = red, blocked = yellow
- [ ] Summary line shows count of ready tasks and prompt to run `hive plan dispatch`
- [ ] `--json` outputs the full plan as JSON for agent consumption
- [ ] `--compact` renders one line per task without the target line
- [ ] `--filter <agent|status|label>` filters the board

### US-003: Task creation

**As a** developer (or PM agent) populating a plan
**I want** `hive plan add <target> <title>` with options for ID, priority, and dependencies
**So that** I can build up the task graph incrementally

#### Acceptance Criteria
- [ ] `hive plan add <target> <title> [--id ID] [--priority p0-p3] [--depends-on IDs] [--parent ID] [--labels tags] [--description text]`
- [ ] If `--id` is omitted, an ID is auto-generated
- [ ] `--depends-on` accepts comma-separated IDs; all must exist in the plan
- [ ] `--parent` ID must exist in the plan
- [ ] Adding the task must not create a dependency cycle (validated with `validateDAG`)
- [ ] After adding: prints the task, its dependency chain, and whether it's immediately ready
- [ ] Target is validated against agent names/roles in config

### US-004: Ready queue

**As an** agent polling loop (or a developer reviewing the plan)
**I want** `hive plan ready [agent]` to return only tasks whose dependencies are all satisfied
**So that** I know exactly what can be worked on right now without traversing the graph myself

#### Acceptance Criteria
- [ ] `hive plan ready` lists all tasks with status `open` where every `depends_on` task has status `done`
- [ ] `hive plan ready <agent>` filters to tasks targeting that agent
- [ ] Results are sorted by priority (p0 first), then by creation time (oldest first)
- [ ] `--json` outputs the ready list for programmatic consumption by the polling loop
- [ ] Tasks matching the ready criteria are auto-promoted from `open` to `ready` status when the plan is loaded or when any task completes

### US-005: Chat-driven state transitions

**As a** developer who doesn't want to manually update task statuses
**I want** the plan to auto-update when agents post DONE or BLOCKER messages in chat
**So that** the board reflects reality in real-time without manual bookkeeping

#### Acceptance Criteria
- [ ] `reconcilePlanWithChat(plan, newMessages)` in `src/core/plan.ts` scans messages for task ID references and updates statuses
- [ ] DONE messages containing a known task ID → mark that task as `done`; set `completed_at` and `resolution`
- [ ] BLOCKER messages containing a known task ID → mark as `failed`; set `resolution`
- [ ] If no task ID is found in message but the agent has exactly one dispatched/running task, infer that task
- [ ] After a task completes: cascade — recompute ready tasks; promote newly-unblocked `open` tasks to `ready`
- [ ] After a task fails: cascade block — tasks that transitively depend on it get status `blocked`
- [ ] Integrated into the polling loop after reading chat messages (between chat read and task execution)
- [ ] The polling loop checks plan for ready tasks after checking chat for manual REQUESTs; manual REQUESTs take priority

### US-006: Bulk import from files

**As a** developer (or PM agent) with a pre-authored task list
**I want** `hive plan import <file>` to create multiple tasks from a YAML or Markdown file
**So that** I can populate the plan from a spec document or existing task file without adding tasks one-by-one

#### Acceptance Criteria
- [ ] YAML format supported: `tasks:` array with `id`, `target`, `title`, `priority`, `depends_on`, `description` fields
- [ ] Markdown format supported: `## ID: title (priority) @target [depends: IDs]` parsed with regex
- [ ] Validates all targets exist in config, all dependency IDs are resolvable (within import or existing plan), and no cycles
- [ ] Skips tasks whose IDs already exist in the plan with a warning
- [ ] Prints summary: `Imported 12 tasks (3 ready, 9 pending)`
- [ ] `hive plan export <file>` exports the current plan to YAML for backup or sharing

### US-007: Dependency graph visualization

**As a** developer trying to understand bottlenecks in a complex plan
**I want** `hive plan graph` to render the dependency DAG in the terminal
**So that** I can see which chains are blocking progress and where the critical path is

#### Acceptance Criteria
- [ ] `hive plan graph` renders connected components of the DAG left-to-right: root tasks (no deps) on the left, leaf tasks on the right
- [ ] Tasks show status icon and ID; arrows show dependency edges
- [ ] Chains are sorted by highest priority task first, then longest chain first
- [ ] Standalone tasks (no deps, no dependents) are grouped at the bottom
- [ ] `--focus <id>` shows only the subgraph containing a specific task (ancestors + descendants)
- [ ] `--critical-path` highlights the longest remaining dependency chain

### US-008: Dispatch from plan

**As a** developer with a populated plan
**I want** `hive plan dispatch` to send all ready tasks to their target agents in one command
**So that** I don't have to manually `hive dispatch` each task separately

#### Acceptance Criteria
- [ ] `hive plan dispatch` dispatches one ready task per agent (highest priority)
- [ ] `--all` dispatches all ready tasks, even multiple per agent
- [ ] `--agent <name>` dispatches only the top ready task for a specific agent
- [ ] `--id <id>` dispatches a specific task by ID (must be ready)
- [ ] `--dry-run` shows what would be dispatched without doing it
- [ ] Dispatch action: set status to `dispatched`, set `dispatched_at`, append `[USER] REQUEST @ROLE: [TASK_ID] title. description_first_line` to chat
- [ ] The `[TASK_ID]` in the chat message enables `reconcilePlanWithChat` to match DONE responses back to the task
- [ ] `--auto` mode: the polling loop auto-dispatches ready tasks without user intervention, controlled by `plan.auto_dispatch: true` in config

### US-009: Task update, remove, and reset

**As a** developer managing an evolving plan
**I want** commands to reprioritize, reassign, reset failed tasks, and remove obsolete tasks
**So that** the plan stays current as requirements change

#### Acceptance Criteria
- [ ] `hive plan update <id>` accepts: `--status`, `--priority`, `--target`, `--depends-on` (replace), `--add-dep`, `--remove-dep`, `--title`, `--description`, `--labels`
- [ ] `hive plan remove <id>` removes a task; refuses if other tasks depend on it unless `--force` (which also cleans dependency edges)
- [ ] `hive plan remove` refuses for tasks in `dispatched` or `running` status unless `--force`
- [ ] `hive plan reset <id>` shortcut: sets status to `open`, clears `dispatched_at`, `completed_at`, `resolution`
- [ ] All mutations validate DAG integrity, update `updated_at`, and save atomically

### US-010: Hierarchical task grouping

**As a** developer organizing a plan with epics containing multiple subtasks
**I want** parent-child task relationships with automatic parent status rollup
**So that** I can group related tasks and track progress at the epic level

#### Acceptance Criteria
- [ ] Tasks with `parent` field are displayed as children of the parent task in board and tree views
- [ ] Parent task status is computed from children: all done → done, any running → running, any failed → shows warning, else shows progress (e.g., `3/5 done`)
- [ ] `hive plan tree` renders a hierarchical tree view showing parent → children nesting
- [ ] `hive plan add ... --parent <id>` creates a subtask
- [ ] Parent tasks are never dispatched directly — only leaf tasks get dispatched

### US-011: Plan analytics and critical path

**As a** developer (or PM agent) making prioritization decisions
**I want** `hive plan stats` showing status breakdown, per-agent workload, critical path, and estimated remaining cost
**So that** I can identify bottlenecks and make informed decisions about what to prioritize

#### Acceptance Criteria
- [ ] `hive plan stats` shows: status breakdown with percentages and progress bar, per-agent remaining workload, critical path (longest remaining dependency chain), estimated remaining cost
- [ ] Critical path algorithm: finds the longest path in the DAG among non-done tasks
- [ ] Per-agent workload: count of remaining tasks per agent with breakdown by status
- [ ] Estimated remaining cost: `(remaining tasks) × (average budget cap)` with note that costs are approximate
- [ ] `--json` for programmatic consumption

## Quality Gates

These commands must pass for every user story:
- `npm run typecheck` - Type checking
- `npm test` - All vitest tests pass
- `npm run build` - TypeScript compilation succeeds
