# AgentHive — Engineering Tasks

> All tasks reference `docs/SPEC.md` for acceptance criteria.
> Prefix convention: `CORE-` (core library), `CLI-` (commands), `HOOK-` (hooks), `BUILD-` (tooling/CI/distribution).

---

## CORE-01: Config loader and schema validation (Tier 1)

**File:** `src/core/config.ts`
**Also:** `src/types/config.ts`, `templates/config.yaml`
**Problem:** Every command depends on reading `.hive/config.yaml`. Without a validated, typed config object, all downstream commands are guessing at the shape of user input. This is the foundation — nothing else works without it.
**Fix:**
1. Define TypeScript interfaces in `src/types/config.ts`:
   - `HiveConfig` (top-level: session, defaults, agents, chat, hooks)
   - `AgentConfig` (per-agent: description, agent, poll, budget, daily_max)
   - `ChatConfig` (file, role_map)
   - `DefaultsConfig` (poll, budget, daily_max, model, skip_permissions)
2. In `src/core/config.ts`:
   - `loadConfig(dir?: string): HiveConfig` — reads `.hive/config.yaml`, parses with `yaml` package, validates required fields, merges agent-level overrides with defaults.
   - `resolveHivePath(dir?: string): string` — walks up from cwd to find `.hive/` directory (like how git finds `.git/`).
   - Throw typed errors: `HiveConfigNotFoundError`, `HiveConfigValidationError`.
3. Write `templates/config.yaml` — annotated default config matching the schema in SPEC.md.
4. Add `yaml` to dependencies.

---

## CORE-02: Git worktree manager (Tier 1)

**File:** `src/core/worktree.ts`
**Problem:** Workspace isolation via worktrees is the core architectural bet. If worktree creation, listing, or cleanup fails, agents have nowhere to run.
**Fix:**
1. Implement functions:
   - `createWorktree(name: string, baseBranch?: string): Promise<string>` — runs `git worktree add .hive/worktrees/<name> -b agent/<name> [baseBranch]`. Returns the worktree path. Errors if branch already exists (suggest `hive add --force`).
   - `listWorktrees(): Promise<WorktreeInfo[]>` — parses `git worktree list --porcelain`. Returns name, path, branch, HEAD commit.
   - `removeWorktree(name: string): Promise<void>` — runs `git worktree remove .hive/worktrees/<name>`. Deletes the branch `agent/<name>` after removal.
   - `rebaseAndPush(worktreePath: string, targetBranch?: string): Promise<RebaseResult>` — in the worktree: `git fetch origin`, `git rebase origin/<target>`, `git push origin <branch>:<target>`. Returns success or conflict details.
2. All functions must validate that the current directory is a git repo before executing.
3. Handle edge cases: worktree directory exists but git doesn't track it (orphaned), branch exists but worktree doesn't (dangling branch).

---

## CORE-03: Chat file protocol (Tier 1)

**File:** `src/core/chat.ts`
**Problem:** The chat file is the coordination backbone. If message formatting is inconsistent or reading is unreliable, agents miss tasks or post malformed messages.
**Fix:**
1. Define message types: `STATUS`, `DONE`, `REQUEST`, `QUESTION`, `BLOCKER`, `ACK`, `WARN`.
2. Implement:
   - `appendMessage(role: string, type: MessageType, body: string): Promise<void>` — atomic append to chat file. Uses `fs.appendFile` with newline. Format: `[ROLE] TYPE: body`.
   - `readMessages(since?: number): Promise<ChatMessage[]>` — reads the file, skips comment/blank lines, parses each line into `{ role, type, body, lineNumber }`.
   - `findRequests(role: string, since?: number): Promise<ChatMessage[]>` — filters for `REQUEST @ROLE` messages since the given line number. Case-insensitive on role.
   - `initChatFile(path: string): Promise<void>` — creates the file with the protocol header (comment block explaining format and rules).
3. Chat file path comes from `HiveConfig.chat.file`, resolved relative to `.hive/`.

---

## CORE-04: Lock and checkpoint manager (Tier 1)

