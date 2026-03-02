# Bug Fixes

## Overview

Critical bugs discovered during codebase review that affect safety, correctness, and usability of AgentHive v0.1. The most severe issues are that safety hooks (destructive-guard, check-chat) are installed but never wired to Claude Code, and that tmux commands are vulnerable to shell injection from user-controlled config values.

## User Stories

### US-001: Hook registration with Claude Code

**As a** developer using AgentHive
**I want** safety hooks to be automatically registered with Claude Code in each agent worktree
**So that** the destructive-guard and check-chat hooks actually protect my codebase when agents run with `--dangerously-skip-permissions`

#### Acceptance Criteria
- [ ] `hive init` creates `.claude/settings.json` inside each worktree (e.g., `.hive/worktrees/sre/.claude/settings.json`)
- [ ] The settings file maps hooks from `config.hooks.safety` to `PreToolUse` events and hooks from `config.hooks.coordination` to `UserPromptSubmit` and `PostToolUse` events
- [ ] Hook paths are absolute so they resolve correctly from any worktree working directory
- [ ] Custom hooks defined in `config.hooks.custom` are also wired into the settings file
- [ ] Verify by running `claude --agent sre -p "run rm -rf /"` in a worktree and confirming the destructive-guard hook blocks it

### US-002: Hook files shipped in compiled builds

**As a** developer installing AgentHive via `npm install -g`
**I want** hook shell scripts to be included in the compiled distribution
**So that** `hive init` can copy working hooks instead of silently installing nothing

#### Acceptance Criteria
- [ ] After `npm run build`, `dist/hooks/destructive-guard.sh` and `dist/hooks/check-chat.sh` exist
- [ ] A `postbuild` script in `package.json` copies `src/hooks/*.sh` to `dist/hooks/`
- [ ] `copyHooks()` in `src/commands/init.ts` logs a warning when a hook source file is not found at the resolved path instead of silently skipping
- [ ] Both `npm run build && node dist/index.js init` and `npm run build:binary && bin/hive init` result in hooks being copied to `.hive/hooks/`
- [ ] Alternatively, hook scripts are embedded as string constants in a TypeScript module and written via `writeFileSync` instead of `copyFileSync`

### US-003: Shell injection prevention in tmux commands

**As a** developer with a custom session name in config.yaml
**I want** tmux commands to be safe from shell injection
**So that** a session name or agent name containing shell metacharacters cannot execute arbitrary commands

#### Acceptance Criteria
- [ ] All `execSync` calls with tmux commands in `src/commands/launch.ts` and `src/commands/kill.ts` are replaced with `execFileSync('tmux', [...args])` which bypasses shell interpretation
- [ ] Specifically: `launch.ts` lines 124, 157, 162, 187, 236 and `kill.ts` lines 41, 76, 104
- [ ] `buildLoopCommand()` in `launch.ts` returns an args array instead of a shell string, or paths with spaces are properly quoted
- [ ] A `tmux(args: string[]): void` helper is extracted to reduce duplication across both files
- [ ] Test with a config containing `session: "test session"` (space in name) — launch and kill work correctly

### US-004: Honest error message when .hive/ already exists

**As a** developer running `hive init` in an already-initialized repo
**I want** an accurate error message that tells me what I can actually do
**So that** I'm not directed to a nonexistent `hive add` command

#### Acceptance Criteria
- [ ] The error message in `src/commands/init.ts:82` no longer references `hive add`
- [ ] The replacement message tells the user to edit `.hive/config.yaml` manually and create worktrees with `git worktree add`, or references `hive add` only after that command is implemented (see `prd-features.md` US-012)
- [ ] If `hive add` is implemented later, this message is updated to reference the real command

### US-005: Working `--raw` flag on `hive config`

**As a** developer debugging config parsing issues
**I want** `hive config --raw` to show the unprocessed config.yaml contents
**So that** I can compare raw input vs resolved output to identify default-merging issues

#### Acceptance Criteria
- [ ] `hive config --raw` reads and prints `.hive/config.yaml` as-is without resolving defaults or computing derived fields
- [ ] `hive config --raw --json` parses the raw YAML and outputs it as JSON without default merging
- [ ] `hive config --raw --agents` is rejected with a warning that `--raw` and `--agents` are mutually exclusive
- [ ] Import `readFileSync` from `node:fs` in `src/commands/config.ts`

### US-006: Model field in generated config

**As a** developer running `hive init` for the first time
**I want** the generated `config.yaml` to include `model: sonnet` in the defaults section
**So that** `hive config` shows the correct model and I can see what model my agents will use without checking source code

#### Acceptance Criteria
- [ ] `buildConfig()` in `src/commands/init.ts` includes `model: 'sonnet'` in the `defaults` object
- [ ] After `hive init`, `.hive/config.yaml` contains a `model` field under `defaults`
- [ ] `hive config` no longer shows `model: undefined` for the defaults section

## Quality Gates

These commands must pass for every user story:
- `npm run typecheck` - Type checking
- `npm test` - All vitest tests pass
- `npm run build` - TypeScript compilation succeeds
