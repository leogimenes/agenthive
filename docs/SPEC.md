# AgentHive — Product Specification

## Problem

Running multiple Claude Code agents in parallel on a single codebase requires solving five problems that no existing tool addresses together:

1. **Workspace isolation** — Two agents editing the same file simultaneously causes corruption. Today users manually `git clone` the repo N times. Wasteful (disk, network) and error-prone.
2. **Coordination** — Agents need to know what other agents are doing. There's no built-in mechanism for inter-agent communication in Claude Code.
3. **Cost control** — Without budget caps, a misbehaving agent can burn through API credits. There's no per-agent or daily budget enforcement.
4. **Failure handling** — Agents fail silently. No backoff, no escalation, no retry budget. A stuck agent wastes polling cycles and money.
5. **Observability** — With N agents running in parallel, there's no unified view of what's happening. Each agent's transcript is buried in `~/.claude/projects/`.

**Who is affected:** Developers who use Claude Code for complex projects and want to parallelize work across specialized roles (SRE, frontend, backend, QA, security, etc.).

**Current workaround:** ~400 lines of hand-rolled bash scripts per project (polling daemon, tmux launcher, chat file protocol, budget tracking, transcript tailing). This is what AgentHive extracts and generalizes.

## Proposed Solution

A CLI tool (`hive`) that turns any git repository into a multi-agent Claude Code workspace. One command to initialize, one command to launch, built-in coordination and cost control.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  User's Git Repository                              │
│                                                     │
│  .hive/                                             │
│  ├── config.yaml          ← Agent definitions       │
│  ├── chat.md              ← Coordination log        │
│  ├── hooks/               ← Safety + coordination   │
│  ├── state/               ← Locks, checkpoints      │
│  └── worktrees/           ← Git worktrees           │
│      ├── sre/             ← agent/sre branch        │
│      ├── frontend/        ← agent/frontend branch   │
│      └── qa/              ← agent/qa branch         │
│                                                     │
│  .claude/agents/          ← Agent prompt definitions │
│  .claude/settings.json    ← Claude Code config      │
└─────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────┐
│  hive launch                                        │
│                                                     │
│  tmux session "hive"                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ SRE loop │ │ FE loop  │ │ QA loop  │  ...       │
│  │ polls    │ │ polls    │ │ polls    │            │
│  │ chat.md  │ │ chat.md  │ │ chat.md  │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│       │             │            │                  │
│       ▼             ▼            ▼                  │
│  claude -p      claude -p    claude -p              │
│  --agent sre    --agent fe   --agent qa             │
│  (in worktree)  (in worktree)(in worktree)          │
└─────────────────────────────────────────────────────┘
```

### Core Concepts

**Worktrees, not clones.** Each agent gets a git worktree (`.hive/worktrees/<name>/`) on its own branch (`agent/<name>`). Shared git object store means minimal disk overhead. After task completion, the agent rebases onto `main` and pushes.

**Chat-based coordination.** A single append-only file (`.hive/chat.md`) serves as the message bus. Agents read it before each task, write to it after completion. The protocol is enforced by format, not by code — agents post `[ROLE] TYPE: message` lines.

**Budget as a first-class concept.** Per-task caps (`--max-budget-usd`) prevent a single invocation from spiraling. Daily caps prevent aggregate overspend. When a daily cap is hit, the agent sleeps and logs why.

**Hooks for safety and coordination.** AgentHive ships two generic hooks:
- `destructive-guard.sh` — blocks `rm -rf`, `git reset --hard`, `DROP TABLE`, etc.
- `check-chat.sh` — injects chat messages into Claude's context on every prompt and after commits.

Users can add project-specific hooks (typecheck, lint, test) following the same pattern.

**Observability via transcript tailing.** `hive tail` provides a unified, color-coded timeline across all agent transcripts. It parses Claude Code's JSONL session files and merges them chronologically.

## CLI Commands

### `hive init`

Initializes a `.hive/` directory in the current git repository.

**Behavior:**
1. Verify current directory is a git repo.
2. Create `.hive/` directory structure.
3. Create `.hive/config.yaml` from template (interactive: ask which agents to create, or accept a preset).
4. For each agent in config: `git worktree add .hive/worktrees/<name> -b agent/<name>`.
5. Copy generic hooks into `.hive/hooks/`.
6. Set up `.claude/agents/` with agent definitions (if templates are provided).
7. Add `.hive/worktrees/` and `.hive/state/` to `.gitignore`.

**Flags:**
- `--preset <name>` — Use a predefined agent set (e.g., `fullstack`, `backend-only`).
- `--agents <list>` — Comma-separated agent names to create.
- `--yes` — Skip interactive prompts, use defaults.

### `hive launch [agents...]`

Starts agent polling daemons in a tmux session.

**Behavior:**
1. Read `.hive/config.yaml`.
2. For each agent (or specified subset): start `agent-loop` in a tmux window.
3. Each loop polls `.hive/chat.md` for `REQUEST @ROLE` messages.
4. When work is found: run `claude -p --agent <name>` in the agent's worktree.
5. After completion: rebase onto `main`, push, record spending.

**Flags:**
- `--dry-run` — Show what would be launched without starting anything.
- `--attach` — Attach to the tmux session after launching.

### `hive kill [agents...]`

Stops agent daemons.

**Behavior:**
- No args: kill the entire tmux session.
- With args: kill specific agent windows.

### `hive status`

Shows the state of all agents.

**Output:**
```
AGENT        STATUS              DAILY SPEND   LAST ACTIVITY
sre          RUNNING (PID 1234)  $4.00/$20.00  2m ago — DONE: BE-09
frontend     RUNNING (PID 1235)  $2.00/$20.00  5m ago — idle
qa           STOPPED             $0.00/$20.00  —
```

### `hive dispatch <role> <message>`

Appends a `REQUEST` to the chat file.

**Behavior:**
```bash
hive dispatch sre "implement connection pooling for Prisma"
# Appends: [USER] REQUEST @SRE: implement connection pooling for Prisma
```

**Flags:**
- `--from <role>` — Override the sender role (default: `USER`).

### `hive tail [workspace]`

Unified agent activity timeline.

**Behavior:**
- No args: tail all agents, interleaved chronologically.
- With workspace: filter to one agent.

**Flags:**
- `--last <N>` — Show last N events (default: 40).
- `--follow` — Live follow mode (like `tail -f`).
- `--list` — List all sessions per workspace.

### `hive config`

Shows the resolved configuration.

**Behavior:** Reads `.hive/config.yaml`, resolves defaults, and prints the effective config.

## Configuration Schema

File: `.hive/config.yaml`

```yaml
# AgentHive configuration
# Docs: https://github.com/<org>/agenthive