**File:** `src/core/lock.ts`
**Problem:** Without locking, two instances of the same agent loop can run simultaneously, double-processing tasks. Without checkpoints, an agent re-scans the entire chat file on every poll.
**Fix:**
1. Implement:
   - `acquireLock(agentName: string): Promise<boolean>` — writes PID to `.hive/state/<name>.lock`. If lock exists, check if PID is alive (`process.kill(pid, 0)`). If alive, return false. If stale, remove and acquire.
   - `releaseLock(agentName: string): Promise<void>` — removes the lock file.
   - `getCheckpoint(agentName: string): Promise<number>` — reads `.hive/state/<name>.checkpoint` (line number). Returns 0 if missing.
   - `setCheckpoint(agentName: string, line: number): Promise<void>` — writes line number.
2. Register signal handlers (SIGINT, SIGTERM) to release locks on exit.
3. Ensure `.hive/state/` directory is created if missing.

---

## CORE-05: Budget tracker (Tier 1)

**File:** `src/core/budget.ts`
**Problem:** Without budget enforcement, a single agent invocation can burn unlimited API credits. The daily cap prevents aggregate overspend across many tasks.
**Fix:**
1. Implement:
   - `checkDailyBudget(agentName: string, dailyMax: number): Promise<{ allowed: boolean, spent: number }>` — reads `.hive/state/<name>.daily-spend`. If file date is not today, reset to 0. Compare spent vs dailyMax.
   - `recordSpending(agentName: string, amount: number): Promise<number>` — adds amount to daily spend file. Returns new total.
   - `getDailySpend(agentName: string): Promise<{ spent: number, date: string }>` — reads current spend without modifying.
2. Per-task budget is enforced by passing `--max-budget-usd` to the `claude` CLI. This module only tracks the daily aggregate.

---

## CORE-06: Polling daemon (Tier 1)

**File:** `src/core/polling.ts`
**Problem:** This is the heart of the system — the loop that turns chat messages into Claude invocations. It must handle all the edge cases: budget exhaustion, consecutive failures, lock contention, git conflicts.
**Fix:**
1. Implement `AgentLoop` class:
   ```typescript
   class AgentLoop {
     constructor(config: AgentConfig, hiveConfig: HiveConfig)
     start(): Promise<void>   // begins the polling loop
     stop(): Promise<void>    // graceful shutdown
   }
   ```
2. Loop logic (mirrors the proven bash implementation):
   - Check daily budget → if exhausted, sleep 1 hour.
   - Git fetch + rebase worktree onto main → if fails, log warning, skip cycle.
   - Read chat file for `REQUEST @ROLE` since last checkpoint.
   - If task found: invoke `claude -p --agent <name> --max-budget-usd <budget> --dangerously-skip-permissions --no-session-persistence "<prompt>"` in the worktree directory.
   - On success: rebase onto main, push, record spending, reset fail counter.
   - On failure: increment fail counter, apply exponential backoff after 3 consecutive failures (5min base, 30min cap).
   - On rebase conflict: post `BLOCKER` to chat, do not push.
   - If no task: increment idle counter, sleep poll interval.
3. The prompt template must instruct the agent to:
   - Implement the task
   - Run build/test gates
   - Commit changes
   - Append `DONE` or `BLOCKER` to chat file
4. Use `child_process.spawn` for the `claude` invocation. Stream stdout/stderr to the tmux window.

---

## CLI-01: `hive init` command (Tier 1)

**File:** `src/commands/init.ts`
**Also:** `src/index.ts` (CLI entry point)
**Problem:** Without `init`, users must manually create the `.hive/` directory, config file, worktrees, and hooks. This is the first-run experience — it must be correct and helpful.
**Fix:**
1. Implement the `init` subcommand:
   - Verify cwd is a git repo (check for `.git/` directory or `git rev-parse --git-dir`).
   - Error if `.hive/` already exists.
   - Create `.hive/`, `.hive/hooks/`, `.hive/state/`.
   - Copy generic hooks from the bundled `hooks/` directory.
   - If `--agents` flag provided: create config with those agents. Otherwise: interactive prompt (use `@inquirer/prompts`) asking which roles to set up.
   - For each agent: `git worktree add .hive/worktrees/<name> -b agent/<name>`.
   - Create `.hive/config.yaml` with the resolved agent list.
   - Create `.hive/chat.md` with protocol header.
   - Append `.hive/worktrees/` and `.hive/state/` to `.gitignore` if not already present.
   - Print success summary.
