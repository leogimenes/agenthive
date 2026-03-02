# AgentHive — Terminal UI

> Interactive TUI for real-time multi-agent monitoring, dispatching, and control.
> Prefix convention: `UI-` (all tasks are frontend/CLI — one engineer can own the full TUI).
>
> **Dependency:** All BUG- tasks in TASKS-BUGS.md should be resolved first. The TUI builds on top of existing command logic.

---

## UI-01: TUI framework selection and app scaffold (Tier 2)

**File:** new `src/tui/` directory
**Also:** `package.json` (new dependency), `src/index.ts` (new command registration)
**Problem:** AgentHive is CLI-only. Power users running 5+ agents need a persistent dashboard — not `hive status` in a loop. A terminal UI provides real-time monitoring without leaving the terminal or managing tmux windows manually.
**Fix:**
1. Evaluate TUI frameworks for Node.js/TypeScript:
   - **ink** (React for CLIs) — mature, component model, hooks, flexbox layout. Used by Vercel, Gatsby, Prisma CLIs. Fits the existing TypeScript stack. Recommended.
   - **blessed / blessed-contrib** — powerful but unmaintained, callback-heavy API.
   - **terminal-kit** — lower-level, more control, less ergonomic.
   - **Raw ANSI** — no dependency, full control, high effort.
2. Install the chosen framework (e.g., `npm install ink react`). Add `@types/react` as dev dependency.
3. Configure TypeScript for JSX if using ink (`"jsx": "react-jsx"` in tsconfig or separate tsconfig for TUI).
4. Create the base layout scaffold in `src/tui/App.tsx`:
   ```
   ┌─────────────────────────────────────────────────────────┐
   │  🐝 AgentHive — my-project              3/5 running    │
   ├──────────────────────────┬──────────────────────────────┤
   │  AGENT STATUS            │  CHAT                        │
   │                          │                              │
   │  sre    ● RUNNING $4/20  │  [PM] REQUEST @SRE: ...      │
   │  front  ● RUNNING $2/20  │  [SRE] DONE: BE-09 ...      │
   │  back   ○ STOPPED $0/20  │  [FE] BLOCKER: conflict...   │
   │  qa     ● RUNNING $1/20  │                              │
   │                          │                              │
   ├──────────────────────────┴──────────────────────────────┤
   │  > dispatch sre "implement connection pooling"          │
   └─────────────────────────────────────────────────────────┘
   ```
5. Register `hive ui` (or `hive tui`) command in `src/index.ts` that launches the TUI.
6. The TUI should be an optional entry point — all functionality must remain available via individual CLI commands.

---

## UI-02: Live agent status panel (Tier 2)

**File:** new `src/tui/panels/StatusPanel.tsx`
**Also:** `src/core/lock.ts`, `src/core/budget.ts`
**Problem:** `hive status` is a one-shot snapshot. Users need continuous visibility into which agents are running, their spend, and whether any locks are stale.
**Fix:**
1. Create a `StatusPanel` component that renders the agent status table.
2. Poll agent state every 2-3 seconds (configurable):
   - Lock status via `getLockStatus()` — RUNNING/STOPPED/STALE
   - Daily spend via `getDailySpend()` — color-coded by percentage
   - Last chat message from each role via `readMessages()` — truncated
3. Use color coding matching the existing CLI output:
   - Green: RUNNING, spend < 50%
   - Yellow: spend 50-80%, STALE_LOCK
   - Red: spend > 80%, BLOCKER
4. Show summary line: `N/M agents running · $X.XX total spend · session: name`
5. Highlight the currently selected agent (for detail view navigation).
6. Data fetching should be extracted into a shared hook (`useAgentStatus`) that both the panel and potential future web UI can consume.

---

## UI-03: Live chat panel (Tier 2)

**File:** new `src/tui/panels/ChatPanel.tsx`
**Also:** `src/core/chat.ts`
**Problem:** `hive tail -f` works but takes over the terminal. The TUI needs an integrated, auto-scrolling chat view alongside the status panel.
**Fix:**
1. Create a `ChatPanel` component that renders chat messages with color coding.
2. Reuse the existing color palette and type styles from `src/commands/tail.ts` (lines 16-44). Extract them into a shared `src/tui/theme.ts` or `src/core/colors.ts`.
3. Use `watchFile` (or `chokidar` — already a dependency) to detect new messages.
4. Auto-scroll to bottom on new messages. Allow scroll-up to review history (pause auto-scroll when user scrolls).
5. Support filtering: press `f` to toggle filter by agent, press `t` to filter by type.
6. Show message count and optional timestamp (see FEAT-01 in TASKS-FEATURES.md — timestamps must land first for this to be useful).
7. New messages should flash or highlight briefly (bold for 2s) to draw attention.

---

## UI-04: Dispatch input bar (Tier 2)

