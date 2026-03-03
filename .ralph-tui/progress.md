# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

- **Command registration pattern**: Each command has a `registerXxxCommand(program)` export in `src/commands/xxx.ts`, imported and called in `src/index.ts`
- **CWD resolution**: All commands resolve `cwd` from `program.opts().cwd` or `process.cwd()`, then pass to `resolveHiveRoot(cwd)` + `loadConfig(cwd)`
- **ESM module**: Project uses ESM (`import`/`export`), never `require()`. All local imports use `.js` extensions.

---

## 2026-03-03 - agenthive-2h2.1
- Fixed stale `hive add --force` reference in `src/core/worktree.ts:25`
- Replaced with actionable message: tells user to run `git worktree remove <path>` and retry, or delete the directory manually
- Files changed: `src/core/worktree.ts`
- **Learnings:**
  - `init.ts:81` was already fixed in a prior iteration (references `git worktree add` correctly)
  - The `hive add` command does not exist yet (planned as US-010); when it's implemented, both `init.ts` and `worktree.ts` should be updated to reference it
---

## 2026-03-03 - agenthive-2h2.2
- Implemented `hive merge [agents...]` command for orchestrated rebase and push
- Files changed: `src/commands/merge.ts` (new), `src/index.ts` (registration)
- Features:
  - No args: merges all agents with commits ahead of main, in alphabetical order
  - With args: merges only specified agents in the order given
  - Pre-merge checks: worktree clean, counts commits ahead, skips agents with no new commits
  - Per-agent: fetch → rebase onto main → push to main (fast-forward)
  - On conflict: stops, prints conflict files, saves state for `--continue`
  - `--dry-run` shows what would be merged without doing it
  - `--continue` resumes after manually resolved conflict
  - Summary printed at the end with per-agent results
- **Learnings:**
  - Worktrees use a `.git` file (not directory) pointing to main repo's git dir; rebase state dirs must be checked via `git rev-parse --git-dir`
  - `getMainBranch()` in `src/core/worktree.ts` checks origin/main, origin/master, then local main/master
  - Merge state is persisted in `.hive/state/merge-state.json` for `--continue` flow
---

## 2026-03-03 - agenthive-2h2.3
- Implemented `hive completion <shell>` command for bash, zsh, and fish shell completions
- Files changed: `src/commands/completion.ts` (new), `src/index.ts` (registration)
- Features:
  - Static completions for all command names and global flags (`--cwd`, `--version`, `--help`)
  - Dynamic agent name completions for `launch`, `kill`, `dispatch`, `tail`, and `merge` via `hive config --agents --json`
  - Per-command flag/option completions
  - Subcommand completions for `plan` and `templates`
  - Installation instructions printed via `hive completion --help`
  - Error handling for unknown shell names
- **Learnings:**
  - Dynamic completions resolve agent names at tab-completion time by invoking `hive config --agents --json` and parsing the output — this works even without importing config modules
  - The `addHelpText('after', ...)` commander method is useful for appending installation instructions to `--help` output
  - Completion scripts are pure string generation — no external dependencies needed
---

## 2026-03-03 - agenthive-2h2.10
- Implemented `hive add <name>` and `hive remove <name>` commands for post-init agent management
- Files changed: `src/commands/agent.ts` (new), `src/index.ts` (registration), `src/commands/completion.ts` (add/remove completions), `src/commands/init.ts` (updated error message), `src/core/worktree.ts` (updated error message)
- Features:
  - `hive add <name>` with options: `--agent`, `--poll`, `--budget`, `--daily-max`, `--description`
  - Validates name uniqueness and role tag collision
  - Creates worktree, registers hooks, updates config.yaml with comment preservation via `yaml` `parseDocument`
  - `hive remove <name>` with `--force` (remove running agent) and `--delete-branch`
  - Checks running state, kills tmux window and process if forced, removes worktree, updates config.yaml, cleans state files
  - Updated error messages in `init.ts` and `worktree.ts` to reference `hive add`/`hive remove`
  - Shell completions added for bash, zsh, and fish
