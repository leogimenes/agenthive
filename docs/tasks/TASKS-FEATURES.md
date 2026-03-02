# AgentHive — Feature Improvements

> New capabilities prioritized by impact. Organized into Tier A (high-impact, address real orchestration pain), Tier B (quality-of-life for daily use), and Tier C (polish that compounds over time).
> Prefix convention: `FEAT-`.
>
> **Dependency:** BUG-01 through BUG-03 (TASKS-BUGS.md) should be resolved before starting Tier A work. The safety system must be functional before adding features.

---

# Tier A — High Impact

These address the biggest pain points observed during real multi-agent orchestration (6+ agents, 20+ tasks, 8-hour session).

---

## FEAT-01: Add timestamps to chat protocol (Tier 2)

**File:** `src/core/chat.ts:38,59-71`
**Also:** `src/types/config.ts:104-117` (ChatMessage interface), `src/commands/tail.ts:46-50` (display), `src/commands/status.ts:54-57` (last activity)
**Problem:** The chat protocol has no timestamps. `hive status` can't show "2m ago" (the SPEC output format on line 125 shows this, but it's not implemented). `hive tail` can't show when messages were posted. Every downstream observability feature (notifications, cost-per-task, SLA tracking) requires knowing **when** something happened, not just **what** happened.
**Fix:**
1. Extend the message format to include an ISO 8601 timestamp:
   ```
   # Before:
   [SRE] DONE: implemented BE-09

   # After:
   [SRE] DONE (2026-03-01T15:30:45Z): implemented BE-09
   ```
2. Update `MESSAGE_REGEX` in `chat.ts:38` to make the timestamp group optional (backward-compatible):
   ```typescript
   const MESSAGE_REGEX = /^\[([A-Z_]+)\]\s+(STATUS|DONE|REQUEST|QUESTION|BLOCKER|ACK|WARN)(?:\s+\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\))?:\s*(.+)$/;
   ```
3. Update `appendMessage()` (line 59-71) to include the timestamp:
   ```typescript
   const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
   const line = `[${role.toUpperCase()}] ${type} (${ts}): ${body.trim()}\n`;
   ```
4. Add `timestamp?: Date` to `ChatMessage` interface in `types/config.ts:105`.
5. Update `parseMessages()` (chat.ts:142-164) to extract the timestamp from group 3 and parse it as a Date.
6. Update `hive tail` display to show relative timestamps: `2m ago`, `1h ago`, `yesterday`.
7. Update `hive status` to show relative time for last activity: `"2m ago — DONE: BE-09"`.
8. **Backward compatibility:** Old messages without timestamps parse normally (timestamp field is undefined). New messages always include timestamps.
9. Update tests in `tests/core/chat.test.ts` — add cases for timestamped messages and mixed old/new format.

---

## FEAT-02: Desktop notifications on agent events (Tier 2)

**File:** new `src/core/notify.ts`
**Also:** `src/core/polling.ts:122-163` (event emission points), `src/commands/tail.ts:157-169` (follow mode)
**Problem:** Power users context-switch constantly. Without push notifications, the only way to know an agent finished, hit a blocker, or exhausted its budget is to poll `hive status` or stare at `hive tail -f`. Every finished task sits idle until the user happens to check.
**Fix:**
1. Create `src/core/notify.ts` with a platform-aware notification function:
   ```typescript
   export async function notify(title: string, body: string, urgency?: 'low' | 'normal' | 'critical'): Promise<void>
   ```
2. Platform detection and dispatch:
   - **Linux:** `notify-send` (check availability with `which notify-send`)
     ```bash
     notify-send --urgency=<urgency> "AgentHive: <title>" "<body>"
     ```
   - **macOS:** `osascript`
     ```bash
     osascript -e 'display notification "<body>" with title "AgentHive: <title>"'
     ```
   - **Fallback:** Terminal bell (`\x07`) + bold stderr message.
