# Remaining Work

## Overview

Remaining user stories across all PRDs that have not yet been implemented. Includes one partially-complete bug fix (stale `hive add` reference in worktree.ts), one partially-complete feature (configuration profiles need full YAML profile files), and eight unstarted feature improvements covering merge orchestration, shell completions, installation, transcript viewing, cost reporting, session recovery, health monitoring, and post-init agent management.

## User Stories

### US-001: Fix stale `hive add` reference in worktree.ts

**From:** `prd-bug-fixes.md` US-004 (partial)

**As a** developer running `hive init` in an already-initialized repo
**I want** all error messages to reference commands that actually exist
**So that** I'm not directed to a nonexistent `hive add --force` command

#### Acceptance Criteria
- [ ] The error message in `src/core/worktree.ts:25` no longer references `hive add --force`
- [ ] The replacement message tells the user to remove the existing worktree with `git worktree remove` and retry, or to delete the directory manually
- [ ] If `hive add` is implemented later (US-010 in this PRD), both `init.ts` and `worktree.ts` are updated to reference the real command

### US-002: Orchestrated rebase and push

**From:** `prd-features.md` US-003

**As a** developer merging work from multiple agents
**I want** a `hive merge` command that rebases agent branches onto main in a controlled order
**So that** I can avoid unnecessary rebase conflicts caused by random merge ordering

#### Acceptance Criteria
- [ ] `hive merge [agents...]` is registered in `src/index.ts` and implemented in `src/commands/merge.ts`
- [ ] No args: merges all agents that have commits ahead of main, in alphabetical order
- [ ] With args: merges only specified agents in the order given
- [ ] Pre-merge check: verifies worktree is clean, counts commits ahead of main, skips agents with no new commits
- [ ] Merge sequence per agent: fetch → rebase onto main → push to main (fast-forward)
- [ ] On rebase conflict: stops, prints conflict files, offers options (abort this agent, open shell in worktree, abort entire sequence)
- [ ] `--dry-run` shows what would be merged without doing it
- [ ] `--continue` resumes after a manually resolved conflict
- [ ] Summary printed at the end: per-agent result (commits merged, skipped, or failed)

### US-003: Shell completions for bash, zsh, and fish

**From:** `prd-features.md` US-004

**As a** power user who lives in the terminal
**I want** `hive <Tab>` to show available commands and `hive dispatch <Tab>` to show agent names
**So that** I don't have to check `--help` for every command

#### Acceptance Criteria
- [ ] `hive completion <shell>` outputs a completion script for bash, zsh, or fish
- [ ] Static completions include all command names and global flags (`--cwd`, `--version`, `--help`)
- [ ] Dynamic completions for `hive launch`, `hive kill`, `hive dispatch`, and `hive tail` resolve agent names from config at completion time
- [ ] Installation instructions are printed by `hive completion --help`
- [ ] Completions are included in the installation script (US-004) setup flow

### US-004: Installation script

**From:** `prd-features.md` US-005

**As a** developer who wants to install AgentHive without Node.js
**I want** a `curl | bash` one-liner that downloads and installs the standalone binary
**So that** I can set up AgentHive on any Linux or macOS machine in one command

#### Acceptance Criteria
- [ ] `scripts/install.sh` is a POSIX-compatible shell script
- [ ] Detects OS (Linux, macOS) and architecture (x64, arm64)
- [ ] Downloads the pre-built binary from GitHub Releases for the detected platform
- [ ] Verifies SHA256 checksum (downloads `.sha256` sidecar file)
- [ ] Installs to `~/.local/bin/hive` by default, or `/usr/local/bin/hive` with `--global`
- [ ] Warns and prints PATH instructions if `~/.local/bin` is not in PATH
- [ ] `--version <tag>` flag installs a specific release
- [ ] `--uninstall` flag removes the binary
- [ ] Falls back to `wget` if `curl` is not available
- [ ] Existing installation prompts for overwrite confirmation

### US-005: Claude Code transcript viewer

**From:** `prd-features.md` US-006

**As a** developer who needs to understand what an agent actually did (not just what it said in chat)
**I want** a `hive logs` command that parses Claude Code's JSONL transcripts
**So that** I can see every tool call, code edit, and thinking block across agents in a unified timeline

#### Acceptance Criteria
- [ ] `src/core/transcripts.ts` implements: `findTranscriptDir(worktreePath)` scans `~/.claude/projects/` for matching directories, `listSessions(dir)` returns session metadata, `parseTranscript(path)` extracts events from JSONL
- [ ] `hive logs [agent]` shows recent transcript events with tool icons: `$` Bash, `r` Read, `w` Write, `e` Edit, `/` Grep, `*` Glob, `>>` Task
- [ ] `hive logs --list` lists all sessions per agent with start time, duration, and event count
- [ ] `hive logs --session <id>` shows a specific session's full transcript
- [ ] `hive logs --follow` live-tails the active transcript file using `chokidar`
- [ ] Events are color-coded by agent using the same palette as `hive tail`