- **Learnings:**
  - `yaml` package's `parseDocument()` + `doc.setIn()`/`doc.deleteIn()` preserves comments and formatting when modifying YAML programmatically
  - The `registerHooksInWorktree` helper from `init.ts` was duplicated since it's not exported and is tightly coupled to the init flow — could be extracted to a shared module in the future
  - Commander's `parseFloat` can be passed directly as the option parser for numeric flags
---

## 2026-03-03 - agenthive-2h2.4
- Created `scripts/install.sh` — POSIX-compatible installation script for standalone binary
- Files changed: `scripts/install.sh` (new)
- Features:
  - Detects OS (Linux, macOS) and architecture (x64, arm64)
  - Downloads pre-built binary from GitHub Releases (`agenthive/agenthive`)
  - SHA256 checksum verification (supports `sha256sum` and `shasum`)
  - Installs to `~/.local/bin/hive` by default, `/usr/local/bin/hive` with `--global`
  - `--version <tag>` for specific release, `--uninstall` to remove
  - Falls back to `wget` if `curl` not available
  - Existing installation prompts for overwrite confirmation
  - PATH detection with shell-specific instructions
  - Shell completion setup instructions at end of install flow
- **Learnings:**
  - POSIX sh doesn't support arrays or `[[ ]]` — use `case` for string matching and `[ ]` for tests
  - GitHub API releases/latest endpoint returns JSON; parsing tag_name with grep+sed avoids jq dependency
  - `mktemp -d` is widely available on both Linux and macOS for temp directory creation
---

## 2026-03-03 - agenthive-2h2.5
- Implemented `hive logs [agent]` command — Claude Code transcript viewer
- Files changed: `src/core/transcripts.ts` (new), `src/commands/logs.ts` (new), `src/index.ts` (registration), `src/commands/completion.ts` (logs completions), `tests/core/transcripts.test.ts` (new, 25 tests)
- Features:
  - `findTranscriptDir(worktreePath)` scans `~/.claude/projects/` for matching directories by encoding path
  - `listSessions(dir)` returns session metadata sorted by start time (newest first) with duration and event count
  - `parseTranscript(path)` extracts tool_use, text, and thinking events from JSONL
  - `hive logs [agent]` shows recent transcript events with tool icons: `$` Bash, `r` Read, `w` Write, `e` Edit, `/` Grep, `*` Glob, `>>` Agent
  - `hive logs --list` lists all sessions per agent with start time, duration, and event count
  - `hive logs --session <id>` shows a specific session's full transcript (supports prefix matching)
  - `hive logs --follow` live-tails the active transcript file using `chokidar`
  - `hive logs --json` outputs machine-readable data for all modes
  - Events are color-coded by agent using the same palette as `hive tail`
  - Shell completions added for bash, zsh, and fish
- **Learnings:**
  - Claude Code JSONL transcripts use `type: "user"|"assistant"|"queue-operation"` at the top level; actual API content is in `message.content` (array of content blocks)
  - Claude Code encodes project paths for `~/.claude/projects/` dirs by replacing `/` with `-` (e.g., `/home/user/project` → `-home-user-project`)
  - Tool use blocks have `{type: "tool_use", name: "ToolName", input: {...}}` — tool results come back in `user` entries as `{type: "tool_result"}`
  - The `chokidar` package (already a dependency) works well for live-tailing JSONL files by tracking event count offsets
---