3. Use `execFile` (not `execSync` — don't block the loop) for the notification command.
4. Integrate into the polling loop (`polling.ts`). Emit notifications on:
   - Task completion (DONE posted to chat) — urgency: normal
   - Blocker (BLOCKER posted to chat) — urgency: critical
   - Budget exhaustion (daily cap hit) — urgency: normal
   - Consecutive failure backoff triggered — urgency: normal
5. Add notification to `hive tail --follow` mode: when a DONE or BLOCKER message appears in the follow stream, fire a desktop notification.
6. Configuration in `.hive/config.yaml`:
   ```yaml
   defaults:
     notifications: true        # enable/disable
     notify_on: [DONE, BLOCKER] # which message types trigger notifications
   ```
7. `--notify` flag on `hive launch` and `hive tail -f` to enable without config change.
8. Respect `--quiet` / `--no-notify` flag to suppress.

---

## FEAT-03: Task queue with dependency-aware auto-dispatch (Tier 2)

**File:** new `src/core/queue.ts`
**Also:** new `src/commands/queue.ts`, `src/core/polling.ts:106-119` (integrate queue check), `src/types/config.ts` (new interfaces)
**Problem:** The biggest bottleneck in multi-agent orchestration is the human dispatcher. In the finansaas session, the PM agent manually posted 15+ `REQUEST` messages, tracked cross-agent dependencies by memory ("BE-06 must land before FE-06"), and re-dispatched when agents hit budget caps. A task queue with dependency tracking automates this entirely.
**Fix:**
1. Define the queue format in `.hive/queue.yaml`:
   ```yaml
   tasks:
     - id: BE-06
       target: backend        # agent name or role
       message: "implement pagination for documents endpoint"
       depends_on: []
       status: completed      # pending | dispatched | completed | failed | blocked

     - id: FE-06
       target: frontend
       message: "consume paginated documents endpoint (see BE-06)"
       depends_on: [BE-06]   # won't dispatch until BE-06 is completed
       status: pending

     - id: QA-01
       target: qa
       message: "add coverage tests for pagination"
       depends_on: [BE-06, FE-06]  # waits for both
       status: pending
   ```
2. Create `src/core/queue.ts` with:
   - `loadQueue(hivePath): QueueConfig` — read and validate `.hive/queue.yaml`
   - `getNextTask(queue, agentRole): QueueTask | null` — find the first `pending` task for this role where all `depends_on` are `completed`
   - `markDispatched(hivePath, taskId)` — set status to `dispatched`
   - `markCompleted(hivePath, taskId)` — set status to `completed`, check if any blocked tasks are now unblocked
   - `markFailed(hivePath, taskId)` — set status to `failed`
3. Integrate into `polling.ts:106-119`: after checking chat for REQUESTs, also check the queue for available tasks. Chat REQUESTs take priority over queue tasks (manual dispatch overrides auto-dispatch).
4. When a DONE message is detected in chat, scan for matching task ID and auto-mark as completed. Match by checking if the DONE message body contains the task ID (e.g., `[SRE] DONE: implemented BE-06...`).
5. When a BLOCKER message is detected, mark the task as `failed` and notify.
6. Create `src/commands/queue.ts` with:
   - `hive queue` — show current queue status (table with id, target, status, depends_on)
   - `hive queue add <target> <message> [--depends-on <ids>]` — add a task
   - `hive queue remove <id>` — remove a task
   - `hive queue reset <id>` — reset a failed task to pending
   - `hive queue import <file>` — bulk import tasks from a YAML/Markdown file
7. Add `queue` section to `HiveConfig` type and config validation.

---

## FEAT-04: `hive merge` — orchestrated rebase and push (Tier 2)

**File:** new `src/commands/merge.ts`
**Also:** `src/core/worktree.ts:rebaseAndPush` (existing function), `src/index.ts` (register command)
**Problem:** When multiple agents finish work, rebasing onto main in random order causes avoidable conflicts. In the finansaas session, agents posted BLOCKER messages due to rebase conflicts that could have been avoided by merging in dependency order. Currently, `rebaseAndPush` runs inside the polling loop — there's no user-facing command for manual, ordered merging.
**Fix:**
1. Create `src/commands/merge.ts` with `hive merge [agents...]`:
   - No args: merge all agents that have commits ahead of main.
   - With args: merge only specified agents, in the order given.
2. Pre-merge check for each agent:
   - Verify worktree exists and is clean (`git status --porcelain` in worktree).
   - Check if agent branch has commits ahead of main (`git log origin/main..agent/<name> --oneline`).
   - Skip agents with no new commits (nothing to merge).
3. Merge sequence:
   ```
   For each agent (in order):
     1. git fetch origin (in worktree)
     2. git rebase origin/main (in worktree)
     3. If conflict: STOP, print conflict files, offer options:
        a. Abort and skip this agent
        b. Open shell in worktree to resolve manually
        c. Abort entire merge sequence
     4. git push origin agent/<name>:main (fast-forward push to main)
     5. Print success: "✓ sre — 3 commits merged to main"
   ```
4. `--dry-run` flag: show which agents would be merged and in what order, without doing anything.
5. `--continue` flag: resume after a conflict was manually resolved (like `git rebase --continue`).
6. `--abort` flag: abort a merge in progress.
7. After successful merge of each agent, update the queue (FEAT-03) if applicable — completed tasks may unblock dependent tasks.
8. Print a summary at the end:
   ```
   ✓ sre       — 3 commits merged
   ✓ backend   — 5 commits merged
   ✗ frontend  — conflict on src/api.ts (skipped)
   ○ qa        — no new commits
   ```

---

# Tier B — Quality of Life

These improve the daily experience for users who've already adopted AgentHive.

---

## FEAT-05: Shell completions for bash, zsh, and fish (Tier 3)

**File:** new `src/completions.ts` or leverage commander's built-in support
**Also:** `src/index.ts`, installation script
**Problem:** Power users expect `hive <Tab>` to show available commands, `hive kill <Tab>` to show running agents, and `hive dispatch <Tab>` to show agent names. Without completions, users must check `--help` constantly.
**Fix:**
1. Commander.js has built-in completion support via the `tabtab` or `omelette` libraries, or via custom completion scripts.
2. Generate static completion scripts for each shell:
   - **bash:** `hive completion bash > /etc/bash_completion.d/hive`
   - **zsh:** `hive completion zsh > ~/.zfunc/_hive`
   - **fish:** `hive completion fish > ~/.config/fish/completions/hive.fish`
3. Register `hive completion <shell>` command that outputs the appropriate completion script.
4. Static completions: command names, global flags (`--cwd`, `--version`, `--help`).
5. Dynamic completions (requires reading config at completion time):
   - `hive launch <Tab>` → agent names from config
   - `hive kill <Tab>` → agent names from config (ideally only running ones)
   - `hive dispatch <Tab>` → agent names + role tags from config
   - `hive tail <Tab>` → agent names from config
6. Include completion setup instructions in `hive init` output and in the installation script (FEAT-06).

---

## FEAT-06: Installation script (Tier 3)

**File:** new `scripts/install.sh`
**Also:** `scripts/build-binary.sh` (builds the artifacts this installs)
**Problem:** Installing AgentHive currently requires either `npm install -g agenthive` (needs Node.js) or manually downloading the Bun binary. There's no single-command installer for users who just want the binary.
**Fix:**
1. Create `scripts/install.sh` — a POSIX-compatible shell script:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/<org>/agenthive/main/scripts/install.sh | bash
   ```
2. The script should:
   - Detect OS (Linux, macOS) and architecture (x64, arm64).
   - Download the pre-built binary from GitHub Releases for the detected platform.
   - Verify checksum (SHA256 — download `.sha256` file alongside binary).
   - Install to `~/.local/bin/hive` (or `/usr/local/bin/hive` with `--global` flag).
   - Set up shell completions (FEAT-05) if the user opts in.
   - Print success message with `hive --version` verification.
3. Handle edge cases:
   - `~/.local/bin` not in PATH → print instructions to add it.
   - Existing installation → ask to overwrite or print upgrade instructions.
   - No `curl` → try `wget`.
   - No write permission to target directory → suggest `sudo` or alternative path.
4. Add a `--version <tag>` flag to install a specific release.
5. Add an `--uninstall` flag to remove the binary and completions.
6. **GitHub Release workflow:** This depends on a CI pipeline that builds binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64 on each release. That's a separate DEVOPS task but must exist before this script is useful.
7. Future: Homebrew tap (`brew install <org>/tap/agenthive`) — separate task.

---

## FEAT-07: `hive logs` — Claude Code transcript viewer (Tier 3)

**File:** new `src/commands/logs.ts`, new `src/core/transcripts.ts`
**Also:** `src/index.ts` (register command)
**Problem:** `hive tail` only shows chat messages — what agents **said**. It doesn't show what agents **did**. Claude Code writes rich JSONL transcripts to `~/.claude/projects/` that contain every tool call, every code edit, every thinking block. The SPEC (CLI-05, lines 196-205) originally spec'd this as part of `hive tail`, but it's better as a separate command. This is the deep observability layer that turns "agent is running" into "agent is refactoring the auth module on line 45 of auth.guard.ts."
**Fix:**
1. Create `src/core/transcripts.ts`:
   - `findTranscriptDir(worktreePath): string | null` — scan `~/.claude/projects/` for a directory matching the worktree's absolute path (Claude Code uses the project path as part of the transcript directory name, with path separators replaced by `-`).
   - `listSessions(transcriptDir): SessionInfo[]` — list all `.jsonl` files, sorted by mtime. Return `{ path, startTime, endTime, messageCount }`.
   - `parseTranscript(sessionPath): TranscriptEvent[]` — read JSONL, extract events. Each event has: `timestamp`, `type` (tool_call, text, thinking, error), `tool` (Bash, Read, Write, Edit, Grep, Glob, Task), `summary` (truncated content).
2. Create `src/commands/logs.ts`:
   - `hive logs [agent]` — show recent transcript events for an agent (or all agents).
   - `hive logs --list` — list all sessions per agent with start time, duration, and event count.
   - `hive logs --session <id>` — show a specific session's full transcript.
   - `hive logs --follow` — live-tail the active transcript file.
3. Display format:
   ```
   [15:30:42] [SRE] $ npm test                              ← Bash tool
   [15:30:48] [SRE] r src/auth/auth.guard.ts                ← Read tool
   [15:31:02] [SRE] e src/auth/auth.guard.ts:45-52          ← Edit tool
   [15:31:15] [SRE] $ npm test                              ← Bash tool
   [15:31:22] [SRE] ✓ All 245 tests pass
   ```
4. Tool icons (from SPEC): `$` = Bash, `r` = Read, `w` = Write, `e` = Edit, `/` = Grep, `*` = Glob, `>>` = Task.
5. Use `chokidar` (already a dependency) for `--follow` mode watching.
6. Color-code by agent (reuse palette from `tail.ts`).

---

## FEAT-08: `hive cost` — cost reporting and tracking (Tier 3)

**File:** new `src/commands/cost.ts`
**Also:** `src/core/budget.ts` (extend with historical tracking)
**Problem:** Budget tracking in `budget.ts` only stores today's aggregate spend per agent. There's no history, no per-task cost, no trend analysis. Users running 5+ agents over multiple days have no way to answer "how much did this feature cost?" or "which agent burns the most budget?" Currently, `recordSpending` always records the per-task budget cap (not actual spend — `polling.ts:126` records `this.agent.budget`), so costs are approximate. Even approximate data is useful for trend analysis and cost awareness.
**Fix:**
1. Extend `src/core/budget.ts` with a cost log:
   - New file: `.hive/state/<agent>.cost-log` — append-only TSV with `timestamp`, `task_summary`, `amount`, `success`.
   - `logTaskCost(hivePath, agent, task, amount, success)` — appends a line.
   - Call from `polling.ts` after each task (line 126 and 145) instead of just `recordSpending`.
2. Create `src/commands/cost.ts`:
   - `hive cost` — summary view:
     ```
     🐝 AgentHive — Cost Report

     TODAY                          THIS WEEK
     sre        $4.00 (2 tasks)    $18.00 (9 tasks)
     frontend   $2.00 (1 task)     $12.00 (6 tasks)
     backend    $6.00 (3 tasks)    $24.00 (12 tasks)
     qa         $2.00 (1 task)     $8.00 (4 tasks)
     ─────────────────────────────────────────────
     TOTAL      $14.00 (7 tasks)   $62.00 (31 tasks)
     ```
   - `hive cost --agent <name>` — per-agent detail with task-by-task breakdown.
   - `hive cost --since <date>` — filter by date range.
   - `hive cost --json` — machine-readable output.
3. `hive cost --watch` — live-updating cost display (refresh every 30s).
4. This is approximate (records budget cap per task, not actual Claude API cost). Add a note in the output: `"Costs are estimated based on per-task budget caps."`
5. Future enhancement (not this task): parse Claude Code transcripts to extract actual API costs if available.

---

# Tier C — Polish

These improve resilience and flexibility. They compound over time but aren't blocking adoption.

---

## FEAT-09: `hive resume` — session recovery after crash or disconnect (Tier 3)

**File:** new `src/commands/resume.ts`
**Also:** `src/commands/launch.ts:122-134` (current session conflict handling), `src/core/lock.ts`
**Problem:** If the tmux session dies (terminal close, SSH disconnect, system reboot), `hive launch` refuses to start because lock files with stale PIDs exist. The user must manually `hive kill` (which tries to kill a non-existent tmux session), then `hive launch`. Worse, if the tmux session is alive but the user's terminal isn't attached, `hive launch --force` will kill running agents unnecessarily.
**Fix:**
1. Create `src/commands/resume.ts`:
   - Detect the current state:
     - tmux session exists? (check `tmux has-session`)
     - For each agent: lock status (running, stale, none)
     - For each agent: tmux window exists?
   - Build a recovery plan:
     - Stale locks (PID dead, no tmux window) → clean lock, relaunch
     - Running locks (PID alive, tmux window present) → skip (already running)
     - No lock, no window → launch from scratch
     - Lock exists but no tmux window → clean lock, relaunch (orphaned process was killed)
2. Print the plan before executing:
   ```
   🐝 AgentHive — Resume

   sre        ● running (PID 1234, tmux window present) — skip
   frontend   ✗ stale lock (PID 5678 dead) — will clean and relaunch
   backend    ○ not running — will launch
   qa         ● running (PID 9012, tmux window present) — skip

   Resume 2 agents? [Y/n]
   ```
3. `--yes` flag to skip confirmation.
4. `--force` flag to restart even running agents.
5. Reuse tmux session if it exists — don't create a new one. Add windows to the existing session for agents that need relaunching.

---

## FEAT-10: Agent health watchdog (Tier 3)

**File:** new `src/core/watchdog.ts`
**Also:** `src/core/polling.ts` (emit health signals), `src/core/lock.ts` (heartbeat extension)
**Problem:** Agents can get stuck in ways the polling loop doesn't detect: infinite loops in Claude, hang on a git operation, zombie process consuming resources. The polling loop has backoff for consecutive failures, but no mechanism to detect "stuck" (no output for N minutes). In the finansaas session, an agent hit the budget cap mid-task and stopped without posting DONE — the PM had to manually detect this.
**Fix:**
1. Add a heartbeat mechanism to locks:
   - Extend lock file format: write `<PID>\n<ISO timestamp>` instead of just `<PID>`.
   - Update `acquireLock` and `getLockStatus` in `lock.ts` to read/write the heartbeat.
   - The polling loop (`polling.ts`) updates the heartbeat timestamp at the start of each cycle (before budget check).
2. Create `src/core/watchdog.ts`:
   - `checkAgentHealth(hivePath, agent, maxSilenceMinutes): HealthStatus` — returns `healthy`, `unresponsive`, `stuck`, or `dead`.
   - `unresponsive`: lock heartbeat is older than `maxSilenceMinutes` (default: 10 for normal poll intervals, `poll * 3` for long-running agents).
   - `stuck`: agent has been processing the same task for more than `maxTaskMinutes` (detect via checkpoint not advancing while PID is alive).
   - `dead`: PID not alive but lock not cleaned up.
3. Integrate into `hive status` — show health indicator alongside status:
   ```
   sre    RUNNING (healthy)    $4.00/$20.00    2m ago — DONE: BE-09
   front  RUNNING (stuck?)     $2.00/$20.00    45m ago — idle
   ```
4. Optional: `hive watch` command that runs the watchdog in a loop and sends notifications (FEAT-02) when agents become unhealthy. Can be a `--watch` flag on `hive status`.
5. Auto-recovery (optional, gated by config flag): if an agent is detected as dead/stuck, auto-kill and relaunch it. Default: off. Config: `defaults.auto_restart: true`.

---

## FEAT-11: Configuration profiles for common workflows (Tier 3)

**File:** `src/commands/init.ts:34-38` (existing PRESETS), new `templates/profiles/`
**Also:** `templates/config.yaml` (existing annotated template)
**Problem:** The current presets (fullstack, backend-only, minimal) only control which agents are created. They don't set budget limits, poll intervals, hooks, or other config appropriate for the workflow. A security audit needs different settings than a feature sprint.
**Fix:**
1. Create `templates/profiles/` directory with full config templates:
   - **`fullstack.yaml`** — 5 agents (sre, frontend, backend, qa, security), balanced budgets ($2/task, $20/day), 60s poll. The current default.
   - **`security-audit.yaml`** — 2 agents (security, qa), higher budgets ($5/task, $50/day), 90s poll, extra safety hooks.
   - **`refactor.yaml`** — 3 agents (backend, qa, sre), tight budgets ($1/task, $10/day), 30s poll (faster iteration).
   - **`solo.yaml`** — 1 agent (backend), high budget ($10/task, $100/day), 30s poll. For single-agent power usage.
   - **`review.yaml`** — 2 agents (security, qa), read-only hooks (block all writes), review-focused prompts.
2. Extend `hive init --preset <name>` to load the full profile (not just agent names). The profile YAML is used as the base config, with the user's overrides applied on top.
3. `hive init --list-presets` to show available profiles with descriptions.
4. Profiles include everything: agents, defaults, hooks, chat config. They're complete, opinionated starting points.

---

## FEAT-12: `hive add` and `hive remove` — post-init agent management (Tier 3)

**File:** new `src/commands/add.ts`, new `src/commands/remove.ts`
**Also:** `src/index.ts` (register commands), `src/commands/init.ts:82` (fix error message — cross-ref BUG-04)
**Problem:** After `hive init`, there's no way to add or remove agents without manually editing `config.yaml` and running git worktree commands. BUG-04 notes that `init.ts` references `hive add` but it doesn't exist.
**Fix:**
1. **`hive add <name> [--agent <file>] [--poll N] [--budget N] [--daily-max N]`**:
   - Validate name isn't already in config.
   - Add agent entry to `.hive/config.yaml` (parse YAML, add to `agents` section, write back).
   - Create git worktree: `git worktree add .hive/worktrees/<name> -b agent/<name>`.
   - Add role mapping to `chat.role_map` (uppercased name).
   - Generate `.claude/settings.json` in the new worktree (requires BUG-01 fix).
   - Optionally install agent template (if TMPL-03 is implemented).
   - Print confirmation with the agent's resolved config.
2. **`hive remove <name> [--force]`**:
   - Validate name exists in config.
   - Check if agent is running (lock file with live PID) — refuse unless `--force`.
   - Kill the agent's tmux window if it exists.
   - Release the lock if held.
   - Remove git worktree: `git worktree remove .hive/worktrees/<name>`.
   - Optionally delete the branch: `git branch -D agent/<name>` (ask for confirmation, or `--delete-branch` flag).
   - Remove agent entry from `.hive/config.yaml`.
   - Remove role mapping from `chat.role_map`.
   - Print confirmation.
3. After implementing `hive add`, update the error message in `init.ts:82` to reference the real command (resolves BUG-04).
4. Use the `yaml` package's `parse` → modify → `stringify` to edit config.yaml while preserving comments where possible (the `yaml` library supports comment preservation with `keepSourceTokens: true`).

---

## Implementation Order

**Phase A — Foundation improvements (do first):**
1. FEAT-01 (timestamps) — 30-minute change, unblocks FEAT-02 and UI-03
2. FEAT-02 (notifications) — standalone, high impact
3. FEAT-04 (`hive merge`) — standalone, addresses real pain

**Phase B — Orchestration automation:**
4. FEAT-03 (task queue) — largest feature, transforms the workflow

**Phase C — Distribution and polish:**
5. FEAT-05 (shell completions)
6. FEAT-06 (installation script)
7. FEAT-12 (`hive add` / `hive remove`)

**Phase D — Deep observability:**
8. FEAT-07 (`hive logs`)
9. FEAT-08 (`hive cost`)

**Phase E — Resilience:**
10. FEAT-09 (`hive resume`)
11. FEAT-10 (watchdog)
12. FEAT-11 (config profiles)
