# Terminal UI

## Overview

An interactive terminal UI (TUI) for AgentHive that provides real-time monitoring, dispatching, and control of multi-agent orchestration sessions. The TUI is an additive layer — all functionality remains available via individual CLI commands. It consolidates `hive status`, `hive tail`, and `hive dispatch` into a single persistent dashboard. Target framework: ink (React for CLIs) due to TypeScript compatibility, component model, and flexbox layout.

## User Stories

### US-001: TUI framework scaffold and base layout

**As a** developer managing multiple agents
**I want** a single `hive ui` command that opens a persistent terminal dashboard
**So that** I can monitor all agents, read chat messages, and dispatch work without switching between multiple CLI commands

#### Acceptance Criteria
- [ ] `hive ui` (or `hive tui`) command is registered in `src/index.ts` and launches the TUI
- [ ] TUI framework (ink + react) is installed and TypeScript JSX is configured
- [ ] Base layout renders three panels: status (left), chat (right), and input bar (bottom)
- [ ] A header bar shows the session name, running agent count, and total daily spend
- [ ] Pressing `q` or `Ctrl+C` exits the TUI without killing running agents
- [ ] The TUI code lives in `src/tui/` to keep it isolated from the CLI command code
- [ ] All existing CLI commands continue to work independently when the TUI is not running

### US-002: Live agent status panel

**As a** developer monitoring a running session
**I want** a continuously updated status table showing each agent's state, spend, and last activity
**So that** I can see at a glance which agents are working, idle, or stuck

#### Acceptance Criteria
- [ ] Status panel polls agent state every 2-3 seconds using existing `getLockStatus()` and `getDailySpend()` functions
- [ ] Each agent row shows: name, status (RUNNING/STOPPED/STALE), daily spend with color coding (green < 50%, yellow 50-80%, red > 80%), and truncated last chat message
- [ ] Summary line shows `N/M agents running · $X.XX total spend`
- [ ] Arrow keys or `j`/`k` highlight an agent row for detail view navigation
- [ ] Status data fetching is extracted into a reusable hook or module, not inlined into the component

### US-003: Live chat panel

**As a** developer following agent coordination
**I want** a scrolling chat view with color-coded messages beside the status panel
**So that** I can see what agents are communicating without running a separate `hive tail -f`

#### Acceptance Criteria
- [ ] Chat panel renders messages with per-role color coding and per-type styling matching `src/commands/tail.ts` palette
- [ ] New messages appear automatically via file watching (using `chokidar` or `fs.watchFile`)
- [ ] Auto-scrolls to bottom on new messages; pauses auto-scroll when user scrolls up
- [ ] Press `f` to toggle agent filter, `t` to filter by message type
- [ ] New messages briefly highlight (bold for 2 seconds) to draw attention
- [ ] Color palette and type styles are extracted from `tail.ts` into a shared module (e.g., `src/core/colors.ts`)

### US-004: Dispatch input bar

**As a** developer who needs to send a task to an agent
**I want** an inline input field in the TUI for dispatching messages
**So that** I can assign work without leaving the dashboard or opening another terminal

#### Acceptance Criteria
- [ ] Input bar at the bottom accepts `<target> <message>` format (same as `hive dispatch` positional args)
- [ ] Tab-completion cycles through available agent names from config
- [ ] Target is validated against config before sending; invalid targets show inline error
- [ ] After sending: message appears immediately in the chat panel with confirmation
- [ ] Prefix commands supported: `/from PM sre fix the timeout` sets sender role; `/warn all deployment soon` sets message type
- [ ] Up-arrow recalls last 20 dispatched messages
- [ ] `Esc` cancels input and returns focus to panels; `d` from any panel focuses the input bar

### US-005: Agent detail view

**As a** developer investigating a specific agent's behavior
**I want** to drill into an agent and see its recent activity, git status, and errors
**So that** I can diagnose issues without SSHing into the tmux window

#### Acceptance Criteria
- [ ] Pressing `Enter` on a selected agent in the status panel expands the right panel to show agent detail
- [ ] Detail view shows: status, PID, branch name, commits ahead/behind main, daily spend with percentage
- [ ] Last 10 chat messages from this agent's role are displayed
- [ ] Action shortcuts: `k` to kill, `r` to relaunch, `m` to merge (rebase+push), `Esc` to go back
- [ ] Git information is fetched via `git log --oneline` in the agent's worktree directory

### US-006: Keyboard navigation system

**As a** power user
**I want** vim-style keyboard navigation throughout the TUI
**So that** I can control everything without reaching for a mouse

#### Acceptance Criteria
- [ ] Global keys: `q`/`Ctrl+C` quit, `Tab` cycles panels, `1`/`2`/`3` jump to panel, `d` focuses dispatch, `?` shows help overlay
- [ ] Status panel: `j`/`k` or arrows select agent, `Enter` opens detail, `K` kills agent, `L` launches agent
- [ ] Chat panel: `j`/`k` or arrows scroll, `G` jumps to bottom, `g` to top, `f` toggles filter, `/` searches
- [ ] All keybindings are documented in the `?` help overlay
- [ ] Keybindings are defined in a single `src/tui/keybindings.ts` file for easy customization

### US-007: Cost overview bar

**As a** developer running multiple agents over a full day
**I want** a persistent cost summary bar showing total spend across all agents
**So that** I have instant cost awareness without calculating per-agent numbers mentally

#### Acceptance Criteria
- [ ] A 1-2 line bar between the header and main panels shows: total today's spend, total daily max, progress bar, and per-agent mini-breakdown
- [ ] Progress bar uses block characters (`█` filled, `░` empty) with color: green < 50%, yellow 50-80%, red > 80%
- [ ] Updates every 5 seconds by reading budget files
- [ ] Shows ⚠ indicator if any agent has exceeded 90% of daily budget

## Quality Gates

These commands must pass for every user story:
- `npm run typecheck` - Type checking
- `npm test` - All vitest tests pass
- `npm run build` - TypeScript compilation succeeds