2. Set up the CLI entry point in `src/index.ts` using `commander`:
   - Register all subcommands.
   - Add `--version`, `--help`.
   - Add `--cwd <path>` global option.

---

## CLI-02: `hive launch` and `hive kill` commands (Tier 1)

**File:** `src/commands/launch.ts`, `src/commands/kill.ts`
**Problem:** Launching and stopping agents must be reliable. If launch fails silently or kill leaves orphan processes, the user loses trust in the tool.
**Fix:**
1. `hive launch [agents...]`:
   - Load config.
   - If no args: launch all agents. If args: validate each name exists in config.
   - Check for existing tmux session. If exists: warn and offer to kill + relaunch (or `--force` to skip prompt).
   - For each agent: create a tmux window running the agent loop.
   - The loop process is the Node.js polling daemon from CORE-06, invoked as a subprocess (`hive _loop <agent>` — internal command not shown in help).
   - Print summary table and attach instructions.
   - `--attach`: auto-attach to tmux after launch.
   - `--dry-run`: print what would be launched without doing it.
2. `hive kill [agents...]`:
   - No args: `tmux kill-session -t <session>`.
   - With args: `tmux kill-window -t <session>:<name>` for each.
   - Verify lock files are cleaned up. If PID still alive after kill, force-kill.

---

## CLI-03: `hive status` command (Tier 2)

**File:** `src/commands/status.ts`
**Problem:** Users need to know at a glance which agents are running, how much they've spent, and what they last did.
**Fix:**
1. For each agent in config:
   - Check lock file → determine RUNNING (live PID), STALE LOCK, or STOPPED.
   - Read daily spend file → show `$spent/$daily_max`.
   - Read last line of chat file matching this role → show last activity and relative time.
2. Format as a table (use `cli-table3` or manual padding).
3. Exit code: 0 if all agents healthy, 1 if any stale locks or errors.

---

## CLI-04: `hive dispatch` command (Tier 2)

**File:** `src/commands/dispatch.ts`
**Problem:** Writing to the chat file manually (`echo '...' >> chat.md`) is error-prone (wrong format, wrong path, missing role tag).
**Fix:**
1. `hive dispatch <role> <message>`:
   - Validate role exists in config's `chat.role_map`.
   - Use `appendMessage()` from CORE-03 to write `[USER] REQUEST @ROLE: message`.
   - `--from <role>`: override sender (default: `USER`).
   - Print confirmation with the exact line appended.
2. Support reading message from stdin if `-` is passed: `echo "fix timeout" | hive dispatch sre -`.

---

## CLI-05: `hive tail` command (Tier 2)

**File:** `src/commands/tail.ts`
**Problem:** Understanding what N agents are doing requires checking N tmux windows or N transcript files. Users need a unified timeline.
**Fix:**
1. Port the `agent-tail.sh` logic to TypeScript:
   - Find Claude Code transcript files in `~/.claude/projects/` matching the worktree paths.
   - Parse JSONL: extract timestamps, tool calls, text outputs.
   - Merge events from all agents chronologically.
   - Color-code by workspace (use `chalk`).
   - Tool icons: `$` bash, `r` read, `w` write, `e` edit, `/` grep, `*` glob, `>>` task.
2. Flags:
   - `[workspace]` — filter to one agent.
   - `--last <N>` — show last N events (default: 40).
   - `--follow` — watch for new events (use `chokidar` or `fs.watch` on JSONL files).
   - `--list` — list all sessions per workspace.

---

## CLI-06: `hive config` command (Tier 3)

**File:** `src/commands/config.ts`
**Problem:** Users need to verify their config is parsed correctly, especially after editing YAML.
**Fix:**
1. Load config using CORE-01.
2. Print the resolved config (with defaults merged) as formatted YAML.
3. If config has errors, print validation errors and exit 1.

---

## HOOK-01: Generic destructive guard hook (Tier 1)

