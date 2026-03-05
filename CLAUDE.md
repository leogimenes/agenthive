# AgentHive

Multi-agent orchestrator for Claude Code. Turns any git repository into a coordinated workspace where specialized AI agents run in parallel with budget control, safety hooks, and unified observability.

## Stack

- **Language:** TypeScript (Node.js ≥ 20, ESM)
- **CLI framework:** commander
- **Config:** YAML (.hive/config.yaml), parsed with `yaml` package
- **Testing:** vitest (67 tests across 4 suites)
- **Distribution:** Standalone binary via Bun compile, or `npm install -g`

## Project Structure

```text
src/
├── index.ts              # CLI entry point (commander setup)
├── commands/             # One file per CLI subcommand
│   ├── init.ts           # hive init — scaffold .hive/, worktrees, hooks
│   ├── launch.ts         # hive launch — start agent daemons in tmux
│   ├── kill.ts           # hive kill — stop agents and clean locks
│   ├── status.ts         # hive status — agent table with spend + activity
│   ├── dispatch.ts       # hive dispatch — send messages to agents via chat
│   ├── tail.ts           # hive tail — color-coded chat message viewer
│   └── config.ts         # hive config — show resolved configuration
├── core/                 # Shared business logic
│   ├── config.ts         # YAML config loader + validation + resolution
│   ├── worktree.ts       # Git worktree CRUD + sync + rebase/push
│   ├── chat.ts           # Chat file protocol (read/write/filter/checkpoint)
│   ├── polling.ts        # Agent polling daemon (AgentLoop class)
│   ├── budget.ts         # Per-task + daily budget tracking
│   └── lock.ts           # PID-based file locking + checkpoints
├── hooks/                # Shell hooks shipped with AgentHive
│   ├── destructive-guard.sh
│   └── check-chat.sh
└── types/
    └── config.ts         # TypeScript interfaces for config schema

tests/core/              # Unit tests for core modules
scripts/build-binary.sh  # Standalone binary builder (Bun compile)
```

## Commands

```bash
# Development
npm run dev -- <command>    # Run via tsx (hot reload)
npm run check              # TypeScript check + all tests
npm test                   # Run vitest
npm run typecheck          # tsc --noEmit

# Build
npm run build              # Compile TypeScript to dist/
npm run build:binary       # Standalone binary → bin/hive (requires Bun)

# CLI
hive init                  # Initialize .hive/ in current git repo
hive launch [agents...]    # Start agent daemons in tmux
hive kill [agents...]      # Stop agents
hive status [--json]       # Show agent state table
hive dispatch <target> <msg>  # Send message to agent via chat
hive tail [agent] [-f]     # View/follow chat messages
hive config [--agents]     # Show resolved config
```

## Key Design Decisions

1. **Git worktrees** for workspace isolation (not separate clones)
2. **Append-only chat file** as the coordination bus (not sockets/IPC)
3. **Claude Code coupled** — hooks, transcripts, and agent invocation are all Claude Code specific
4. **Rebase + push** merge strategy — agents rebase onto main after task completion
5. **Bun compile** for standalone binary distribution

## Spec and Tasks

- Product spec: `docs/SPEC.md`
- Engineering tasks (v0.1 — complete): `docs/tasks/TASKS.md`
- Bug fixes: `docs/tasks/TASKS-BUGS.md`
- Terminal UI: `docs/tasks/TASKS-UI.md`
- Agent templates: `docs/tasks/TASKS-TEMPLATES.md`
- Feature improvements: `docs/tasks/TASKS-FEATURES.md`
- Planning & task tracking: `docs/tasks/TASKS-PLANNING.md`

## PRDs (ralph-tui format)

- Bug fixes: `tasks/prd-bug-fixes.md`
- Terminal UI: `tasks/prd-terminal-ui.md`
- Agent templates: `tasks/prd-agent-templates.md`
- Feature improvements: `tasks/prd-features.md`
- Planning & task tracking: `tasks/prd-planning.md`