## 2026-03-03 - agenthive-2h2.6
- Implemented `hive cost` command for per-agent and aggregate cost reporting
- Files changed: `src/core/budget.ts` (cost log functions), `src/core/polling.ts` (logTaskCost integration), `src/commands/cost.ts` (new), `src/index.ts` (registration), `src/commands/completion.ts` (cost completions), `tests/core/budget.test.ts` (7 new tests)
- Features:
  - Cost log: append-only TSV file per agent at `.hive/state/<agent>.cost-log` with timestamp, task summary, amount, success
  - `logTaskCost()` called from `polling.ts` after each task completion (both success and failure)
  - `hive cost` summary table: per-agent today and this-week spend with task counts
  - `hive cost --agent <name>` task-by-task breakdown for one agent
  - `hive cost --since <date>` filters by date range
  - `hive cost --json` outputs machine-readable data
  - Output includes note: "Costs are estimated based on per-task budget caps"
  - Shell completions added for bash, zsh, and fish
- **Learnings:**
  - `appendFileSync` is ideal for append-only log files — no need to read-modify-write
  - TSV format with tab-separated fields works well for structured log lines; task descriptions need tab/newline sanitization
  - The existing `recordSpending` tracks daily totals (resets daily), while the new cost log is permanent and append-only — they serve complementary purposes
---

## 2026-03-03 - agenthive-2h2.7
- Implemented `hive resume` command for session recovery after crash/disconnect
- Files changed: `src/commands/resume.ts` (new), `src/index.ts` (registration), `src/commands/completion.ts` (resume completions)
- Features:
  - Detects agent state: running (PID alive + lock), stale (lock exists but PID dead), stopped (no state)
  - Lists tmux windows to detect orphaned windows alongside stale locks
  - Builds and displays a color-coded recovery plan showing each agent's state and planned action
  - `--yes` skips confirmation prompt for scripted/automated use
  - `--force` restarts even running agents (kills process, cleans lock, relaunches)
  - `--dry-run` shows recovery plan without executing
  - Reuses existing tmux session if present — adds windows rather than creating a new session
  - Cleans stale locks and orphaned tmux windows before relaunching
  - Shell completions added for bash, zsh, and fish
- **Learnings:**
  - `tmux list-windows -t <session> -F '#{window_name}'` is the clean way to list window names in a session — use `execFileSync` with pipe output to parse
  - The `readline` module's `createInterface` + `rl.question()` works well for simple y/N confirmation prompts in CLI commands
  - The `buildLoopCommand` helper from `launch.ts` was duplicated rather than shared — both detect tsx vs production mode and build the appropriate command string
---

## 2026-03-03 - agenthive-2h2.8
- Implemented agent health watchdog (US-008) with heartbeat-based health monitoring
- Files changed: `src/core/lock.ts` (heartbeat format + updateHeartbeat), `src/core/watchdog.ts` (new), `src/core/polling.ts` (heartbeat at cycle start), `src/commands/status.ts` (health indicators + --watch mode), `src/commands/completion.ts` (--watch/--interval completions), `tests/core/lock.test.ts` (updated for new format), `tests/core/watchdog.test.ts` (new, 12 tests)
- Features:
  - Lock file format extended to `<PID>\n<ISO timestamp>` — backward compatible with old PID-only format
  - `updateHeartbeat()` called at start of every polling cycle
  - `checkAgentHealth()` returns: `healthy`, `unresponsive` (heartbeat > poll*3), `stuck` (checkpoint not advancing), `dead` (PID gone, lock stale), `stopped` (no lock)
  - `hive status` shows health indicator alongside status: `RUNNING (healthy)` vs `RUNNING (unresponsive?)`
  - `hive status --watch [--interval N]` runs continuous health monitoring with desktop notifications on state changes
  - Shell completions updated for bash, zsh, and fish
- **Learnings:**
  - Extending lock file format required updating existing tests that used `toEqual` with exact object shape — `getLockStatus` now returns an additional `heartbeat` field
  - Backward compatibility with old lock format (PID-only, no newline) was important since existing locks may still be in this format
  - The `isProcessAlive` helper in lock.ts was made `export` for reuse by the watchdog module
  - `await new Promise(() => {})` is a clean pattern for keeping a CLI process alive indefinitely (for watch mode)
---