session: my-project           # tmux session name (default: directory name)

defaults:
  poll: 60                    # seconds between chat file checks
  budget: 2.00                # max USD per task invocation
  daily_max: 20.00            # max USD per agent per day
  model: sonnet               # Claude model (passed to claude -p)
  skip_permissions: true      # --dangerously-skip-permissions

agents:
  sre:
    description: "Site Reliability Engineer"
    agent: sre                # maps to .claude/agents/sre.md
    poll: 60
    budget: 2.00
    daily_max: 20.00

  frontend:
    description: "Frontend Developer"
    agent: frontend
    poll: 90
    budget: 2.00
    daily_max: 20.00

  backend:
    description: "Backend Engineer"
    agent: backend-debugger
    poll: 60
    budget: 3.00
    daily_max: 25.00

  qa:
    description: "Quality Analyst"
    agent: qa
    poll: 90
    budget: 2.00
    daily_max: 20.00

chat:
  file: chat.md               # relative to .hive/
  role_map:                    # agent name → chat role tag
    sre: SRE
    frontend: FRONTEND
    backend: DEBUGGER
    qa: QA

hooks:
  safety:
    - destructive-guard       # ships with AgentHive
  coordination:
    - check-chat              # ships with AgentHive
  # Users can add project-specific hooks:
  # custom:
  #   - path/to/my-hook.sh
```

## Acceptance Criteria

### hive init
- Given a git repo with no `.hive/`, when `hive init` runs, then `.hive/` is created with `config.yaml`, `chat.md`, `hooks/`, and one worktree per agent in config.
- Given a directory that is not a git repo, when `hive init` runs, then it exits with error: "Not a git repository."
- Given `.hive/` already exists, when `hive init` runs, then it exits with error: "Already initialized. Use `hive add` to add agents."
- Each worktree is on a branch `agent/<name>` based on current HEAD.

### hive launch
- Given a valid config, when `hive launch` runs, then a tmux session is created with one window per agent.
- Given `hive launch sre frontend`, then only those two agents are started.
- Given an agent is already running (lock file with live PID), then skip it with a warning.
- Given a stale lock file (PID not running), then clean it up and proceed.

### hive dispatch
- Given `hive dispatch sre "fix timeout"`, then `.hive/chat.md` gains line: `[USER] REQUEST @SRE: fix timeout`.
- Given an unknown role, then exit with error listing valid roles from config.

### hive tail
- Given agents have run at least one session, then `hive tail` shows interleaved events from all agents.
- Given `--follow`, then new events appear in real time.

### Budget enforcement
- Given `budget: 2.00` and a task that exceeds it, then Claude CLI's `--max-budget-usd` stops the invocation.
- Given daily spend reaches `daily_max`, then the agent loop sleeps for 1 hour and logs the reason.
- Given a new UTC day, then daily spend resets to 0.

### Worktree management
- Given `hive init` with 3 agents, then 3 worktrees exist under `.hive/worktrees/`.
- Given a task completes, then the agent's branch is rebased onto `main` and pushed.
- Given a rebase conflict, then the agent posts a `BLOCKER` to chat and does not push.

## Out of Scope (v0.1)

- **Agent definition templates/generators** — Users write their own `.claude/agents/*.md` files. AgentHive does not generate role prompts.
- **Code assistant agnosticism** — v0.1 is Claude Code only. No adapter layer for other tools.
- **Web UI / dashboard** — CLI and tmux only. TUI is a v0.2 goal.
- **Remote/cloud execution** — All agents run locally.
- **Multi-repo support** — One repo per hive. Monorepo-friendly via worktrees, but not multi-repo orchestration.
- **Agent-to-agent direct messaging** — All coordination goes through the chat file. No direct sockets or IPC.
- **Automatic conflict resolution** — If a rebase fails, the agent reports a BLOCKER. A human resolves it.

## Open Questions (to resolve during implementation)

1. **Hook installation in worktrees:** Each worktree needs `.claude/settings.json` pointing to hooks. Should `hive init` create per-worktree settings, or symlink to a shared config?
2. **Chat file location:** `.hive/chat.md` is inside `.hive/` which is gitignored (state/ and worktrees/ are, but chat.md could be tracked). Should the chat file be committed as an audit trail, or stay ephemeral?
3. **Bun vs Node for binary compilation:** Bun's `bun build --compile` produces a single binary trivially. Node SEA requires more setup. Both work. Decide during build task.