### US-006: Cost reporting

**From:** `prd-features.md` US-007

**As a** developer running multiple agents over several days
**I want** a `hive cost` command that shows per-agent and aggregate spend with daily trends
**So that** I can track costs and avoid budget surprises

#### Acceptance Criteria
- [ ] `src/core/budget.ts` gains a cost log: `.hive/state/<agent>.cost-log` — append-only TSV with timestamp, task summary, amount, success
- [ ] `logTaskCost()` is called from `polling.ts` after each task instead of just `recordSpending()`
- [ ] `hive cost` shows a summary table: per-agent today and this-week spend with task counts
- [ ] `hive cost --agent <name>` shows task-by-task breakdown for one agent
- [ ] `hive cost --since <date>` filters by date range
- [ ] `hive cost --json` outputs machine-readable data
- [ ] Output includes a note: "Costs are estimated based on per-task budget caps"

### US-007: Session recovery after crash

**From:** `prd-features.md` US-008

**As a** developer whose terminal disconnected or machine rebooted
**I want** `hive resume` to detect orphaned state and relaunch dead agents
**So that** I can recover a session without manually debugging lock files and tmux windows

#### Acceptance Criteria
- [ ] `hive resume` detects the current state for each agent: tmux window alive?, lock PID alive?, stale lock?
- [ ] Builds and displays a recovery plan: skip running agents, clean stale locks and relaunch, launch agents with no state
- [ ] Prompts for confirmation before executing (or `--yes` to skip)
- [ ] Reuses the existing tmux session if it exists — adds windows rather than creating a new session
- [ ] `--force` flag restarts even running agents

### US-008: Agent health watchdog

**From:** `prd-features.md` US-009

**As a** developer running a long session
**I want** automatic detection of stuck or dead agents
**So that** I learn about problems from a notification instead of discovering them hours later

#### Acceptance Criteria
- [ ] Lock file format extended to include a heartbeat timestamp: `<PID>\n<ISO timestamp>`
- [ ] Polling loop updates heartbeat at the start of each cycle
- [ ] `checkAgentHealth()` in `src/core/watchdog.ts` returns: `healthy`, `unresponsive` (heartbeat older than `poll × 3`), `stuck` (checkpoint not advancing while PID alive), or `dead` (PID not alive, lock not cleaned)
- [ ] `hive status` shows health indicator alongside status: `RUNNING (healthy)` vs `RUNNING (stuck?)`
- [ ] Optional `--watch` flag on `hive status` runs the watchdog in a loop and sends desktop notifications on unhealthy state changes

### US-009: Configuration profiles

**From:** `prd-features.md` US-010 (partial)

**As a** developer starting different types of projects
**I want** `hive init --profile security-audit` to set up an opinionated full config
**So that** I get appropriate agents, budgets, hooks, and poll intervals for my workflow without manual tuning

#### Acceptance Criteria
- [ ] `templates/profiles/` directory contains complete config templates: `fullstack.yaml`, `security-audit.yaml`, `refactor.yaml`, `solo.yaml`, `review.yaml`
- [ ] Each profile sets agents, defaults (budget, poll, model), and hooks — not just agent names
- [ ] `hive init --preset <name>` loads the full profile as the base config (not just the agent list as it does today)
- [ ] `hive init --list-presets` shows available profiles with descriptions
- [ ] The existing `fullstack`/`backend-only`/`minimal` presets are migrated to the profile format

### US-010: Post-init agent management

**From:** `prd-features.md` US-011

**As a** developer who needs to add or remove an agent after initialization
**I want** `hive add <name>` and `hive remove <name>` commands
**So that** I can modify my agent setup without manually editing config and running git worktree commands

#### Acceptance Criteria
- [ ] `hive add <name> [--agent <file>] [--poll N] [--budget N] [--daily-max N]` adds an agent to config, creates worktree and branch, adds role mapping, and generates `.claude/settings.json` in the worktree
- [ ] Validates name isn't already in config; validates no ID collision
- [ ] `hive remove <name>` refuses if agent is running unless `--force` is passed
- [ ] Remove: kills tmux window, releases lock, removes worktree, optionally deletes branch (`--delete-branch`), removes from config and role map
- [ ] Config YAML is modified using the `yaml` package with comment preservation where possible
- [ ] After `hive add` is implemented, the error message in `init.ts:82` and `worktree.ts:25` are updated to reference the real command (resolves US-001 in this PRD)

## Quality Gates

These commands must pass for every user story:
- `npm run typecheck` - Type checking
- `npm test` - All vitest tests pass
- `npm run build` - TypeScript compilation succeeds
