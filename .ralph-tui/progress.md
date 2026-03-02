# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

- **Shared colors module**: Color palette, role colors, and type styles are in `src/core/colors.ts`. Both CLI commands (tail.ts) and TUI components use this shared module for consistent styling.
- **TSX/JSX config**: tsconfig.json has `"jsx": "react-jsx"` for ink components. TSX files compile alongside regular TS files.
- **Ink component pattern**: TUI components are in `src/tui/components/`, hooks in `src/tui/hooks/`. The App.tsx orchestrates all panels with a `useInput` handler for keyboard navigation.
- **Import extensions**: All ESM imports use `.js` extensions even for `.tsx` files (NodeNext resolution requires this).
- **Plan module pattern**: Plan storage is `.hive/plan.json` with atomic writes (tmp + rename). Core logic in `src/core/plan.ts`, types in `src/types/plan.ts`, CLI in `src/commands/plan.ts`. Commander subcommands are registered on a parent command object.
- **Commander subcommand pattern**: Use `program.command('parent')` then chain `.command('child')` on the parent. Default action uses `.action()` on parent with options.

---

## 2026-03-02 - agenthive-ady
- Implemented full Terminal UI (TUI) for AgentHive using ink 6 + React 19
- All 7 user stories implemented:
  - US-001: TUI framework scaffold - `hive ui` / `hive tui` command, base 3-panel layout
  - US-002: Live agent status panel - polls every 3s, shows status/spend/activity per agent
  - US-003: Live chat panel - file watching via `watchFile`, auto-scroll, role/type filters
  - US-004: Dispatch input bar - `<target> <message>` format, tab-completion, /from /warn prefix commands, history
  - US-005: Agent detail view - git info, recent messages, spend breakdown for selected agent
  - US-006: Keyboard navigation - vim-style j/k, Tab cycle, 1/2/3 panel jump, ? help overlay
  - US-007: Cost overview bar - progress bar with color coding, per-agent breakdown, ⚠ warning
- Files created:
  - `src/core/colors.ts` - Shared color palette extracted from tail.ts
  - `src/tui/App.tsx` - Main TUI application component
  - `src/tui/keybindings.ts` - Keybinding definitions and help entries
  - `src/tui/hooks/useAgentStatus.ts` - Status polling hook
  - `src/tui/hooks/useChatMessages.ts` - Chat file watching hook
  - `src/tui/components/Header.tsx` - Session info header
  - `src/tui/components/CostBar.tsx` - Budget progress bar
  - `src/tui/components/StatusPanel.tsx` - Agent status table
  - `src/tui/components/ChatPanel.tsx` - Chat message viewer
  - `src/tui/components/InputBar.tsx` - Dispatch input field
  - `src/tui/components/AgentDetail.tsx` - Agent detail drill-down
  - `src/tui/components/HelpOverlay.tsx` - Keyboard shortcut overlay
  - `src/commands/ui.ts` - CLI command registration
- Files modified:
  - `src/index.ts` - Added registerUiCommand
  - `src/commands/tail.ts` - Replaced inline colors with shared colors module
  - `tsconfig.json` - Added `"jsx": "react-jsx"`
  - `package.json` - Added ink, react, @types/react dependencies
- **Learnings:**
  - Ink 6 uses React 19, works cleanly with TSX + NodeNext module resolution
  - `useInput` from ink is the unified keyboard handler — one handler covers all panel modes
  - `watchFile` with 1000ms interval is sufficient for live chat updates (same as tail.ts)
  - `useStdout().stdout.rows` provides terminal height for dynamic layout sizing
  - For ink components, color names (strings) work with `<Text color="cyan">` — no need for chalk in React components
---

## 2026-03-02 - agenthive-ady.1
- Verified US-001 (TUI framework scaffold and base layout) was already fully implemented in prior iteration
- All acceptance criteria met: `hive ui`/`hive tui` command, ink+react framework, 3-panel layout (status/chat/input), header bar, q/Ctrl+C exit, `src/tui/` isolation
- Quality gates: typecheck clean, 67/67 tests pass
- **Learnings:**
  - No additional work needed — bead closed immediately after verification
---