**File:** `src/hooks/destructive-guard.sh`
**Problem:** Agents running with `--dangerously-skip-permissions` can execute destructive commands. This hook is the safety net.
**Fix:**
1. Port the existing `pre-destructive-guard.sh` from finansaas — it's already generic.
2. Remove the hardcoded path. The hook should work from any directory.
3. Blocked patterns: `git reset --hard`, `git push --force`, `git push -f`, `git clean -f`, `rm -rf`, `DROP TABLE`, `TRUNCATE`.
4. Exit 2 to block, exit 0 to allow.

---

## HOOK-02: Generic chat injection hook (Tier 1)

**File:** `src/hooks/check-chat.sh`
**Problem:** Agents need to see the coordination chat before processing each prompt and after committing. Without this, agents operate in isolation.
**Fix:**
1. Port the existing `check-chat.sh` from finansaas.
2. Make the chat file path configurable: read from `$HIVE_CHAT_FILE` environment variable (set by the polling daemon before invoking `claude`).
3. Handle both `UserPromptSubmit` and `PostToolUse` events.
4. Exit 0 if chat file is missing or empty (graceful degradation for repos not using AgentHive).

---

## BUILD-01: CLI entry point and dependency setup (Tier 1)

**File:** `src/index.ts`, `package.json`
**Problem:** The project needs its dependency tree installed and a working CLI entry point before any command can be developed.
**Fix:**
1. Install dependencies:
   - `commander` — CLI framework
   - `yaml` — YAML parsing
   - `chalk` — terminal colors
   - `@inquirer/prompts` — interactive prompts (for `init`)
   - `chokidar` — file watching (for `tail --follow`)
2. Install dev dependencies:
   - `typescript`, `tsx` — build and dev run
   - `vitest` — testing
   - `eslint`, `@typescript-eslint/*` — linting
3. Set up `src/index.ts` as the CLI entry point with `commander`:
   - `#!/usr/bin/env node` shebang
   - Register all subcommands
   - Parse argv, dispatch to command handlers
4. Verify `npm run dev -- init --help` works.

---

## BUILD-02: Standalone binary compilation (Tier 3)

**File:** `package.json` (scripts), build config
**Problem:** Users shouldn't need Node.js installed to run AgentHive. A standalone binary removes the runtime dependency.
**Fix:**
1. Evaluate compilation options:
   - **Bun `bun build --compile`** — simplest, single command, cross-platform. Requires Bun for building only.
   - **Node.js SEA (Single Executable Application)** — native, no extra tooling, but more setup (postject, blob injection).
   - **pkg** — mature but deprecated by Vercel.
2. Add a `build:binary` script to `package.json`.
3. Target: Linux x64 (primary), macOS arm64 (secondary).
4. Test that the binary can run `hive init` and `hive --help` without Node.js in PATH.

---

## BUILD-03: Test infrastructure (Tier 2)

**File:** `tests/`, `vitest.config.ts`
**Problem:** Core modules (config, worktree, chat, lock, budget) need unit tests. Without tests, refactoring is guesswork.
**Fix:**
1. Create `vitest.config.ts` with TypeScript support.
2. Write unit tests for:
   - `config.ts` — valid YAML, missing fields, default merging, path resolution.
   - `chat.ts` — append, read, filter by role, handle empty file.
   - `lock.ts` — acquire, release, stale detection, concurrent access.
   - `budget.ts` — daily reset, spend recording, cap enforcement.
3. For `worktree.ts`: integration tests that create real git repos in a temp directory.
4. Target: 80% coverage on `src/core/`.

---

## Implementation Order

**Phase 1 — Foundation (must ship together):**
1. BUILD-01 (dependencies + entry point)
2. CORE-01 (config)
3. CORE-02 (worktrees)
4. CORE-03 (chat)
5. CORE-04 (locks)
6. CORE-05 (budget)
7. CLI-01 (`hive init`)

**Phase 2 — Runtime (agents can run):**
8. CORE-06 (polling daemon)
9. HOOK-01 (destructive guard)
10. HOOK-02 (chat injection)
11. CLI-02 (`hive launch` + `hive kill`)

**Phase 3 — Observability + polish:**
12. CLI-03 (`hive status`)
13. CLI-04 (`hive dispatch`)
14. CLI-05 (`hive tail`)
15. CLI-06 (`hive config`)

**Phase 4 — Distribution:**
16. BUILD-02 (standalone binary)
17. BUILD-03 (tests)