**File:** new `src/tui/panels/InputBar.tsx`
**Also:** `src/commands/dispatch.ts` (reuse validation logic)
**Problem:** To dispatch work, users must switch to another terminal and type `hive dispatch sre "..."`. The TUI should allow inline dispatching without context-switching.
**Fix:**
1. Create an `InputBar` component at the bottom of the TUI layout.
2. Input format: `<target> <message>` (same as `hive dispatch` positional args).
3. Tab-completion for agent names — cycle through available agents on Tab.
4. Validate target against config (reuse logic from `dispatch.ts:68-88`).
5. After sending: show confirmation inline, append to chat panel immediately.
6. Support `--from` and `--type` modifiers via prefix syntax:
   - `/from PM sre fix the timeout` → `[PM] REQUEST @SRE: fix the timeout`
   - `/warn all deployment in 5 minutes` → `[USER] WARN: deployment in 5 minutes`
7. Up-arrow for message history recall (last 20 dispatches).
8. Press `Esc` to cancel input and return focus to panels.

---

## UI-05: Agent detail view (Tier 3)

**File:** new `src/tui/panels/AgentDetail.tsx`
**Problem:** The status panel shows a summary. Power users need to drill into a specific agent to see: recent chat messages from that role, spend history, error/blocker history, worktree status (branch, ahead/behind main).
**Fix:**
1. When an agent is selected in the status panel (Enter or arrow keys), expand the right panel to show agent detail:
   ```
   ┌─ sre ─────────────────────────────────────────────────┐
   │  Status: RUNNING (PID 12345)                          │
   │  Branch: agent/sre (3 ahead of main)                  │
   │  Spend:  $4.00 / $20.00 (20%)                         │
   │  Idle:   12 cycles (12 min)                           │
   │                                                        │
   │  Recent activity:                                      │
   │  [SRE] DONE: BE-09 — Prisma timeout config            │
   │  [SRE] DONE: BE-08 — document reprocess endpoint      │
   │  [SRE] BLOCKER: rebase conflict on prisma.schema      │
   └────────────────────────────────────────────────────────┘
   ```
2. Show git status for the worktree: `git log --oneline agent/sre..origin/main` (how far behind), `git log --oneline origin/main..agent/sre` (how far ahead).
3. Show last 10 chat messages from this agent's role.
4. Show error count and last error timestamp.
5. Action shortcuts: `k` to kill this agent, `r` to relaunch, `m` to merge (rebase+push).

---

## UI-06: Keyboard shortcuts and navigation (Tier 3)

**File:** new `src/tui/keybindings.ts`
**Problem:** Power users expect keyboard-driven navigation. The TUI must be usable without a mouse.
**Fix:**
1. Define global keybindings:
   - `q` / `Ctrl+C` — quit TUI (agents keep running in tmux)
   - `Tab` — cycle focus between panels (Status → Chat → Input)
   - `1` / `2` / `3` — jump to panel by number
   - `d` — focus dispatch input bar
   - `s` — focus status panel
   - `c` — focus chat panel
   - `?` — show help overlay with all keybindings
2. Status panel navigation:
   - `j` / `k` or `↑` / `↓` — select agent
   - `Enter` — open agent detail view
   - `K` — kill selected agent
   - `L` — launch selected agent (if stopped)
3. Chat panel navigation:
   - `j` / `k` or `↑` / `↓` — scroll
   - `G` — jump to bottom (latest)
   - `g` — jump to top
   - `f` — toggle agent filter
   - `/` — search in chat messages
4. Store custom keybinding overrides in `~/.config/agenthive/keybindings.json` (optional, v2).

---

## UI-07: Cost overview bar (Tier 3)

**File:** new `src/tui/panels/CostBar.tsx`
**Also:** `src/core/budget.ts`
**Problem:** With multiple agents running, users need at-a-glance cost visibility. The status panel shows per-agent spend, but a summary bar gives instant total cost awareness.
**Fix:**
1. Add a thin bar (1-2 lines) between the header and the main panels:
   ```
   💰 Today: $8.42 / $100.00 (8.4%)  ████░░░░░░  │  sre: $4.00  front: $2.00  qa: $1.42  back: $1.00
   ```
2. Calculate total daily spend across all agents. Calculate total daily max.
3. Render a progress bar (block characters: `█` for filled, `░` for empty).
4. Color the bar: green < 50%, yellow 50-80%, red > 80%.
5. Update every 5 seconds (budget files are lightweight to read).
6. If any agent has exceeded 90% of daily budget, show a ⚠ indicator.

---

## Implementation Order

1. **UI-01** — Framework setup. Everything else depends on this.
2. **UI-02** + **UI-03** — Status panel and chat panel. These are the core value.
3. **UI-04** — Dispatch input. Makes the TUI self-contained.
4. **UI-06** — Keybindings. Polish the interaction model.
5. **UI-05** + **UI-07** — Detail view and cost bar. Nice-to-have depth.

**Note:** The TUI is additive — it does not replace any existing CLI command. All `hive status`, `hive tail`, `hive dispatch`, etc. continue to work independently.
