# Ralph Progress Log

This file tracks progress across iterations. Agents update this file
after each iteration and it's included in prompts for context.

## Codebase Patterns (Study These First)

*Add reusable patterns discovered during development here.*

- **Claude Code hook registration**: Settings go in `.claude/settings.json` inside each worktree. Format: `{ "hooks": { "PreToolUse": [{ "type": "command", "command": "/abs/path" }] } }`. Hook events: PreToolUse (safety), UserPromptSubmit/PostToolUse (coordination).

---

## 2026-03-02 - agenthive-a29.1
- Implemented hook registration with Claude Code in `hive init`
- After worktree creation, `registerHooksInWorktree()` creates `.claude/settings.json` in each worktree
- Safety hooks (`config.hooks.safety`) → mapped to `PreToolUse` events
- Coordination hooks (`config.hooks.coordination`) → mapped to `UserPromptSubmit` + `PostToolUse` events
- Custom hooks (`config.hooks.custom`) → mapped to `PreToolUse` events
- All hook paths are absolute (resolved via `resolve()`)
- Files changed: `src/commands/init.ts`
- **Learnings:**
  - The `HiveConfig['hooks']` type works well for accessing the hooks sub-type without a separate import
  - The `buildConfig()` function returns the config object before it's written to YAML, so it's available for `registerHooksInWorktree()` without needing to re-parse
  - Worktrees are created at `.hive/worktrees/<name>/`, so `.claude/settings.json` goes at `.hive/worktrees/<name>/.claude/settings.json`
---