## 2026-03-02 - agenthive-hym
- Implemented full Planning and Task Tracking system (all 11 user stories)
- **US-001**: Plan data model — `PlanTask` and `Plan` interfaces in `src/types/plan.ts`, atomic JSON storage at `.hive/plan.json`
- **US-002**: Board view — `hive plan` kanban-style board with status columns, `--json`, `--compact`, `--filter` flags
- **US-003**: Task creation — `hive plan add <target> <title>` with ID generation, priority, deps, parent, labels, description
- **US-004**: Ready queue — `computeReadyTasks()` returns tasks sorted by priority with all deps done; `hive plan ready [agent]`
- **US-005**: Chat-driven transitions — `reconcilePlanWithChat()` auto-updates plan from DONE/BLOCKER messages; integrated into polling loop
- **US-006**: Bulk import/export — `hive plan import <file>` (YAML + Markdown); `hive plan export <file>` (YAML)
- **US-007**: Dependency graph — `hive plan graph` with `--focus <id>` and `--critical-path` flags
- **US-008**: Dispatch — `hive plan dispatch` sends ready tasks to agents via chat; `--agent`, `--id`, `--all`, `--dry-run`
- **US-009**: Task management — `hive plan update`, `hive plan remove`, `hive plan reset` with DAG validation
- **US-010**: Hierarchical grouping — parent-child relationships, computed parent status rollup, `hive plan tree`
- **US-011**: Analytics — `hive plan stats` with status breakdown, per-agent workload, critical path, cost estimate
- Files created:
  - `src/types/plan.ts` — Plan data model interfaces
  - `src/core/plan.ts` — Core plan logic (load/save, ready queue, DAG validation, chat reconciliation, critical path)
  - `src/commands/plan.ts` — All `hive plan` CLI subcommands
  - `tests/core/plan.test.ts` — 45 tests covering all core plan functions
- Files modified:
  - `src/index.ts` — Added registerPlanCommand
  - `src/core/polling.ts` — Integrated plan reconciliation and auto-dispatch into agent loop
- Quality gates: typecheck clean, 112/112 tests pass (45 new), build succeeds
- **Learnings:**
  - Commander subcommands: register child commands on parent command object, not program directly
  - Atomic file writes with tmp + rename prevent partial writes from concurrent agents
  - DAG cycle detection uses standard 3-color DFS (white/gray/black)
  - Plan reconciliation must happen before checking for manual REQUESTs in the polling loop
  - Bracketed task IDs in chat messages `[TASK-ID]` enable reliable matching between dispatch and completion
---

## 2026-03-02 - agenthive-hym.1
- Verified US-001 (Plan data model and storage) was already fully implemented in prior iteration (agenthive-hym)
- All acceptance criteria met: `PlanTask`/`Plan` interfaces in `src/types/plan.ts`, atomic JSON storage, sorted-by-ID writes, all 8 core functions exported from `src/core/plan.ts`, `generateId()` format, `validateDAG()` cycle detection, optional plan file
- Quality gates: typecheck clean, 112/112 tests pass (45 plan tests)
- **Learnings:**
  - No additional work needed — bead closed immediately after verification
---

## 2026-03-02 - agenthive-07s.1
- Implemented US-001: Chat message timestamps — every chat message now includes an ISO 8601 timestamp
- New wire format: `[ROLE] TYPE <ISO8601>: body` (backward-compatible with legacy `[ROLE] TYPE: body`)
- Files modified:
  - `src/types/config.ts` — Added optional `timestamp` field to `ChatMessage` interface
  - `src/core/chat.ts` — Updated `appendMessage` to include timestamps, added `MESSAGE_REGEX_TS` for new format, `parseMessages` tries timestamped format first then falls back to legacy
  - `src/core/colors.ts` — Added `timeAgo()` and `formatTimestamp()` helpers, updated `formatMessage()` to show HH:MM:SS
  - `src/commands/status.ts` — Shows "(2m ago)" relative time in LAST ACTIVITY column
  - `src/commands/tail.ts` — Raw mode outputs timestamp in `<ISO8601>` format
  - `src/tui/components/ChatPanel.tsx` — Displays HH:MM:SS timestamp in message lines
  - `src/core/polling.ts` — Updated agent prompt to instruct timestamp format
  - `tests/core/chat.test.ts` — Updated existing tests for new format, added timestamp parsing and legacy backward-compat tests
- Quality gates: typecheck clean, 113/113 tests pass (1 new), build succeeds
- **Learnings:**
  - Backward-compatible regex approach: try new format first, fall back to legacy — avoids breaking existing chat files
  - `timestamp` field is optional on `ChatMessage` to support both old and new messages in the same file
  - `timeAgo()` is useful for both CLI status and TUI — placed in shared `colors.ts` module
---
