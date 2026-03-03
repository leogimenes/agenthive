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
