# AgentHive — Planning & Task Tracking

> A Beads-inspired planning and tracking system built into AgentHive. Gives users a structured way to author task graphs with dependencies, and gives agents a queryable "ready queue" of actionable work. Replaces manual `hive dispatch` orchestration with a persistent, dependency-aware plan that survives sessions and auto-dispatches when predecessors complete.
>
> Prefix convention: `PLAN-`.
>
> **Supersedes:** FEAT-03 (task queue) in TASKS-FEATURES.md. FEAT-03 defined a basic `.hive/queue.yaml` with auto-dispatch. This spec absorbs that concept and extends it with richer data model, multiple views, hierarchical tasks, and agent-optimized query interface.
>
> **Key inspiration:** [Beads](https://steveyegge.github.io/beads/) by Steve Yegge — a git-backed issue tracker designed for AI coding agents. We adapt its core ideas (dependency DAG, ready queue, hash-based IDs, agent-first JSON interface) to AgentHive's architecture (chat protocol, worktrees, tmux, YAML config).

---

## Design Principles

1. **Agent-first, human-readable.** The primary consumer of plan data is the polling loop and agents via `--json`. But the default CLI output must be scannable by humans.
2. **Chat protocol is the event bus.** Plan state changes are driven by DONE/BLOCKER/STATUS messages in the chat file. The plan tracks state; the chat drives transitions.
3. **Dependencies are structural, not textual.** "FE-06 depends on BE-06" is an explicit edge in a DAG, not a sentence in a description. The system can compute what's ready.
4. **Git-friendly storage.** The plan file lives in `.hive/` and can be committed as an audit trail. Format must produce clean diffs.
5. **Concurrent-safe.** Multiple agents (or the user) may update the plan simultaneously. IDs must be collision-free. Writes must be atomic.

---

## PLAN-01: Data model and storage format (Tier 2)

**File:** new `src/types/plan.ts`, new `src/core/plan.ts`
**Problem:** There's no structured representation of work in AgentHive. The chat file is append-only prose. The user tracks dependencies in their head. Agents have no way to query "what should I work on next?" without a human posting a REQUEST.
**Fix:**
1. Define the task data model in `src/types/plan.ts`:
   ```typescript
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
     priority: 'p0' | 'p1' | 'p2' | 'p3';

     /** Lifecycle status. */
     status: 'open' | 'ready' | 'dispatched' | 'running' | 'done' | 'failed' | 'blocked';

     /** IDs of tasks that must be 'done' before this task becomes 'ready'. */
     depends_on: string[];

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
   }

   export interface Plan {
     /** Plan metadata. */
     name: string;
     created_at: string;
     updated_at: string;

     /** All tasks in the plan. */
     tasks: PlanTask[];
   }

   /** Status transitions. */
   // open → ready (when all depends_on are done)
   // ready → dispatched (when auto-dispatch or manual dispatch sends REQUEST)
   // dispatched → running (when agent picks up the task)
   // running → done | failed (when agent posts DONE or BLOCKER)
   // failed → open (when user resets for retry)
   // any → blocked (when a dependency fails — cascading block)
   ```

2. Storage: `.hive/plan.json` — single JSON file, atomically read/written.
   - Why JSON over YAML: easier to parse/write programmatically, no comment-preservation issues, valid for `--json` passthrough.
   - Why single file over JSONL: the plan is read-modify-write (not append-only like chat). Atomic writes with `writeFileSync` + temp file + rename ensure consistency.
   - Git-friendly: tasks are sorted by `id` before writing, so diffs show only changed tasks.
   - File is optional — AgentHive works without a plan (pure chat-driven mode remains the default).

3. Create `src/core/plan.ts` with:
   ```typescript
   loadPlan(hivePath: string): Plan | null
   savePlan(hivePath: string, plan: Plan): void
   generateId(prefix?: string): string  // 4-char hex hash, optionally prefixed
   computeReadyTasks(plan: Plan): PlanTask[]  // open tasks with all deps done
   computeBlockedTasks(plan: Plan): PlanTask[]  // tasks with failed dependencies
   getTasksByAgent(plan: Plan, agentRole: string): PlanTask[]
   getDependencyChain(plan: Plan, taskId: string): PlanTask[]  // full chain to roots
   validateDAG(plan: Plan): { valid: boolean; cycles?: string[][] }  // detect circular deps
   ```

4. ID generation: if user provides an ID (e.g., `BE-06`), use it. Otherwise auto-generate: `<first-4-chars-of-target>-<4-hex-chars>` (e.g., `back-a3f8`). Hash is derived from `title + target + Date.now()` to avoid collisions across concurrent agent creation.

5. Atomic writes: write to `.hive/plan.json.tmp`, then `rename` to `.hive/plan.json`. This prevents partial writes if the process is killed mid-write.

---

## PLAN-02: `hive plan` command — board view (Tier 2)

**File:** new `src/commands/plan.ts`
**Also:** `src/index.ts` (register command)
**Problem:** Users need a quick overview of the entire plan — what's done, what's running, what's blocked, what's next. `hive status` shows agent state, but not work item state.
**Fix:**
1. Register `hive plan` command. No subcommand defaults to the board view.
2. **Board view** (default) — kanban columns by status:
   ```
   🐝 AgentHive — Plan: my-project (14 tasks)

   OPEN (2)        READY (3)       DISPATCHED (1)  RUNNING (2)     DONE (6)        FAILED (0)
   ────────        ─────────       ────────────    ───────────     ────────        ──────────
   ○ FE-12 p3      ◎ FE-07 p0      → SEC-09 p2     ● FE-06 p0      ✓ BE-06 p1
     frontend        frontend         security        frontend        backend
   ○ FE-11 p3      ◎ QA-02 p2                      ● QA-03 p2      ✓ BE-07 p2
     frontend        qa                               qa              backend
                   ◎ BE-10 p2                                       ✓ BE-08 p1
                     backend                                          backend
                                                                    ✓ BE-09 p2
                                                                      backend
                                                                    ✓ SEC-07 p2
                                                                      security
                                                                    ✓ SEC-08 p2
                                                                      security

   Ready: 3 tasks can be dispatched now. Run `hive plan dispatch` to send them.
   ```
3. Status icons: `○` open, `◎` ready, `→` dispatched, `●` running, `✓` done, `✗` failed, `◉` blocked.
4. Color coding: p0 = bold red, p1 = yellow, p2 = white, p3 = gray. Done = green, failed = red, blocked = yellow.
5. `--json` flag: output the full plan as JSON (for agent consumption).
6. `--compact` flag: one line per task (no target line):
   ```
   ✓ BE-06  p1  backend   implement pagination for documents
   ● FE-06  p0  frontend  consume paginated documents endpoint
   ◎ QA-02  p2  qa        pagination integration tests
   ```
7. `--filter <agent|status|label>` flag: filter board by agent, status, or label.

---

## PLAN-03: `hive plan add` — task creation (Tier 2)

**File:** `src/commands/plan.ts` (subcommand)
**Problem:** Users need to create tasks with dependencies, priorities, and targets. Must work both interactively (human at keyboard) and programmatically (PM agent creating tasks via CLI).
**Fix:**
1. `hive plan add <target> <title> [options]`:
   ```bash
   # Simple task
   hive plan add backend "implement pagination for documents" --id BE-06 --priority p1

   # Task with dependencies
   hive plan add frontend "consume paginated documents endpoint" --id FE-06 --depends-on BE-06 --priority p0

   # Task with parent (subtask)
   hive plan add qa "test pagination edge cases" --parent QA-01 --depends-on BE-06,FE-06

   # Minimal (auto-generates ID, defaults to p2)
   hive plan add sre "add connection pooling"
   ```

2. Options:
   - `--id <id>` — user-provided ID. If omitted, auto-generate.
   - `--priority <p0|p1|p2|p3>` — default: `p2`.
   - `--depends-on <ids>` — comma-separated task IDs. Validates they exist in the plan.
   - `--parent <id>` — parent task for hierarchical grouping.
   - `--labels <labels>` — comma-separated labels.
   - `--description <text>` — detailed description (or read from stdin with `--description -`).

3. Validation:
   - Target must be a valid agent name or role in config.
   - `--depends-on` IDs must exist in the plan.
   - `--parent` ID must exist in the plan.
   - Adding the task must not create a dependency cycle (run `validateDAG` after adding).
   - ID must not already exist.

4. After adding: print the task and its position in the dependency chain:
   ```
   ✓ Added: FE-06 (frontend, p0)
     "consume paginated documents endpoint"
     Blocked by: BE-06 (done) ✓
     Status: ready (all dependencies met — run `hive plan dispatch` to send)
   ```

5. Bulk creation: `hive plan import <file>` reads a YAML or Markdown file and creates multiple tasks. See PLAN-06.

---

## PLAN-04: `hive plan ready` — the ready queue (Tier 2)

**File:** `src/core/plan.ts` (computeReadyTasks), `src/commands/plan.ts` (subcommand)
**Problem:** The most important question an agent (or user) can ask is: "what can I work on right now?" This requires computing which open tasks have all dependencies satisfied. Beads calls this the "ready queue" — it's the core optimization that makes planning useful.
**Fix:**
1. `hive plan ready [agent]`:
   - No args: show all ready tasks across all agents.
   - With agent name/role: show only tasks targeting that agent.
   ```
   🐝 Ready tasks (3):

   ◎ FE-07  p0  frontend  consume paginated categories endpoint
     Deps: BE-07 ✓
   ◎ QA-02  p2  qa        pagination integration tests
     Deps: BE-06 ✓, BE-07 ✓
   ◎ BE-10  p2  backend   add soft delete to documents
     Deps: (none)
   ```
2. `--json` flag for agent consumption — this is the primary interface for the polling loop:
   ```json
   [
     { "id": "FE-07", "target": "frontend", "priority": "p0", "title": "...", "depends_on": ["BE-07"] },
     { "id": "QA-02", "target": "qa", "priority": "p2", "title": "...", "depends_on": ["BE-06", "BE-07"] }
   ]
   ```
3. Sort by priority (p0 first), then by creation time (oldest first).
4. `computeReadyTasks()` logic:
   ```typescript
   function computeReadyTasks(plan: Plan): PlanTask[] {
     const doneIds = new Set(plan.tasks.filter(t => t.status === 'done').map(t => t.id));
     return plan.tasks.filter(t =>
       t.status === 'open' &&
       t.depends_on.every(dep => doneIds.has(dep))
     );
   }
   ```
   Tasks matching this filter have their status auto-promoted from `open` to `ready` when the plan is loaded or when a task completes.

---

## PLAN-05: Chat-driven state transitions (Tier 2)

**File:** `src/core/plan.ts` (new reconcile function), `src/core/polling.ts:106-165` (integrate plan updates)
**Also:** `src/core/chat.ts` (parse task IDs from messages)
**Problem:** The plan must stay in sync with reality. When an agent posts `[SRE] DONE: implemented BE-09`, the plan should auto-mark BE-09 as done. When an agent posts `[FE] BLOCKER: rebase conflict`, the dispatched task should be marked failed. Without this, the plan becomes stale and users must manually update it — defeating the purpose.
**Fix:**
1. Add `reconcilePlanWithChat(plan, newMessages): PlanUpdate[]` to `src/core/plan.ts`:
   ```typescript
   function reconcilePlanWithChat(plan: Plan, messages: ChatMessage[]): PlanUpdate[] {
     const updates: PlanUpdate[] = [];
     for (const msg of messages) {
       if (msg.type === 'DONE') {
         // Extract task ID from message body: look for known plan IDs
         const taskId = extractTaskId(msg.body, plan);
         if (taskId) {
           updates.push({ taskId, newStatus: 'done', resolution: msg.body, timestamp: msg.timestamp });
         }
       }
       if (msg.type === 'BLOCKER') {
         const taskId = extractTaskId(msg.body, plan);
         if (taskId) {
           updates.push({ taskId, newStatus: 'failed', resolution: msg.body, timestamp: msg.timestamp });
         }
       }
     }
     return updates;
   }
   ```
2. `extractTaskId(body, plan)` strategy:
   - Scan the message body for any known task ID from the plan (exact match, case-insensitive).
   - If no ID found, match by agent role: if the agent has exactly one `dispatched` or `running` task, assume that's the one.
   - If ambiguous (multiple dispatched tasks, no ID in message), skip — require manual update.
3. After task completion, cascade: recompute ready tasks. Any `open` tasks whose `depends_on` are now all `done` get promoted to `ready`.
4. After task failure, cascade block: any task that transitively depends on the failed task gets status `blocked`.
5. Integrate into the polling loop (`polling.ts`):
   - After reading chat messages (line 106), call `reconcilePlanWithChat`.
   - Apply updates to the plan and save.
   - Before checking for manual REQUESTs in chat, check the plan for ready tasks targeting this agent. Plan tasks take priority order (p0 > p1 > p2 > p3).
   - When dispatching from plan: set task status to `dispatched`, post a REQUEST to chat referencing the task ID.
6. The polling loop becomes:
   ```
   poll cycle:
     1. check budget
     2. sync worktree
     3. read new chat messages
     4. reconcile plan with chat (update statuses)
     5. check chat for manual REQUESTs → if found, run task
     6. check plan for ready tasks targeting this agent → if found, dispatch highest priority
     7. idle
   ```

---

## PLAN-06: `hive plan import` — bulk task creation from files (Tier 2)

**File:** `src/commands/plan.ts` (subcommand)
**Problem:** Creating tasks one-by-one via `hive plan add` is tedious for large plans. Users (and especially PM agents) think in terms of task files, specs, or dependency lists. They need to import a batch of tasks from a structured file.
**Fix:**
1. `hive plan import <file>` — accepts YAML or Markdown.
2. **YAML format** (native):
   ```yaml
   tasks:
     - id: BE-06
       target: backend
       title: "implement pagination for documents"
       priority: p1

     - id: FE-06
       target: frontend
       title: "consume paginated documents endpoint"
       depends_on: [BE-06]
       priority: p0
       description: |
         BE-06 changed GET /documents to return { data, total, limit, offset }.
         Update getDocuments() in api.ts and all 3 callers.

     - id: QA-02
       target: qa
       title: "pagination integration tests"
       depends_on: [BE-06, FE-06]
   ```
3. **Markdown format** (parsed from existing task files):
   ```markdown
   ## BE-06: implement pagination for documents (p1) @backend
   ## FE-06: consume paginated documents endpoint (p0) @frontend [depends: BE-06]
   ## QA-02: pagination integration tests @qa [depends: BE-06, FE-06]
   ```
   Parse with regex: `## <id>: <title> (<priority>) @<target> [depends: <ids>]`
4. On import:
   - Validate all targets exist in config.
   - Validate dependency IDs reference tasks in the import file or existing plan.
   - Detect cycles.
   - Skip tasks whose IDs already exist in the plan (print warning).
   - Print summary: `Imported 12 tasks (3 ready, 9 pending). Run \`hive plan\` to see the board.`
5. `hive plan export <file>` — export the current plan to YAML. Useful for backup or sharing across projects.

---

## PLAN-07: `hive plan graph` — dependency visualization (Tier 3)

**File:** `src/commands/plan.ts` (subcommand)
**Problem:** With 15+ tasks and complex dependency chains, users need a visual representation of the DAG to understand critical paths, bottlenecks, and what's blocked.
**Fix:**
1. `hive plan graph` — render the dependency DAG in the terminal:
   ```
   🐝 AgentHive — Dependency Graph

   BE-06 ✓ ──┬──→ FE-06 ● ──→ QA-02 ◎
              │
              └──→ FE-07 ◎ ──→ QA-04 ○
                          │
   BE-07 ✓ ──────────────┘

   BE-08 ✓ ──→ FE-08 ✓ ──→ QA-03 ●

   BE-09 ✓    (no dependents)

   SEC-07 ✓   (no dependents)
   SEC-08 ✓   (no dependents)

   Legend: ○ open  ◎ ready  → dispatched  ● running  ✓ done  ✗ failed  ◉ blocked
   ```
2. Layout algorithm:
   - Group tasks into dependency chains (connected components of the DAG).
   - Within each chain, layout left-to-right by dependency depth.
   - Root tasks (no dependencies) on the left, leaf tasks (no dependents) on the right.
   - Chains sorted by: highest priority task in chain, then longest chain first.
3. For large plans, use `--focus <id>` to show only the subgraph containing a specific task (ancestors + descendants).
4. `--critical-path` flag: highlight the longest dependency chain (the bottleneck).
5. Color coding matches the board view (p0 = red, done = green, etc.).
6. Standalone tasks (no deps, no dependents) are grouped at the bottom.

---

## PLAN-08: `hive plan dispatch` — send ready tasks to agents (Tier 2)

**File:** `src/commands/plan.ts` (subcommand), `src/core/plan.ts`
**Also:** `src/core/chat.ts` (appendMessage)
**Problem:** Once the plan has ready tasks, the user needs a single command to dispatch them all. This replaces the manual `hive dispatch sre "..."` workflow for planned work.
**Fix:**
1. `hive plan dispatch [--agent <name>] [--id <id>] [--auto] [--dry-run]`:
   - No flags: dispatch all ready tasks (one per agent — each agent gets its highest-priority ready task).
   - `--agent <name>`: dispatch only the top ready task for this specific agent.
   - `--id <id>`: dispatch a specific task by ID (must be in ready status).
   - `--dry-run`: show what would be dispatched without doing it.
   - `--all`: dispatch all ready tasks, even multiple per agent (agents will queue them).
2. Dispatch action for each task:
   ```
   1. Set task status: ready → dispatched
   2. Set task.dispatched_at = now
   3. Append to chat: [USER] REQUEST @<ROLE>: [<TASK_ID>] <title>. <description_first_line>
   4. Save plan
   ```
3. The REQUEST message includes the task ID in brackets so `reconcilePlanWithChat` (PLAN-05) can match DONE messages back to the task:
   ```
   [USER] REQUEST @BACKEND: [BE-06] implement pagination for documents endpoint. Add pagination param to DocumentRepository.findAll(), add ?limit=N&offset=M query params (default 50, max 200), return envelope { data, total, limit, offset }.
   ```
4. Print dispatch summary:
   ```
   🐝 Dispatched 3 tasks:
     → BE-10  p2  backend   add soft delete to documents
     → FE-07  p0  frontend  consume paginated categories endpoint
     → QA-02  p2  qa        pagination integration tests

   2 tasks still waiting on dependencies.
   ```
5. `--auto` mode (for use with `hive launch`): the polling loop auto-dispatches ready tasks without user intervention. This is the fully autonomous mode where the plan drives all work. Controlled by config:
   ```yaml
   plan:
     auto_dispatch: true    # agents auto-pick ready tasks from the plan
     dispatch_delay: 30     # seconds to wait after a dependency completes before dispatching the next
   ```

---

## PLAN-09: `hive plan update` and `hive plan remove` — task management (Tier 3)

**File:** `src/commands/plan.ts` (subcommands)
**Problem:** Plans change. Tasks need to be reprioritized, reassigned, reset after failure, or removed entirely. Must support both human and agent updates.
**Fix:**
1. **`hive plan update <id> [options]`**:
   - `--status <status>` — manual status override (e.g., reset a failed task to `open`).
   - `--priority <p>` — reprioritize.
   - `--target <agent>` — reassign to a different agent.
   - `--depends-on <ids>` — replace dependencies (validates no cycles).
   - `--add-dep <id>` — add a dependency.
   - `--remove-dep <id>` — remove a dependency.
   - `--title <title>` — update the title.
   - `--description <text>` — update description.
   - `--labels <labels>` — replace labels.
2. **`hive plan remove <id> [--force]`**:
   - Remove a task from the plan.
   - If other tasks depend on this one, refuse unless `--force` (which also removes the dependency edges from dependents).
   - If task is in `dispatched` or `running` status, refuse unless `--force` (work may be in progress).
3. **`hive plan reset <id>`** — shortcut for `update --status open`. Clears `dispatched_at`, `completed_at`, `resolution`. Useful for retrying failed tasks.
4. All mutations: validate DAG integrity, update `updated_at`, save atomically.

---

## PLAN-10: Hierarchical task grouping (Tier 3)

**File:** `src/core/plan.ts`, `src/commands/plan.ts`
**Problem:** Large plans have natural hierarchy: an epic ("implement pagination") contains multiple tasks (BE-06, FE-06, QA-02). Without hierarchy, the board is a flat list that's hard to scan. Beads uses a hierarchical naming scheme (parent.1, parent.1.1) for this.
**Fix:**
1. Tasks can have a `parent` field pointing to another task ID.
2. Parent task status is **computed from children**:
   - All children done → parent is done
   - Any child failed → parent shows warning
   - Any child running → parent is running
   - Otherwise → parent shows progress (e.g., "3/5 done")
3. Board view groups children under parents:
   ```
   READY (3)
   ─────────
   ◎ PAGINATION (3/6 done)
     ◎ FE-07  p0  frontend
     ◎ QA-02  p2  qa
   ◎ BE-10    p2  backend
   ```
4. `hive plan tree` — dedicated tree view showing full hierarchy:
   ```
   PAGINATION
   ├── BE-06 ✓ backend — implement pagination for documents
   ├── BE-07 ✓ backend — implement pagination for categories
   ├── FE-06 ● frontend — consume paginated documents endpoint
   ├── FE-07 ◎ frontend — consume paginated categories endpoint
   ├── QA-02 ◎ qa — pagination integration tests
   └── QA-04 ○ qa — pagination E2E tests
   ```
5. `hive plan add ... --parent PAGINATION` to add subtasks.
6. Parent tasks don't get dispatched — only leaf tasks do. Parents are purely organizational.

---

## PLAN-11: Plan analytics and critical path (Tier 3)

**File:** `src/commands/plan.ts` (subcommand), `src/core/plan.ts`
**Problem:** With 20+ tasks, users need to understand: what's the bottleneck? Which agent is overloaded? How much will this plan cost? When will it finish? These are the questions a PM agent (or human) needs answered to make prioritization decisions.
**Fix:**
1. `hive plan stats`:
   ```
   🐝 Plan: my-project — 20 tasks

   Status breakdown:
     done: 8 (40%)  ████████░░░░░░░░░░░░
     running: 2      ██
     ready: 3        ███
     open: 5         █████
     failed: 1       █
     blocked: 1      █

   Per-agent workload:
     backend:  2 remaining (1 ready, 1 open)
     frontend: 3 remaining (1 running, 1 ready, 1 open)
     qa:       3 remaining (1 running, 1 ready, 1 open)
     security: 0 remaining ✓

   Critical path: BE-06 → FE-06 → QA-02 → QA-04 (longest chain: 4 tasks)
   Estimated remaining cost: $12.00 (6 tasks × $2.00 avg)
   ```
2. Critical path algorithm: find the longest path in the DAG (considering only non-done tasks). This is the bottleneck — completing tasks off the critical path doesn't reduce total time.
3. Per-agent load balancing insight: if one agent has 8 tasks and another has 1, suggest redistribution.
4. `--json` for programmatic consumption.

---

## Implementation Order

**Phase 1 — Core engine (ship together):**
1. **PLAN-01** — Data model and storage. Everything depends on this.
2. **PLAN-04** — Ready queue computation. This is the core value prop.
3. **PLAN-05** — Chat-driven state transitions. Makes the plan live.
4. **PLAN-03** — Task creation CLI. Users need to populate the plan.

**Phase 2 — Dispatch and visualization:**
5. **PLAN-08** — Dispatch from plan. Closes the loop: plan → dispatch → execute → DONE → plan updates.
6. **PLAN-02** — Board view. Users can see what's happening.
7. **PLAN-06** — Bulk import. Practical for large plans.

**Phase 3 — Advanced features:**
8. **PLAN-07** — Dependency graph visualization.
9. **PLAN-09** — Update and remove commands.
10. **PLAN-10** — Hierarchical grouping.
11. **PLAN-11** — Analytics and critical path.

**Integration note:** The polling loop integration (PLAN-05) makes the plan-driven mode opt-in. Without a `.hive/plan.json`, AgentHive works exactly as before (pure chat-driven). With a plan file, agents auto-check for ready tasks after processing chat messages. This means all existing behavior is preserved — the plan is additive.
